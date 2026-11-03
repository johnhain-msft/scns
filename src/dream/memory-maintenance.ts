/**
 * Memory maintenance / "forgetting" (handoff SIBLING milestone). SCNS's dream cycle
 * CONSOLIDATES (daily→weekly→monthly) but never FORGETS — human memory does both.
 * This adds a tiered, gated, REVERSIBLE access-aware decay phase, mirroring the
 * gated-negative-memory / causal-phase pattern (default-OFF, archive-not-delete).
 *
 * Access-aware "use it or lose it": a low-value-tier file whose gazetteer entities are
 * ALL stale (none retrieved within the staleness window — the D2 retrieval signal in
 * `memory_access`) is a forgetting candidate; a file mentioning any FRESH entity is
 * kept. Curated tiers (MEMORY.md, lessons/, negative/, weekly/, monthly/) are NEVER
 * eligible — only explicitly low-value tiers (default `sessions/` telemetry digests).
 * "Decay" = MOVE to `archive/` (excluded from search/index) — recoverable, never a
 * hard delete of a curated lesson or guardrail.
 */

import type Database from 'better-sqlite3'
import { matchEntities, SCNS_GAZETTEER, type GazetteerEntry } from '../memory/entities/gazetteer.js'
import { staleEntities, accessSignalStats } from '../memory/memory-access.js'

/** Minimal vault surface the maintenance phase needs (injectable for tests). */
export interface MaintenanceVault {
  listFiles: () => ReadonlyArray<{ path: string; mtimeMs: number; sizeBytes: number }>
  read: (path: string) => { content: string } | null
  write: (path: string, content: string) => unknown
  remove: (path: string) => boolean
}

/** Default tiers eligible for forgetting — low long-term value telemetry digests only. */
export const DEFAULT_LOW_VALUE_TIER_PREFIXES: readonly string[] = ['sessions/']

/** Number of dream cycles of non-retrieval before an entity is considered stale. */
export const DEFAULT_STALE_CYCLES = 30

/**
 * Production warm-up guard + throttle for the live maintenance phase. The guard exists
 * because access-aware decay reads `memory_access` (the D2a retrieval signal): until that
 * signal is WARM, every entity looks stale and the phase would archive an entire tier on
 * the very first run (the cold-start coupling bug). These defaults refuse to decay until
 * the loop has accrued real retrievals, throttle how much a single run may archive, and
 * never forget freshly-written files. All are reversible-archive safe.
 */
export const DEFAULT_MAINTENANCE_GUARD = {
  /** Require this many TOTAL accesses in `memory_access` before any decay. */
  minWarmupAccesses: 20,
  /** Require this many DISTINCT accessed entities before any decay. */
  minWarmupEntities: 3,
  /** Never archive more than this many files in a single run. */
  maxArchivePerRun: 500,
  /** Never archive a file younger than this (ms) — protects fresh telemetry. */
  minFileAgeMs: 14 * 86_400_000,
} as const

export interface MaintenanceDeps {
  /** Memory vault DB (holds `memory_access`). */
  readonly db: Database.Database
  readonly vault: MaintenanceVault
  /** Current dream cycle number. */
  readonly cycle: number
  /** Stale if not accessed within this many cycles. Default {@link DEFAULT_STALE_CYCLES}. */
  readonly staleCycles?: number
  /** Only files under these prefixes are eligible. Default {@link DEFAULT_LOW_VALUE_TIER_PREFIXES}. */
  readonly lowValueTierPrefixes?: readonly string[]
  /** Entity vocabulary to evaluate freshness against. Default the SCNS gazetteer. */
  readonly knownEntities?: readonly string[]
  readonly gazetteer?: readonly GazetteerEntry[]
  /** Plan only — archive nothing. */
  readonly dryRun?: boolean
  /**
   * Warm-up guard (opt-in): when {@link minWarmupAccesses} and/or {@link minWarmupEntities}
   * are set, decay NOTHING until the access signal meets BOTH thresholds. Prevents the
   * cold-start "archive the whole tier" before `memory_access` reflects real usage.
   * Omit both ⇒ guard disabled (legacy behavior, used by the focused unit tests).
   */
  readonly minWarmupAccesses?: number
  readonly minWarmupEntities?: number
  /** Cap files archived per run (safety throttle). Omit ⇒ no cap. */
  readonly maxArchivePerRun?: number
  /** Only archive files at least this old (ms). Omit ⇒ no age filter. */
  readonly minFileAgeMs?: number
  /** Injectable clock for the age cutoff (default {@link Date.now}). */
  readonly now?: number
}

export interface DecayCandidate {
  readonly path: string
  readonly reason: 'only-stale-entities' | 'no-live-entities'
  readonly archivePath: string
}

export interface MaintenancePlan {
  readonly cycle: number
  readonly staleBeforeCycle: number
  readonly scanned: number
  readonly decayCandidates: readonly DecayCandidate[]
  /** Whether the access signal met the warm-up guard (true when the guard is disabled). */
  readonly accessSignalWarm: boolean
  /** Set when the plan archived nothing because the access signal was still cold. */
  readonly skippedReason?: 'cold-access-signal'
}

export interface MaintenanceResult {
  readonly plan: MaintenancePlan
  readonly archived: readonly string[]
  readonly archivedCount: number
  readonly dryRun: boolean
}

function gazetteerCanonicals(gazetteer: readonly GazetteerEntry[]): string[] {
  return gazetteer.map((g) => g.canonical)
}

function isEligible(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => path.startsWith(p))
}

/**
 * Identify forgetting candidates WITHOUT mutating anything: low-value-tier files whose
 * gazetteer entities are all stale (or that mention no live entity). Curated/other tiers
 * are not scanned. Pure read of the vault + `memory_access`.
 */
export function planMemoryMaintenance(deps: MaintenanceDeps): MaintenancePlan {
  const staleCycles = deps.staleCycles ?? DEFAULT_STALE_CYCLES
  const prefixes = deps.lowValueTierPrefixes ?? DEFAULT_LOW_VALUE_TIER_PREFIXES
  const gazetteer = deps.gazetteer ?? SCNS_GAZETTEER
  const known = deps.knownEntities ?? gazetteerCanonicals(gazetteer)
  const staleBeforeCycle = deps.cycle - staleCycles

  // Warm-up guard (opt-in): until the D2a retrieval signal (`memory_access`) has accrued
  // real usage, EVERY entity looks stale and the phase would archive an entire tier on the
  // first run. When a threshold is configured and unmet, decay nothing this cycle.
  const guardEnabled = deps.minWarmupAccesses != null || deps.minWarmupEntities != null
  if (guardEnabled) {
    const stats = accessSignalStats(deps.db)
    const warm =
      stats.totalAccesses >= (deps.minWarmupAccesses ?? 0) &&
      stats.distinctEntities >= (deps.minWarmupEntities ?? 0)
    if (!warm) {
      return {
        cycle: deps.cycle,
        staleBeforeCycle,
        scanned: 0,
        decayCandidates: [],
        accessSignalWarm: false,
        skippedReason: 'cold-access-signal',
      }
    }
  }

  const staleSet = new Set(staleEntities(deps.db, known, staleBeforeCycle))
  const now = deps.now ?? Date.now()
  const minFileAgeMs = deps.minFileAgeMs

  const decayCandidates: DecayCandidate[] = []
  let scanned = 0
  for (const file of deps.vault.listFiles()) {
    if (!isEligible(file.path, prefixes)) continue
    scanned++
    // Age cutoff: never forget freshly-written telemetry (a transient gap in the access
    // signal must not evict something just created).
    if (minFileAgeMs != null && now - file.mtimeMs < minFileAgeMs) continue
    const content = deps.vault.read(file.path)?.content ?? ''
    const entities = matchEntities(content, gazetteer).map((m) => m.canonical)

    // Keep the file if ANY mentioned entity is still fresh (recently retrieved).
    const hasFreshEntity = entities.some((e) => !staleSet.has(e))
    if (hasFreshEntity) continue

    decayCandidates.push({
      path: file.path,
      reason: entities.length === 0 ? 'no-live-entities' : 'only-stale-entities',
      archivePath: `archive/decayed/${file.path}`,
    })
  }

  // Throttle: cap how much a single run may archive (reversible, but gradual is safer).
  const capped =
    deps.maxArchivePerRun != null
      ? decayCandidates.slice(0, deps.maxArchivePerRun)
      : decayCandidates

  return { cycle: deps.cycle, staleBeforeCycle, scanned, decayCandidates: capped, accessSignalWarm: true }
}

/**
 * Plan + (unless dryRun) reversibly archive each decay candidate by moving it under
 * `archive/` (excluded from search/index) — the original is removed but its content is
 * recoverable. Never hard-deletes; never touches curated tiers.
 */
export function executeMemoryMaintenance(deps: MaintenanceDeps): MaintenanceResult {
  const plan = planMemoryMaintenance(deps)
  if (deps.dryRun) {
    return { plan, archived: [], archivedCount: 0, dryRun: true }
  }

  const archived: string[] = []
  for (const c of plan.decayCandidates) {
    const file = deps.vault.read(c.path)
    if (!file) continue
    deps.vault.write(c.archivePath, file.content)
    deps.vault.remove(c.path)
    archived.push(c.path)
  }

  return { plan, archived, archivedCount: archived.length, dryRun: false }
}
