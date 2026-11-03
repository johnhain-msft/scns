/**
 * Team task autospawner (WS-S meta-fix).
 *
 * Closes the dogfood loop: when a task is created on a team that has
 * no active scns-manager, this service auto-spawns one against the
 * team's oldest unowned pending task. Without it, the broker requires
 * a human to call POST /api/tasks/:id/spawn (or the CLI) to start the
 * dispatch chain — meaning SCNS can't dogfood a single-prompt task.
 *
 * Design notes (from rubber-duck design pass):
 *  - Atomic claim BEFORE the await: UPDATE ... WHERE owner IS NULL
 *    AND status = 'pending' with a sentinel owner. Only proceeds if
 *    `changes === 1`. After the spawn resolves the sentinel is
 *    replaced with the real session id; on failure the row is
 *    rolled back so the next tick can retry. This is the
 *    SUBMITTING-before-await pattern (chamber-copilot lib/job-store.mjs).
 *  - The atomic claim also flips status to 'in_progress', which
 *    exempts the team from team-reaper archival (see team-reaper.ts
 *    line 122-127) for the duration of the spawn.
 *  - Active-manager detection joins team_members → sessions and
 *    filters by archived_at IS NULL plus the live-status set used
 *    elsewhere in session-repository.ts.
 *  - Per-task cooldown after a failed launch prevents thrash.
 *  - tickInProgress guard prevents overlapping ticks if a spawn
 *    takes longer than the polling interval.
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AgentSpawner } from './agent-spawner.js'
import { buildTaskSpawnPrompt } from './task-spawn-prompt.js'

export interface AutospawnerLogger {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

export interface TeamTaskAutospawnerOptions {
  readonly intervalMs: number
  readonly cooldownMs: number
  readonly enabled: boolean
  readonly workingDir: string
  /**
   * Multi-project foundation (P3): when set, only spawn for teams whose
   * project_id matches. Legacy NULL-project teams are excluded so a broker
   * pointed at project A never auto-spawns managers for project B (or
   * unmigrated) teams. Omit to preserve legacy global behaviour.
   */
  readonly projectId?: string
}

export interface TeamTaskAutospawnerDeps {
  readonly db: Database.Database
  readonly agentSpawner: Pick<AgentSpawner, 'spawn'>
  readonly logger?: AutospawnerLogger
  readonly now?: () => number
}

export interface TeamTaskAutospawner {
  start(): void
  stop(): void
  tickOnce(): Promise<void>
}

const SENTINEL_OWNER = '__autospawn_pending__'

interface CandidateRow {
  task_id: number
  team_id: string
  team_name: string
  subject: string
  description: string | null
}

const NOOP_LOGGER: AutospawnerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

export function createTeamTaskAutospawner(
  deps: TeamTaskAutospawnerDeps,
  opts: TeamTaskAutospawnerOptions,
): TeamTaskAutospawner {
  const log = deps.logger ?? NOOP_LOGGER
  const now = deps.now ?? ((): number => Date.now())
  const cooldownByTask = new Map<number, number>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let tickInProgress = false
  let stopped = false

  const candidateStmt = deps.db.prepare(`
    SELECT t.id AS task_id,
           tm.id AS team_id,
           tm.name AS team_name,
           t.subject AS subject,
           t.description AS description
    FROM tasks t
    JOIN teams tm ON tm.id = t.team_id
    WHERE t.status = 'pending'
      AND t.owner IS NULL
      AND tm.status = 'active'
      AND tm.archived_at IS NULL
      AND (@projectId IS NULL OR tm.project_id = @projectId)
      AND t.id = (
        SELECT MIN(t2.id) FROM tasks t2
        WHERE t2.team_id = tm.id
          AND t2.status = 'pending'
          AND t2.owner IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM team_members mem
        JOIN sessions s ON s.id = mem.session_id
        WHERE mem.team_id = tm.id
          AND mem.role = 'scns-manager'
          AND s.archived_at IS NULL
          AND s.status IN ('active','working','reporting','idle','paused','registered')
      )
    ORDER BY t.id ASC
  `)

  const claimStmt = deps.db.prepare(
    `UPDATE tasks SET owner = ?, status = 'in_progress', updated_at = datetime('now')
     WHERE id = ? AND owner IS NULL AND status = 'pending'`,
  )
  const releaseStmt = deps.db.prepare(
    `UPDATE tasks SET owner = NULL, status = 'pending', updated_at = datetime('now')
     WHERE id = ? AND owner = ?`,
  )
  const finalizeStmt = deps.db.prepare(
    `UPDATE tasks SET owner = ?, updated_at = datetime('now')
     WHERE id = ? AND owner = ?`,
  )

  function findCandidates(): CandidateRow[] {
    return candidateStmt.all({ projectId: opts.projectId ?? null }) as CandidateRow[]
  }

  function claim(taskId: number): boolean {
    return claimStmt.run(SENTINEL_OWNER, taskId).changes === 1
  }

  function release(taskId: number): void {
    releaseStmt.run(taskId, SENTINEL_OWNER)
  }

  function finalize(taskId: number, sessionId: string): void {
    finalizeStmt.run(sessionId, taskId, SENTINEL_OWNER)
  }

  async function spawnFor(c: CandidateRow): Promise<void> {
    const cooldownUntil = cooldownByTask.get(c.task_id) ?? 0
    if (now() < cooldownUntil) return
    if (!claim(c.task_id)) return

    const prompt = buildTaskSpawnPrompt({
      role: 'scns-manager',
      team: { id: c.team_id, name: c.team_name },
      task: { id: c.task_id, subject: c.subject, description: c.description },
      projectRoot: opts.workingDir,
    })
    const name = `task-${c.task_id}-scns-manager-${randomUUID().slice(0, 8)}`

    try {
      const result = await deps.agentSpawner.spawn({
        team_id: c.team_id,
        name,
        role: 'scns-manager',
        working_dir: opts.workingDir,
        prompt,
        launch_method: 'acp',
        permissions: 'default',
        task: { id: c.task_id, subject: c.subject, description: c.description },
        team_name: c.team_name,
      })
      finalize(c.task_id, result.sessionId)
      cooldownByTask.delete(c.task_id)
      log.info('team-task-autospawner: spawned manager', {
        task_id: c.task_id,
        team_id: c.team_id,
        session_id: result.sessionId,
      })
    } catch (err) {
      release(c.task_id)
      cooldownByTask.set(c.task_id, now() + opts.cooldownMs)
      log.warn('team-task-autospawner: spawn failed', {
        task_id: c.task_id,
        team_id: c.team_id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function tickOnce(): Promise<void> {
    if (!opts.enabled || tickInProgress || stopped) return
    tickInProgress = true
    try {
      const candidates = findCandidates()
      for (const c of candidates) await spawnFor(c)
    } finally {
      tickInProgress = false
    }
  }

  function scheduleNext(): void {
    if (stopped) return
    timer = setTimeout(() => {
      void tickOnce().finally(scheduleNext)
    }, opts.intervalMs)
  }

  return {
    start(): void {
      if (!opts.enabled || timer != null || stopped) return
      log.info('team-task-autospawner: starting', {
        intervalMs: opts.intervalMs,
        cooldownMs: opts.cooldownMs,
      })
      scheduleNext()
    },
    stop(): void {
      stopped = true
      if (timer != null) {
        clearTimeout(timer)
        timer = null
      }
    },
    tickOnce,
  }
}
