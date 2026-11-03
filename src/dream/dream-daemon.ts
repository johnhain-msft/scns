/**
 * AutoDream daemon — orchestrates the full consolidation cycle.
 *
 * Uses its own SQLite database for dream state (separate from the broker DB).
 * Uses the filesystem vault for MEMORY.md and daily log access.
 */

import type { DreamGateConfig, DreamGateResult } from './dream-gates.js'
import type { ConsolidationResult } from './consolidation.js'
import { checkDreamGates, DEFAULT_DREAM_GATE_CONFIG } from './dream-gates.js'
import {
  getDreamState,
  recordDreamRun,
  acquireDreamLock,
  releaseDreamLock,
  incrementSessionCount,
} from './dream-state.js'
import { extractFromMultipleLogs, synthesizeEntry, fixTypos } from './extraction.js'
import { runConsolidation } from './consolidation.js'
import { parseMemoryMd, serializeMemoryMd, resynthesizeMemoryEntries } from './memory-entries.js'
import { runHousekeeping, DEFAULT_HOUSEKEEPING_CONFIG } from './housekeeping.js'
import { applyNegativeMemories } from '../memory/negative-memory-applicator.js'
import { runShadowNegativeMemoryEval } from './shadow-negative-memory-eval.js'
import { runGatedNegativeMemoryApplyLive } from '../memory/gated-negative-memory-runner.js'
import { runCausalEdgeInference } from '../memory/causal-runner.js'
import type { CausalProvider } from '../memory/causal-provider.js'
import { segmentStructuredEvents } from './event-segmenter.js'
import { writeEventNodes } from '../memory/event-nodes.js'
import { runNegativeMemoryCritic } from '../memory/negative-memory-critic.js'
import { createVault } from '../memory/vault.js'
import { createArchiveStore } from '../memory/archive-store.js'
import { generateCoreFiles } from '../memory/core-file-generator.js'
import { initConsolidationState, createConsolidationScheduler } from './consolidation-scheduler.js'
import {
  runWeeklyConsolidation,
  runMonthlyConsolidation,
} from './tiered-consolidation.js'
import { openDreamDatabase } from './dream-schema.js'
import { logger } from '../shared/logger.js'
import { InvalidStateError } from '../shared/errors.js'

// ── Public interfaces ──────────────────────────────────────────────

export interface DreamDaemonConfig {
  readonly vaultRootDir: string
  readonly dbPath: string
  readonly gateConfig?: Partial<DreamGateConfig>
  readonly dryRun?: boolean
  /** Optional broker DB for housekeeping (prune OTel, events) */
  readonly brokerDb?: import('better-sqlite3').Database
  /** Project root for negative memory application (defaults to cwd) */
  readonly projectRoot?: string
  /**
   * Opt-in, default-OFF (env `SCNS_GATED_NEG_MEM_SHADOW=1`). When true, after the
   * blind applicator runs, also run the gated applicator in a throwaway shadow
   * temp dir (seeded with a copy of the live instructions file) to log what the
   * non-regression gate WOULD adopt/reject. NEVER mutates the live file.
   */
  readonly gatedNegativeMemoriesShadow?: boolean
  /**
   * Default-ON via the CLI wiring (opt out with env `SCNS_GATED_NEG_MEM_LIVE=0`).
   * When true, the live negative-memory self-edit is routed through the per-rule
   * non-regression gate (wedge C, `runGatedNegativeMemoryApplyLive`) instead of the
   * blind applicator. Under the default Mock backend the runner REFUSES to mutate
   * the target (a fake/inert signal must never edit the live guardrails); a real
   * measured gate requires `SCNS_GATED_NEG_MEM_LIVE_ACP=1` — a HARD-STOP agent
   * spawn. Set to false ⇒ the blind path runs exactly as before (byte-identical).
   */
  readonly gatedNegativeMemoriesLive?: boolean
  /**
   * Memory vault DB handle for the M1.3 causal-edge phase (design-m1.md §5). The
   * daemon otherwise only touches its own dream DB + the filesystem vault, so this
   * is supplied separately (like {@link brokerDb}). Absent ⇒ the causal phase is
   * skipped (the default, and prod today).
   */
  readonly memoryDb?: import('better-sqlite3').Database
  /**
   * Default-OFF (M1.3). When true AND {@link memoryDb} is present, runs the gated
   * causal-edge inference phase in the slow path. The phase is itself default-OFF:
   * without an injected provider / `SCNS_DREAM_CAUSAL_ACP=1` + factory it uses the
   * null provider (zero edges, zero writes). It writes ONLY to `memory_causal` —
   * NEVER to guardrail files (issue-#5 precedent). Unset ⇒ byte-identical to today.
   */
  readonly causalEdgeInference?: boolean
  /** Injectable causal provider (tests). Default: env-gated/null inside the runner. */
  readonly causalProvider?: CausalProvider
  /** Injectable factory for the runner's env-gated real ACP provider (HARD-STOP spawn). */
  readonly makeCausalAcpProvider?: () => CausalProvider
  /**
   * Default-OFF (WS-1 event/outcome substrate). When true AND {@link memoryDb} is present, runs the
   * event-segmentation phase: broker `events` (decision types) + `proposal_outcomes` are segmented
   * into clean, narratable decision→action→outcome EVENT nodes with a first-class event-time τ,
   * stored as retrievable chunks (facts-as-chunks) + the `event_nodes` sidecar. Deterministic +
   * LLM-free + idempotent (dedup on event_key). Uses {@link brokerDb} when present for broker
   * decisions. Unset ⇒ byte-identical to today. Env opt-in: `SCNS_EVENT_SEGMENTATION=1`.
   */
  readonly eventSegmentation?: boolean
  /**
   * Default-OFF (SIBLING milestone). When true AND {@link memoryDb} is present, runs the
   * gated, REVERSIBLE memory-maintenance / "forgetting" phase: low-value-tier files
   * (default `sessions/`) whose gazetteer entities are all stale (not retrieved within
   * the staleness window — the D2 `memory_access` signal) are MOVED to `archive/`
   * (excluded from search, recoverable). NEVER touches curated tiers or guardrails.
   * Unset ⇒ byte-identical to today. Env opt-in: `SCNS_DREAM_MAINTENANCE=1`.
   */
  readonly memoryMaintenance?: boolean
  /**
   * Production guard for the maintenance phase (warm-up + throttle + age cutoff). When
   * omitted, the phase runs WITHOUT a warm-up guard (legacy/test behavior). cli.ts sets
   * {@link DEFAULT_MAINTENANCE_GUARD} so the live phase refuses to decay on a cold signal.
   */
  readonly maintenanceGuard?: {
    readonly minWarmupAccesses?: number
    readonly minWarmupEntities?: number
    readonly maxArchivePerRun?: number
    readonly minFileAgeMs?: number
  }
}

export interface DreamRunResult {
  readonly success: boolean
  readonly skipped: boolean
  readonly skipReason?: string
  readonly consolidation?: ConsolidationResult
  readonly durationMs: number
  readonly error?: string
}

export interface DreamStatus {
  readonly lastRunAt: string | null
  readonly sessionsSinceLastRun: number
  readonly totalRuns: number
  readonly gateCheck: DreamGateResult
}

// ── Factory ────────────────────────────────────────────────────────

export function createDreamDaemon(config: DreamDaemonConfig) {
  const db = openDreamDatabase(config.dbPath)
  const vault = createVault({ rootDir: config.vaultRootDir })
  const archiveStore = createArchiveStore({
    rootDir: `${config.vaultRootDir}/archive`,
  })
  initConsolidationState(db)
  const scheduler = createConsolidationScheduler(db)
  const gateConfig: DreamGateConfig = {
    ...DEFAULT_DREAM_GATE_CONFIG,
    ...config.gateConfig,
  }

  let closed = false

  /** Read daily log files from the vault's daily/ directory. */
  function readDailyLogs(
    sinceDate: string | null,
  ): ReadonlyArray<{ content: string; date: string }> {
    const allFiles = vault.listFiles(undefined, 'daily')
    const logs: Array<{ content: string; date: string }> = []

    for (const file of allFiles) {
      // Extract date from filename like "daily/2026-04-05.md"
      const match = /(\d{4}-\d{2}-\d{2})\.md$/.exec(file.path)
      if (!match) continue

      const date = match[1]!

      // Filter: only include logs after the last run (strict less-than to include same-day entries)
      if (sinceDate && date < sinceDate.slice(0, 10)) continue

      logs.push({ content: file.content, date })
    }

    // Sort by date ascending
    logs.sort((a, b) => a.date.localeCompare(b.date))
    return logs
  }

  /** Execute one consolidation cycle (core logic). */
  async function executeConsolidation(): Promise<DreamRunResult> {
    const start = Date.now()

    try {
      // Read current MEMORY.md (or empty string if first run)
      const memoryFile = vault.read('MEMORY.md')
      const currentMemoryMd = memoryFile?.content ?? ''

      // Determine last run date for log filtering
      const state = getDreamState(db)
      const lastRunAt = state?.last_run_at ?? null

      // Read and filter daily logs
      const logs = readDailyLogs(lastRunAt)
      logger.info({ logCount: logs.length, sinceDate: lastRunAt }, 'Dream: reading daily logs')

      // Extract entries from logs
      const newEntries = extractFromMultipleLogs(logs)
      logger.info({ entryCount: newEntries.length }, 'Dream: extracted entries')

      // Run consolidation
      const consolidation = runConsolidation({
        currentMemoryMd,
        newEntries,
      })

      // Re-synthesize all entries through the synthesis pipeline
      // This cleans typos and transforms raw prompts into actionable lessons
      const parsedEntries = parseMemoryMd(consolidation.memoryMd)
      const synthesized = resynthesizeMemoryEntries(parsedEntries, synthesizeEntry, fixTypos)
      const synthesizedMd = serializeMemoryMd(synthesized)

      // Write new MEMORY.md (unless dry run)
      if (!config.dryRun) {
        vault.write('MEMORY.md', synthesizedMd)
        logger.info({ entriesKept: consolidation.entriesKept }, 'Dream: wrote MEMORY.md')
      } else {
        logger.info('Dream: dry run — skipping MEMORY.md write')
      }

      const durationMs = Date.now() - start

      // Record dream run in state DB (skip for dry runs to avoid poisoning gate state)
      if (!config.dryRun) {
        recordDreamRun(db, {
          durationMs,
          entriesProcessed: consolidation.entriesProcessed,
        })
      }

      // Apply negative memories to copilot-instructions.md
      if (!config.dryRun) {
        try {
          const projectRoot = config.projectRoot ?? process.cwd()
          // Run the critic FIRST so the applicator's strict filter has
          // verdicts to read. Heuristic-only (null LLM provider) by default —
          // sufficient to suppress pipeline-artifact noise.
          const criticResult = await runNegativeMemoryCritic({ vault })
          if (
            criticResult.heuristicSuppressed +
              criticResult.llmSuppressed +
              criticResult.llmRevised >
            0
          ) {
            logger.info(
              {
                heuristicSuppressed: criticResult.heuristicSuppressed,
                llmSuppressed: criticResult.llmSuppressed,
                llmRevised: criticResult.llmRevised,
                skippedAlreadyReviewed: criticResult.skippedAlreadyReviewed,
              },
              'Dream: negative-memory critic pass complete',
            )
          }
          if (config.gatedNegativeMemoriesLive) {
            // Wedge C (default-OFF): route the live self-edit through the per-rule
            // non-regression gate instead of the blind writer. The critic already
            // ran above (shared with the blind path) ⇒ pass a no-op criticRunner to
            // avoid a duplicate pass.
            const gated = await runGatedNegativeMemoryApplyLive({
              vault,
              projectRoot,
              env: process.env,
              criticRunner: async () => {},
            })
            logger.info(
              {
                ran: gated.ran,
                skipReason: gated.skipReason,
                candidateCount: gated.candidateCount,
                adopted: gated.adopted.length,
                rejected: gated.rejected.length,
                spawned: gated.spawned,
              },
              'Dream: gated negative-memory apply (live)',
            )
          } else {
            const negResult = applyNegativeMemories({ vault, projectRoot })
            if (
              negResult.appliedCount > 0 ||
              negResult.suppressedByCriticCount > 0 ||
              negResult.pendingReviewCount > 0
            ) {
              logger.info(
                {
                  applied: negResult.appliedCount,
                  skipped: negResult.skippedCount,
                  suppressedByCritic: negResult.suppressedByCriticCount,
                  pendingReview: negResult.pendingReviewCount,
                },
                'Dream: applied negative memories',
              )
            }
          }

          // Opt-in shadow eval: run the gated applicator on a COPY of the live
          // file inside a throwaway temp dir. Never touches the live file.
          if (config.gatedNegativeMemoriesShadow) {
            try {
              const shadow = await runShadowNegativeMemoryEval({ vault, projectRoot })
              logger.info(
                {
                  ran: shadow.ran,
                  skipReason: shadow.skipReason,
                  candidateCount: shadow.candidateCount,
                  adopted: shadow.adopted.length,
                  rejected: shadow.rejections.length,
                  backups: shadow.backups.length,
                },
                'Dream: shadow gated negative-memory eval',
              )
            } catch (err) {
              logger.warn({ err }, 'Dream: shadow gated negative-memory eval failed')
            }
          }
        } catch (err) {
          logger.warn({ err }, 'Dream: negative memory application failed')
        }
      }

      // Run tiered consolidation (weekly/monthly) if due
      if (!config.dryRun) {
        try {
          if (scheduler.shouldRunWeekly()) {
            const today = new Date()
            const weekNum = getISOWeek(today)
            const weekId = `${today.getFullYear()}-W${String(weekNum).padStart(2, '0')}`
            const dailyDates = getLastNDailyDates(7, today)

            const weekResult = runWeeklyConsolidation({
              vault,
              archiveStore,
              weekId,
              dailyLogDates: dailyDates,
            })
            scheduler.recordWeeklyRun()
            logger.info(
              {
                weekId,
                lessonsExtracted: weekResult.lessonsExtracted,
                archived: weekResult.archivedCount,
              },
              'Dream: weekly consolidation complete',
            )
          }

          if (scheduler.shouldRunMonthly()) {
            const today = new Date()
            const monthId = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
            const weeklyFiles = vault.listFiles(undefined, 'weekly')
            const weeklyIds = weeklyFiles
              .map((f) => {
                const m = /(\d{4}-W\d{2})\.md$/.exec(f.path)
                return m ? m[1]! : null
              })
              .filter((id): id is string => id !== null)

            const monthResult = runMonthlyConsolidation({
              vault,
              archiveStore,
              monthId,
              weeklyIds,
            })
            scheduler.recordMonthlyRun()
            logger.info(
              {
                monthId,
                stablePatterns: monthResult.stablePatternsFound,
                archivedWeeklies: monthResult.archivedWeeklies,
              },
              'Dream: monthly consolidation complete',
            )
          }
        } catch (err) {
          logger.warn({ err }, 'Dream: tiered consolidation failed')
        }
      }

      // ── WS-1 event/outcome substrate (dream slow-path; DEFAULT-OFF, structured-first) ──
      // Segments broker DECISION events + proposal_outcomes into clean, narratable
      // decision→action→outcome EVENT nodes with a real event-time τ, stored as retrievable chunks
      // + the event_nodes sidecar. Guarded: requires BOTH the opt-in flag AND a memory DB handle;
      // inert + byte-identical otherwise. Deterministic + LLM-free + idempotent (dedup on
      // event_key). Sits BEFORE the causal phase so causal candidates reason over fresh events.
      if (!config.dryRun && config.eventSegmentation && config.memoryDb) {
        try {
          const records = segmentStructuredEvents({
            vaultDb: config.memoryDb,
            ...(config.brokerDb ? { brokerDb: config.brokerDb } : {}),
          })
          const evStats = await writeEventNodes(config.memoryDb, records)
          logger.info(
            {
              considered: evStats.considered,
              written: evStats.written,
              skippedExisting: evStats.skippedExisting,
              embeddings: evStats.embeddingsWritten,
            },
            'Dream: event/outcome substrate',
          )
        } catch (err) {
          logger.warn({ err }, 'Dream: event segmentation failed')
        }
      }

      // ── M1.3 causal edges (LLM in the dream slow-path; DEFAULT-OFF, design-m1.md §5) ──
      // Guarded: requires BOTH the opt-in flag AND a memory DB handle. With neither
      // (the default + prod today) this block is inert and the cycle is byte-identical.
      // The runner is itself default-OFF (null provider unless a provider is injected
      // or SCNS_DREAM_CAUSAL_ACP=1 + a factory is wired) and writes ONLY to the
      // memory_causal table — never guardrail files. Sits between tiered consolidation
      // and core-file generation so causal links reason over the curated tiers.
      if (!config.dryRun && config.causalEdgeInference && config.memoryDb) {
        try {
          const causal = await runCausalEdgeInference({
            db: config.memoryDb,
            env: process.env,
            ...(config.causalProvider ? { provider: config.causalProvider } : {}),
            ...(config.makeCausalAcpProvider
              ? { makeAcpProvider: config.makeCausalAcpProvider }
              : {}),
          })
          logger.info(
            {
              ran: causal.ran,
              skipReason: causal.skipReason,
              providerLabel: causal.providerLabel,
              candidates: causal.candidateCount,
              persisted: causal.persisted,
              materialized: causal.materialized,
            },
            'Dream: causal edge inference',
          )
        } catch (err) {
          logger.warn({ err }, 'Dream: causal edge inference failed')
        }
      }

      // ── Memory maintenance / "forgetting" (SIBLING milestone; DEFAULT-OFF) ──
      // Guarded: requires BOTH the opt-in flag AND a memory DB handle. Gated + REVERSIBLE
      // (moves stale low-value-tier telemetry to archive/, never hard-deletes, never
      // touches curated tiers/guardrails). Uses the D2 `memory_access` retrieval signal
      // ("use it or lose it"). With neither flag nor db (the default + prod today) this
      // block is inert and the cycle is byte-identical.
      if (config.memoryMaintenance && config.memoryDb) {
        try {
          const { executeMemoryMaintenance } = await import('./memory-maintenance.js')
          const dayCycle = Math.floor(Date.now() / 86_400_000)
          const maint = executeMemoryMaintenance({
            db: config.memoryDb,
            vault: {
              listFiles: () => vault.listFiles(),
              read: (p) => vault.read(p),
              write: (p, c) => vault.write(p, c),
              remove: (p) => vault.remove(p),
            },
            cycle: dayCycle,
            ...(config.maintenanceGuard ?? {}),
            ...(config.dryRun ? { dryRun: true } : {}),
          })
          logger.info(
            {
              scanned: maint.plan.scanned,
              candidates: maint.plan.decayCandidates.length,
              archived: maint.archivedCount,
              warm: maint.plan.accessSignalWarm,
              ...(maint.plan.skippedReason ? { skippedReason: maint.plan.skippedReason } : {}),
              dryRun: maint.dryRun,
            },
            'Dream: memory maintenance (forgetting)',
          )
        } catch (err) {
          logger.warn({ err }, 'Dream: memory maintenance failed')
        }
      }

      // Generate/update SOUL.md and USER.md
      if (!config.dryRun) {
        try {
          const coreResult = generateCoreFiles({ vault })
          logger.info(
            {
              preferences: coreResult.userPreferences,
              patterns: coreResult.userPatterns,
            },
            'Dream: core files (SOUL.md, USER.md) updated',
          )
        } catch (err) {
          logger.warn({ err }, 'Dream: core file generation failed')
        }
      }

      // Run housekeeping on broker DB if available
      if (config.brokerDb && !config.dryRun) {
        const hkResult = runHousekeeping(config.brokerDb, DEFAULT_HOUSEKEEPING_CONFIG)
        if (hkResult.success) {
          logger.info(
            {
              spansPruned: hkResult.otelSpansPruned,
              metricsPruned: hkResult.otelMetricsPruned,
              eventsPruned: hkResult.eventsPruned,
              vacuumed: hkResult.vacuumed,
              walTruncated: hkResult.walTruncated,
              walFramesCheckpointed: hkResult.walFramesCheckpointed,
            },
            'Dream: housekeeping complete',
          )
        }
      }

      return {
        success: true,
        skipped: false,
        consolidation,
        durationMs,
      }
    } catch (err) {
      const durationMs = Date.now() - start
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ err }, 'Dream: consolidation failed')
      return {
        success: false,
        skipped: false,
        durationMs,
        error: message,
      }
    }
  }

  return {
    /** Execute one consolidation cycle, checking gates first. */
    async run(): Promise<DreamRunResult> {
      if (closed) throw new InvalidStateError('DreamDaemon is closed')
      const start = Date.now()

      // Check gates
      const gateResult = checkDreamGates(db, gateConfig)
      if (!gateResult.canRun) {
        logger.info({ failedGate: gateResult.failedGate }, 'Dream: gates failed, skipping')
        return {
          success: true,
          skipped: true,
          skipReason: gateResult.failedGate,
          durationMs: Date.now() - start,
        }
      }

      // Acquire lock
      const lockHolder = `dream-daemon-${process.pid}`
      const locked = acquireDreamLock(db, lockHolder)
      if (!locked) {
        return {
          success: true,
          skipped: true,
          skipReason: 'lock',
          durationMs: Date.now() - start,
        }
      }

      try {
        return await executeConsolidation()
      } finally {
        releaseDreamLock(db, lockHolder)
      }
    },

    /** Skip gate check, run consolidation immediately. */
    async forceRun(): Promise<DreamRunResult> {
      if (closed) throw new InvalidStateError('DreamDaemon is closed')
      const lockHolder = `dream-daemon-force-${process.pid}`
      const locked = acquireDreamLock(db, lockHolder)
      if (!locked) {
        return {
          success: false,
          skipped: true,
          skipReason: 'lock',
          durationMs: 0,
          error: 'Could not acquire lock',
        }
      }

      try {
        return await executeConsolidation()
      } finally {
        releaseDreamLock(db, lockHolder)
      }
    },

    /** Return current dream state + gate check. */
    getStatus(): DreamStatus {
      if (closed) throw new InvalidStateError('DreamDaemon is closed')
      const state = getDreamState(db)
      const gateCheck = checkDreamGates(db, gateConfig)

      return {
        lastRunAt: state?.last_run_at ?? null,
        sessionsSinceLastRun: state?.sessions_since_last_run ?? 0,
        totalRuns: state?.total_runs ?? 0,
        gateCheck,
      }
    },

    /** Increment the session counter for gate checks. Call on session-end. */
    notifySessionCompleted(): void {
      if (closed) return
      incrementSessionCount(db)
    },

    /** Close the dream database connection. */
    close(): void {
      if (closed) return
      closed = true
      db.close()
    },
  }
}

export type DreamDaemon = ReturnType<typeof createDreamDaemon>

// ── Date helpers ───────────────────────────────────────────────────

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
}

function getLastNDailyDates(n: number, fromDate: Date): string[] {
  const dates: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(fromDate)
    d.setDate(d.getDate() - i)
    dates.push(d.toISOString().slice(0, 10))
  }
  return dates
}
