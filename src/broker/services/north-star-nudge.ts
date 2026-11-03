/**
 * M2 (anti-drift) — session-end NORTH_STAR nudge.
 *
 * Why this exists: SCNS drifted for ~4 weeks because design intent lived
 * only in conversation. The NORTH_STAR rule ("a session that does real
 * work refreshes Current state + Next moves before it ends") had no
 * mechanical backstop. This service is that backstop — scns-native, so
 * it works identically under Copilot CLI and Claude Code.
 *
 * Mechanism: the hooks endpoint already logs every session hook through
 * `eventLog.hookReceived(...)`, which dispatches a `hook_received`
 * broker event. This service subscribes to that stream (zero changes to
 * the endpoint or its payload schema) and, on `session-end`, asks git:
 * did the working window land substantive commits (src/ or specs/)
 * WITHOUT any commit touching docs/NORTH_STAR.md?
 *
 * If yes → emit `north_star_nudged` and maintain EXACTLY ONE reminder:
 * a single GitHub issue keyed by NORTH_STAR_NUDGE_MARKER (see the test
 * header for why an issue beats a shared_state flag: the hooks are
 * fire-and-forget so state has no channel back into a session, and an
 * issue survives the daily 06:00 broker restart AND is visible to John
 * where he already works). Strict dedupe: an open reminder suppresses
 * everything; a closed one is reopened, not duplicated. A later window
 * that DID refresh NORTH_STAR closes the reminder (self-clearing).
 *
 * It is a NUDGE: it never blocks a session, never fails the hook
 * response, and is silent when things are fine.
 */

import type { EventDispatcher } from '../event-dispatcher.js'
import type { EventLog } from './event-log.js'
import { logger } from '../../shared/logger.js'
import {
  closeTrackedIssue,
  defaultIssueRunCommand,
  upsertTrackedIssue,
  type IssueRunCommand,
} from './tracked-issue.js'

const log = logger.child({ module: 'north-star-nudge' })

export const NORTH_STAR_NUDGE_MARKER = '<!-- scns-north-star-nudge -->'
export const NORTH_STAR_NUDGE_LABEL = 'scns:self-improvement'
export const NORTH_STAR_PATH = 'docs/NORTH_STAR.md'
const DEFAULT_WINDOW_HOURS = 8
const MAX_COMMITS_IN_BODY = 10

export interface WindowCommit {
  readonly sha: string
  readonly subject: string
  readonly files: readonly string[]
}

export interface NudgeDeps {
  readonly eventLog: EventLog
  readonly dispatcher: EventDispatcher
  /** The scns clone the commits land in (broker cfg.projectRoot). */
  readonly projectRoot: string
  readonly enabled: boolean
  readonly runCommand?: IssueRunCommand
  /** Sliding-window fallback when no session-start marker is known. */
  readonly windowHours?: number
  /**
   * Session-start marker: ISO timestamp the session began (the broker's
   * sessions.created_at, stamped when the first hook event auto-registered
   * the session). Return null to fall back to the sliding window.
   */
  readonly getSessionStart?: (sessionId: string) => string | null
  readonly now?: () => Date
}

export interface NudgeOutcome {
  readonly status: 'nudged' | 'cleared' | 'silent' | 'disabled' | 'error'
  readonly action?: 'created' | 'reopened'
  readonly issueNumber?: number | null
  readonly reason?: string
}

export interface NorthStarNudge {
  /** Run the session-end check directly (tests, manual probes). */
  check(sessionId: string | null): Promise<NudgeOutcome>
  /** Await every check kicked off by the subscriber so far. */
  flush(): Promise<void>
  stop(): void
}

// ── Pure helpers ─────────────────────────────────────────────────────

/** Parse `git log --name-only --pretty=format:%H%x09%s` output. */
export function parseGitLogNameOnly(stdout: string): WindowCommit[] {
  const commits: WindowCommit[] = []
  let current: { sha: string; subject: string; files: string[] } | null = null
  for (const line of stdout.split('\n')) {
    const trimmed = line.trimEnd()
    if (trimmed === '') continue
    const headerMatch = trimmed.match(/^([0-9a-f]{7,40})\t(.*)$/)
    if (headerMatch) {
      current = { sha: headerMatch[1]!, subject: headerMatch[2]!, files: [] }
      commits.push(current)
    } else if (current) {
      current.files.push(trimmed)
    }
  }
  return commits
}

export interface WindowClassification {
  readonly substantive: readonly WindowCommit[]
  readonly northStarTouched: boolean
}

/** Substantive = src/ or specs/ changes; the nudge clears on any NORTH_STAR commit. */
export function classifyWindowCommits(commits: readonly WindowCommit[]): WindowClassification {
  const substantive = commits.filter((c) => c.files.some((f) => /^(src|specs)\//.test(f)))
  const northStarTouched = commits.some((c) => c.files.includes(NORTH_STAR_PATH))
  return { substantive, northStarTouched }
}

function buildReminderBody(windowStart: string, substantive: readonly WindowCommit[]): string {
  const listed = substantive.slice(0, MAX_COMMITS_IN_BODY)
  const lines = [
    'A working session ended after landing substantive changes without refreshing',
    '`docs/NORTH_STAR.md`. The NORTH_STAR rule: a session that does real work updates',
    '"Current state" and "Next moves" before it ends, so design intent lives in a',
    'versioned document instead of only in a conversation.',
    '',
    `Commits since ${windowStart} that touched \`src/\` or \`specs/\`:`,
    '',
    ...listed.map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.subject}`),
  ]
  if (substantive.length > listed.length) {
    lines.push(`- … and ${substantive.length - listed.length} more`)
  }
  lines.push(
    '',
    'What to do: in the next working session, refresh the "Current state" and',
    '"Next moves" sections of `docs/NORTH_STAR.md` to match what actually landed,',
    'then close this issue (a session-end that includes a NORTH_STAR commit also',
    'closes it automatically).',
    '',
    'Filed automatically by the SCNS broker (north-star-nudge, session-end hook).',
  )
  return lines.join('\n')
}

// ── Service ──────────────────────────────────────────────────────────

export function createNorthStarNudge(deps: NudgeDeps): NorthStarNudge {
  const run = deps.runCommand ?? defaultIssueRunCommand
  const windowHours = deps.windowHours ?? DEFAULT_WINDOW_HOURS
  const now = deps.now ?? (() => new Date())

  const locator = {
    marker: NORTH_STAR_NUDGE_MARKER,
    label: NORTH_STAR_NUDGE_LABEL,
    cwd: deps.projectRoot,
    run,
  }

  async function runCheck(sessionId: string | null): Promise<NudgeOutcome> {
    if (!deps.enabled) return { status: 'disabled' }

    const markerStart = sessionId ? (deps.getSessionStart?.(sessionId) ?? null) : null
    const windowStart =
      markerStart ?? new Date(now().getTime() - windowHours * 3_600_000).toISOString()

    // --all: sessions commit on topic/worktree branches — the broker
    // clone's checked-out HEAD would miss both the offense and the
    // self-clearing NORTH_STAR refresh.
    const gitLog = await run(
      'git',
      ['log', '--all', `--since=${windowStart}`, '--name-only', '--pretty=format:%H%x09%s'],
      deps.projectRoot,
    )
    if (!gitLog.ok) {
      log.warn({ sessionId, stderr: gitLog.stderr }, 'north-star nudge: git log failed')
      return { status: 'error', reason: gitLog.stderr }
    }

    const { substantive, northStarTouched } = classifyWindowCommits(
      parseGitLogNameOnly(gitLog.stdout),
    )

    // The gh conversation can fail (outage, missing label, auth). A nudge
    // must degrade to a warning — never throw at a manual check() caller
    // and never fail the hook path.
    try {
      if (northStarTouched) {
        // Self-clearing: a refresh landed — close the reminder if one is open.
        const closed = await closeTrackedIssue({
          ...locator,
          comment:
            'docs/NORTH_STAR.md was refreshed in a commit inside the latest working window — closing automatically.',
        })
        if (closed.closed) {
          deps.eventLog.northStarNudgeCleared(sessionId, { issue_number: closed.issueNumber })
          log.info({ sessionId, issueNumber: closed.issueNumber }, 'north-star nudge cleared')
          return { status: 'cleared', issueNumber: closed.issueNumber }
        }
        return { status: 'silent', reason: 'north-star-touched' }
      }

      if (substantive.length === 0) {
        return { status: 'silent', reason: 'no-substantive-commits' }
      }

      const upsert = await upsertTrackedIssue({
        ...locator,
        title: 'Refresh docs/NORTH_STAR.md — sessions are landing changes without it',
        body: buildReminderBody(windowStart, substantive),
        // Strict dedupe: while one reminder is open, later offending
        // sessions stay completely silent — no edits, no comments.
        onOpen: 'skip',
      })

      if (upsert.action === 'unchanged') {
        return {
          status: 'silent',
          reason: 'reminder-already-open',
          issueNumber: upsert.issueNumber,
        }
      }

      const action = upsert.action === 'reopened' ? 'reopened' : 'created'
      deps.eventLog.northStarNudged(sessionId, {
        action,
        issue_number: upsert.issueNumber,
        window_start: windowStart,
        substantive_commits: substantive.length,
        shas: substantive.slice(0, MAX_COMMITS_IN_BODY).map((c) => c.sha.slice(0, 7)),
      })
      log.info(
        { sessionId, action, issueNumber: upsert.issueNumber, commits: substantive.length },
        'north-star nudge filed',
      )
      return { status: 'nudged', action, issueNumber: upsert.issueNumber }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log.warn({ sessionId, reason }, 'north-star nudge: gh conversation failed')
      return { status: 'error', reason }
    }
  }

  // All checks run strictly one at a time. Session-end can be delivered
  // more than once for one session (extension + CLI hooks), and two
  // sessions can end within the find-then-create window of the upsert —
  // unserialized, both would list "no reminder" and file duplicates.
  let queue: Promise<unknown> = Promise.resolve()
  function check(sessionId: string | null): Promise<NudgeOutcome> {
    const next = queue.then(() => runCheck(sessionId))
    queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const unsubscribe = deps.dispatcher.subscribe({ event_types: ['hook_received'] }, (event) => {
    let hookEvent: unknown
    try {
      hookEvent = (JSON.parse(event.payload) as Record<string, unknown>)['hookEvent']
    } catch {
      return
    }
    if (hookEvent !== 'session-end') return
    check(event.session_id).catch((err) => {
      // A nudge failure must never propagate into the dispatcher.
      log.warn({ err, sessionId: event.session_id }, 'north-star nudge check failed')
    })
  })

  log.info(
    { enabled: deps.enabled, projectRoot: deps.projectRoot, windowHours },
    'north-star nudge: subscribed to session-end hooks',
  )

  return {
    check,
    async flush(): Promise<void> {
      let tail: Promise<unknown>
      do {
        tail = queue
        await tail.catch(() => undefined)
      } while (tail !== queue)
    },
    stop(): void {
      unsubscribe()
    },
  }
}
