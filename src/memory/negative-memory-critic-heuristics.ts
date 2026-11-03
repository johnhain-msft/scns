/**
 * Negative-memory critic — heuristic prefilter.
 *
 * Pure, deterministic functions that classify candidate negative memories
 * before the (more expensive) LLM critic stage runs. The goal is to suppress
 * obvious pipeline-artifact noise — quality-gate rejections, "no staged diff"
 * messages, transient npm test/lint failures, team archive churn — that
 * should never become permanent agent behavioral instructions.
 *
 * Output for each memory:
 *   - status: 'keep' | 'suppress' | 'undecided'
 *   - rationale: short reason string for audit
 *
 * `undecided` means the heuristics have no opinion; the LLM critic is
 * expected to make the final call. Existing pinned memories always pass
 * through as 'keep' regardless of content (caller responsibility).
 */

import type { NegativeMemory } from './negative-memory-types.js'

export type HeuristicStatus = 'keep' | 'suppress' | 'undecided'

export interface HeuristicVerdict {
  readonly status: HeuristicStatus
  readonly rationale: string
}

// ── Suppression patterns ─────────────────────────────────────────────────────
//
// Each pattern carries a short rationale used when it fires. Patterns are
// matched against the dontRule (primary) and originalText (secondary), with
// case-insensitive comparison.

interface SuppressPattern {
  readonly pattern: RegExp
  readonly rationale: string
}

const PIPELINE_ARTIFACT_PATTERNS: readonly SuppressPattern[] = [
  {
    pattern: /^quality gate rejected/i,
    rationale: 'pipeline artifact: quality-gate rejection log line',
  },
  {
    pattern: /team produced no staged diff/i,
    rationale: 'pipeline artifact: empty-diff handoff result',
  },
  {
    pattern: /npm (test|run lint|run test|lint) failed/i,
    rationale: 'pipeline artifact: transient build/test failure',
  },
  {
    pattern: /\bteam-[a-z0-9-]{6,}\s+(archived|reaped|expired)/i,
    rationale: 'pipeline artifact: team archive churn',
  },
  {
    pattern: /^acp (session|prompt) (timed out|timeout)/i,
    rationale: 'pipeline artifact: ACP transport timeout',
  },
  {
    pattern: /^scheduler (tick|run) failed/i,
    rationale: 'pipeline artifact: scheduler tick failure',
  },
]

const SYSTEM_MESSAGE_PATTERNS: readonly RegExp[] = [
  /^\[(INFO|WARN|ERROR|DEBUG|TRACE)\]/i,
  /^\s*at\s+[\w$.]+\s*\(.+:\d+:\d+\)\s*$/m, // stack-trace frame
  /^Error: .+\n\s+at /,
  /\bUnhandledPromiseRejection\b/,
  /^TypeError: /,
]

// Regex fragments used to collapse incident-specific tokens for template-based
// dedupe. We replace each with a fixed placeholder before comparing rules.
const ID_TOKEN_PATTERNS: readonly { regex: RegExp; replacement: string }[] = [
  // UUIDs
  {
    regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: '<UUID>',
  },
  // team-* / brain-* / sugg-* slugs (8+ hex/alphanumeric chars)
  { regex: /\bteam-[a-z0-9-]{6,}/gi, replacement: '<TEAM>' },
  { regex: /\bsugg-[a-z0-9-]{6,}/gi, replacement: '<SUGG>' },
  { regex: /\bbrain-[a-z0-9-]{4,}/gi, replacement: '<BRAIN>' },
  // git SHAs
  { regex: /\b[0-9a-f]{7,40}\b/gi, replacement: '<SHA>' },
  // ISO timestamps
  {
    regex: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/gi,
    replacement: '<TS>',
  },
  // bare dates
  { regex: /\b\d{4}-\d{2}-\d{2}\b/g, replacement: '<DATE>' },
  // standalone numbers (counts, ports, durations) — keep small ints alone
  { regex: /\b\d{4,}\b/g, replacement: '<N>' },
]

// Minimum word count after id-stripping. Below this we treat as too vague.
const MIN_WORDS_AFTER_STRIP = 5

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Normalize a rule for template-based comparison. Strips incident-specific
 * tokens (uuids, team ids, shas, timestamps) so the same templated message
 * collapses to a single fingerprint.
 */
export function normalizeRuleTemplate(rule: string): string {
  let s = rule.toLowerCase().trim()
  for (const { regex, replacement } of ID_TOKEN_PATTERNS) {
    s = s.replace(regex, replacement)
  }
  // collapse whitespace
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/**
 * Apply heuristic checks to a single memory. Returns 'undecided' when no
 * heuristic fires — the LLM critic should then make the final call.
 */
export function judgeMemoryHeuristic(mem: NegativeMemory): HeuristicVerdict {
  const rule = (mem.dontRule ?? '').trim()
  const original = (mem.originalText ?? '').trim()

  if (mem.pinned) {
    return { status: 'keep', rationale: 'pinned: user-vouched, bypasses critic' }
  }

  // 1. Empty / whitespace rule
  if (rule.length === 0) {
    return { status: 'suppress', rationale: 'empty rule body' }
  }

  // 2. Pipeline-artifact patterns (check dontRule + originalText)
  for (const { pattern, rationale } of PIPELINE_ARTIFACT_PATTERNS) {
    if (pattern.test(rule) || pattern.test(original)) {
      return { status: 'suppress', rationale }
    }
  }

  // 3. System-message / stack-trace patterns
  for (const pattern of SYSTEM_MESSAGE_PATTERNS) {
    if (pattern.test(rule) || pattern.test(original)) {
      return {
        status: 'suppress',
        rationale: 'looks like a system log line, not user feedback',
      }
    }
  }

  // 4. Vague rule check — strip ids then count words
  const normalized = normalizeRuleTemplate(rule)
  const wordCount = normalized.split(/\s+/).filter((w) => w.length > 0).length
  if (wordCount < MIN_WORDS_AFTER_STRIP) {
    return {
      status: 'suppress',
      rationale: `too vague: ${wordCount} words after stripping ids`,
    }
  }

  return { status: 'undecided', rationale: '' }
}

/**
 * Batch judge a list of memories. Also performs duplicate-by-template
 * collapse: when two undecided memories share a normalized template, the
 * older copy keeps 'undecided' (so the LLM judges once); the newer ones are
 * marked 'suppress' with rationale "duplicate-template".
 */
export function judgeMemoriesHeuristic(
  memories: readonly NegativeMemory[],
): ReadonlyMap<string, HeuristicVerdict> {
  const verdicts = new Map<string, HeuristicVerdict>()
  const seenTemplates = new Map<string, string>() // template -> id

  // Sort by createdAt ascending so the FIRST occurrence is the canonical one.
  const sorted = [...memories].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  for (const mem of sorted) {
    const verdict = judgeMemoryHeuristic(mem)
    if (verdict.status === 'undecided') {
      const template = normalizeRuleTemplate(mem.dontRule)
      const canonical = seenTemplates.get(template)
      if (canonical && canonical !== mem.id) {
        verdicts.set(mem.id, {
          status: 'suppress',
          rationale: `duplicate-template of ${canonical}`,
        })
        continue
      }
      seenTemplates.set(template, mem.id)
    }
    verdicts.set(mem.id, verdict)
  }

  return verdicts
}

/** Exported for tests + LLM-critic batching. */
export const HEURISTIC_INTERNALS = {
  PIPELINE_ARTIFACT_PATTERNS,
  SYSTEM_MESSAGE_PATTERNS,
  MIN_WORDS_AFTER_STRIP,
} as const
