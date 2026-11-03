/**
 * Project work-context snapshot — the evidence a relevance decision may rest on.
 *
 * A memory is retired because its applicability ENDED, and that claim needs evidence: which
 * sessions are live, which tasks moved, what coordination is still unresolved, and what the
 * human actually said. This module gathers exactly that, project-scoped, read-only.
 *
 * The design rule is that absence is not evidence. An unreachable broker, a drifted schema or a
 * missing transcript oracle degrades {@link EvidenceCompleteness} — it never produces an empty
 * snapshot that reads like "no work found". Issue #70 (session expiry / collaboration-state
 * loss) is precisely why: a session can vanish from the broker while its coordination is very
 * much alive, so a decision derived from silence would delete a still-applicable instruction.
 *
 * Nothing here judges a memory. It only reports what is known and what is not.
 */

import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import {
  createSessionTranscript,
  type SessionTranscript,
} from './session-transcript.js'
import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'work-context' })

/** Session statuses that count as "still doing work" rather than history. */
const LIVE_SESSION_STATUSES = new Set(['active', 'idle', 'waiting', 'running'])
/** Task statuses that are still open. */
const OPEN_TASK_STATUSES = new Set(['pending', 'in_progress', 'blocked'])
/** Task statuses that represent a finished transition. */
const CLOSED_TASK_STATUSES = new Set(['completed', 'failed', 'deleted', 'cancelled'])

const MAX_MESSAGE_CHARS = 400
const MAX_ROWS = 500

/**
 * Take one row more than the cap so a full page is distinguishable from a truncated one, then
 * hand back exactly the cap. `truncated` is the signal the caller must not swallow: the rows
 * beyond it were never read, and a guard cannot object with evidence it never saw.
 */
function capRows<T>(rows: readonly T[]): { readonly rows: readonly T[]; readonly truncated: boolean } {
  return rows.length > MAX_ROWS
    ? { rows: rows.slice(0, MAX_ROWS), truncated: true }
    : { rows, truncated: false }
}

export interface WorkSessionEvidence {
  readonly id: string
  readonly purpose: string
  readonly workingDir: string
  readonly status: string
  readonly live: boolean
  readonly archived: boolean
  readonly lastHeartbeat: string | null
  readonly createdAt: string | null
}

export interface WorkTaskEvidence {
  readonly id: number
  readonly teamId: string | null
  readonly subject: string
  readonly description: string | null
  readonly status: string
  readonly owner: string | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

export interface WorkMessageEvidence {
  readonly id: string
  readonly senderId: string | null
  readonly receiverId: string | null
  readonly content: string
  readonly createdAt: string | null
}

export interface WorkIntentEvidence {
  readonly filePath: string
  readonly sessionId: string
  readonly intent: string
  readonly declaredAt: string | null
}

/**
 * Coordination excluded on purpose because it belongs to a session that EXISTS but is outside
 * this snapshot's scope — archived, or owned by another project. Attributable, so it is not an
 * evidence gap; counted, so a scoped inventory can never be mistaken for an empty one. Content
 * is deliberately not carried: it would cross a project boundary.
 */
export interface ScopedOutCoordination {
  readonly messages: number
  readonly intents: number
  readonly tasks: number
}

export interface WorkHumanTurn {
  readonly sessionId: string
  readonly turnIndex: number
  readonly text: string
  readonly timestampMs: number | null
}

export interface EvidenceCompleteness {
  /**
   * `complete` — every source answered.
   * `partial`  — some answered; absence-based retirement is NOT supportable.
   * `unavailable` — the broker could not be read at all.
   */
  readonly level: 'complete' | 'partial' | 'unavailable'
  readonly brokerReachable: boolean
  readonly sessionsAvailable: boolean
  readonly tasksAvailable: boolean
  readonly messagesAvailable: boolean
  readonly intentsAvailable: boolean
  readonly transcriptsAvailable: boolean
  /**
   * `false` when at least one unread message or open file intent could not be attributed to any
   * session row at all — the #70 case, where the session vanished while its coordination is
   * still alive. The sources themselves read fine, but the coordination inventory the guards
   * check is TRUNCATED, so its silence is not agreement.
   */
  readonly coordinationAttributable: boolean
  /**
   * `false` when a task could not be attributed to any project. `tasks` carries no project
   * column — it is scoped through `teams.project_id` — so a task whose team is missing or
   * carries no project is a record we read but cannot place.
   */
  readonly tasksAttributable: boolean
  /**
   * `false` when a row cap truncated at least one evidence query. The rows past the cap were
   * never seen, so the inventory is a sample rather than the record — and the acceptance rule
   * is explicit that a truncated inventory is incomplete evidence, not an empty one.
   */
  readonly inventoryComplete: boolean
  /** Human-readable description of each thing we could NOT observe. */
  readonly gaps: readonly string[]
}

export interface WorkContextSnapshot {
  readonly capturedAt: string
  readonly projectId: string
  readonly projectRoot: string
  readonly brokerDbPath: string
  readonly sessions: readonly WorkSessionEvidence[]
  readonly activeSessionIds: readonly string[]
  readonly openTasks: readonly WorkTaskEvidence[]
  readonly completedTasks: readonly WorkTaskEvidence[]
  /** Tasks read from the broker whose owning project could not be determined. */
  readonly orphanedTasks: readonly WorkTaskEvidence[]
  readonly unreadMessages: readonly WorkMessageEvidence[]
  readonly openIntents: readonly WorkIntentEvidence[]
  /** Unread messages that resolve to no session row at all. Reported, never discarded. */
  readonly orphanedMessages: readonly WorkMessageEvidence[]
  /** Open file intents whose holding session row is gone. Reported, never discarded. */
  readonly orphanedIntents: readonly WorkIntentEvidence[]
  /** Attributable coordination excluded by scope (archived / another project), counted only. */
  readonly scopedOutCoordination: ScopedOutCoordination
  readonly humanTurns: readonly WorkHumanTurn[]
  readonly completeness: EvidenceCompleteness
}

export interface BuildWorkContextOptions {
  readonly projectId: string
  readonly projectRoot: string
  readonly brokerDbPath: string
  /** Copilot CLI transcript store. Defaults to the oracle's own resolution. */
  readonly transcriptPath?: string
  /** Injectable for tests; defaults to {@link createSessionTranscript}. */
  readonly openTranscript?: (path?: string) => SessionTranscript
}

function truncate(s: string | null | undefined, max: number): string {
  const text = (s ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Name the vanished sessions behind an orphan set, or say so when every endpoint was nulled. */
function describeMissingSessions(ids: readonly (string | null)[]): string {
  const named = [...new Set(ids.filter((id): id is string => id !== null))].sort()
  if (named.length === 0) return 'a session whose identity was erased with it'
  return `session ${named.join(', ')}`
}

/**
 * Whether a physical column exists on a table.
 *
 * `schema.sql` is what a broker running current code CREATES; it is not what is on disk. The
 * issue-#70 ladder columns are added by the `ALTER TABLE` migration loop in
 * `src/broker/storage/db.ts`, which only runs when that broker process next starts — so a
 * deployed database keeps the pre-#70 `messages` shape until then. This module reads broker
 * databases directly rather than through the broker, so it must run against both shapes.
 * Verified 2026-09-18: all 10 deployed broker databases on this machine still lack
 * `disposition`, and a query naming it fails the whole read with `no such column`.
 */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return cols.some((c) => c.name === column)
  } catch {
    return false
  }
}

/**
 * Capture the project's current work evidence. Read-only: the broker DB is opened `readonly`, so
 * building a snapshot can never write into a live corpus.
 */
export function buildWorkContextSnapshot(
  opts: BuildWorkContextOptions,
): WorkContextSnapshot {
  const { projectId, projectRoot, brokerDbPath } = opts
  const gaps: string[] = []

  let db: Database.Database | null = null
  let brokerReachable = false
  if (!existsSync(brokerDbPath)) {
    gaps.push(`broker database not found at ${brokerDbPath} — session evidence unavailable`)
  } else {
    try {
      db = new Database(brokerDbPath, { readonly: true, fileMustExist: true })
      brokerReachable = true
    } catch (err) {
      gaps.push(
        `broker database at ${brokerDbPath} could not be opened (${err instanceof Error ? err.message : String(err)})`,
      )
    }
  }

  let sessions: WorkSessionEvidence[] = []
  const openTasks: WorkTaskEvidence[] = []
  const completedTasks: WorkTaskEvidence[] = []
  const orphanedTasks: WorkTaskEvidence[] = []
  let scopedOutTasks = 0
  let unreadMessages: WorkMessageEvidence[] = []
  let openIntents: WorkIntentEvidence[] = []
  const orphanedMessages: WorkMessageEvidence[] = []
  const orphanedIntents: WorkIntentEvidence[] = []
  let scopedOutMessages = 0
  let scopedOutIntents = 0
  /** Every session id present in the broker DB, regardless of project or archive state. */
  const knownSessionIds = new Set<string>()
  let sessionsAvailable = false
  let tasksAvailable = false
  let messagesAvailable = false
  let intentsAvailable = false
  /** Evidence queries whose row cap was reached, so their tail was never read. */
  const truncatedSources: string[] = []

  if (db) {
    try {
      const all = db
        .prepare(
          `SELECT id, purpose, working_dir, status, last_heartbeat, created_at, archived_at
             FROM sessions WHERE project_id = ? AND archived_at IS NULL
             ORDER BY created_at DESC LIMIT ?`,
        )
        .all(projectId, MAX_ROWS + 1) as Array<{
        id: string
        purpose: string | null
        working_dir: string | null
        status: string | null
        last_heartbeat: string | null
        created_at: string | null
        archived_at: string | null
      }>
      const { rows, truncated } = capRows(all)
      if (truncated) truncatedSources.push('sessions')
      sessions = rows.map((r) => ({
        id: r.id,
        purpose: truncate(r.purpose, 200),
        workingDir: r.working_dir ?? '',
        status: r.status ?? 'unknown',
        live: LIVE_SESSION_STATUSES.has((r.status ?? '').toLowerCase()),
        archived: r.archived_at !== null,
        lastHeartbeat: r.last_heartbeat,
        createdAt: r.created_at,
      }))
      // Separate from the scoped read above: this is the set of sessions that EXIST, used to
      // tell "outside this snapshot's scope" (attributable) from "gone" (an evidence gap).
      // One TEXT column over a GC-bounded table, so it is not worth a row cap.
      for (const r of db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>) {
        knownSessionIds.add(r.id)
      }
      sessionsAvailable = true
    } catch (err) {
      gaps.push(`sessions could not be read (${err instanceof Error ? err.message : String(err)})`)
    }

    try {
      const all = db
        .prepare(
          `SELECT t.id, t.team_id, t.subject, t.description, t.status, t.owner,
                  t.created_at, t.updated_at, tm.project_id AS team_project_id
             FROM tasks t LEFT JOIN teams tm ON tm.id = t.team_id
            ORDER BY t.updated_at DESC LIMIT ?`,
        )
        .all(MAX_ROWS + 1) as Array<{
        id: number
        team_id: string | null
        subject: string | null
        description: string | null
        status: string | null
        owner: string | null
        created_at: string | null
        updated_at: string | null
        team_project_id: string | null
      }>
      const { rows, truncated } = capRows(all)
      if (truncated) truncatedSources.push('task transitions')
      for (const r of rows) {
        const task: WorkTaskEvidence = {
          id: r.id,
          teamId: r.team_id,
          subject: truncate(r.subject, 200),
          description: r.description ? truncate(r.description, 400) : null,
          status: r.status ?? 'unknown',
          owner: r.owner,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }
        // `tasks` has no project column of its own; it is scoped through its team.
        if (r.team_project_id === null) {
          // Team row missing, or a team that was never bound to a project. Read, not placed.
          orphanedTasks.push(task)
          continue
        }
        if (r.team_project_id !== projectId) {
          scopedOutTasks += 1
          continue
        }
        const status = (r.status ?? '').toLowerCase()
        if (OPEN_TASK_STATUSES.has(status)) openTasks.push(task)
        else if (CLOSED_TASK_STATUSES.has(status)) completedTasks.push(task)
      }
      tasksAvailable = true
    } catch (err) {
      gaps.push(`tasks could not be read (${err instanceof Error ? err.message : String(err)})`)
    }

    const sessionIds = new Set(sessions.map((s) => s.id))
    try {
      // Issue #70 turned "read" into a ladder: delivered_at -> read_at -> disposition.
      // Unresolved means NEITHER read NOR disposed, mirroring the broker's own retention
      // invariant in `countRetainedMessagesForSession` (message-repository.ts). Delivery is
      // deliberately not settlement: reaching the recipient's context is not a verdict.
      // On a pre-#70 database the column is absent and `read_at IS NULL` is already the
      // complete definition of unsettled, since no disposition can exist there — a narrower
      // predicate, not a degraded one, so it is not reported as an evidence gap.
      const settled = hasColumn(db, 'messages', 'disposition')
        ? 'read_at IS NULL AND disposition IS NULL'
        : 'read_at IS NULL'
      const all = db
        .prepare(
          `SELECT id, sender_id, receiver_id, content, created_at
             FROM messages WHERE ${settled}
             ORDER BY created_at DESC LIMIT ?`,
        )
        .all(MAX_ROWS + 1) as Array<{
        id: string
        sender_id: string | null
        receiver_id: string | null
        content: string | null
        created_at: string | null
      }>
      const { rows, truncated } = capRows(all)
      if (truncated) truncatedSources.push('unread messages')
      unreadMessages = []
      for (const r of rows) {
        const evidence: WorkMessageEvidence = {
          id: r.id,
          senderId: r.sender_id,
          receiverId: r.receiver_id,
          content: truncate(r.content, MAX_MESSAGE_CHARS),
          createdAt: r.created_at,
        }
        if (!sessionsAvailable) {
          // Without the session list there is nothing to scope against, and dropping rows on a
          // guess would be the very absence-as-evidence this module refuses. Keep them all;
          // `sessionsAvailable: false` already tells the guards the snapshot is blind.
          unreadMessages.push(evidence)
          continue
        }
        const endpoints = [r.sender_id, r.receiver_id].filter(
          (id): id is string => id !== null,
        )
        if (endpoints.some((id) => sessionIds.has(id))) {
          unreadMessages.push(evidence)
        } else if (endpoints.some((id) => knownSessionIds.has(id))) {
          // The session exists — archived, or another project's. Excluding it is scoping.
          scopedOutMessages += 1
        } else {
          // No endpoint resolves to any session row (including both endpoints nulled by
          // `messages.sender_id/receiver_id REFERENCES sessions(id) ON DELETE SET NULL`).
          orphanedMessages.push(evidence)
        }
      }
      messagesAvailable = true
    } catch (err) {
      gaps.push(`messages could not be read (${err instanceof Error ? err.message : String(err)})`)
    }

    try {
      const all = db
        .prepare(
          `SELECT file_path, session_id, intent, declared_at FROM file_intents
             ORDER BY declared_at DESC LIMIT ?`,
        )
        .all(MAX_ROWS + 1) as Array<{
        file_path: string
        session_id: string
        intent: string | null
        declared_at: string | null
      }>
      const { rows, truncated } = capRows(all)
      if (truncated) truncatedSources.push('open file intents')
      openIntents = []
      for (const r of rows) {
        const evidence: WorkIntentEvidence = {
          filePath: r.file_path,
          sessionId: r.session_id,
          intent: r.intent ?? 'edit',
          declaredAt: r.declared_at,
        }
        if (!sessionsAvailable || sessionIds.has(r.session_id)) {
          openIntents.push(evidence)
        } else if (knownSessionIds.has(r.session_id)) {
          scopedOutIntents += 1
        } else {
          orphanedIntents.push(evidence)
        }
      }
      intentsAvailable = true
    } catch (err) {
      gaps.push(
        `file intents could not be read (${err instanceof Error ? err.message : String(err)})`,
      )
    }

    try {
      db.close()
    } catch {
      /* already closed */
    }
  }

  // Human turns — the transcript ORACLE, not a shape classifier.
  const humanTurns: WorkHumanTurn[] = []
  let transcriptsAvailable = false
  const openTranscript =
    opts.openTranscript ??
    ((path?: string) => createSessionTranscript(path ? { path } : {}))
  const transcript = openTranscript(opts.transcriptPath)
  try {
    if (transcript.mode === 'oracle') {
      transcriptsAvailable = true
      for (const session of sessions) {
        for (const turn of transcript.humanTurns(session.id)) {
          if (!turn.text) continue
          humanTurns.push({
            sessionId: session.id,
            turnIndex: turn.turnIndex,
            text: truncate(turn.text, 1000),
            timestampMs: turn.timestampMs,
          })
        }
      }
    } else {
      gaps.push(`human-turn transcript unavailable: ${transcript.reason}`)
    }
  } finally {
    transcript.close()
  }

  // Orphaned coordination is unobserved evidence, not absent evidence: the rows are real and
  // unresolved, but the session that would explain them is gone. Naming them here is what stops
  // a truncated inventory from being read as an empty one.
  const coordinationAttributable = orphanedMessages.length === 0 && orphanedIntents.length === 0
  const tasksAttributable = orphanedTasks.length === 0
  if (!tasksAttributable) {
    gaps.push(
      `${orphanedTasks.length} task(s) could not be attributed to a project — their team is ` +
        'missing or was never bound to one, so whether this project\u2019s work closed is unknown',
    )
  }
  const inventoryComplete = truncatedSources.length === 0
  if (!inventoryComplete) {
    gaps.push(
      `the ${truncatedSources.join(', ')} inventory hit the ${MAX_ROWS}-row cap — the rows past it ` +
        'were never read, so this is a sample of the evidence and not the whole of it',
    )
  }
  if (orphanedMessages.length > 0) {
    gaps.push(
      `${orphanedMessages.length} unread message(s) reference ${describeMissingSessions(
        orphanedMessages.flatMap((m) => [m.senderId, m.receiverId]),
      )}, no longer in the broker — the coordination is unresolved and cannot be attributed`,
    )
  }
  if (orphanedIntents.length > 0) {
    gaps.push(
      `${orphanedIntents.length} open file intent(s) are held by ${describeMissingSessions(
        orphanedIntents.map((i) => i.sessionId),
      )}, no longer in the broker — the work may still be held`,
    )
  }

  const level: EvidenceCompleteness['level'] = !brokerReachable
    ? 'unavailable'
    : gaps.length > 0
      ? 'partial'
      : 'complete'

  if (level !== 'complete') {
    log.debug({ projectId, level, gaps }, 'work-context snapshot has evidence gaps')
  }

  return {
    capturedAt: new Date().toISOString(),
    projectId,
    projectRoot,
    brokerDbPath,
    sessions,
    activeSessionIds: sessions.filter((s) => s.live).map((s) => s.id),
    openTasks,
    completedTasks,
    orphanedTasks,
    unreadMessages,
    openIntents,
    orphanedMessages,
    orphanedIntents,
    scopedOutCoordination: {
      messages: scopedOutMessages,
      intents: scopedOutIntents,
      tasks: scopedOutTasks,
    },
    humanTurns,
    completeness: {
      level,
      brokerReachable,
      sessionsAvailable,
      tasksAvailable,
      messagesAvailable,
      intentsAvailable,
      transcriptsAvailable,
      coordinationAttributable,
      tasksAttributable,
      inventoryComplete,
      gaps,
    },
  }
}

/**
 * Render the snapshot as the evidence block handed to an evaluator. Every line is an observed
 * fact with its identifier, and the gaps are stated explicitly so a model can see what it does
 * NOT know rather than filling the silence.
 */
export function summarizeWorkContext(snap: WorkContextSnapshot): string {
  const lines: string[] = []
  lines.push(`project: ${snap.projectId} (${snap.projectRoot})`)
  lines.push(`captured: ${snap.capturedAt}`)
  lines.push(`evidence completeness: ${snap.completeness.level}`)
  if (snap.completeness.gaps.length > 0) {
    lines.push('unobserved (do NOT treat as absence of the underlying work):')
    for (const gap of snap.completeness.gaps) lines.push(`  - ${gap}`)
  }

  lines.push('', `sessions (${snap.sessions.length}):`)
  for (const s of snap.sessions) {
    lines.push(
      `  - ${s.id} [${s.status}${s.live ? ', live' : ''}] purpose: ${s.purpose || '(none)'}`,
    )
  }

  lines.push('', `open tasks (${snap.openTasks.length}):`)
  for (const t of snap.openTasks) {
    lines.push(`  - task#${t.id} [${t.status}] ${t.subject}${t.owner ? ` owner=${t.owner}` : ''}`)
  }
  lines.push('', `closed tasks (${snap.completedTasks.length}):`)
  for (const t of snap.completedTasks) {
    lines.push(`  - task#${t.id} [${t.status}] ${t.subject} (updated ${t.updatedAt ?? 'unknown'})`)
  }

  lines.push('', `unresolved coordination — unread messages (${snap.unreadMessages.length}):`)
  for (const m of snap.unreadMessages) {
    lines.push(`  - ${m.id} ${m.senderId ?? '?'}→${m.receiverId ?? '?'}: ${m.content}`)
  }
  lines.push('', `open file intents (${snap.openIntents.length}):`)
  for (const i of snap.openIntents) {
    lines.push(`  - ${i.filePath} held by ${i.sessionId} (${i.intent})`)
  }

  // Coordination the scoped inventory above does NOT contain. Stated separately and always,
  // so "0 unread messages" can never be the whole story when rows were in fact set aside.
  if (snap.orphanedMessages.length > 0 || snap.orphanedIntents.length > 0) {
    lines.push(
      '',
      `unresolved coordination whose session is GONE (${snap.orphanedMessages.length} message(s), ` +
        `${snap.orphanedIntents.length} intent(s)) — unattributable, do NOT read as resolved:`,
    )
    for (const m of snap.orphanedMessages) {
      lines.push(`  - ${m.id} ${m.senderId ?? '?'}→${m.receiverId ?? '?'}: ${m.content}`)
    }
    for (const i of snap.orphanedIntents) {
      lines.push(`  - ${i.filePath} held by ${i.sessionId} (${i.intent})`)
    }
  }
  const scoped = snap.scopedOutCoordination
  if (scoped.messages > 0 || scoped.intents > 0 || scoped.tasks > 0) {
    lines.push(
      '',
      `coordination excluded as out of scope: ${scoped.messages} unread message(s), ` +
        `${scoped.intents} file intent(s), ${scoped.tasks} task(s) belong to sessions or teams ` +
        "outside this project's active set (archived, or another project). Attributable, so not " +
        'an evidence gap; content withheld.',
    )
  }
  if (snap.orphanedTasks.length > 0) {
    lines.push(
      '',
      `tasks whose owning project is UNKNOWN (${snap.orphanedTasks.length}) — do NOT read as ` +
        'this project having no such work:',
    )
    for (const t of snap.orphanedTasks) {
      lines.push(`  - task#${t.id} [${t.status}] ${t.subject} (team ${t.teamId ?? '?'})`)
    }
  }

  lines.push('', `human turns (${snap.humanTurns.length}):`)
  for (const t of snap.humanTurns) {
    lines.push(`  - ${t.sessionId}#${t.turnIndex}: ${t.text}`)
  }

  return lines.join('\n')
}
