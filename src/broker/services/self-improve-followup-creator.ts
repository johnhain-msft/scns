/**
 * Task 26 — Self-improve follow-up creator (closes the perpetual-loop gap).
 *
 * Problem (observed on team 3e39c3dd task 25): scns-manager sessions run
 * exactly ONE ACP turn — the auto-dispatch turn — and then exit because
 * `DEFAULT_NUDGE_ROLES` in `agent-spawner.ts` only includes `scns-dev`.
 * After the dev/QA cycle finishes and the quality-gate emits a verdict,
 * no manager exists to evaluate the outcome or call `scns_create_task`
 * with a follow-up. The team-task-autospawner only spawns a manager
 * when a PENDING task already exists, so the dogfood loop dies after
 * one task.
 *
 * Fix (option (b) from the task brief): a dedicated subscriber listens
 * on `quality_gate_verdict`. For teams whose name matches an allowlist
 * (default prefix: `scns-self-improve`), it creates a follow-up task
 * on the same team carrying the verdict outcome and a postmortem
 * prompt. The autospawner picks the task up on its next tick and
 * spawns a fresh manager — re-invoking the manager role without any
 * change to nudge logic, auto-dispatch, or agent-spawner.
 *
 * Halt rule: a tally of consecutive failing verdicts per team. After
 * `failureHaltThreshold` (default 3) the service stops creating
 * postmortem follow-ups and instead emits a single "self-improve loop
 * halted" task so a human can investigate. A passing verdict at any
 * time resets the counter.
 *
 * Idempotency: `qualityCheckId` is embedded in the follow-up's
 * description as `[qc:<id>]`. A second verdict carrying the same id
 * (e.g. a flaky dispatcher firing twice) is detected via a LIKE query
 * and silently skipped — no duplicate follow-up tasks.
 *
 * Failure isolation: the dispatcher subscription wraps the handler in
 * try/catch and never re-throws, so a malformed payload or DB blip
 * cannot kill the broker.
 *
 * Constraints respected (per task 26 brief):
 *   - Does not modify team-task-autospawner.ts
 *   - Does not modify auto-dispatch.ts, agent-spawner.ts,
 *     gate-evidence.ts, task-completion-gate.ts, quality-gate-arbiter.ts
 *   - Pure additive feature behind a team-name allowlist
 */
import type Database from 'better-sqlite3'
import type { EventDispatcher } from '../event-dispatcher.js'
import { findTeamById } from '../storage/repositories/team-repository.js'
import { createTask, findTasksByTeam } from '../storage/repositories/task-repository.js'

export interface VerdictPayload {
  readonly team_id?: string | null
  readonly passed?: boolean
  readonly qualityCheckId?: string | null
}

export type FollowupAction = 'skipped' | 'created' | 'halted'

export interface HandleVerdictResult {
  readonly action: FollowupAction
  readonly reason?: string
  readonly taskId?: number
}

export interface SelfImproveFollowupLogger {
  info?: (msg: string, fields?: Record<string, unknown>) => void
  warn?: (msg: string, fields?: Record<string, unknown>) => void
}

export interface SelfImproveFollowupCreatorOptions {
  /** Team-name prefixes eligible for the perpetual loop. */
  readonly teamPrefixes?: readonly string[]
  /** Consecutive failed verdicts before the loop halts. */
  readonly failureHaltThreshold?: number
  readonly logger?: SelfImproveFollowupLogger
}

export interface SelfImproveFollowupCreatorDeps {
  readonly db: Database.Database
  readonly dispatcher: EventDispatcher
  readonly options?: SelfImproveFollowupCreatorOptions
}

export interface SelfImproveFollowupCreator {
  start(): void
  stop(): void
  /** Test seam — invoke the verdict handler directly. */
  handleVerdict(payload: VerdictPayload): HandleVerdictResult
}

const DEFAULT_PREFIXES: readonly string[] = ['scns-self-improve']
const DEFAULT_HALT_THRESHOLD = 3

export function createSelfImproveFollowupCreator(
  deps: SelfImproveFollowupCreatorDeps,
): SelfImproveFollowupCreator {
  const prefixes = deps.options?.teamPrefixes ?? DEFAULT_PREFIXES
  const haltThreshold = Math.max(1, deps.options?.failureHaltThreshold ?? DEFAULT_HALT_THRESHOLD)
  const log = deps.options?.logger

  // Per-team in-memory state. Resets on broker restart by design; the
  // perpetual loop is meant to survive routine restarts because after a
  // restart the autospawner will simply pick the most-recent pending
  // task and a single transient verdict will create at most one extra
  // follow-up before the counter rebuilds.
  const consecutiveFailures = new Map<string, number>()
  const halted = new Set<string>()
  let unsubscribe: (() => void) | null = null

  function isEligible(teamName: string): boolean {
    return prefixes.some((p) => teamName.startsWith(p))
  }

  function alreadyFollowedUp(teamId: string, qualityCheckId: string): boolean {
    const marker = `[qc:${qualityCheckId}]`
    const row = deps.db
      .prepare('SELECT id FROM tasks WHERE team_id = ? AND description LIKE ? LIMIT 1')
      .get(teamId, `%${marker}%`) as { id: number } | undefined
    return row !== undefined
  }

  function buildPostmortemTask(
    teamId: string,
    passed: boolean,
    qualityCheckId: string,
  ): { subject: string; description: string; active_form: string } {
    const verdict = passed ? 'PASSED' : 'FAILED'
    const subject =
      `Postmortem previous task (QG ${verdict}) and propose next highest-leverage SCNS self-improvement`
    const description = [
      `[qc:${qualityCheckId}]`,
      `Auto-created follow-up after quality_gate_verdict (passed=${passed}, qc=${qualityCheckId}).`,
      ``,
      `Manager: as your first action, postmortem the previous task on this team:`,
      `  1. Read the latest 5 quality_checks (sqlite ~/.session-broker/data.db).`,
      `  2. Read recent scns_suggestions for any untriaged improvements.`,
      `  3. Read recent silent-dev / dev_no_work events.`,
      `Then call scns_create_task on this team with ONE concrete code change`,
      `that is the highest-leverage next SCNS improvement. Do not create vague`,
      `"investigate X" tasks — the next task must be a concrete code change with`,
      `a clear acceptance criterion.`,
      ``,
      `Guardrails: keep the lint floor, keep the test floor, do not modify`,
      `team-task-autospawner.ts, and prefer blue/green deploy where applicable.`,
      `Team: ${teamId}.`,
    ].join('\n')
    return { subject, description, active_form: 'Postmortem + propose follow-up' }
  }

  function buildHaltTask(
    teamId: string,
    failures: number,
    qualityCheckId: string,
  ): { subject: string; description: string; active_form: string } {
    const subject = `Self-improve loop halted — ${failures} consecutive QG failures`
    const description = [
      `[qc:${qualityCheckId}]`,
      `The perpetual self-improvement loop on team ${teamId} has been halted`,
      `because the most recent ${failures} quality-gate verdicts all failed.`,
      ``,
      `Next steps for a human (or brain at L2+):`,
      `  1. Inspect recent quality_checks to identify the root cause.`,
      `  2. Inspect events table for dev_no_work / silent-dev signals.`,
      `  3. Either fix the underlying issue and explicitly create a new task,`,
      `     or mark this halt task 'failed' to acknowledge and reset.`,
      ``,
      `No further follow-up tasks will be auto-created on this team until`,
      `the broker restarts or the halt is manually cleared.`,
    ].join('\n')
    return { subject, description, active_form: 'Halt summary' }
  }

  function handleVerdict(payload: VerdictPayload): HandleVerdictResult {
    const teamId = payload.team_id ?? null
    if (!teamId) return { action: 'skipped', reason: 'no-team-id' }
    if (typeof payload.passed !== 'boolean') {
      return { action: 'skipped', reason: 'no-passed-flag' }
    }
    if (!payload.qualityCheckId) return { action: 'skipped', reason: 'no-quality-check-id' }

    const team = findTeamById(deps.db, teamId)
    if (!team) return { action: 'skipped', reason: 'team-not-found' }
    if (!isEligible(team.name)) return { action: 'skipped', reason: 'team-not-eligible' }
    if (halted.has(teamId)) return { action: 'skipped', reason: 'already-halted' }

    if (alreadyFollowedUp(teamId, payload.qualityCheckId)) {
      return { action: 'skipped', reason: 'already-followed-up' }
    }

    if (payload.passed === false) {
      const next = (consecutiveFailures.get(teamId) ?? 0) + 1
      consecutiveFailures.set(teamId, next)
      if (next >= haltThreshold) {
        halted.add(teamId)
        const spec = buildHaltTask(teamId, next, payload.qualityCheckId)
        const task = createTask(deps.db, { team_id: teamId, ...spec })
        log?.info?.('Self-improve loop halted', {
          team_id: teamId,
          task_id: task.id,
          consecutive_failures: next,
        })
        return { action: 'halted', taskId: task.id }
      }
    } else {
      consecutiveFailures.set(teamId, 0)
    }

    const spec = buildPostmortemTask(teamId, payload.passed, payload.qualityCheckId)
    const task = createTask(deps.db, { team_id: teamId, ...spec })
    log?.info?.('Self-improve follow-up task created', {
      team_id: teamId,
      task_id: task.id,
      passed: payload.passed,
      quality_check_id: payload.qualityCheckId,
    })
    return { action: 'created', taskId: task.id }
  }

  return {
    start() {
      if (unsubscribe) return
      unsubscribe = deps.dispatcher.subscribe(
        { event_types: ['quality_gate_verdict'] },
        (evt) => {
          try {
            const payload = JSON.parse(evt.payload) as VerdictPayload
            handleVerdict(payload)
          } catch (err) {
            log?.warn?.('Failed to handle quality_gate_verdict payload', {
              err: err instanceof Error ? err.message : String(err),
            })
          }
        },
      )
    },
    stop() {
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    },
    handleVerdict,
  }
}

/**
 * Test/inspection helper — returns the count of follow-up tasks the
 * service has created on a team. Defined here (rather than re-deriving
 * with raw SQL) so future callers don't have to know the marker
 * convention. Filters by description LIKE `[qc:%]`.
 */
export function countAutoFollowupsOnTeam(db: Database.Database, teamId: string): number {
  const tasks = findTasksByTeam(db, teamId)
  return tasks.filter((t) => (t.description ?? '').includes('[qc:')).length
}
