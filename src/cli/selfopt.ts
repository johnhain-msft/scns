/**
 * CLI runners for `scns selfopt` (Phase 0 — measurement substrate).
 *
 * `mine`     — mine labelled TaskRecords from the broker event history and
 *              print the deterministic train/val/test split.
 * `baseline` — replay a held-out split against the current artifact under a
 *              deterministic backend and print the reproducible held-out score.
 *
 * Both open the broker database READONLY (better-sqlite3 `{ readonly: true }`)
 * — Phase 0 is read/measure only and must never mutate broker state or run the
 * migration path. Intent text is resolved best-effort from the suggestion store.
 */
import Database from 'better-sqlite3'
import { basename } from 'node:path'
import {
  computeBaseline,
  loadOutcomeEvents,
  mineTaskRecords,
  MockBackend,
} from '../selfopt/index.js'
import type { GateMetric, IntentResolver, TaskRecord, TaskSplit } from '../selfopt/index.js'
import { runShadowEvalWithOptIns } from '../selfopt/shadow-eval-runner.js'
import { runValidateLossWithOptIns } from '../selfopt/validate-loss-runner.js'
import type { Vault } from '../memory/vault.js'

export interface SelfoptDeps {
  /** Broker DB path (default: broker config dbPath). */
  readonly dbPath: string
  /** Project root for naming + intent resolution. */
  readonly projectRoot: string
  /** Directory holding the suggestion store (for intent resolution). */
  readonly suggestionsDir: string
  readonly valFraction?: number
  readonly testFraction?: number
  readonly seed?: number
  readonly maxTasks?: number
}

/** Build an intent resolver backed by the on-disk suggestion store. */
async function buildIntentResolver(suggestionsDir: string): Promise<IntentResolver> {
  try {
    const { createSuggestionStore } = await import('../suggest/suggestion-store.js')
    const store = createSuggestionStore({ rootDir: suggestionsDir })
    return (id: string) => {
      try {
        return store.get(id)?.title ?? null
      } catch {
        return null
      }
    }
  } catch {
    return () => null
  }
}

/** Open the broker DB readonly and mine TaskRecords. Caller-agnostic core. */
async function mine(deps: SelfoptDeps): Promise<TaskRecord[]> {
  const db = new Database(deps.dbPath, { readonly: true, fileMustExist: true })
  try {
    const events = loadOutcomeEvents(db)
    const intentResolver = await buildIntentResolver(deps.suggestionsDir)
    return mineTaskRecords(events, {
      project: basename(deps.projectRoot),
      intentResolver,
      valFraction: deps.valFraction,
      testFraction: deps.testFraction,
      seed: deps.seed,
      maxTasks: deps.maxTasks,
    })
  } finally {
    db.close()
  }
}

function splitCounts(tasks: ReadonlyArray<TaskRecord>): Record<TaskSplit, number> {
  const counts: Record<TaskSplit, number> = { train: 0, val: 0, test: 0 }
  for (const t of tasks) counts[t.split]++
  return counts
}

function outcomeCounts(tasks: ReadonlyArray<TaskRecord>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const t of tasks) counts[t.outcome] = (counts[t.outcome] ?? 0) + 1
  return counts
}

export interface RunMineOptions {
  readonly json?: boolean
  readonly limit?: number
}

/** `scns selfopt mine` — print the mined task bench + split. */
export async function runMine(deps: SelfoptDeps, opts: RunMineOptions = {}): Promise<string> {
  const tasks = await mine(deps)
  const counts = splitCounts(tasks)
  const outcomes = outcomeCounts(tasks)

  if (opts.json) {
    return JSON.stringify(
      {
        project: basename(deps.projectRoot),
        source: 'broker-events:quality_gate_verdict+team_completed',
        seed: deps.seed ?? 42,
        valFraction: deps.valFraction ?? 0.34,
        testFraction: deps.testFraction ?? 0.0,
        nTasks: tasks.length,
        split: counts,
        outcomes,
        tasks: tasks.map((t) => ({
          id: t.id,
          split: t.split,
          outcome: t.outcome,
          recordedScore: t.recordedScore,
          intent: t.intent,
          tags: t.tags,
        })),
      },
      null,
      2,
    )
  }

  const lines: string[] = []
  lines.push(`selfopt mine — project: ${basename(deps.projectRoot)}`)
  lines.push(`source: broker events (quality_gate_verdict paired with team_completed)`)
  lines.push(`tasks: ${tasks.length}   split: train=${counts.train} val=${counts.val} test=${counts.test}`)
  lines.push(
    `outcomes: ${Object.entries(outcomes)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  )
  lines.push('')
  const limit = opts.limit ?? 12
  lines.push(`first ${Math.min(limit, tasks.length)} task(s):`)
  for (const t of tasks.slice(0, limit)) {
    const score = t.recordedScore === null ? 'n/a' : t.recordedScore.toFixed(2)
    lines.push(`  [${t.split.padEnd(5)}] ${t.id}  score=${score}  ${t.outcome.padEnd(7)}  ${t.intent}`)
  }
  return lines.join('\n')
}

export interface RunBaselineOptions {
  readonly json?: boolean
  readonly split?: TaskSplit
  readonly metric?: GateMetric
}

/** `scns selfopt baseline` — print the reproducible held-out score. */
export async function runBaseline(
  deps: SelfoptDeps,
  opts: RunBaselineOptions = {},
): Promise<string> {
  const tasks = await mine(deps)
  const split = opts.split ?? 'val'
  const metric = opts.metric ?? 'hard'
  const baseline = await computeBaseline(tasks, {
    split,
    metric,
    backend: new MockBackend(),
  })

  if (opts.json) {
    return JSON.stringify(
      {
        project: basename(deps.projectRoot),
        source: 'broker-events:quality_gate_verdict+team_completed',
        seed: deps.seed ?? 42,
        nTasksTotal: tasks.length,
        ...baseline,
      },
      null,
      2,
    )
  }

  const lines: string[] = []
  lines.push(`selfopt baseline — project: ${basename(deps.projectRoot)}`)
  lines.push(`held-out split: ${baseline.split}   metric: ${baseline.metric}`)
  lines.push(`tasks scored: ${baseline.nTasks} of ${tasks.length} total`)
  lines.push(`score: ${baseline.score.toFixed(4)}   (hard=${baseline.hard.toFixed(4)} soft=${baseline.soft.toFixed(4)})`)
  lines.push(`mean cost: ${baseline.meanTokens.toFixed(1)} tokens, ${baseline.meanLatencyMs.toFixed(1)} ms`)
  lines.push('')
  lines.push('per-task (deterministic, id-ordered):')
  for (const pt of baseline.perTask) {
    lines.push(`  ${pt.id}  hard=${pt.hard.toFixed(2)}  soft=${pt.soft.toFixed(2)}`)
  }
  return lines.join('\n')
}

export interface RunShadowEvalDeps {
  readonly vault: Vault
  readonly projectRoot: string
  readonly brokerDbPath: string
  /** Environment for the opt-in env vars. Default `process.env` (injectable). */
  readonly env?: NodeJS.ProcessEnv
}

export interface RunShadowEvalOptions {
  readonly json?: boolean
}

/**
 * `scns selfopt shadow-eval` — run the shadow gated negative-memory eval honouring
 * the default-OFF env opt-ins, and format the gate outcome + measurement report.
 */
export async function runShadowEval(
  deps: RunShadowEvalDeps,
  opts: RunShadowEvalOptions = {},
): Promise<string> {
  const result = await runShadowEvalWithOptIns({
    vault: deps.vault,
    projectRoot: deps.projectRoot,
    brokerDbPath: deps.brokerDbPath,
    ...(deps.env ? { env: deps.env } : {}),
  })

  if (opts.json) {
    return JSON.stringify(
      {
        project: basename(deps.projectRoot),
        ran: result.ran,
        skipReason: result.skipReason ?? null,
        candidateCount: result.candidateCount,
        adopted: result.adopted.map((a) => a.rule),
        rejected: result.rejections.map((r) => r.rule),
        report: result.report,
      },
      null,
      2,
    )
  }

  const lines: string[] = []
  lines.push(`selfopt shadow-eval — project: ${basename(deps.projectRoot)}`)
  lines.push(`ran: ${result.ran}${result.skipReason ? `   skipReason: ${result.skipReason}` : ''}`)
  lines.push(
    `candidates: ${result.candidateCount}   adopted: ${result.adopted.length}   rejected: ${result.rejections.length}`,
  )
  lines.push('')
  if (result.report) {
    const r = result.report
    lines.push(`report (MEASUREMENT, not a gate): backend=${r.backendLabel}`)
    lines.push(
      `  tasks: ${r.nTasks}   score: ${r.score.toFixed(4)}   (hard=${r.hard.toFixed(4)} soft=${r.soft.toFixed(4)})`,
    )
    lines.push(`  mean cost: ${r.meanTokens.toFixed(1)} tokens, ${r.meanLatencyMs.toFixed(1)} ms`)
    lines.push(`  ${r.disclosure}`)
  } else {
    lines.push('report: none (set SCNS_SELFOPT_SHADOW_REAL_VAL=1 to mine the real broker val split)')
  }
  return lines.join('\n')
}

export interface RunValidateLossDeps {
  readonly projectRoot: string
  /** Environment for the opt-in env var. Default `process.env` (injectable). */
  readonly env?: NodeJS.ProcessEnv
}

export interface RunValidateLossOptions {
  readonly json?: boolean
}

function truncateForDisplay(text: string, max = 280): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

/**
 * `scns selfopt validate-loss` — run the single-spawn loss-validation experiment
 * honouring the default-OFF `SCNS_SELFOPT_VALIDATE_LOSS_ACP` opt-in, and format the
 * per-reading baseline(Mock)→candidate deltas. Default-OFF ⇒ symmetric Mock, no
 * spawn (nSpawns 0, worktree null).
 */
export async function runValidateLoss(
  deps: RunValidateLossDeps,
  opts: RunValidateLossOptions = {},
): Promise<string> {
  const result = await runValidateLossWithOptIns({
    projectRoot: deps.projectRoot,
    ...(deps.env ? { env: deps.env } : {}),
  })

  if (opts.json) {
    return JSON.stringify(
      {
        project: basename(deps.projectRoot),
        backendLabel: result.backendLabel,
        spawned: result.spawned,
        nSpawns: result.nSpawns,
        worktree: result.worktree,
        pid: result.pid,
        pidAlreadyExited: result.pidAlreadyExited,
        killedByPid: result.killedByPid,
        baselineResponse: result.baselineResponse,
        candidateResponse: result.candidateResponse,
        readings: result.readings,
        headlineDelta: result.headlineDelta,
        disclosure: result.disclosure,
      },
      null,
      2,
    )
  }

  const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`)
  const lines: string[] = []
  lines.push(`selfopt validate-loss — project: ${basename(deps.projectRoot)}`)
  lines.push(
    `backend: ${result.backendLabel}   spawned: ${result.spawned}   nSpawns: ${result.nSpawns}`,
  )
  if (result.worktree) {
    lines.push(
      `worktree: ${result.worktree}   pid: ${result.pid ?? 'n/a'}   ` +
        `killedByPid: ${result.killedByPid}   pidAlreadyExited: ${result.pidAlreadyExited}`,
    )
  }
  lines.push('')
  lines.push('readings (baseline=Mock vs candidate):')
  for (const r of result.readings) {
    const tag = r.headline ? 'HEADLINE ' : 'secondary'
    lines.push(
      `  [${tag}] ${r.id} ${r.op}=${r.arg}  baseline=${r.baselineHard}  ` +
        `candidate=${r.candidateHard}  delta=${sign(r.delta)}`,
    )
  }
  lines.push('')
  lines.push(`headline delta: ${sign(result.headlineDelta)}`)
  lines.push(
    `candidate response (${result.candidateResponse.length} chars): ${truncateForDisplay(result.candidateResponse)}`,
  )
  lines.push(`disclosure: ${result.disclosure}`)
  return lines.join('\n')
}
