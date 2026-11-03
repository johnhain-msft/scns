/**
 * Manual, session-aware memory pruning (#73) — the operation behind `scns memory prune`.
 *
 * Composes the pieces rather than reimplementing them: the meta registry resolves which project
 * owns a directory, {@link buildWorkContextSnapshot} gathers the evidence, the pruning evaluator
 * proposes, deterministic guards decide, and the shared #71 deletion primitive executes.
 *
 * Two rules shape the whole flow.
 *
 * **Preview is the product.** A preview is read-only and produces a reviewable plan. `apply`
 * consumes THAT plan — it never re-runs the evaluator, so what a human approved is exactly what
 * runs, and a plan that has gone stale is refused rather than silently re-derived.
 *
 * **One writer.** A project's vault is written by its own broker. When that broker is live the
 * CLI must not open a second writable connection and run an independent reindex against it; this
 * module reports that condition (`brokerLive`) so the caller can delegate or refuse instead of
 * racing. When no broker is running there is no second writer, and local execution is safe.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { openMemoryDb, EVENT_NODE_PATH_PREFIX } from './db.js'
import { createVault, type Vault } from './vault.js'
import { createNegativeMemoryStore } from './negative-memory-store.js'
import { NEGATIVE_MEMORY_SCAN_LIMIT } from './negative-memory-applicator.js'
import {
  applyMemoryDeletion,
  previewMemoryDeletion,
  buildRuleBackers,
  parseManagedBlockRules,
  INSTRUCTIONS_RELATIVE_PATH,
  type MemoryDeletionPlan,
  type MemoryDeletionResult,
  type MemoryDeletionTarget,
  type ProjectMemoryIdentity,
} from './memory-deletion.js'
import {
  evaluatePruningCandidates,
  NULL_PRUNING_PROVIDER,
  recheckDecision,
  type PruningCandidate,
  type PruningDecision,
  type PruningProvider,
} from './pruning-evaluator.js'
import { buildWorkContextSnapshot, type WorkContextSnapshot } from './work-context.js'
import { resolveScnsHome } from '../shared/scns-home.js'
import { resolveProjectForPath, type ProjectRow } from '../meta-broker/registry.js'
import { ValidationError } from '../shared/errors.js'
import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'pruning-runner' })

/** Vault tier holding negative memories — the tier this command prunes. */
const NEGATIVE_PREFIX = 'negative/'

export interface ResolvedProjectMemory {
  readonly identity: ProjectMemoryIdentity
  readonly brokerDbPath: string
  readonly status: string
  readonly boundPort: number | null
  /** True when the registry says a broker process is currently serving this project. */
  readonly brokerLive: boolean
}

export interface ResolveProjectMemoryOptions {
  readonly directory: string
  /** Meta registry path. Defaults to `<SCNS_HOME>/.scns/meta-broker.db`. */
  readonly metaDbPath?: string
  /** Per-project broker DB dir. Defaults to `~/.session-broker/projects`. */
  readonly projectDbDir?: string
}

/**
 * Resolve which registered project owns a directory, and where its memory lives.
 *
 * Uses the registry's deepest-root rule, so a nested project is never served by its parent. A
 * directory with no registration throws: falling back to the global vault would point a deletion
 * at the wrong store entirely.
 */
export function resolveProjectMemory(opts: ResolveProjectMemoryOptions): ResolvedProjectMemory {
  const directory = resolve(opts.directory)
  const metaDbPath = opts.metaDbPath ?? join(resolveScnsHome(), '.scns', 'meta-broker.db')
  const projectDbDir = opts.projectDbDir ?? join(homedir(), '.session-broker', 'projects')

  if (!existsSync(metaDbPath)) {
    throw new ValidationError(
      `no project registry at ${metaDbPath} — cannot resolve which project owns ${directory}`,
    )
  }

  const db = new Database(metaDbPath, { readonly: true, fileMustExist: true })
  let row: ProjectRow | null
  try {
    row = resolveProjectForPath(db, directory)
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }

  if (!row) {
    throw new ValidationError(
      `${directory} is not inside any registered SCNS project — refusing to fall back to the global vault`,
    )
  }

  const home = join(projectDbDir, row.projectId, 'home')
  const vaultRoot = join(home, '.scns', 'memory')
  return {
    identity: {
      projectId: row.projectId,
      projectRoot: row.projectRoot,
      instanceId: row.instanceId,
      vaultRoot,
      dbPath: join(vaultRoot, 'vault.db'),
    },
    brokerDbPath: join(projectDbDir, row.projectId, 'data.db'),
    status: row.status,
    boundPort: row.boundPort,
    brokerLive: row.status === 'running' && row.boundPort !== null,
  }
}

// ── Plan ─────────────────────────────────────────────────────────────────────

export interface PruningPlan {
  readonly schemaVersion: 1
  readonly kind: 'scns-memory-pruning-plan'
  readonly createdAt: string
  readonly directory: string
  readonly project: ProjectMemoryIdentity
  readonly brokerStatus: string
  readonly evidence: {
    readonly completeness: WorkContextSnapshot['completeness']
    readonly capturedAt: string
    readonly liveSessions: readonly string[]
    readonly openTaskIds: readonly number[]
    readonly closedTaskIds: readonly number[]
    readonly unreadMessageIds: readonly string[]
    /** Unread messages the broker can no longer attribute to any session. */
    readonly orphanedMessageIds: readonly string[]
    /** File intents whose holding session row is gone. */
    readonly orphanedIntentPaths: readonly string[]
    /** Tasks read from the broker whose owning project could not be determined. */
    readonly orphanedTaskIds: readonly number[]
    /** Attributable coordination excluded by scope (archived / another project). */
    readonly scopedOutCoordination: WorkContextSnapshot['scopedOutCoordination']
    readonly humanTurnCount: number
  }
  readonly counts: {
    readonly inventoried: number
    readonly keep: number
    readonly retire: number
    readonly revise: number
    readonly uncertain: number
    readonly pinned: number
  }
  /** Union of vault files, indexed paths and managed Markdown, with each orphan type explained. */
  readonly inventory: MemoryRecordInventory
  readonly decisions: readonly PruningDecision[]
  /** Exactly what `apply` would execute. Empty when nothing was actionable. */
  readonly deletion: MemoryDeletionPlan | null
  readonly evaluator: {
    readonly configured: boolean
    readonly failed: boolean
    readonly error: string | null
    readonly downgraded: number
  }
  readonly warnings: readonly string[]
}

export interface MemoryPruningServiceOptions {
  readonly vault: Vault
  readonly db: Database.Database
  readonly identity: ProjectMemoryIdentity
  readonly brokerDbPath: string
  readonly brokerStatus?: string
  readonly provider?: PruningProvider
  readonly transcriptPath?: string
}

/** Read the negative-memory tier as evaluator candidates (no page cap — see NEGATIVE_MEMORY_SCAN_LIMIT). */
export function inventoryCandidates(vault: Vault): readonly PruningCandidate[] {
  const store = createNegativeMemoryStore(vault)
  return store.list({ limit: NEGATIVE_MEMORY_SCAN_LIMIT }).map((m) => ({
    path: `${NEGATIVE_PREFIX}${m.id}.md`,
    memoryId: m.id,
    rule: m.criticVerdict?.status === 'revise' && m.criticVerdict.revisedRule
      ? m.criticVerdict.revisedRule
      : m.dontRule,
    body: m.originalText,
    category: m.category,
    sessionId: m.sessionId,
    createdAt: m.createdAt,
    pinned: Boolean(m.pinned),
    criticStatus: m.criticVerdict?.status ?? null,
  }))
}

// ── Record inventory (plan §2) ───────────────────────────────────────────────

/**
 * Where a record is present. `fully-matched` is the healthy case; the other three are the orphan
 * types the plan requires be EXPLAINED rather than merely survived.
 */
export type MemoryRecordClass =
  | 'fully-matched'
  | 'file-only'
  | 'index-only'
  | 'projection-only'

export interface MemoryRecordEntry {
  /** Vault-relative path, or `null` for a projected rule with no backing record. */
  readonly path: string | null
  /** Managed-block rule text, when this record projects one (or IS only a projection). */
  readonly rule: string | null
  readonly recordClass: MemoryRecordClass
  readonly file: boolean
  readonly index: boolean
  readonly projection: boolean
  /** Why this record is an orphan, in words — empty for `fully-matched`. */
  readonly explanation: string
}

export interface MemoryRecordInventory {
  readonly counts: Readonly<Record<MemoryRecordClass, number>>
  readonly records: readonly MemoryRecordEntry[]
  /** Every record whose stores disagree. A `fully-matched` record is never here. */
  readonly orphans: readonly MemoryRecordEntry[]
  /** Synthetic `event-nodes/*` index rows — owned by the dream slow-path, never orphan files. */
  readonly syntheticEventNodePaths: readonly string[]
  /** The managed instruction file is absent. Reported, never created. */
  readonly instructionsFileMissing: boolean
}

const EMPTY_CLASS_COUNTS: Record<MemoryRecordClass, number> = {
  'fully-matched': 0,
  'file-only': 0,
  'index-only': 0,
  'projection-only': 0,
}

/**
 * Inventory the union of canonical vault files, indexed paths and managed Markdown (plan §2).
 *
 * The union is the point. {@link inventoryCandidates} enumerates the negative tier by reading
 * FILES, so a record that exists only in the index is invisible to it — you cannot find a record
 * missing from the very store you enumerated. Reconciling the three stores against each other is
 * what makes each orphan type visible and explainable.
 *
 * Synthetic `event-nodes/*` rows have no on-disk file BY DESIGN, so they are held out of the
 * classification entirely and reported separately rather than counted as index-only orphans.
 */
export function inventoryRecords(
  vault: Vault,
  db: Database.Database,
  identity: ProjectMemoryIdentity,
): MemoryRecordInventory {
  const filePaths = new Set(vault.listFiles().map((f) => f.path))

  const indexedPaths = new Set<string>()
  const syntheticEventNodePaths = new Set<string>()
  const noteIndexed = (path: string | null | undefined) => {
    if (!path) return
    if (path.startsWith(EVENT_NODE_PATH_PREFIX)) syntheticEventNodePaths.add(path)
    else indexedPaths.add(path)
  }
  for (const r of db.prepare('SELECT path FROM vault_files').all() as Array<{ path: string }>) {
    noteIndexed(r.path)
  }
  for (const r of db.prepare('SELECT DISTINCT file_path FROM chunks').all() as Array<{
    file_path: string
  }>) {
    noteIndexed(r.file_path)
  }

  const instructionsPath = join(identity.projectRoot, INSTRUCTIONS_RELATIVE_PATH)
  const instructionsFileMissing = !existsSync(instructionsPath)
  const blockRules = instructionsFileMissing
    ? []
    : parseManagedBlockRules(readFileSync(instructionsPath, 'utf-8'))

  // rule text → the record paths that currently project it (critic revision wins).
  const backers = buildRuleBackers(vault)
  const projectedBy = new Map<string, string[]>()
  for (const rule of blockRules) {
    for (const id of backers.get(rule) ?? []) {
      const path = `${NEGATIVE_PREFIX}${id}.md`
      projectedBy.set(path, [...(projectedBy.get(path) ?? []), rule])
    }
  }

  const records: MemoryRecordEntry[] = []
  for (const path of [...new Set([...filePaths, ...indexedPaths])].sort()) {
    const file = filePaths.has(path)
    const index = indexedPaths.has(path)
    const rule = projectedBy.get(path)?.[0] ?? null
    const projection = rule !== null
    let recordClass: MemoryRecordClass
    let explanation = ''
    if (file && index) {
      recordClass = 'fully-matched'
    } else if (file) {
      recordClass = 'file-only'
      explanation =
        'a canonical vault file with no index rows — it is not retrievable until the next index pass'
    } else {
      recordClass = 'index-only'
      explanation =
        'index rows with no canonical vault file — the record can still be retrieved, but its ' +
        'source is gone; it self-heals on the next index pass'
    }
    records.push({ path, rule, recordClass, file, index, projection, explanation })
  }

  // A projected rule that nothing backs exists only in the managed Markdown.
  for (const rule of blockRules) {
    const backed = [...(backers.get(rule) ?? [])].some((id) =>
      filePaths.has(`${NEGATIVE_PREFIX}${id}.md`) || indexedPaths.has(`${NEGATIVE_PREFIX}${id}.md`),
    )
    if (backed) continue
    records.push({
      path: null,
      rule,
      recordClass: 'projection-only',
      file: false,
      index: false,
      projection: true,
      explanation:
        'a rule in the managed instruction block with no backing record — it keeps being injected ' +
        'though nothing in the vault or index supports it',
    })
  }

  const counts = { ...EMPTY_CLASS_COUNTS }
  for (const r of records) counts[r.recordClass] += 1

  return {
    counts,
    records,
    orphans: records.filter((r) => r.recordClass !== 'fully-matched'),
    syntheticEventNodePaths: [...syntheticEventNodePaths].sort(),
    instructionsFileMissing,
  }
}

export function createMemoryPruningService(opts: MemoryPruningServiceOptions) {
  const { vault, db, identity, brokerDbPath, provider = NULL_PRUNING_PROVIDER } = opts

  async function preview(): Promise<PruningPlan> {
    const warnings: string[] = []
    const candidates = inventoryCandidates(vault)
    const inventory = inventoryRecords(vault, db, identity)
    if (inventory.orphans.length > 0) {
      warnings.push(
        `${inventory.orphans.length} orphaned record(s): ` +
          inventory.orphans
            .map((r) => `${r.path ?? r.rule} (${r.recordClass})`)
            .join(', '),
      )
    }
    if (inventory.instructionsFileMissing) {
      warnings.push(
        `no managed instruction file at ${join(identity.projectRoot, INSTRUCTIONS_RELATIVE_PATH)} — ` +
          'reported, not created',
      )
    }
    const snapshot = buildWorkContextSnapshot({
      projectId: identity.projectId,
      projectRoot: identity.projectRoot,
      brokerDbPath,
      ...(opts.transcriptPath ? { transcriptPath: opts.transcriptPath } : {}),
    })

    if (snapshot.completeness.level !== 'complete') {
      warnings.push(
        `work evidence is ${snapshot.completeness.level}: ${snapshot.completeness.gaps.join('; ')} — ` +
          'nothing will be retired on the strength of what could not be observed',
      )
    }
    if (provider === NULL_PRUNING_PROVIDER) {
      warnings.push(
        'no pruning evaluator is configured — every unpinned memory is reported as uncertain, not kept',
      )
    }

    const evaluation = await evaluatePruningCandidates({ candidates, snapshot, provider })
    if (evaluation.evaluatorFailed) {
      warnings.push(`the evaluator failed (${evaluation.providerError}) — no memory was assessed`)
    }

    const targets: MemoryDeletionTarget[] = []
    for (const d of evaluation.decisions) {
      if (d.verdict === 'retire') {
        targets.push({ path: d.path, action: 'delete', reason: d.rationale })
      } else if (d.verdict === 'revise' && d.revisedRule) {
        targets.push({
          path: d.path,
          action: 'revise',
          revisedRule: d.revisedRule,
          ...(d.revisedBody ? { revisedBody: d.revisedBody } : {}),
          reason: d.rationale,
        })
      }
    }

    const deletion =
      targets.length > 0
        ? previewMemoryDeletion({ vault, db, identity, targets, mode: 'retire' })
        : null
    if (deletion) warnings.push(...deletion.warnings)

    const counts = {
      inventoried: candidates.length,
      keep: evaluation.decisions.filter((d) => d.verdict === 'keep').length,
      retire: evaluation.decisions.filter((d) => d.verdict === 'retire').length,
      revise: evaluation.decisions.filter((d) => d.verdict === 'revise').length,
      uncertain: evaluation.decisions.filter((d) => d.verdict === 'uncertain').length,
      pinned: candidates.filter((c) => c.pinned).length,
    }
    log.info(
      { projectId: identity.projectId, ...counts, orphans: inventory.orphans.length },
      'pruning preview complete',
    )

    return {
      schemaVersion: 1,
      kind: 'scns-memory-pruning-plan',
      createdAt: new Date().toISOString(),
      directory: identity.projectRoot,
      project: identity,
      brokerStatus: opts.brokerStatus ?? 'unknown',
      evidence: {
        completeness: snapshot.completeness,
        capturedAt: snapshot.capturedAt,
        liveSessions: snapshot.activeSessionIds,
        openTaskIds: snapshot.openTasks.map((t) => t.id),
        closedTaskIds: snapshot.completedTasks.map((t) => t.id),
        unreadMessageIds: snapshot.unreadMessages.map((m) => m.id),
        orphanedMessageIds: snapshot.orphanedMessages.map((m) => m.id),
        orphanedIntentPaths: snapshot.orphanedIntents.map((i) => i.filePath),
        orphanedTaskIds: snapshot.orphanedTasks.map((t) => t.id),
        scopedOutCoordination: snapshot.scopedOutCoordination,
        humanTurnCount: snapshot.humanTurns.length,
      },
      counts,
      inventory,
      decisions: evaluation.decisions,
      deletion,
      evaluator: {
        configured: provider !== NULL_PRUNING_PROVIDER,
        failed: evaluation.evaluatorFailed,
        error: evaluation.providerError,
        downgraded: evaluation.downgraded,
      },
      warnings,
    }
  }

  /**
   * Execute the reviewed plan. Never re-decides — but it does re-CHECK.
   *
   * The deletion primitive verifies that the reviewed BYTES are unchanged. That is not the same
   * as verifying the reviewed PREMISES: a retirement justified by "that coordination ended" is
   * invalidated when the peer sends a message an hour later, even though every file hash still
   * matches. So the work snapshot is recaptured under the lease and the same guards are re-run
   * against it; any decision that no longer stands is dropped from the plan before execution.
   */
  function apply(plan: PruningPlan): MemoryDeletionResult {
    if (plan.kind !== 'scns-memory-pruning-plan' || plan.schemaVersion !== 1) {
      throw new ValidationError('not a supported scns-memory-pruning-plan v1')
    }
    if (!plan.deletion) {
      return refusedResult(
        'the reviewed plan contains no retire or revise decisions — nothing to apply',
      )
    }

    return withVaultLease(identity.vaultRoot, () => {
      const recheck = recheckPremises(plan)
      if (recheck.invalidated.length > 0 && recheck.stillValid.length === 0) {
        return {
          ...refusedResult(
            'every reviewed decision was invalidated by work evidence that changed since the preview',
          ),
          errors: recheck.invalidated,
        }
      }

      const deletion =
        recheck.invalidated.length === 0
          ? plan.deletion!
          : {
              ...plan.deletion!,
              items: plan.deletion!.items.filter((i) => recheck.stillValid.includes(i.path)),
            }

      const result = applyMemoryDeletion({ vault, db, identity, plan: deletion })
      if (recheck.invalidated.length === 0) return result
      // Some reviewed work did not happen, so this is not a complete apply.
      return {
        ...result,
        applied: false,
        partial: true,
        errors: [...result.errors, ...recheck.invalidated],
      }
    })
  }

  function refusedResult(reason: string): MemoryDeletionResult {
    return {
      planId: 'none',
      applied: false,
      partial: false,
      refused: reason,
      recoveryRef: null,
      items: [],
      managedBlock: { status: 'skipped', rulesRemoved: 0, rulesRevised: 0 },
      embeddingsPendingBackfill: 0,
      errors: [],
    }
  }

  /** Re-run the decision guards against a FRESH snapshot taken under the lease. */
  function recheckPremises(plan: PruningPlan): {
    stillValid: string[]
    invalidated: string[]
  } {
    const snapshot = buildWorkContextSnapshot({
      projectId: identity.projectId,
      projectRoot: identity.projectRoot,
      brokerDbPath,
      ...(opts.transcriptPath ? { transcriptPath: opts.transcriptPath } : {}),
    })
    const candidates = inventoryCandidates(vault)
    const byId = new Map(candidates.map((c) => [c.memoryId, c]))

    const stillValid: string[] = []
    const invalidated: string[] = []
    for (const decision of plan.decisions) {
      if (decision.verdict !== 'retire' && decision.verdict !== 'revise') continue
      const candidate = byId.get(decision.memoryId)
      if (!candidate) {
        // The record is already gone; the deletion primitive reports that per item.
        stillValid.push(decision.path)
        continue
      }
      const recheck = recheckDecision({ decision, candidate, snapshot })
      if (recheck.stands) {
        stillValid.push(decision.path)
      } else {
        invalidated.push(`${decision.path}: ${recheck.reason}`)
      }
    }
    return { stillValid, invalidated }
  }

  return { preview, apply }
}

export type MemoryPruningService = ReturnType<typeof createMemoryPruningService>

// ── Cross-process lease ──────────────────────────────────────────────────────

/**
 * Serialize mutations of one project's memory across PROCESSES.
 *
 * `withIndexingLock` is process-local, which is not enough here: the CLI, the broker and a dream
 * pass are separate processes over the same vault. `wx` creation is atomic on both NTFS and POSIX,
 * so the first writer wins and a second refuses loudly rather than interleaving a delete with a
 * re-index. A lease older than {@link LEASE_STALE_MS} is treated as abandoned (a crashed holder
 * must not block the vault forever).
 */
export const LEASE_STALE_MS = 10 * 60 * 1000

export function withVaultLease<T>(vaultRoot: string, fn: () => T): T {
  const leasePath = join(vaultRoot, '.prune-lease')
  mkdirSync(vaultRoot, { recursive: true })

  let fd: number
  try {
    fd = openSync(leasePath, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    let holder = '(unreadable)'
    let stale = false
    try {
      const raw = JSON.parse(readFileSync(leasePath, 'utf-8')) as { pid?: number; at?: string }
      holder = `pid ${raw.pid ?? '?'} since ${raw.at ?? '?'}`
      stale = raw.at !== undefined && Date.now() - Date.parse(raw.at) > LEASE_STALE_MS
    } catch {
      stale = true
    }
    if (!stale) {
      throw new ValidationError(
        `another process holds the memory mutation lease for ${vaultRoot} (${holder}) — refusing to write concurrently`,
      )
    }
    unlinkSync(leasePath)
    fd = openSync(leasePath, 'wx')
  }

  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  } catch {
    /* the lease's existence is what matters, not its contents */
  }

  try {
    return fn()
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* already closed */
    }
    try {
      unlinkSync(leasePath)
    } catch {
      /* already removed */
    }
  }
}

// ── Convenience wiring ───────────────────────────────────────────────────────

export interface OpenProjectMemoryResult {
  readonly resolved: ResolvedProjectMemory
  readonly vault: Vault
  readonly db: Database.Database
  readonly close: () => void
}

/** Open a resolved project's vault + memory DB. The caller owns `close()`. */
export function openProjectMemory(resolved: ResolvedProjectMemory): OpenProjectMemoryResult {
  const vault = createVault({ rootDir: resolved.identity.vaultRoot })
  const db = openMemoryDb(resolved.identity.dbPath)
  return {
    resolved,
    vault,
    db,
    close: () => {
      try {
        db.close()
      } catch {
        /* already closed */
      }
    },
  }
}

/** Human-readable rendering of a plan for terminal review. */
export function formatPruningPlan(plan: PruningPlan): string {
  const lines: string[] = []
  lines.push(`Project      ${plan.project.projectId}`)
  lines.push(`Root         ${plan.project.projectRoot}`)
  lines.push(`Vault        ${plan.project.vaultRoot}`)
  lines.push(`Broker       ${plan.brokerStatus}`)
  lines.push(`Evidence     ${plan.evidence.completeness.level}`)
  for (const gap of plan.evidence.completeness.gaps) lines.push(`             gap: ${gap}`)
  lines.push(
    `Memories     ${plan.counts.inventoried} inventoried  ` +
      `keep=${plan.counts.keep} retire=${plan.counts.retire} revise=${plan.counts.revise} ` +
      `uncertain=${plan.counts.uncertain} pinned=${plan.counts.pinned}`,
  )
  const inv = plan.inventory
  lines.push(
    `Records      ${inv.counts['fully-matched']} fully-matched  ` +
      `file-only=${inv.counts['file-only']} index-only=${inv.counts['index-only']} ` +
      `projection-only=${inv.counts['projection-only']}` +
      (inv.syntheticEventNodePaths.length > 0
        ? `  (+${inv.syntheticEventNodePaths.length} synthetic event-node path(s), not orphans)`
        : ''),
  )
  if (inv.orphans.length > 0) {
    lines.push(`Orphans      ${inv.orphans.length} record(s) whose stores disagree:`)
    for (const r of inv.orphans) {
      lines.push(`  [${r.recordClass}] ${r.path ?? r.rule}`)
      lines.push(`     ${r.explanation}`)
    }
  }
  if (inv.instructionsFileMissing) {
    lines.push('Instructions no managed instruction file — reported, not created')
  }
  if (!plan.evaluator.configured) {
    lines.push('Evaluator    not configured — no memory was assessed')
  } else if (plan.evaluator.failed) {
    lines.push(`Evaluator    FAILED: ${plan.evaluator.error}`)
  } else if (plan.evaluator.downgraded > 0) {
    lines.push(
      `Evaluator    ${plan.evaluator.downgraded} destructive proposal(s) downgraded to uncertain by policy`,
    )
  }

  for (const w of plan.warnings) lines.push(`Warning      ${w}`)

  const actionable = plan.decisions.filter(
    (d) => d.verdict === 'retire' || d.verdict === 'revise',
  )
  if (actionable.length === 0) {
    lines.push('', 'No memory is proposed for removal or revision.')
  } else {
    lines.push('', 'Proposed changes:')
    for (const d of actionable) {
      lines.push(`  [${d.verdict}] ${d.path} (${d.applicability})`)
      lines.push(`     reason: ${d.rationale}`)
      if (d.evidenceRefs.length > 0) lines.push(`     evidence: ${d.evidenceRefs.join(', ')}`)
      if (d.revisedRule) lines.push(`     becomes: ${d.revisedRule}`)
    }
  }

  const uncertain = plan.decisions.filter((d) => d.verdict === 'uncertain')
  if (uncertain.length > 0) {
    lines.push('', `Left unchanged because applicability could not be established (${uncertain.length}):`)
    for (const d of uncertain.slice(0, 20)) {
      lines.push(`  ${d.path}: ${d.rationale}`)
    }
    if (uncertain.length > 20) lines.push(`  … and ${uncertain.length - 20} more`)
  }

  if (plan.deletion) {
    const mb = plan.deletion.managedBlock
    lines.push('', `Managed instructions: ${mb.path}`)
    lines.push(
      `  exists=${mb.exists} block=${mb.blockPresent} remove=${mb.removedRules.length} revise=${mb.revisedRules.length} unmatched=${mb.unmatchedRules.length}`,
    )
  }

  return lines.join('\n')
}
