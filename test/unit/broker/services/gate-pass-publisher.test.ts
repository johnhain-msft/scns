/**
 * F1 — Gate-PASS Publisher tests.
 *
 * Two test surfaces (mirrors auto-merger.test.ts):
 *   1) Pure-function tests for `publishGatePassBranch` with a scripted
 *      execFile-style fake run — asserts the exact git/gh command
 *      sequence, the idempotency check, and every failure shape.
 *   2) Event-driven factory tests: a real dispatcher + event log, a
 *      synthetic `quality_gate_verdict` dispatched, and the emitted
 *      `gate_published` / `gate_publish_failed` audit events asserted.
 *
 * Non-negotiables pinned here:
 *   - only `scns/auto/*` branches are ever pushed; never main
 *   - a verdict replay must NOT open a duplicate PR (pr-exists skip)
 *   - a publish failure emits an audit event but never throws into the
 *     dispatcher (the verdict is already decided — publishing is post-verdict)
 */

import { describe, it, expect } from 'vitest'

import {
  createGatePassPublisher,
  publishGatePassBranch,
  buildPrBody,
  type PublishRunCommand,
  type PublishRunResult,
} from '../../../../src/broker/services/gate-pass-publisher.js'
import { createEventDispatcher } from '../../../../src/broker/event-dispatcher.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'

function ok(stdout: string, stderr = ''): PublishRunResult {
  return { ok: true, stdout, stderr }
}
function err(code: number, stdout = '', stderr = ''): PublishRunResult {
  return { ok: false, stdout, stderr, code }
}

interface RecordedCall {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
}

/**
 * Build a recording fake run from a router over (file, args). Every call
 * is captured so tests can assert exactly which commands ran (and which
 * did NOT — e.g. no push after a pr-exists skip).
 */
function fakeRun(router: (file: string, args: readonly string[]) => PublishRunResult): {
  run: PublishRunCommand
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const run: PublishRunCommand = (file, args, cwd) => {
    calls.push({ file, args, cwd })
    return Promise.resolve(router(file, args))
  }
  return { run, calls }
}

const EVIDENCE = {
  teamId: 'team-selfissue-task-123-abc',
  score: 1,
  reason: 'ok',
  qualityCheckId: 'qc-42',
  sourceIssueNumber: 2,
}

const BRANCH = 'scns/auto/team-selfissue-task-123-abc-xyz'
const PR_URL = 'https://github.com/example-org/Cosmere_RPG/pull/1'

/** Router for the full happy path: remote ok, no existing PR, push ok, create ok. */
function happyRouter(file: string, args: readonly string[]): PublishRunResult {
  if (file === 'git' && args[0] === 'remote') {
    return ok('https://github.com/example-org/Cosmere_RPG.git\n')
  }
  if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') return ok('[]\n')
  if (file === 'git' && args[0] === 'push') return ok('')
  if (file === 'git' && args[0] === 'log') return ok('feat: apply team artifact\n')
  if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
    return ok(PR_URL + '\n')
  }
  return err(1, '', `unexpected command: ${file} ${args.join(' ')}`)
}

// ──────────────────────────────────────────────────────────────────────
// Part 1 — publishGatePassBranch (pure command orchestration)
// ──────────────────────────────────────────────────────────────────────

describe('publishGatePassBranch', () => {
  it('pushes the branch and opens a PR carrying the verdict evidence', async () => {
    const { run, calls } = fakeRun(happyRouter)
    const outcome = await publishGatePassBranch(run, BRANCH, '/repo', EVIDENCE)

    expect(outcome.status).toBe('published')
    if (outcome.status === 'published') expect(outcome.prUrl).toBe(PR_URL)

    // Exact push shape: plain branch push to origin, never force, never main.
    const push = calls.find((c) => c.file === 'git' && c.args[0] === 'push')
    expect(push).toBeDefined()
    expect(push!.args).toEqual(['push', 'origin', BRANCH])
    expect(push!.cwd).toBe('/repo')

    // PR create carries title + body with the evidence fields.
    const create = calls.find((c) => c.file === 'gh' && c.args[1] === 'create')
    expect(create).toBeDefined()
    const bodyIdx = create!.args.indexOf('--body')
    expect(bodyIdx).toBeGreaterThan(-1)
    const body = create!.args[bodyIdx + 1]!
    expect(body).toContain('qc-42')
    expect(body).toContain('Closes #2')
    expect(body).toContain(EVIDENCE.teamId)
    // Head must be the scns/auto branch, base left to the repo default.
    const headIdx = create!.args.indexOf('--head')
    expect(create!.args[headIdx + 1]).toBe(BRANCH)
    expect(create!.args).not.toContain('--base')
  })

  it('refuses to publish a non-scns/auto branch without running any command', async () => {
    const { run, calls } = fakeRun(happyRouter)
    const outcome = await publishGatePassBranch(run, 'main', '/repo', EVIDENCE)
    expect(outcome.status).toBe('skipped')
    if (outcome.status === 'skipped') expect(outcome.reason).toBe('not-auto-branch')
    expect(calls).toHaveLength(0)
  })

  it('skips (does not fail) when the repo has no origin remote', async () => {
    const { run, calls } = fakeRun((file, args) =>
      file === 'git' && args[0] === 'remote' ? err(2, '', 'error: No such remote') : ok(''),
    )
    const outcome = await publishGatePassBranch(run, BRANCH, '/repo', EVIDENCE)
    expect(outcome.status).toBe('skipped')
    if (outcome.status === 'skipped') expect(outcome.reason).toBe('no-remote')
    // Nothing after the remote check may run.
    expect(calls.filter((c) => c.file === 'gh')).toHaveLength(0)
    expect(calls.filter((c) => c.args[0] === 'push')).toHaveLength(0)
  })

  it('is idempotent: an existing PR (any state) skips push and create', async () => {
    const { run, calls } = fakeRun((file, args) => {
      if (file === 'git' && args[0] === 'remote') return ok('git@github.com:o/r.git\n')
      if (file === 'gh' && args[1] === 'list')
        return ok(JSON.stringify([{ number: 7, url: PR_URL }]))
      return err(1, '', 'must not run')
    })
    const outcome = await publishGatePassBranch(run, BRANCH, '/repo', EVIDENCE)
    expect(outcome.status).toBe('skipped')
    if (outcome.status === 'skipped') {
      expect(outcome.reason).toBe('pr-exists')
      expect(outcome.prUrl).toBe(PR_URL)
    }
    expect(calls.filter((c) => c.args[0] === 'push')).toHaveLength(0)
    expect(calls.filter((c) => c.args[1] === 'create')).toHaveLength(0)
    // The idempotency probe must look at ALL states so a closed PR is
    // not re-opened by a verdict replay.
    const list = calls.find((c) => c.file === 'gh' && c.args[1] === 'list')!
    const stateIdx = list.args.indexOf('--state')
    expect(list.args[stateIdx + 1]).toBe('all')
  })

  it('fails at pr-list when gh cannot answer (no blind push without the idempotency probe)', async () => {
    const { run, calls } = fakeRun((file, args) => {
      if (file === 'git' && args[0] === 'remote') return ok('git@github.com:o/r.git\n')
      if (file === 'gh' && args[1] === 'list') return err(4, '', 'gh: not logged in')
      return ok('')
    })
    const outcome = await publishGatePassBranch(run, BRANCH, '/repo', EVIDENCE)
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.step).toBe('pr-list')
    expect(calls.filter((c) => c.args[0] === 'push')).toHaveLength(0)
  })

  it('fails at push and never reaches pr-create', async () => {
    const { run, calls } = fakeRun((file, args) => {
      if (file === 'git' && args[0] === 'remote') return ok('git@github.com:o/r.git\n')
      if (file === 'gh' && args[1] === 'list') return ok('[]')
      if (file === 'git' && args[0] === 'push') return err(128, '', 'permission denied')
      return ok('')
    })
    const outcome = await publishGatePassBranch(run, BRANCH, '/repo', EVIDENCE)
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.step).toBe('push')
      expect(outcome.detail).toContain('permission denied')
    }
    expect(calls.filter((c) => c.args[1] === 'create')).toHaveLength(0)
  })

  it('fails at pr-create after a successful push', async () => {
    const { run } = fakeRun((file, args) => {
      if (file === 'git' && args[0] === 'remote') return ok('git@github.com:o/r.git\n')
      if (file === 'gh' && args[1] === 'list') return ok('[]')
      if (file === 'git' && args[0] === 'push') return ok('')
      if (file === 'git' && args[0] === 'log') return ok('feat: x\n')
      if (file === 'gh' && args[1] === 'create') return err(1, '', 'validation failed')
      return ok('')
    })
    const outcome = await publishGatePassBranch(run, BRANCH, '/repo', EVIDENCE)
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.step).toBe('pr-create')
  })

  it('falls back to a generated title when the branch has no readable subject', async () => {
    const { run, calls } = fakeRun((file, args) => {
      if (file === 'git' && args[0] === 'log') return err(128, '', 'unknown revision')
      return happyRouter(file, args)
    })
    const outcome = await publishGatePassBranch(run, BRANCH, '/repo', EVIDENCE)
    expect(outcome.status).toBe('published')
    const create = calls.find((c) => c.args[1] === 'create')!
    const titleIdx = create.args.indexOf('--title')
    expect(create.args[titleIdx + 1]).toContain(BRANCH)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Issue-keyed dedupe (John, 2026-08-11): one AUTO PR per source issue,
// first-PASS-wins — a later PASS wave on a DIFFERENT branch for the same
// issue must not open a second `Closes #N` PR. Live precedent: team
// …qfzdf5 produced two PASS branches for issue #2.
// ──────────────────────────────────────────────────────────────────────

describe('publishGatePassBranch — issue-keyed dedupe', () => {
  /** Router where the branch probe is empty but another auto-PR already closes the issue. */
  function issueDupRouter(existingBody: string, headRefName = 'scns/auto/other-earlier-branch') {
    return (file: string, args: readonly string[]): PublishRunResult => {
      if (file === 'gh' && args[1] === 'list' && args.includes('--head')) return ok('[]')
      if (file === 'gh' && args[1] === 'list') {
        return ok(JSON.stringify([{ number: 16, url: PR_URL, body: existingBody, headRefName }]))
      }
      return happyRouter(file, args)
    }
  }

  it('skips when another auto-PR already closes the same issue (first-PASS-wins)', async () => {
    const { run, calls } = fakeRun(issueDupRouter('evidence…\n\nCloses #2\n\nfooter'))
    const outcome = await publishGatePassBranch(run, BRANCH, '/repo', EVIDENCE)
    expect(outcome.status).toBe('skipped')
    if (outcome.status === 'skipped') {
      expect(outcome.reason).toBe('issue-pr-exists')
      expect(outcome.prUrl).toBe(PR_URL)
    }
    expect(calls.filter((c) => c.args[0] === 'push')).toHaveLength(0)
    expect(calls.filter((c) => c.args[1] === 'create')).toHaveLength(0)
    // The probe must consider closed/merged PRs too (a rejected artifact must
    // not respawn as a fresh PR on the next wave).
    const probe = calls.find(
      (c) => c.file === 'gh' && c.args[1] === 'list' && !c.args.includes('--head'),
    )!
    const stateIdx = probe.args.indexOf('--state')
    expect(probe.args[stateIdx + 1]).toBe('all')
  })

  it('does not confuse "Closes #23" with issue #2', async () => {
    const { run } = fakeRun(issueDupRouter('Closes #23'))
    const outcome = await publishGatePassBranch(run, BRANCH, '/repo', EVIDENCE)
    expect(outcome.status).toBe('published')
  })

  it('ignores non-auto PRs that mention the issue (human PRs never suppress the artifact)', async () => {
    const { run } = fakeRun(issueDupRouter('Closes #2', 'feature/human-fix'))
    const outcome = await publishGatePassBranch(run, BRANCH, '/repo', EVIDENCE)
    expect(outcome.status).toBe('published')
  })

  it('fails closed when the issue probe cannot answer (no blind second PR)', async () => {
    const { run, calls } = fakeRun((file, args) => {
      if (file === 'gh' && args[1] === 'list' && args.includes('--head')) return ok('[]')
      if (file === 'gh' && args[1] === 'list') return err(4, '', 'gh: server error')
      return happyRouter(file, args)
    })
    const outcome = await publishGatePassBranch(run, BRANCH, '/repo', EVIDENCE)
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.step).toBe('issue-pr-list')
    expect(calls.filter((c) => c.args[0] === 'push')).toHaveLength(0)
  })

  it('skips the issue probe entirely when no source issue resolved', async () => {
    const { run, calls } = fakeRun(happyRouter)
    const outcome = await publishGatePassBranch(run, BRANCH, '/repo', {
      ...EVIDENCE,
      sourceIssueNumber: null,
    })
    expect(outcome.status).toBe('published')
    const listCalls = calls.filter((c) => c.file === 'gh' && c.args[1] === 'list')
    expect(listCalls).toHaveLength(1)
    expect(listCalls[0]!.args).toContain('--head')
  })
})

describe('buildPrBody', () => {
  it('includes verdict evidence and the Closes line', () => {
    const body = buildPrBody(BRANCH, EVIDENCE)
    expect(body).toContain('qc-42')
    expect(body).toContain('score')
    expect(body).toContain('Closes #2')
    expect(body).toContain(BRANCH)
  })

  it('omits the Closes line when there is no source issue', () => {
    const body = buildPrBody(BRANCH, { ...EVIDENCE, sourceIssueNumber: null })
    expect(body).not.toContain('Closes #')
  })
})

// ──────────────────────────────────────────────────────────────────────
// Part 2 — event-driven factory
// ──────────────────────────────────────────────────────────────────────

function verdictEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    event_type: 'quality_gate_verdict' as const,
    session_id: null,
    team_id: EVIDENCE.teamId,
    payload: JSON.stringify({
      team_id: EVIDENCE.teamId,
      passed: true,
      branch: BRANCH,
      score: 1,
      reason: 'ok',
      qualityCheckId: 'qc-42',
      ...overrides,
    }),
    created_at: new Date().toISOString(),
  }
}

describe('createGatePassPublisher (event-driven)', () => {
  it('publishes on a PASS verdict and emits gate_published with the PR URL', async () => {
    const testDb = createBrokerTestDb()
    try {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const { run } = fakeRun(happyRouter)
      const publisher = createGatePassPublisher({
        eventLog,
        dispatcher,
        projectRoot: '/repo',
        enabled: true,
        runCommand: run,
        resolveSourceIssue: (teamId) => (teamId === EVIDENCE.teamId ? 2 : null),
      })
      dispatcher.dispatch(verdictEvent())
      await publisher.flush()
      publisher.stop()

      const published = eventLog.since(0).find((e) => e.event_type === 'gate_published')
      expect(published).toBeDefined()
      const payload = JSON.parse(published!.payload)
      expect(payload.branch).toBe(BRANCH)
      expect(payload.team_id).toBe(EVIDENCE.teamId)
      expect(payload.pr_url).toBe(PR_URL)
      expect(payload.source_issue_number).toBe(2)
      expect(payload.quality_check_id).toBe('qc-42')
    } finally {
      testDb.close()
    }
  })

  it('a verdict replay does not open a duplicate PR (second run skips on pr-exists)', async () => {
    const testDb = createBrokerTestDb()
    try {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      let created = false
      const { run, calls } = fakeRun((file, args) => {
        if (file === 'gh' && args[1] === 'list') {
          return created ? ok(JSON.stringify([{ number: 1, url: PR_URL }])) : ok('[]')
        }
        if (file === 'gh' && args[1] === 'create') {
          created = true
          return ok(PR_URL + '\n')
        }
        return happyRouter(file, args)
      })
      const publisher = createGatePassPublisher({
        eventLog,
        dispatcher,
        projectRoot: '/repo',
        enabled: true,
        runCommand: run,
      })
      dispatcher.dispatch(verdictEvent())
      await publisher.flush()
      dispatcher.dispatch({ ...verdictEvent(), id: 2 })
      await publisher.flush()
      publisher.stop()

      expect(calls.filter((c) => c.args[1] === 'create')).toHaveLength(1)
      const publishedEvents = eventLog.since(0).filter((e) => e.event_type === 'gate_published')
      expect(publishedEvents).toHaveLength(1)
    } finally {
      testDb.close()
    }
  })

  it('emits gate_publish_failed (and does not throw) when the push fails', async () => {
    const testDb = createBrokerTestDb()
    try {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const { run } = fakeRun((file, args) => {
        if (file === 'git' && args[0] === 'push') return err(128, '', 'no route to host')
        return happyRouter(file, args)
      })
      const publisher = createGatePassPublisher({
        eventLog,
        dispatcher,
        projectRoot: '/repo',
        enabled: true,
        runCommand: run,
      })
      dispatcher.dispatch(verdictEvent())
      await publisher.flush()
      publisher.stop()

      const failed = eventLog.since(0).find((e) => e.event_type === 'gate_publish_failed')
      expect(failed).toBeDefined()
      const payload = JSON.parse(failed!.payload)
      expect(payload.branch).toBe(BRANCH)
      expect(payload.step).toBe('push')
      expect(payload.detail).toContain('no route to host')
      expect(eventLog.since(0).find((e) => e.event_type === 'gate_published')).toBeUndefined()
    } finally {
      testDb.close()
    }
  })

  it('ignores FAIL verdicts and non-scns/auto branches', async () => {
    const testDb = createBrokerTestDb()
    try {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const { run, calls } = fakeRun(happyRouter)
      const publisher = createGatePassPublisher({
        eventLog,
        dispatcher,
        projectRoot: '/repo',
        enabled: true,
        runCommand: run,
      })
      dispatcher.dispatch(verdictEvent({ passed: false }))
      dispatcher.dispatch({ ...verdictEvent({ branch: 'feature/manual' }), id: 2 })
      dispatcher.dispatch({ ...verdictEvent({ branch: null }), id: 3 })
      await publisher.flush()
      publisher.stop()

      expect(calls).toHaveLength(0)
      expect(eventLog.since(0).filter((e) => e.event_type === 'gate_published')).toHaveLength(0)
    } finally {
      testDb.close()
    }
  })

  it('does nothing when disabled', async () => {
    const testDb = createBrokerTestDb()
    try {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const { run, calls } = fakeRun(happyRouter)
      const publisher = createGatePassPublisher({
        eventLog,
        dispatcher,
        projectRoot: '/repo',
        enabled: false,
        runCommand: run,
      })
      dispatcher.dispatch(verdictEvent())
      await publisher.flush()
      publisher.stop()

      expect(calls).toHaveLength(0)
      expect(eventLog.since(0).filter((e) => e.event_type === 'gate_published')).toHaveLength(0)
    } finally {
      testDb.close()
    }
  })

  it('publishes even when no source issue resolves (evidence omits Closes)', async () => {
    const testDb = createBrokerTestDb()
    try {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const { run, calls } = fakeRun(happyRouter)
      const publisher = createGatePassPublisher({
        eventLog,
        dispatcher,
        projectRoot: '/repo',
        enabled: true,
        runCommand: run,
        // no resolveSourceIssue at all
      })
      dispatcher.dispatch(verdictEvent())
      await publisher.flush()
      publisher.stop()

      const create = calls.find((c) => c.args[1] === 'create')!
      const body = create.args[create.args.indexOf('--body') + 1]!
      expect(body).not.toContain('Closes #')
      expect(eventLog.since(0).find((e) => e.event_type === 'gate_published')).toBeDefined()
    } finally {
      testDb.close()
    }
  })
})
