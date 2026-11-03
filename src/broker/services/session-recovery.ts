/**
 * Session Recovery — snapshots active agents before restart, respawns with context after.
 *
 * Flow:
 *   1. Pre-shutdown: snapshotActiveAgents() captures agent state + tasks + messages to DB
 *   2. Post-startup: loadPendingSnapshots() + recoverAgents() respawns with recovery prompts
 *   3. remapSessionReferences() migrates ownership from old → new session ID
 */

import type Database from 'better-sqlite3'
import { logger } from '../../shared/logger.js'
import type { SpawnInput, SpawnResult } from './agent-spawner.js'
import { AgentCapExceededError } from '../../shared/errors.js'

const log = logger.child({ module: 'session-recovery' })

// ── F3 / F4: crash-loop detection + bounded fan-out ──────────────────

/**
 * Minimum delta between two broker startups for recovery to be considered
 * safe. If the previous startup was less than this many ms ago, we assume
 * the broker is in a crash loop and skip recoverAgents entirely. The user
 * must remove `~/.scns/recovery_hard_disabled` (see
 * `crashLoopDetectedOnStartup`) to resume recovery. 60 s is the chosen
 * threshold — healthy restarts (daily-restart.plist) are spaced hours apart,
 * and launchd's default ThrottleInterval is 10 s.
 */
export const CRASH_LOOP_MIN_DELTA_MS = 60_000

/** Max age of a recovery snapshot that will still be replayed. Phase 13 used 1 day; reduced to 1 h to shrink the blast radius of a crash-loop replay storm. */
export const RECOVERY_SNAPSHOT_MAX_AGE_HOURS = 1

/** Fan-out concurrency — recoverAgents processes this many snapshots at a time. */
export const RECOVERY_CONCURRENCY = 2

const STARTUP_STATE_KEY = 'broker:last_startup_at'
const RECOVERY_DISABLED_KEY = 'broker:recovery_hard_disabled'

/**
 * F3: Record the current wall-clock time as the most recent broker startup,
 * returning the previous value (if any). Used by `crashLoopDetectedOnStartup`.
 */
export function recordBrokerStartup(db: Database.Database, now: number = Date.now()): number | null {
  const row = db
    .prepare("SELECT value FROM shared_state WHERE key = ?")
    .get(STARTUP_STATE_KEY) as { value: string } | undefined
  const prev = row ? Number(row.value) : null
  db.prepare(
    `INSERT INTO shared_state (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(STARTUP_STATE_KEY, String(now))
  return prev
}

/**
 * F3: Detect if this startup happened within CRASH_LOOP_MIN_DELTA_MS of the
 * previous one. When detected, set the hard-disabled flag so subsequent
 * startups also skip recovery until a human clears it. Returns true when
 * recovery should be skipped.
 */
export function crashLoopDetectedOnStartup(
  db: Database.Database,
  previousStartupMs: number | null,
  now: number = Date.now(),
): boolean {
  // Check the persisted hard-disable flag first — once tripped, recovery
  // stays off until explicitly cleared.
  const disabledRow = db
    .prepare("SELECT value FROM shared_state WHERE key = ?")
    .get(RECOVERY_DISABLED_KEY) as { value: string } | undefined
  if (disabledRow && disabledRow.value === '1') {
    log.warn('recovery: hard-disabled flag set — skipping agent recovery (clear broker:recovery_hard_disabled in shared_state to resume)')
    return true
  }
  if (previousStartupMs === null) return false
  const delta = now - previousStartupMs
  if (delta < CRASH_LOOP_MIN_DELTA_MS) {
    log.error(
      { previousStartupMs, now, deltaMs: delta, thresholdMs: CRASH_LOOP_MIN_DELTA_MS },
      'recovery: crash loop detected — hard-disabling agent recovery',
    )
    // Trip the persisted flag so the next boot (which may also be fast) also skips.
    db.prepare(
      `INSERT INTO shared_state (key, value, updated_at)
       VALUES (?, '1', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')`,
    ).run(RECOVERY_DISABLED_KEY)
    return true
  }
  return false
}

/** F3: clear the hard-disable flag (exposed for an admin/CLI route). */
export function clearRecoveryHardDisable(db: Database.Database): void {
  db.prepare("DELETE FROM shared_state WHERE key = ?").run(RECOVERY_DISABLED_KEY)
}

// ── Types ────────────────────────────────────────────────────────────

/** Info about an active agent, provided by the spawner's in-memory map. */
export interface ActiveAgentInfo {
  readonly sessionId: string
  readonly teamId: string
  readonly name: string
  readonly role: string
  readonly launchMethod: 'acp' | 'tmux' | 'detached'
  readonly workingDir: string
}

/** A persisted recovery snapshot row from the DB. */
export interface RecoverySnapshot {
  readonly id: number
  readonly session_id: string
  readonly team_id: string
  readonly name: string
  readonly role: string
  readonly working_dir: string
  readonly purpose: string | null
  readonly launch_method: string
  readonly pending_tasks: string | null
  readonly recent_messages: string | null
  readonly recovery_prompt: string | null
  readonly status: string
  readonly created_at: string
  readonly recovered_at: string | null
  readonly new_session_id: string | null
}

/** Result of a single agent recovery attempt. */
export interface RecoveryResult {
  readonly originalSessionId: string
  readonly newSessionId: string | null
  readonly success: boolean
  readonly error?: string
}

type SpawnFn = (input: SpawnInput) => Promise<SpawnResult>

// ── Constants ────────────────────────────────────────────────────────

const MAX_RECENT_MESSAGES = 20

// ── Snapshot ─────────────────────────────────────────────────────────

/**
 * Capture the current state of all active agents into recovery_snapshots.
 * Called during pre-restart drain phase.
 */
export function snapshotActiveAgents(
  db: Database.Database,
  agents: readonly ActiveAgentInfo[],
): readonly RecoverySnapshot[] {
  if (agents.length === 0) return []

  const snapshots: RecoverySnapshot[] = []

  const insertStmt = db.prepare(
    `INSERT INTO recovery_snapshots
       (session_id, team_id, name, role, working_dir, purpose, launch_method,
        pending_tasks, recent_messages, recovery_prompt, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  )

  const getSession = db.prepare('SELECT purpose FROM sessions WHERE id = ?')

  const getPendingTasks = db.prepare(
    `SELECT subject, description, status, owner FROM tasks
     WHERE team_id = ? AND status IN ('pending', 'in_progress')
     ORDER BY id`,
  )

  const getRecentMessages = db.prepare(
    `SELECT sender_id, receiver_id, content, created_at FROM messages
     WHERE sender_id = ? OR receiver_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
  )

  const txn = db.transaction(() => {
    for (const agent of agents) {
      const session = getSession.get(agent.sessionId) as { purpose: string } | undefined
      const purpose = session?.purpose ?? null

      const tasks = getPendingTasks.all(agent.teamId) as Array<{
        subject: string
        description: string | null
        status: string
        owner: string | null
      }>
      const pendingTasks = tasks.length > 0 ? JSON.stringify(tasks) : null

      const msgs = getRecentMessages.all(
        agent.sessionId,
        agent.sessionId,
        MAX_RECENT_MESSAGES,
      ) as Array<{
        sender_id: string
        receiver_id: string | null
        content: string
        created_at: string
      }>
      // Reverse to chronological order
      msgs.reverse()
      const recentMessages = msgs.length > 0 ? JSON.stringify(msgs) : null

      const result = insertStmt.run(
        agent.sessionId,
        agent.teamId,
        agent.name,
        agent.role,
        agent.workingDir,
        purpose,
        agent.launchMethod,
        pendingTasks,
        recentMessages,
        null, // recovery_prompt generated on recovery
      )

      const id = Number(result.lastInsertRowid)
      snapshots.push({
        id,
        session_id: agent.sessionId,
        team_id: agent.teamId,
        name: agent.name,
        role: agent.role,
        working_dir: agent.workingDir,
        purpose,
        launch_method: agent.launchMethod,
        pending_tasks: pendingTasks,
        recent_messages: recentMessages,
        recovery_prompt: null,
        status: 'pending',
        created_at: new Date().toISOString(),
        recovered_at: null,
        new_session_id: null,
      })
    }
  })

  txn()

  log.info({ count: snapshots.length }, 'Snapshotted active agents for recovery')
  return snapshots
}

// ── Recovery prompt ──────────────────────────────────────────────────

/** Build a recovery prompt from a snapshot's persisted state. */
export function buildRecoveryPrompt(snapshot: RecoverySnapshot): string {
  const lines: string[] = []

  lines.push(
    '## Recovery Context',
    '',
    'You are resuming work after a scheduled restart. Your previous session was',
    `preserved and you should continue where you left off.`,
    '',
  )

  if (snapshot.purpose) {
    lines.push(`**Original Purpose:** ${snapshot.purpose}`, '')
  }

  lines.push(`**Role:** ${snapshot.role}`)
  lines.push(`**Team:** ${snapshot.team_id}`)
  lines.push(`**Working Directory:** ${snapshot.working_dir}`)
  lines.push('')

  // Pending tasks
  if (snapshot.pending_tasks) {
    try {
      const tasks = JSON.parse(snapshot.pending_tasks) as Array<{
        subject: string
        description?: string | null
        status: string
      }>
      if (tasks.length > 0) {
        lines.push('### Pending Tasks', '')
        for (const task of tasks) {
          const desc = task.description ? ` — ${task.description}` : ''
          lines.push(`- [${task.status}] ${task.subject}${desc}`)
        }
        lines.push('')
      }
    } catch {
      // Skip malformed tasks
    }
  }

  // Recent message history
  if (snapshot.recent_messages) {
    try {
      const messages = JSON.parse(snapshot.recent_messages) as Array<{
        sender_id: string
        content: string
        created_at: string
      }>
      if (messages.length > 0) {
        lines.push('### Recent Message History', '')
        for (const msg of messages) {
          lines.push(`- **${msg.sender_id}**: ${msg.content}`)
        }
        lines.push('')
      }
    } catch {
      // Skip malformed messages
    }
  }

  lines.push(
    '### Instructions',
    '',
    'Continue your assigned work. Check for any pending tasks and messages.',
    'Report progress to your team lead when you have updates.',
  )

  return lines.join('\n')
}

// ── Load / status helpers ────────────────────────────────────────────

/** Load all pending (unrecovered) snapshots from the DB. */
export function loadPendingSnapshots(db: Database.Database): readonly RecoverySnapshot[] {
  return db
    .prepare("SELECT * FROM recovery_snapshots WHERE status = 'pending' ORDER BY id")
    .all() as RecoverySnapshot[]
}

/** Mark a snapshot as successfully recovered. */
export function markSnapshotRecovered(
  db: Database.Database,
  snapshotId: number,
  newSessionId: string,
): void {
  db.prepare(
    `UPDATE recovery_snapshots
     SET status = 'recovered', new_session_id = ?, recovered_at = datetime('now')
     WHERE id = ?`,
  ).run(newSessionId, snapshotId)
}

/** Mark a snapshot as failed. */
export function markSnapshotFailed(db: Database.Database, snapshotId: number): void {
  db.prepare(
    "UPDATE recovery_snapshots SET status = 'failed', recovered_at = datetime('now') WHERE id = ?",
  ).run(snapshotId)
}

/** Expire pending snapshots older than maxAgeDays. */
export function expireOldSnapshots(db: Database.Database, maxAgeDays: number): number {
  const result = db
    .prepare(
      `UPDATE recovery_snapshots
       SET status = 'expired'
       WHERE status = 'pending'
         AND created_at < datetime('now', '-' || ? || ' days')`,
    )
    .run(maxAgeDays)
  return result.changes
}

/** Expire pending snapshots older than maxAgeHours. F3: we now use 1h by default. */
export function expireOldSnapshotsHours(db: Database.Database, maxAgeHours: number): number {
  const result = db
    .prepare(
      `UPDATE recovery_snapshots
       SET status = 'expired'
       WHERE status = 'pending'
         AND created_at < datetime('now', '-' || ? || ' hours')`,
    )
    .run(maxAgeHours)
  return result.changes
}

// ── Session ID remapping ─────────────────────────────────────────────

/** Migrate ownership references from old session ID to new session ID. */
export function remapSessionReferences(
  db: Database.Database,
  oldSessionId: string,
  newSessionId: string,
): void {
  // Remap task ownership
  db.prepare('UPDATE tasks SET owner = ? WHERE owner = ?').run(newSessionId, oldSessionId)

  // Remap shared state session references
  db.prepare('UPDATE shared_state SET session_id = ? WHERE session_id = ?').run(
    newSessionId,
    oldSessionId,
  )

  log.info({ oldSessionId, newSessionId }, 'Remapped session references')
}

// ── Recovery ─────────────────────────────────────────────────────────

/**
 * Optional spawner-capacity probe. When provided, recoverAgents short-circuits
 * remaining snapshots as soon as capacity is exhausted (active >= halfMax),
 * so a single recovery pass can't saturate the spawner and block legitimate
 * brain-driven work from starting. See F4 in plan.md.
 */
export interface RecoveryCapacityProbe {
  /** Current active-agent count. */
  getActiveCount(): number
  /** Max concurrent agents configured on the spawner. */
  getMaxConcurrent(): number
}

export interface RecoveryOptions {
  /** F4 fan-out cap (default: RECOVERY_CONCURRENCY = 2). */
  readonly concurrency?: number
  /** F4 capacity probe — stops early when spawner is half-full. */
  readonly capacityProbe?: RecoveryCapacityProbe
}

/**
 * Respawn agents from pending recovery snapshots. Bounded-parallel (default
 * concurrency 2) and optionally short-circuits when the spawner is at
 * half-capacity, so we never drain our entire concurrent-agent budget on
 * recovery alone.
 */
export async function recoverAgents(
  db: Database.Database,
  spawn: SpawnFn,
  snapshots: readonly RecoverySnapshot[],
  options?: RecoveryOptions,
): Promise<readonly RecoveryResult[]> {
  const concurrency = Math.max(1, options?.concurrency ?? RECOVERY_CONCURRENCY)
  const capacityProbe = options?.capacityProbe
  const results: RecoveryResult[] = []
  let abortRemaining = false

  const shouldShortCircuit = (): boolean => {
    if (!capacityProbe) return false
    const active = capacityProbe.getActiveCount()
    const max = capacityProbe.getMaxConcurrent()
    if (!Number.isFinite(max)) return false
    return active * 2 >= max
  }

  async function recoverOne(snapshot: RecoverySnapshot): Promise<void> {
    if (abortRemaining) {
      results.push({
        originalSessionId: snapshot.session_id,
        newSessionId: null,
        success: false,
        error: 'recovery-skipped: spawner at half-capacity',
      })
      return
    }
    const prompt = buildRecoveryPrompt(snapshot)

    // Store the generated prompt back for audit trail
    db.prepare('UPDATE recovery_snapshots SET recovery_prompt = ? WHERE id = ?').run(
      prompt,
      snapshot.id,
    )

    try {
      // Ensure team exists (it may have been cleaned up)
      const teamExists = db
        .prepare('SELECT id FROM teams WHERE id = ?')
        .get(snapshot.team_id)
      if (!teamExists) {
        db.prepare(
          "INSERT INTO teams (id, name, status) VALUES (?, ?, 'active')",
        ).run(snapshot.team_id, `recovered-${snapshot.team_id}`)
      }

      const spawnResult = await spawn({
        team_id: snapshot.team_id,
        name: `${snapshot.name}-recovered`,
        role: snapshot.role,
        prompt,
        launch_method: snapshot.launch_method as 'acp' | 'tmux' | 'detached',
        working_dir: snapshot.working_dir,
      })

      // Remap references from old → new session
      remapSessionReferences(db, snapshot.session_id, spawnResult.sessionId)

      markSnapshotRecovered(db, snapshot.id, spawnResult.sessionId)

      results.push({
        originalSessionId: snapshot.session_id,
        newSessionId: spawnResult.sessionId,
        success: true,
      })

      log.info(
        {
          originalSessionId: snapshot.session_id,
          newSessionId: spawnResult.sessionId,
          team: snapshot.team_id,
        },
        'Agent recovered from snapshot',
      )
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      markSnapshotFailed(db, snapshot.id)

      results.push({
        originalSessionId: snapshot.session_id,
        newSessionId: null,
        success: false,
        error,
      })

      // F1 + F4: once the spawner rejects for cap, stop recovery — continuing
      // just produces N more rejected results and noisy logs.
      if (err instanceof AgentCapExceededError) {
        abortRemaining = true
        log.warn(
          { active: err.active, max: err.max },
          'recovery: spawner cap reached — aborting remaining snapshot recoveries',
        )
      } else {
        log.error({ err: error, sessionId: snapshot.session_id }, 'Agent recovery failed')
      }
    }

    // Post-spawn capacity check for the NEXT snapshot.
    if (shouldShortCircuit()) {
      abortRemaining = true
      log.info(
        {
          active: capacityProbe?.getActiveCount(),
          max: capacityProbe?.getMaxConcurrent(),
        },
        'recovery: spawner at half-capacity — aborting remaining snapshot recoveries',
      )
    }
  }

  // F4: bounded-parallel worker pool. Dispatch `concurrency` workers that
  // each pull the next snapshot off a shared index until exhausted or
  // abortRemaining trips.
  let nextIndex = 0
  const workers: Promise<void>[] = []
  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (true) {
          if (abortRemaining) return
          const i = nextIndex++
          if (i >= snapshots.length) return
          await recoverOne(snapshots[i]!)
        }
      })(),
    )
  }
  await Promise.all(workers)

  return results
}
