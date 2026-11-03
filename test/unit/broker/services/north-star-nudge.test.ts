/**
 * M2 (anti-drift) — session-end NORTH_STAR nudge tests.
 *
 * Contract (handoff step 3): on a session-end hook, the broker checks
 * whether the working window landed substantive commits (src/ or specs/)
 * in the project repo WITHOUT any commit touching docs/NORTH_STAR.md.
 * If so it emits a broker event and maintains EXACTLY ONE open reminder.
 * It is a NUDGE: it never blocks a session and never spams.
 *
 * Reminder carrier: a single deduplicated GITHUB ISSUE (marker
 * `<!-- scns-north-star-nudge -->`), not a shared_state flag. Why —
 * pinned by the "stateless dedupe" test below:
 *   1. The session hooks are fire-and-forget (`curl ... > /dev/null`,
 *      src/cli/setup-hooks.ts), so a shared_state flag has NO channel
 *      back into the next session without touching the live briefing
 *      path — out of scope here and risky.
 *   2. The parent broker restarts daily at 06:00; the dedupe state must
 *      survive that. An issue lives in GitHub, so a fresh broker (or a
 *      different CLI entirely) re-derives "reminder already open" from
 *      the source of truth instead of process memory.
 *   3. John reads GitHub where he already works; the reminder doubles
 *      as the visible artifact the drift post-mortem asked for.
 */
import { describe, expect, it } from 'vitest'

import {
  classifyWindowCommits,
  createNorthStarNudge,
  parseGitLogNameOnly,
  NORTH_STAR_NUDGE_MARKER,
  type NudgeDeps,
} from '../../../../src/broker/services/north-star-nudge.js'
import type {
  IssueRunCommand,
  IssueRunResult,
} from '../../../../src/broker/services/tracked-issue.js'
import { createEventDispatcher } from '../../../../src/broker/event-dispatcher.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'

const CWD = '/repo'
const LABEL = 'scns:self-improvement'

function ok(stdout: string): IssueRunResult {
  return { ok: true, stdout, stderr: '' }
}

interface RecordedCall {
  readonly file: string
  readonly args: readonly string[]
}

/**
 * Fake runner backed by a mutable "GitHub" issue store plus a canned
 * git-log response, so multiple service instances can share one world.
 */
function fakeWorld(gitLog: string) {
  const issues: Array<{ number: number; state: string; body: string }> = []
  const calls: RecordedCall[] = []
  let nextNumber = 100
  const run: IssueRunCommand = (file, args) => {
    calls.push({ file, args })
    if (file === 'git' && args[0] === 'log') return Promise.resolve(ok(gitLog))
    if (file === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      return Promise.resolve(ok(JSON.stringify(issues)))
    }
    if (file === 'gh' && args[0] === 'issue' && args[1] === 'create') {
      const body = args[args.indexOf('--body') + 1]!
      const number = nextNumber++
      issues.push({ number, state: 'OPEN', body })
      return Promise.resolve(ok(`https://github.com/johnhain-msft/scns/issues/${number}\n`))
    }
    if (file === 'gh' && args[0] === 'issue' && args[1] === 'reopen') {
      const target = issues.find((i) => String(i.number) === args[2])
      if (target) target.state = 'OPEN'
      return Promise.resolve(ok(''))
    }
    if (file === 'gh' && args[0] === 'issue' && args[1] === 'edit') {
      const target = issues.find((i) => String(i.number) === args[2])
      if (target) target.body = args[args.indexOf('--body') + 1]!
      return Promise.resolve(ok(''))
    }
    if (file === 'gh' && args[0] === 'issue' && args[1] === 'close') {
      const target = issues.find((i) => String(i.number) === args[2])
      if (target) target.state = 'CLOSED'
      return Promise.resolve(ok(''))
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`)
  }
  return { run, calls, issues }
}

/** git log --name-only --pretty=format:%H%x09%s output shapes. */
const LOG_SUBSTANTIVE_ONLY = [
  'aaa1111\tfeat: add settle sweep guard',
  '',
  'src/broker/services/foo.ts',
  'test/unit/broker/services/foo.test.ts',
  '',
  'bbb2222\tfix: harden parser',
  '',
  'src/shared/parser.ts',
].join('\n')

const LOG_WITH_NORTH_STAR = [
  'aaa1111\tfeat: add settle sweep guard',
  '',
  'src/broker/services/foo.ts',
  '',
  'ccc3333\tdocs: refresh NORTH_STAR current state',
  '',
  'docs/NORTH_STAR.md',
].join('\n')

const LOG_DOCS_ONLY = ['ddd4444\tdocs: fix typo', '', 'docs/modules.md'].join('\n')

function harness(gitLog: string, overrides?: Partial<NudgeDeps>) {
  const { db } = createBrokerTestDb()
  const dispatcher = createEventDispatcher()
  const eventLog = createEventLog(db, dispatcher)
  const world = fakeWorld(gitLog)
  const deps: NudgeDeps = {
    eventLog,
    dispatcher,
    projectRoot: CWD,
    enabled: true,
    runCommand: world.run,
    windowHours: 8,
    now: () => new Date('2026-08-15T12:00:00Z'),
    ...overrides,
  }
  const service = createNorthStarNudge(deps)
  return { service, world, db, dispatcher, eventLog, deps }
}

function eventTypes(db: ReturnType<typeof createBrokerTestDb>['db']): string[] {
  return (
    db.prepare('SELECT event_type FROM events ORDER BY id').all() as Array<{
      event_type: string
    }>
  ).map((r) => r.event_type)
}

describe('parseGitLogNameOnly', () => {
  it('parses commits with subjects and file lists', () => {
    const commits = parseGitLogNameOnly(LOG_WITH_NORTH_STAR)
    expect(commits).toHaveLength(2)
    expect(commits[0]).toEqual({
      sha: 'aaa1111',
      subject: 'feat: add settle sweep guard',
      files: ['src/broker/services/foo.ts'],
    })
    expect(commits[1]!.files).toEqual(['docs/NORTH_STAR.md'])
  })

  it('returns no commits for empty output', () => {
    expect(parseGitLogNameOnly('')).toEqual([])
    expect(parseGitLogNameOnly('\n\n')).toEqual([])
  })
})

describe('classifyWindowCommits', () => {
  it('flags src/ and specs/ as substantive; docs are not', () => {
    const commits = parseGitLogNameOnly(LOG_DOCS_ONLY)
    const classified = classifyWindowCommits(commits)
    expect(classified.substantive).toHaveLength(0)
    expect(classified.northStarTouched).toBe(false)
  })

  it('detects a NORTH_STAR refresh anywhere in the window', () => {
    const classified = classifyWindowCommits(parseGitLogNameOnly(LOG_WITH_NORTH_STAR))
    expect(classified.substantive).toHaveLength(1)
    expect(classified.northStarTouched).toBe(true)
  })
})

describe('north-star nudge — session-end check', () => {
  it('substantive commits + no NORTH_STAR commit → exactly one nudge issue + event', async () => {
    const { service, world, db } = harness(LOG_SUBSTANTIVE_ONLY)
    const outcome = await service.check('session-1')
    expect(outcome.status).toBe('nudged')
    expect(outcome.action).toBe('created')

    const open = world.issues.filter((i) => i.state === 'OPEN')
    expect(open).toHaveLength(1)
    expect(open[0]!.body).toContain(NORTH_STAR_NUDGE_MARKER)
    expect(open[0]!.body).toContain('aaa1111')

    const create = world.calls.find((c) => c.args[1] === 'create')!
    expect(create.args).toContain(LABEL)
    expect(create.args.join(' ')).not.toContain('scns-auto')

    expect(eventTypes(db)).toContain('north_star_nudged')
  })

  it('window includes a NORTH_STAR commit → silence (a lookup only, no gh writes, no event)', async () => {
    const { service, world, db } = harness(LOG_WITH_NORTH_STAR)
    const outcome = await service.check('session-1')
    expect(outcome.status).toBe('silent')
    // The self-clearing probe may LIST issues, but with no open reminder
    // it must write nothing.
    expect(world.calls.filter((c) => c.file === 'gh' && c.args[1] !== 'list')).toHaveLength(0)
    expect(eventTypes(db)).not.toContain('north_star_nudged')
  })

  it('no substantive commits → silence without even listing issues', async () => {
    const { service, world } = harness(LOG_DOCS_ONLY)
    const outcome = await service.check('session-1')
    expect(outcome.status).toBe('silent')
    expect(world.calls.filter((c) => c.file === 'gh')).toHaveLength(0)
  })

  it('two offending sessions → still exactly one reminder (dedupe skips, no edit)', async () => {
    const { service, world } = harness(LOG_SUBSTANTIVE_ONLY)
    const first = await service.check('session-1')
    expect(first.action).toBe('created')
    const callsAfterFirst = world.calls.length

    const second = await service.check('session-2')
    expect(second.status).toBe('silent')
    expect(second.reason).toBe('reminder-already-open')
    expect(world.issues.filter((i) => i.state === 'OPEN')).toHaveLength(1)
    // Second pass performs the lookup only — no create/edit/reopen writes.
    const writes = world.calls
      .slice(callsAfterFirst)
      .filter((c) => c.file === 'gh' && c.args[1] !== 'list')
    expect(writes).toHaveLength(0)
  })

  it('dedupe is stateless across broker restarts — a fresh instance still skips', async () => {
    const { service, world } = harness(LOG_SUBSTANTIVE_ONLY)
    await service.check('session-1')

    // Same GitHub world, brand-new broker/service (daily 06:00 restart).
    const { db: db2 } = createBrokerTestDb()
    const dispatcher2 = createEventDispatcher()
    const service2 = createNorthStarNudge({
      eventLog: createEventLog(db2, dispatcher2),
      dispatcher: dispatcher2,
      projectRoot: CWD,
      enabled: true,
      runCommand: world.run,
      now: () => new Date('2026-08-15T12:00:00Z'),
    })
    const outcome = await service2.check('session-2')
    expect(outcome.status).toBe('silent')
    expect(world.issues.filter((i) => i.state === 'OPEN')).toHaveLength(1)
  })

  it('closed reminder + still offending → reopens the SAME issue', async () => {
    const { service, world } = harness(LOG_SUBSTANTIVE_ONLY)
    const first = await service.check('session-1')
    const issueNumber = first.issueNumber!
    world.issues.find((i) => i.number === issueNumber)!.state = 'CLOSED'

    const second = await service.check('session-2')
    expect(second.status).toBe('nudged')
    expect(second.action).toBe('reopened')
    expect(second.issueNumber).toBe(issueNumber)
    expect(world.issues).toHaveLength(1)
  })

  it('NORTH_STAR refreshed while a reminder is open → closes it and emits cleared', async () => {
    const offending = harness(LOG_SUBSTANTIVE_ONLY)
    await offending.service.check('session-1')
    expect(offending.world.issues.filter((i) => i.state === 'OPEN')).toHaveLength(1)

    // Next session-end sees a NORTH_STAR commit in its window; same GitHub world.
    const { db: db2 } = createBrokerTestDb()
    const dispatcher2 = createEventDispatcher()
    const eventLog2 = createEventLog(db2, dispatcher2)
    const world2 = { ...offending.world }
    const clearing = createNorthStarNudge({
      eventLog: eventLog2,
      dispatcher: dispatcher2,
      projectRoot: CWD,
      enabled: true,
      runCommand: (file, args, cwd) => {
        if (file === 'git' && args[0] === 'log') {
          return Promise.resolve(ok(LOG_WITH_NORTH_STAR))
        }
        return world2.run(file, args, cwd)
      },
      now: () => new Date('2026-08-15T12:00:00Z'),
    })
    const outcome = await clearing.check('session-2')
    expect(outcome.status).toBe('cleared')
    expect(offending.world.issues.filter((i) => i.state === 'OPEN')).toHaveLength(0)
    expect(eventTypes(db2)).toContain('north_star_nudge_cleared')
  })

  it('disabled → no git, no gh, no events', async () => {
    const { service, world, db } = harness(LOG_SUBSTANTIVE_ONLY, { enabled: false })
    const outcome = await service.check('session-1')
    expect(outcome.status).toBe('disabled')
    expect(world.calls).toHaveLength(0)
    expect(eventTypes(db)).toHaveLength(0)
  })

  it('prefers the session-start marker over the sliding window for --since', async () => {
    const { service, world } = harness(LOG_SUBSTANTIVE_ONLY, {
      getSessionStart: (id) => (id === 'session-1' ? '2026-08-15T09:30:00Z' : null),
    })
    await service.check('session-1')
    const log = world.calls.find((c) => c.file === 'git')!
    expect(log.args.join(' ')).toContain('--since=2026-08-15T09:30:00Z')

    world.calls.length = 0
    await service.check('unknown-session')
    const fallback = world.calls.find((c) => c.file === 'git')!
    // 8h sliding window from the injected clock (12:00Z).
    expect(fallback.args.join(' ')).toContain('--since=2026-08-15T04:00:00')
  })
})

describe('north-star nudge — concurrency and failure hardening', () => {
  it('concurrent session-end events cannot race a duplicate reminder', async () => {
    const { service, world } = harness(LOG_SUBSTANTIVE_ONLY)
    // Snapshot the LIST response at call time, then delay delivering it —
    // an unserialized implementation has both checks read "no reminder"
    // before either create lands, and files two issues.
    const delayedRun: IssueRunCommand = async (file, args, cwd) => {
      const result = await world.run(file, args, cwd)
      if (file === 'gh' && args[1] === 'list') {
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
      return result
    }
    const { db } = createBrokerTestDb()
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    const racy = createNorthStarNudge({
      eventLog,
      dispatcher,
      projectRoot: CWD,
      enabled: true,
      runCommand: delayedRun,
      now: () => new Date('2026-08-15T12:00:00Z'),
    })
    // Two session-ends land back-to-back (e.g. the Copilot extension and
    // the CLI hook both firing for one session).
    eventLog.hookReceived('session-1', { hookEvent: 'session-end' })
    eventLog.hookReceived('session-1', { hookEvent: 'session-end' })
    await racy.flush()
    expect(world.issues.filter((i) => i.state === 'OPEN')).toHaveLength(1)
    expect(world.calls.filter((c) => c.args[1] === 'create')).toHaveLength(1)
    racy.stop()
    service.stop()
  })

  it('a gh failure makes check() return an error outcome instead of throwing', async () => {
    const { db } = createBrokerTestDb()
    const dispatcher = createEventDispatcher()
    const service = createNorthStarNudge({
      eventLog: createEventLog(db, dispatcher),
      dispatcher,
      projectRoot: CWD,
      enabled: true,
      runCommand: (file, args) => {
        if (file === 'git') return Promise.resolve(ok(LOG_SUBSTANTIVE_ONLY))
        return Promise.resolve({
          ok: false,
          stdout: '',
          stderr: `gh outage: ${args[1]}`,
          code: 1,
        })
      },
      now: () => new Date('2026-08-15T12:00:00Z'),
    })
    const outcome = await service.check('session-1')
    expect(outcome.status).toBe('error')
    service.stop()
  })

  it('the window probe looks across ALL refs, not just the checked-out HEAD', async () => {
    // Sessions commit on worktree/topic branches; a HEAD-only git log
    // would miss both the offense and the self-clearing refresh.
    const { service, world } = harness(LOG_SUBSTANTIVE_ONLY)
    await service.check('session-1')
    const log = world.calls.find((c) => c.file === 'git')!
    expect(log.args).toContain('--all')
  })
})

describe('north-star nudge — event-driven wiring', () => {
  it('a dispatched session-end hook_received event triggers the check', async () => {
    const { service, world, eventLog } = harness(LOG_SUBSTANTIVE_ONLY)
    // The hooks endpoint calls eventLog.hookReceived(...), which dispatches
    // hook_received — the service must react to session-end only.
    eventLog.hookReceived('session-9', { hookEvent: 'tool-use' })
    await service.flush()
    expect(world.calls).toHaveLength(0)

    eventLog.hookReceived('session-9', { hookEvent: 'session-end' })
    await service.flush()
    expect(world.issues.filter((i) => i.state === 'OPEN')).toHaveLength(1)
    service.stop()
  })

  it('a git failure inside the subscriber never throws into the dispatcher', async () => {
    const { db } = createBrokerTestDb()
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    const service = createNorthStarNudge({
      eventLog,
      dispatcher,
      projectRoot: CWD,
      enabled: true,
      runCommand: () => Promise.resolve({ ok: false, stdout: '', stderr: 'not a repo', code: 128 }),
      now: () => new Date('2026-08-15T12:00:00Z'),
    })
    eventLog.hookReceived('session-9', { hookEvent: 'session-end' })
    await expect(service.flush()).resolves.toBeUndefined()
    service.stop()
  })
})
