/**
 * Shared memory-deletion primitive (issue #71).
 *
 * The ONE operation that removes or revises a canonical vault record and reconciles every
 * ACTIVE representation of it. Deleting a single representation is not deletion: a memory
 * lives simultaneously as
 *
 *   1. canonical Markdown under the vault root,
 *   2. searchable index rows (`vault_files` → `chunks` → `chunks_fts` / `memory_edges` /
 *      `chunk_embeddings`, the last of which is a `vec0` table with NO foreign key and so is
 *      never cascade-cleaned), and
 *   3. a projected bullet inside the managed `.github/copilot-instructions.md` block.
 *
 * Preview and apply are separate: `previewMemoryDeletion` is read-only and produces a plan the
 * human reviews; `applyMemoryDeletion` consumes THAT plan and refuses when the project identity
 * or any reviewed content has changed underneath it. Nothing here decides WHICH memories should
 * go — that is the caller's (or the pruning evaluator's) job.
 *
 * Two outcomes are deliberately distinct and truthfully reported:
 *   - `retire`      — recoverable. The exact bytes are copied into the vault's `archive/` tier
 *                     (excluded from `vault.listFiles()`, therefore never indexed or retrieved)
 *                     and can be restored with `restoreRetiredMemory`.
 *   - `hard-delete` — unrecoverable. No recovery record is written and the result says so.
 *
 * A filesystem unlink plus a SQLite transaction is NOT one atomic transaction. Each step is
 * reported independently; a partial result is reported as partial, never as success.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import type { Vault } from './vault.js'
import { chunkText } from './chunker.js'
import { createNegativeMemoryStore } from './negative-memory-store.js'
import {
  BLOCK_START,
  BLOCK_END,
  extractManagedBlock,
  negativeRuleText,
  NEGATIVE_MEMORY_SCAN_LIMIT,
} from './negative-memory-applicator.js'
import { ValidationError } from '../shared/errors.js'
import { logger } from '../shared/logger.js'
import {
  ensureRetirementTable,
  findRestorableRetirement,
  markRestored,
  recordRetirement,
} from './retirement-ledger.js'

export {
  ensureRetirementTable,
  isRetiredRevision,
  listRetirements,
  type RetirementRow,
} from './retirement-ledger.js'

const log = logger.child({ module: 'memory-deletion' })

/** Where the managed negative-memory block is projected, relative to the project root. */
export const INSTRUCTIONS_RELATIVE_PATH = join('.github', 'copilot-instructions.md')

/** Vault tier that holds recovery copies. Excluded from `vault.listFiles()` ⇒ never indexed. */
const RETIRED_DIR = join('archive', 'retired')

// ── Types ────────────────────────────────────────────────────────────────────

export type MemoryDeletionMode = 'retire' | 'hard-delete'
export type MemoryDeletionAction = 'delete' | 'revise'
export type StepStatus = 'ok' | 'skipped' | 'failed'

/** The project this operation is bound to. An apply against a different identity is refused. */
export interface ProjectMemoryIdentity {
  readonly projectId: string
  readonly projectRoot: string
  readonly instanceId: string | null
  readonly vaultRoot: string
  readonly dbPath: string
}

export interface MemoryDeletionTarget {
  /** Vault-relative path, e.g. `negative/<id>.md`. */
  readonly path: string
  /** Default `delete`. `revise` rewrites the record, keeping the durable part. */
  readonly action?: MemoryDeletionAction
  /** Replacement `dontRule` text (revise only). */
  readonly revisedRule?: string
  /** Replacement body (revise only). Defaults to `revisedRule`. */
  readonly revisedBody?: string
  /** Free-text justification carried into the plan for review. */
  readonly reason?: string
}

export interface IndexFootprint {
  readonly fileRow: boolean
  readonly chunkIds: readonly number[]
  readonly chunkCount: number
  readonly ftsCount: number
  readonly embeddingCount: number
  readonly edgeCount: number
  readonly eventNodeCount: number
}

export interface ManagedRuleRef {
  /** The bullet text as it appears in the managed block. */
  readonly text: string
  readonly presentInBlock: boolean
  /** True when THIS record is the only one backing the bullet, so removal is safe. */
  readonly soleBacker: boolean
}

export interface MemoryDeletionItem {
  readonly path: string
  readonly memoryId: string | null
  readonly action: MemoryDeletionAction
  readonly sourceExists: boolean
  readonly contentHash: string | null
  readonly sizeBytes: number | null
  readonly pinned: boolean
  readonly index: IndexFootprint
  readonly managedRules: readonly ManagedRuleRef[]
  readonly revisedContent?: string
  readonly revisedRuleText?: string
  readonly reason: string
}

export interface ManagedBlockPlan {
  /** Absolute path of the instruction file. Never created by a preview. */
  readonly path: string
  readonly exists: boolean
  readonly blockPresent: boolean
  readonly fileHash: string | null
  readonly rules: readonly string[]
  readonly removedRules: readonly string[]
  readonly revisedRules: readonly { readonly from: string; readonly to: string }[]
  /** Bullets with no backing vault record — reported, never inferred to be stale. */
  readonly unmatchedRules: readonly string[]
}

export interface MemoryDeletionPlan {
  readonly schemaVersion: 1
  readonly kind: 'scns-memory-deletion-plan'
  readonly planId: string
  readonly createdAt: string
  readonly mode: MemoryDeletionMode
  readonly project: ProjectMemoryIdentity
  readonly items: readonly MemoryDeletionItem[]
  readonly managedBlock: ManagedBlockPlan
  readonly warnings: readonly string[]
}

export interface MemoryDeletionItemResult {
  readonly path: string
  readonly action: MemoryDeletionAction
  readonly source: StepStatus
  readonly index: StepStatus
  /**
   * True when this item reached its approved end state. A `skipped` step is NOT automatically
   * satisfied: a source that was already gone is (the end state matches the plan), a pinned
   * memory we refused to touch is not. Without this distinction an apply that protected a
   * pinned record would report overall success for work it deliberately did not do.
   */
  readonly satisfied: boolean
  readonly recoverable: boolean
  readonly chunksRemoved: number
  readonly chunksCreated: number
  readonly embeddingsRemoved: number
  readonly error?: string
}

export interface MemoryDeletionResult {
  readonly planId: string
  /** True only when every requested step completed. */
  readonly applied: boolean
  /** True when some steps completed and others did not. */
  readonly partial: boolean
  readonly refused: string | null
  readonly recoveryRef: string | null
  readonly items: readonly MemoryDeletionItemResult[]
  readonly managedBlock: {
    readonly status: StepStatus
    readonly rulesRemoved: number
    readonly rulesRevised: number
    readonly error?: string
  }
  /**
   * Revised/reindexed chunks carry no vector until the next embedding backfill; the
   * keyword/FTS path is current immediately. Reported so a caller never claims otherwise.
   */
  readonly embeddingsPendingBackfill: number
  readonly errors: readonly string[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function hashText(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

/** Reject anything that resolves outside the vault root (mirrors `vault.safePath`). */
function assertInsideVault(vaultRoot: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  const resolved = resolve(vaultRoot, normalized)
  const rel = relative(vaultRoot, resolved)
  if (rel.startsWith('..') || resolve(vaultRoot, rel) !== resolved) {
    throw new ValidationError(`Path traversal detected: ${relativePath}`)
  }
  return normalized
}

function readIndexFootprint(db: Database.Database, path: string): IndexFootprint {
  const fileRow = db.prepare('SELECT 1 AS hit FROM vault_files WHERE path = ?').get(path) as
    | { hit: number }
    | undefined
  const chunkIds = (
    db.prepare('SELECT id FROM chunks WHERE file_path = ?').all(path) as Array<{ id: number }>
  ).map((r) => r.id)
  const count = (sql: string): number => {
    try {
      return (db.prepare(sql).get(path) as { n: number }).n
    } catch {
      return 0
    }
  }
  return {
    fileRow: fileRow !== undefined,
    chunkIds,
    chunkCount: chunkIds.length,
    ftsCount: count(
      'SELECT COUNT(*) n FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)',
    ),
    embeddingCount: count(
      'SELECT COUNT(*) n FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)',
    ),
    edgeCount: count(
      'SELECT COUNT(*) n FROM memory_edges WHERE src_chunk IN (SELECT id FROM chunks WHERE file_path = ?)',
    ),
    eventNodeCount: count(
      'SELECT COUNT(*) n FROM event_nodes WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)',
    ),
  }
}

/** Parse the `- rule` bullets out of the managed block. Returns [] when there is no block. */
export function parseManagedBlockRules(fileContent: string): readonly string[] {
  const { block } = extractManagedBlock(fileContent)
  if (!block) return []
  const inner = block.slice(BLOCK_START.length, -BLOCK_END.length)
  const rules: string[] = []
  for (const line of inner.split('\n')) {
    const m = /^\s*-\s+(.*\S)\s*$/.exec(line)
    if (m) rules.push(m[1]!)
  }
  return rules
}

/**
 * Rewrite the managed block with `rules`, preserving every byte outside it. An empty list yields
 * an empty marker pair — the file, its preamble and its trailing prose are never touched.
 */
export function rewriteManagedBlockRules(fileContent: string, rules: readonly string[]): string {
  const { before, block, after } = extractManagedBlock(fileContent)
  if (!block) return fileContent
  const body =
    rules.length === 0
      ? `${BLOCK_START}\n${BLOCK_END}`
      : `${BLOCK_START}\n## Things to AVOID (learned from experience)\n\n${rules
          .map((r) => `- ${r}`)
          .join('\n')}\n${BLOCK_END}`
  return before + body + after
}

/** Frontmatter `id` of a negative-memory file, when the file is one. */
function parseFrontmatterField(content: string, field: string): string | null {
  const m = new RegExp(`^${field}:\\s*(.*)$`, 'm').exec(content)
  return m ? (m[1]?.trim() ?? null) : null
}

/** Map every bullet-worthy rule text to the ids of the records that back it. */
/** Rule text a negative memory currently projects, with the critic's revision winning. */
export function buildRuleBackers(vault: Vault): Map<string, Set<string>> {
  const store = createNegativeMemoryStore(vault)
  const backers = new Map<string, Set<string>>()
  for (const mem of store.list({ limit: NEGATIVE_MEMORY_SCAN_LIMIT })) {
    const text = negativeRuleText(mem)
    if (!text.trim()) continue
    const set = backers.get(text) ?? new Set<string>()
    set.add(mem.id)
    backers.set(text, set)
  }
  return backers
}

/** Replace the `dontRule` frontmatter field and the body of a negative-memory file. */
export function reviseNegativeMemoryContent(
  original: string,
  revisedRule: string,
  revisedBody: string,
): string {
  const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(original)
  if (!fm) return revisedBody
  const singleLineRule = revisedRule.replace(/\r?\n/g, ' ').trim()
  let frontmatter = fm[1]!
  frontmatter = /^dontRule:/m.test(frontmatter)
    ? frontmatter.replace(/^dontRule:.*$/m, `dontRule: ${singleLineRule}`)
    : `${frontmatter}\ndontRule: ${singleLineRule}`
  // A stored critic revision must not keep presenting the obsolete clause as current guidance.
  frontmatter = frontmatter.replace(
    /^criticRevisedRule:.*$/m,
    `criticRevisedRule: ${singleLineRule}`,
  )
  const updatedAt = new Date().toISOString()
  frontmatter = /^updatedAt:/m.test(frontmatter)
    ? frontmatter.replace(/^updatedAt:.*$/m, `updatedAt: ${updatedAt}`)
    : `${frontmatter}\nupdatedAt: ${updatedAt}`
  return `---\n${frontmatter}\n---\n${revisedBody}\n`
}

// ── Preview ──────────────────────────────────────────────────────────────────

export interface PreviewMemoryDeletionOptions {
  readonly vault: Vault
  readonly db: Database.Database
  readonly identity: ProjectMemoryIdentity
  readonly targets: readonly MemoryDeletionTarget[]
  readonly mode: MemoryDeletionMode
}

export function previewMemoryDeletion(opts: PreviewMemoryDeletionOptions): MemoryDeletionPlan {
  const { vault, db, identity, targets, mode } = opts
  ensureRetirementTable(db)

  const warnings: string[] = []
  const backers = buildRuleBackers(vault)

  const instructionsPath = join(identity.projectRoot, INSTRUCTIONS_RELATIVE_PATH)
  const instructionsExist = existsSync(instructionsPath)
  const instructionsContent = instructionsExist ? readFileSync(instructionsPath, 'utf-8') : ''
  const blockRules = parseManagedBlockRules(instructionsContent)
  const blockPresent = extractManagedBlock(instructionsContent).block !== ''

  const targetIds = new Set<string>()
  for (const t of targets) {
    const rel = assertInsideVault(identity.vaultRoot, t.path)
    const file = vault.read(rel)
    if (file) {
      const id = parseFrontmatterField(file.content, 'id')
      if (id) targetIds.add(id)
    }
  }

  const items: MemoryDeletionItem[] = []
  for (const target of targets) {
    const path = assertInsideVault(identity.vaultRoot, target.path)
    const action: MemoryDeletionAction = target.action ?? 'delete'
    const file = vault.read(path)

    if (!file) {
      warnings.push(`${path}: no source file — nothing to remove (index rows still reconciled)`)
    }
    const memoryId = file ? parseFrontmatterField(file.content, 'id') : null
    const pinned = file ? parseFrontmatterField(file.content, 'pinned') === 'true' : false
    if (pinned) {
      warnings.push(
        `${path}: memory is pinned — apply will SKIP it unless the caller explicitly overrides`,
      )
    }

    const currentRule = file ? currentRuleTextOf(file.content) : null
    const managedRules: ManagedRuleRef[] = []
    if (currentRule) {
      const backing = backers.get(currentRule) ?? new Set<string>()
      const otherBackers = [...backing].filter((id) => id !== memoryId && !targetIds.has(id))
      managedRules.push({
        text: currentRule,
        presentInBlock: blockRules.includes(currentRule),
        soleBacker: backing.size > 0 && otherBackers.length === 0,
      })
    }

    let revisedContent: string | undefined
    let revisedRuleText: string | undefined
    if (action === 'revise') {
      if (!target.revisedRule || !target.revisedRule.trim()) {
        throw new ValidationError(`${path}: a revise target requires revisedRule`)
      }
      if (!file) {
        warnings.push(`${path}: cannot revise a missing source file`)
      } else {
        revisedRuleText = target.revisedRule.trim()
        revisedContent = reviseNegativeMemoryContent(
          file.content,
          revisedRuleText,
          (target.revisedBody ?? target.revisedRule).trim(),
        )
      }
    }

    items.push({
      path,
      memoryId,
      action,
      sourceExists: file !== null,
      contentHash: file ? hashText(file.content) : null,
      sizeBytes: file ? file.sizeBytes : null,
      pinned,
      index: readIndexFootprint(db, path),
      managedRules,
      ...(revisedContent !== undefined ? { revisedContent } : {}),
      ...(revisedRuleText !== undefined ? { revisedRuleText } : {}),
      reason: target.reason ?? '',
    })
  }

  const removedRules: string[] = []
  const revisedRules: { from: string; to: string }[] = []
  for (const item of items) {
    for (const ref of item.managedRules) {
      if (!ref.presentInBlock || !ref.soleBacker) continue
      if (item.action === 'revise' && item.revisedRuleText) {
        revisedRules.push({ from: ref.text, to: item.revisedRuleText })
      } else if (item.action === 'delete') {
        removedRules.push(ref.text)
      }
    }
  }

  const touchedTexts = new Set([...removedRules, ...revisedRules.map((r) => r.from)])
  const unmatchedRules = blockRules.filter((r) => !touchedTexts.has(r) && !backers.has(r))

  return {
    schemaVersion: 1,
    kind: 'scns-memory-deletion-plan',
    planId: randomUUID(),
    createdAt: new Date().toISOString(),
    mode,
    project: identity,
    items,
    managedBlock: {
      path: instructionsPath,
      exists: instructionsExist,
      blockPresent,
      fileHash: instructionsExist ? hashText(instructionsContent) : null,
      rules: blockRules,
      removedRules,
      revisedRules,
      unmatchedRules,
    },
    warnings,
  }
}

/** The rule text a record currently projects (critic revision wins, as the applicator does). */
function currentRuleTextOf(content: string): string | null {
  const status = parseFrontmatterField(content, 'criticStatus')
  const revised = parseFrontmatterField(content, 'criticRevisedRule')
  if (status === 'revise' && revised) return revised
  return parseFrontmatterField(content, 'dontRule')
}

// ── Apply ────────────────────────────────────────────────────────────────────

export interface ApplyMemoryDeletionOptions {
  readonly vault: Vault
  readonly db: Database.Database
  readonly identity: ProjectMemoryIdentity
  readonly plan: MemoryDeletionPlan
  /** Pinned memories are protected by default; the caller must opt in explicitly. */
  readonly allowPinned?: boolean
}

export function applyMemoryDeletion(opts: ApplyMemoryDeletionOptions): MemoryDeletionResult {
  const { vault, db, identity, plan, allowPinned = false } = opts
  ensureRetirementTable(db)

  const errors: string[] = []
  const empty = (refused: string): MemoryDeletionResult => ({
    planId: plan.planId,
    applied: false,
    partial: false,
    refused,
    recoveryRef: null,
    items: plan.items.map((i) => ({
      path: i.path,
      action: i.action,
      source: 'skipped' as StepStatus,
      index: 'skipped' as StepStatus,
      satisfied: false,
      recoverable: false,
      chunksRemoved: 0,
      chunksCreated: 0,
      embeddingsRemoved: 0,
    })),
    managedBlock: { status: 'skipped', rulesRemoved: 0, rulesRevised: 0 },
    embeddingsPendingBackfill: 0,
    errors: [refused],
  })

  if (plan.kind !== 'scns-memory-deletion-plan' || plan.schemaVersion !== 1) {
    return empty('plan is not a supported scns-memory-deletion-plan v1')
  }
  if (plan.project.projectId !== identity.projectId) {
    return empty(
      `plan is bound to project ${plan.project.projectId} but this store is ${identity.projectId}`,
    )
  }
  if (resolve(plan.project.vaultRoot) !== resolve(identity.vaultRoot)) {
    return empty(`plan vault root ${plan.project.vaultRoot} does not match ${identity.vaultRoot}`)
  }
  if (resolve(plan.project.projectRoot) !== resolve(identity.projectRoot)) {
    return empty(
      `plan project root ${plan.project.projectRoot} does not match ${identity.projectRoot}`,
    )
  }

  const results: MemoryDeletionItemResult[] = []
  const succeededDeletes: MemoryDeletionItem[] = []
  const succeededRevisions: MemoryDeletionItem[] = []
  let recoveryRef: string | null = null
  let embeddingsPendingBackfill = 0

  for (const item of plan.items) {
    const path = assertInsideVault(identity.vaultRoot, item.path)
    const file = vault.read(path)

    // The source vanished (already deleted, or a concurrent writer removed it). Reconcile the
    // index anyway so no orphan rows survive. The approved end state — this record absent from
    // every active representation — IS reached, so the item counts as satisfied.
    if (!file) {
      const removed = reconcileIndexForPath(db, path)
      results.push({
        path,
        action: item.action,
        source: 'skipped',
        index: 'ok',
        satisfied: item.action === 'delete',
        recoverable: false,
        chunksRemoved: removed.chunks,
        chunksCreated: 0,
        embeddingsRemoved: removed.embeddings,
        ...(item.action === 'revise'
          ? { error: `${path}: cannot revise a source that no longer exists` }
          : {}),
      })
      continue
    }

    const currentHash = hashText(file.content)
    if (item.contentHash !== null && currentHash !== item.contentHash) {
      const msg = `${path}: source changed since the plan was reviewed (stale plan) — refusing`
      errors.push(msg)
      results.push({
        path,
        action: item.action,
        source: 'failed',
        index: 'skipped',
        satisfied: false,
        recoverable: false,
        chunksRemoved: 0,
        chunksCreated: 0,
        embeddingsRemoved: 0,
        error: msg,
      })
      continue
    }

    if (item.pinned && !allowPinned) {
      results.push({
        path,
        action: item.action,
        source: 'skipped',
        index: 'skipped',
        satisfied: false,
        recoverable: false,
        chunksRemoved: 0,
        chunksCreated: 0,
        embeddingsRemoved: 0,
        error: `${path}: pinned memory preserved (pass allowPinned to override)`,
      })
      continue
    }

    const recoverable = plan.mode === 'retire'
    let ref: string | null = null
    try {
      if (recoverable) {
        ref = writeRecoveryRecord(vault, path, file.content, plan)
        recoveryRef = recoveryRef ?? ref
      }

      if (item.action === 'revise') {
        const revised = item.revisedContent
        if (!revised) throw new Error('revise item carries no revisedContent')
        vault.write(path, revised)
        const removed = reconcileIndexForPath(db, path)
        const created = reindexPathFromContent(db, vault, path, revised)
        embeddingsPendingBackfill += created
        recordRetirementRow(db, path, currentHash, 'revise', plan.planId, ref)
        succeededRevisions.push(item)
        results.push({
          path,
          action: 'revise',
          source: 'ok',
          index: 'ok',
          satisfied: true,
          recoverable,
          chunksRemoved: removed.chunks,
          chunksCreated: created,
          embeddingsRemoved: removed.embeddings,
        })
      } else {
        vault.remove(path)
        const removed = reconcileIndexForPath(db, path)
        recordRetirementRow(db, path, currentHash, plan.mode, plan.planId, ref)
        succeededDeletes.push(item)
        results.push({
          path,
          action: 'delete',
          source: 'ok',
          index: 'ok',
          satisfied: true,
          recoverable,
          chunksRemoved: removed.chunks,
          chunksCreated: 0,
          embeddingsRemoved: removed.embeddings,
        })
      }
    } catch (err) {
      const msg = `${path}: ${err instanceof Error ? err.message : String(err)}`
      errors.push(msg)
      results.push({
        path,
        action: item.action,
        source: 'failed',
        index: 'failed',
        satisfied: false,
        recoverable: false,
        chunksRemoved: 0,
        chunksCreated: 0,
        embeddingsRemoved: 0,
        error: msg,
      })
    }
  }

  // Managed block — only rules backed by a SUCCEEDED item may move.
  const managed = applyManagedBlockChanges({
    plan,
    succeededDeletes,
    succeededRevisions,
  })
  if (managed.error) errors.push(managed.error)

  // `applied` means every reviewed item reached its approved end state AND the projection step
  // did not fail. A protected (pinned) item that we deliberately did not touch is NOT satisfied,
  // so an apply that preserved it can never report overall success.
  const allSatisfied = results.every((r) => r.satisfied)
  const anySatisfied = results.some((r) => r.satisfied)
  const managedFailed = managed.status === 'failed'
  const applied = allSatisfied && !managedFailed && results.length > 0
  const partial = !applied && (anySatisfied || managed.status === 'ok')

  log.info(
    {
      planId: plan.planId,
      mode: plan.mode,
      items: results.length,
      applied,
      errors: errors.length,
    },
    'memory deletion apply complete',
  )

  return {
    planId: plan.planId,
    applied,
    partial,
    refused: null,
    recoveryRef,
    items: results,
    managedBlock: {
      status: managed.status,
      rulesRemoved: managed.rulesRemoved,
      rulesRevised: managed.rulesRevised,
      ...(managed.error ? { error: managed.error } : {}),
    },
    embeddingsPendingBackfill,
    errors,
  }
}

interface ManagedBlockOutcome {
  status: StepStatus
  rulesRemoved: number
  rulesRevised: number
  error?: string
}

function applyManagedBlockChanges(args: {
  plan: MemoryDeletionPlan
  succeededDeletes: readonly MemoryDeletionItem[]
  succeededRevisions: readonly MemoryDeletionItem[]
}): ManagedBlockOutcome {
  const { plan, succeededDeletes, succeededRevisions } = args
  const targetPath = plan.managedBlock.path

  const toRemove = new Set<string>()
  for (const item of succeededDeletes) {
    for (const ref of item.managedRules) {
      if (ref.presentInBlock && ref.soleBacker) toRemove.add(ref.text)
    }
  }
  const toRevise = new Map<string, string>()
  for (const item of succeededRevisions) {
    for (const ref of item.managedRules) {
      if (ref.presentInBlock && ref.soleBacker && item.revisedRuleText) {
        toRevise.set(ref.text, item.revisedRuleText)
      }
    }
  }

  if (toRemove.size === 0 && toRevise.size === 0) {
    return { status: 'skipped', rulesRemoved: 0, rulesRevised: 0 }
  }
  if (!existsSync(targetPath)) {
    return {
      status: 'skipped',
      rulesRemoved: 0,
      rulesRevised: 0,
      error: `${targetPath}: instruction file absent — not created by a deletion`,
    }
  }

  const current = readFileSync(targetPath, 'utf-8')
  if (plan.managedBlock.fileHash && hashText(current) !== plan.managedBlock.fileHash) {
    return {
      status: 'failed',
      rulesRemoved: 0,
      rulesRevised: 0,
      error: `${targetPath}: instruction file changed since the plan was reviewed — refusing to write`,
    }
  }

  const rules = parseManagedBlockRules(current)
  let removed = 0
  let revised = 0
  const next: string[] = []
  for (const rule of rules) {
    if (toRemove.has(rule)) {
      removed++
      continue
    }
    const replacement = toRevise.get(rule)
    if (replacement !== undefined) {
      revised++
      next.push(replacement)
      continue
    }
    next.push(rule)
  }

  try {
    writeFileSync(targetPath, rewriteManagedBlockRules(current, next), 'utf-8')
  } catch (err) {
    return {
      status: 'failed',
      rulesRemoved: 0,
      rulesRevised: 0,
      error: `${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  return { status: 'ok', rulesRemoved: removed, rulesRevised: revised }
}

/**
 * Remove every index row for one path, in one transaction.
 *
 * `chunk_embeddings` is a `vec0` virtual table with no foreign key, so it MUST be deleted before
 * its chunks (once the chunk rows are gone the embeddings are unreachable orphans). `chunks_fts`
 * is cleared by the `chunks_ad` trigger and `memory_edges` / `event_nodes` cascade.
 */
function reconcileIndexForPath(
  db: Database.Database,
  path: string,
): { chunks: number; embeddings: number } {
  const footprint = readIndexFootprint(db, path)
  const run = db.transaction(() => {
    db.prepare(
      'DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)',
    ).run(path)
    db.prepare('DELETE FROM chunks WHERE file_path = ?').run(path)
    db.prepare('DELETE FROM vault_files WHERE path = ?').run(path)
  })
  run()
  return { chunks: footprint.chunkCount, embeddings: footprint.embeddingCount }
}

/** Re-chunk a revised file so the index presents the NEW content, never the obsolete clause. */
function reindexPathFromContent(
  db: Database.Database,
  vault: Vault,
  path: string,
  content: string,
): number {
  const file = vault.read(path)
  const mtimeMs = file ? Math.floor(file.mtimeMs) : Date.now()
  const sizeBytes = file ? file.sizeBytes : Buffer.byteLength(content, 'utf-8')
  const chunks = chunkText(content)
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO vault_files (path, mtime_ms, size_bytes, content_hash)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes, content_hash = excluded.content_hash, indexed_at = datetime('now')`,
    ).run(path, mtimeMs, sizeBytes, hashText(content))
    const insert = db.prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const chunk of chunks) {
      insert.run(
        path,
        chunk.index,
        chunk.content,
        chunk.startOffset,
        chunk.endOffset,
        chunk.tokenCount,
      )
    }
  })
  run()
  return chunks.length
}

function recordRetirementRow(
  db: Database.Database,
  path: string,
  contentHash: string,
  mode: string,
  planId: string,
  recoveryRef: string | null,
): void {
  recordRetirement(db, { path, contentHash, mode, planId, recoveryRef })
}

/**
 * Copy the exact bytes into the vault's `archive/` tier. `createVault` excludes `archive` from
 * `listFiles()`, so the recovery copy is never indexed and never retrieved — it is a recovery
 * record, NOT an active memory.
 */
function writeRecoveryRecord(
  vault: Vault,
  path: string,
  content: string,
  plan: MemoryDeletionPlan,
): string {
  const safeName = path.replace(/[\\/]/g, '__')
  const rel = `${RETIRED_DIR.replace(/\\/g, '/')}/${plan.planId}__${safeName}`
  const full = join(vault.rootDir, rel)
  mkdirSync(dirname(full), { recursive: true })
  const header = [
    '<!-- scns-retirement',
    `originalPath: ${path}`,
    `planId: ${plan.planId}`,
    `mode: ${plan.mode}`,
    `retiredAt: ${new Date().toISOString()}`,
    `contentHash: ${hashText(content)}`,
    '-->',
    '',
  ].join('\n')
  writeFileSync(full, header + content, 'utf-8')
  return rel
}

// ── Restore ──────────────────────────────────────────────────────────────────

export interface RestoreOptions {
  readonly vault: Vault
  readonly db: Database.Database
  readonly identity: ProjectMemoryIdentity
  readonly path: string
}

export interface RestoreResult {
  readonly restored: boolean
  readonly path: string
  readonly reason?: string
  /**
   * Restoring the RECORD does not restore its projection. The managed
   * `.github/copilot-instructions.md` block is regenerated from eligible memories by the
   * applicator, so the bullet reappears on the next application pass — not here. Stated
   * explicitly so a caller never reports a half-restore as complete.
   */
  readonly managedBlockNote?: string
  /**
   * Restored chunks carry no vector until the next embedding backfill; the keyword/FTS
   * path is current immediately. Reported so a caller never claims otherwise.
   */
  readonly embeddingsPendingBackfill?: number
}

const MANAGED_BLOCK_RESTORE_NOTE =
  'the record is active again; its managed-instructions bullet is re-projected by the next ' +
  'negative-memory application pass, not by this restore'

/**
 * Restore a RETIRED memory from its recovery record.
 *
 * Refuses when a file already occupies the path: a restore must never overwrite newer content,
 * and a hard-deleted memory has no recovery record by design.
 */
export function restoreRetiredMemory(opts: RestoreOptions): RestoreResult {
  const { vault, db, identity, path: rawPath } = opts
  ensureRetirementTable(db)
  const path = assertInsideVault(identity.vaultRoot, rawPath)

  const row = findRestorableRetirement(db, path)

  if (!row) {
    const priorRestore = db
      .prepare(
        'SELECT restored_at FROM memory_retirements WHERE path = ? AND restored_at IS NOT NULL ORDER BY id DESC LIMIT 1',
      )
      .get(path) as { restored_at: string } | undefined
    return {
      restored: false,
      path,
      reason: priorRestore
        ? `${path} was already restored at ${priorRestore.restored_at} — nothing further to recover`
        : `no retirement record for ${path}`,
    }
  }
  if (!row.recoveryRef) {
    return {
      restored: false,
      path,
      reason: `no recovery record: ${path} was ${row.mode} (unrecoverable by design)`,
    }
  }
  if (vault.read(path) !== null) {
    return {
      restored: false,
      path,
      reason: `a newer file already exists at ${path} — refusing to overwrite it`,
    }
  }

  const full = join(vault.rootDir, row.recoveryRef)
  if (!existsSync(full)) {
    return { restored: false, path, reason: `recovery record missing at ${row.recoveryRef}` }
  }
  const raw = readFileSync(full, 'utf-8')
  const content = raw.replace(/^<!-- scns-retirement[\s\S]*?-->\n\n?/, '')

  markRestored(db, row.id)
  vault.write(path, content)
  const embeddingsPendingBackfill = reindexPathFromContent(db, vault, path, content)
  return {
    restored: true,
    path,
    managedBlockNote: MANAGED_BLOCK_RESTORE_NOTE,
    embeddingsPendingBackfill,
  }
}
