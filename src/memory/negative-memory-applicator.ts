/**
 * Negative Memory Applicator — applies learned "don't do this" rules
 * to .github/copilot-instructions.md as a managed fenced block.
 *
 * Design: full-block regeneration. Each run rebuilds the entire managed
 * block from all eligible memories (confidence ≥ threshold). This is
 * idempotent and deterministic — safe to call on every dream cycle.
 *
 * v1: single target file (.github/copilot-instructions.md) for all target types.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Vault } from './vault.js'
import type { NegativeMemory } from './negative-memory-types.js'
import { createNegativeMemoryStore } from './negative-memory-store.js'
import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'negative-memory-applicator' })

// ── Constants ────────────────────────────────────────────────────────────────

export const BLOCK_START = '<!-- SCNS:negative-memories:start -->'
export const BLOCK_END = '<!-- SCNS:negative-memories:end -->'

const TARGET_FILE = '.github/copilot-instructions.md'

// ── Types ────────────────────────────────────────────────────────────────────

/** Configuration for applying negative memories to a project. */
export interface ApplyConfig {
  readonly vault: Vault
  readonly projectRoot: string
  readonly minConfidence?: number
  /**
   * If true, memories without a critic verdict (legacy entries) are still
   * applied. Default: false — critic must approve before a rule lands in
   * copilot-instructions.md. The dream daemon should call the critic
   * before invoking the applicator, so the strict default is correct.
   */
  readonly allowUnjudged?: boolean
}

/** Result of a negative memory application run. */
export interface ApplyResult {
  readonly appliedCount: number
  readonly skippedCount: number
  readonly suppressedByCriticCount: number
  readonly pendingReviewCount: number
  readonly targetFile: string
  readonly errors: readonly string[]
}

// ── Block operations ─────────────────────────────────────────────────────────

/**
 * Build the managed block content from a list of "don't" rules.
 * Returns empty string if no rules.
 */
export function buildManagedBlock(rules: readonly string[]): string {
  const unique = [...new Set(rules)]
  if (unique.length === 0) return ''

  const ruleLines = unique.map((r) => `- ${r}`).join('\n')
  return `${BLOCK_START}\n## Things to AVOID (learned from experience)\n\n${ruleLines}\n${BLOCK_END}`
}

/**
 * Extract the managed block from file content, splitting into
 * { before, block, after } segments.
 */
export function extractManagedBlock(content: string): {
  before: string
  block: string
  after: string
} {
  const startIdx = content.indexOf(BLOCK_START)
  if (startIdx === -1) {
    return { before: content, block: '', after: '' }
  }

  const endIdx = content.indexOf(BLOCK_END, startIdx)
  if (endIdx === -1) {
    return { before: content, block: '', after: '' }
  }

  const blockEndIdx = endIdx + BLOCK_END.length
  return {
    before: content.slice(0, startIdx),
    block: content.slice(startIdx, blockEndIdx),
    after: content.slice(blockEndIdx),
  }
}

// ── Eligibility derivation (shared) ──────────────────────────────────────────

/** Eligible negative-memory rules plus the categorization counts. */
export interface EligibleRulesResult {
  /** Memories that passed the critic / confidence filter, in store order. */
  readonly eligible: readonly NegativeMemory[]
  /** The "don't" rule text for each eligible memory (revised text when revised). */
  readonly rules: readonly string[]
  readonly skippedCount: number
  readonly suppressedByCriticCount: number
  readonly pendingReviewCount: number
}

/**
/**
 * How many memories to LOAD before filtering.
 *
 * The store sorts newest-first then slices, so a narrow page truncates BEFORE the critic filter runs
 * and can drop every eligible rule. Live-confirmed 2026-07-28: the vault held 223 memories — 215
 * recent `suppress` CI artifacts ahead of 8 genuine `keep` lessons from April–July — so a 200-row
 * page yielded an EMPTY block. Both consumers scan the whole store and let the per-consumer limit
 * apply to what SURVIVES.
 */
export const NEGATIVE_MEMORY_SCAN_LIMIT = 1000

/**
 * A memory's standing against the critic — the ONE definition of "eligible", shared by every
 * consumer so the managed AGENTS.md block and the live per-prompt injection can never disagree.
 */
export type NegativeMemoryEligibility =
  | 'eligible'
  | 'suppressed-by-critic'
  | 'pending-review'
  | 'low-confidence'

/** Just enough of a negative memory to judge its eligibility (structural, so route deps fit). */
export interface ClassifiableNegativeMemory {
  readonly confidence?: number
  readonly pinned?: boolean
  readonly criticVerdict?: { readonly status?: string; readonly revisedRule?: string } | null
}

export function classifyNegativeMemory(
  mem: ClassifiableNegativeMemory,
  opts: { readonly minConfidence?: number; readonly allowUnjudged?: boolean } = {},
): NegativeMemoryEligibility {
  const { minConfidence = 0.7, allowUnjudged = false } = opts

  if (mem.pinned) return 'eligible'
  if ((mem.confidence ?? 0) < minConfidence) return 'low-confidence'

  const status = mem.criticVerdict?.status
  if (!status) return allowUnjudged ? 'eligible' : 'pending-review'

  return status === 'keep' || status === 'revise' ? 'eligible' : 'suppressed-by-critic'
}

/**
 * The rule text to surface — the critic's revision when it rewrote one, else the original.
 *
 * Exported so the deletion primitive matches a managed-block bullet back to the record(s) that
 * back it using the SAME precedence the projection used to write it.
 */
export function negativeRuleText(
  mem: ClassifiableNegativeMemory & { readonly dontRule?: string },
): string {
  const v = mem.criticVerdict
  if (v?.status === 'revise' && v.revisedRule) return v.revisedRule
  return mem.dontRule ?? ''
}

const ruleTextOf = negativeRuleText

/**
 * Relevance floor for the live injection (issue #75): when the prompt lexically matches
 * fewer than this many eligible rules, the selection tops up to this many in store order.
 * A guardrail can apply to a task without sharing its words ("never hardcode secrets" vs.
 * a prompt about adding an endpoint), so pure relevance filtering would silently retire
 * universally-phrased rules — the floor keeps a baseline of them circulating on every
 * prompt while topic-specific rules still only appear when they match.
 *
 * The floor works BOTH ways: it also reserves this many slots for relevant rules when the
 * prompt does match, so a pile of pinned rules can never fully starve on-topic rules out
 * of the injection budget (pinned rules cap at limit − min(relevant, floor)).
 */
export const NEGATIVE_RULE_RELEVANCE_FLOOR = 3

/** Prompt-relevance options for {@link selectInjectableNegativeRules} (issue #75). */
export interface NegativeRuleRelevance {
  /** Scores a rule's INJECTED text against the current prompt; 0 means "not relevant". */
  readonly score: (ruleText: string) => number
  /** Minimum rules to inject when pinned+relevant fall short; see {@link NEGATIVE_RULE_RELEVANCE_FLOOR}. */
  readonly floor: number
}

/**
 * The rules the LIVE per-prompt "Things to AVOID" block may inject.
 *
 * Filters FIRST and truncates SECOND — the ordering matters: the caller fetches a wide page and the
 * limit applies to what survives the critic, so suppressed noise can no longer consume the budget.
 *
 * With `relevance` set (issue #75), a second filter runs AFTER the critic-eligibility gate —
 * relevance can only narrow what quality already admitted, never rescue what the critic
 * suppressed. Selection order: pinned rules first (pinned already overrides the critic and
 * confidence gates — it is the explicit "this always applies" lever, so it bypasses relevance
 * too — but capped so min(relevant, floor) slots stay reserved for the prompt's matches),
 * then relevant rules best-match-first, then — only when those come to fewer than
 * `relevance.floor` — a top-up in store order. Without `relevance` the behavior is
 * byte-identical to the pre-#75 selection (the SCNS_INJECTION_RELEVANCE=0 flip-back path).
 */
export function selectInjectableNegativeRules(
  memories: readonly (ClassifiableNegativeMemory & { readonly dontRule?: string })[],
  opts: {
    readonly limit: number
    readonly minConfidence?: number
    readonly allowUnjudged?: boolean
    readonly relevance?: NegativeRuleRelevance
  },
): string[] {
  const { limit, relevance, ...classifyOpts } = opts
  const injectable = memories
    .filter((m) => classifyNegativeMemory(m, classifyOpts) === 'eligible')
    .map((m) => ({ mem: m, rule: ruleTextOf(m) }))
    .filter((e) => e.rule.trim().length > 0)

  if (!relevance) return injectable.map((e) => e.rule).slice(0, limit)

  const pinned = injectable.filter((e) => e.mem.pinned)
  const rest = injectable.filter((e) => !e.mem.pinned)
  const relevant = rest
    .map((e, i) => ({ entry: e, score: relevance.score(e.rule), i }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.entry)

  // Pinned rules lead, but cannot flood: min(relevant, floor) slots stay reserved for the
  // prompt's actual matches, so pinning N ≥ limit rules still leaves on-topic rules room.
  // With nothing relevant there is nothing to reserve and pinned may fill the whole limit.
  const pinnedCap = Math.max(0, limit - Math.min(relevant.length, relevance.floor))
  const selected = [...pinned.slice(0, pinnedCap), ...relevant]
  if (selected.length < relevance.floor) {
    const chosen = new Set(selected)
    for (const e of rest) {
      if (selected.length >= relevance.floor) break
      if (!chosen.has(e)) selected.push(e)
    }
  }
  return selected.map((e) => e.rule).slice(0, limit)
}

/**
 * Derive the eligible "don't" rules from the vault — the single source of truth
 * for which rules land in the managed block. Both the live applicator and the
 * shadow gated evaluator consume this so the candidate set is identical.
 */
export function deriveEligibleRules(
  vault: Vault,
  opts: { readonly minConfidence?: number; readonly allowUnjudged?: boolean } = {},
): EligibleRulesResult {
  const store = createNegativeMemoryStore(vault)
  const allMemories = store.list({ limit: NEGATIVE_MEMORY_SCAN_LIMIT })

  const eligible: NegativeMemory[] = []
  let skippedCount = 0
  let suppressedByCriticCount = 0
  let pendingReviewCount = 0

  for (const mem of allMemories) {
    switch (classifyNegativeMemory(mem, opts)) {
      case 'eligible':
        eligible.push(mem)
        break
      case 'low-confidence':
        skippedCount++
        break
      case 'suppressed-by-critic':
        suppressedByCriticCount++
        break
      case 'pending-review':
        pendingReviewCount++
        break
    }
  }

  const rules = eligible.map((m) => {
    if (m.criticVerdict?.status === 'revise' && m.criticVerdict.revisedRule) {
      return m.criticVerdict.revisedRule
    }
    return m.dontRule
  })

  return { eligible, rules, skippedCount, suppressedByCriticCount, pendingReviewCount }
}

// ── Main applicator ──────────────────────────────────────────────────────────

/**
 * Apply negative memories to .github/copilot-instructions.md.
 *
 * Reads ALL memories from the vault with confidence ≥ minConfidence,
 * rebuilds the managed block, and writes/updates the target file.
 * Marks applied memories in the vault with targetApplied: true.
 */
export function applyNegativeMemories(config: ApplyConfig): ApplyResult {
  const { vault, projectRoot, minConfidence = 0.7, allowUnjudged = false } = config
  const errors: string[] = []
  const targetPath = join(projectRoot, TARGET_FILE)

  const { eligible, rules, skippedCount, suppressedByCriticCount, pendingReviewCount } =
    deriveEligibleRules(vault, { minConfidence, allowUnjudged })

  if (eligible.length === 0) {
    // Phase 13.12.34 — refuse to erase a non-empty existing block.
    //
    // Postmortem (team ca3ecfec, 2026-05-15): the agent's
    // `.github/copilot-instructions.md` lost all 5 negative-memories rules
    // mid-self-improve cycle. Those rules included exactly the guardrails
    // ("Do not claim functionality works without live verification",
    //  "Never fabricate evidence", "Do not skip manual testing") that
    // would have caught the verdict-PASS branches as poison-pill.
    //
    // The applicator previously called `rewriteEmptyBlock` unconditionally
    // when no memories were eligible — which strips rules any time the
    // vault is transiently empty: index rebuild, critic verdict queue
    // lag, dream-daemon race, or a future bug we can't yet predict. In
    // every such case, preserving the existing rules is safer than
    // erasing them. Suppressing a rule must remain explicit (a critic
    // verdict of `suppress`); falling through to zero must not.
    if (existsSync(targetPath)) {
      const existing = readFileSync(targetPath, 'utf-8')
      const { block } = extractManagedBlock(existing)
      if (block) {
        const inner = block.slice(BLOCK_START.length, -BLOCK_END.length).trim()
        if (inner.length > 0) {
          log.warn(
            {
              skippedCount,
              suppressedByCriticCount,
              pendingReviewCount,
              existingBlockBytes: inner.length,
            },
            'No eligible negative memories but existing block has content — refusing to erase (preserving guardrails)',
          )
          return {
            appliedCount: 0,
            skippedCount,
            suppressedByCriticCount,
            pendingReviewCount,
            targetFile: TARGET_FILE,
            errors,
          }
        }
      }
    }

    log.info(
      { skippedCount, suppressedByCriticCount, pendingReviewCount },
      'No eligible negative memories to apply',
    )
    // Even with zero eligible memories we still need to ensure the managed
    // block in copilot-instructions.md is empty (so previously-applied but
    // now-suppressed rules disappear). Only reached when the file has no
    // existing block or the existing block was already empty.
    rewriteEmptyBlock(targetPath)
    return {
      appliedCount: 0,
      skippedCount,
      suppressedByCriticCount,
      pendingReviewCount,
      targetFile: TARGET_FILE,
      errors,
    }
  }

  // Build the new managed block from the rules derived above.
  const newBlock = buildManagedBlock(rules)

  // Read existing file (if any)
  let existingContent = ''
  if (existsSync(targetPath)) {
    existingContent = readFileSync(targetPath, 'utf-8')
  }

  // Split existing content around the managed block
  const { before, after } = extractManagedBlock(existingContent)

  // Reassemble: before + newBlock + after
  let finalContent: string
  if (existingContent === '') {
    finalContent = newBlock + '\n'
  } else {
    const sep = before.endsWith('\n') || before === '' ? '' : '\n'
    finalContent = before + sep + newBlock + after
  }

  // Write the file
  const dir = dirname(targetPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(targetPath, finalContent, 'utf-8')

  log.info(
    {
      appliedCount: eligible.length,
      suppressedByCriticCount,
      pendingReviewCount,
      targetFile: TARGET_FILE,
    },
    'Applied negative memories to copilot-instructions.md',
  )

  // Mark all eligible memories as applied in the vault
  for (const mem of eligible) {
    if (mem.targetApplied) continue
    try {
      updateMemoryApplied(vault, mem.id, TARGET_FILE)
    } catch (err) {
      const msg = `Failed to mark memory ${mem.id} as applied: ${err instanceof Error ? err.message : String(err)}`
      log.warn(msg)
      errors.push(msg)
    }
  }

  return {
    appliedCount: eligible.length,
    skippedCount,
    suppressedByCriticCount,
    pendingReviewCount,
    targetFile: TARGET_FILE,
    errors,
  }
}

/**
 * If the target file exists and contains a managed block, replace that block
 * with an empty block marker pair. If the file doesn't exist or has no block,
 * this is a no-op. Used when zero memories are eligible — we still want the
 * file to reflect "no applied rules" rather than retain stale content.
 */
function rewriteEmptyBlock(targetPath: string): void {
  if (!existsSync(targetPath)) return
  const existing = readFileSync(targetPath, 'utf-8')
  const { before, block, after } = extractManagedBlock(existing)
  if (!block) return
  const emptyBlock = `${BLOCK_START}\n${BLOCK_END}`
  const sep = before.endsWith('\n') || before === '' ? '' : '\n'
  writeFileSync(targetPath, before + sep + emptyBlock + after, 'utf-8')
}

// ── Vault update helper ──────────────────────────────────────────────────────

/**
 * Update a negative memory vault file to mark it as applied.
 * Modifies the YAML frontmatter: targetApplied → true, appliedTo → filepath.
 *
 * Exported so the gated live runner (Phase-1 wedge C) marks an ADOPTED memory
 * applied with byte-identical semantics to the blind path.
 */
export function updateMemoryApplied(vault: Vault, memoryId: string, appliedTo: string): void {
  const file = vault.read(`negative/${memoryId}.md`)
  if (!file) {
    throw new Error(`Memory file not found: negative/${memoryId}.md`)
  }

  let content = file.content

  // Update targetApplied
  content = content.replace(/^targetApplied: false$/m, 'targetApplied: true')

  // Add or update appliedTo
  if (/^appliedTo:/m.test(content)) {
    content = content.replace(/^appliedTo:.*$/m, `appliedTo: ${appliedTo}`)
  } else {
    // Insert before closing ---
    content = content.replace(/\n---\n/, `\nappliedTo: ${appliedTo}\n---\n`)
  }

  vault.write(`negative/${memoryId}.md`, content)
}
