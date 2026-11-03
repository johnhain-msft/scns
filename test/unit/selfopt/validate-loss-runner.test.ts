/**
 * Phase 1 wedge B — validate-loss runner. CI-safe: `makeWorktree`, `makeBackend`,
 * `killByPid`, `isAlive`, and `env` are ALL injected fakes, so the suite never
 * provisions a git worktree, spawns copilot, or kills a process. Proves the
 * default-OFF gating, the isolated-worktree lifecycle (always torn down, even on
 * throw), and the capture-then-reap-by-PID hygiene.
 */
import { describe, it, expect } from 'vitest'
import {
  runValidateLossWithOptIns,
  type BackendWithPid,
} from '../../../src/selfopt/validate-loss-runner.js'
import { VALIDATE_LOSS_ACP_ENV, HEADLINE_TASK } from '../../../src/selfopt/validate-loss.js'
import type { IsolatedWorktree } from '../../../src/selfopt/shadow-eval-runner.js'
import type { ReplayBackend } from '../../../src/selfopt/replay.js'
import type { TaskRecord } from '../../../src/selfopt/types.js'

const LONG_WITH_VERIFY =
  'To verify a change works, run the full test suite, reproduce the original failure, ' +
  'confirm it no longer occurs, and inspect the diff for unintended side effects across ' +
  'the affected modules and their callers before claiming that the work is truly complete.'

class FixedBackend implements ReplayBackend {
  constructor(private readonly response: string) {}
  attempt(): string {
    return this.response
  }
}

class ThrowingBackend implements ReplayBackend {
  attempt(_task: TaskRecord): string {
    throw new Error('boom — backend attempt failed')
  }
}

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv

interface WorktreeSpy extends IsolatedWorktree {
  cleanupCalls: number
}
function fakeWorktree(cwd = '/tmp/scns-validate-loss-fake-wt'): WorktreeSpy {
  const wt = {
    cwd,
    cleanupCalls: 0,
    cleanup() {
      wt.cleanupCalls++
    },
  }
  return wt
}

describe('wedge B — runValidateLossWithOptIns (default-OFF)', () => {
  it('VR-1: no opt-in ⇒ Mock candidate, no worktree, no spawn, delta 0', async () => {
    let madeWorktree = 0
    let madeBackend = 0
    const res = await runValidateLossWithOptIns({
      projectRoot: '/repo',
      env: env({}),
      makeWorktree: () => {
        madeWorktree++
        return fakeWorktree()
      },
      makeBackend: () => {
        madeBackend++
        return { backend: new FixedBackend('unused'), getPid: () => 1 }
      },
    })

    expect(madeWorktree).toBe(0) // never provisioned
    expect(madeBackend).toBe(0) // never constructed
    expect(res.spawned).toBe(false)
    expect(res.worktree).toBeNull()
    expect(res.pid).toBeNull()
    expect(res.backendLabel).toBe('mock')
    expect(res.nSpawns).toBe(0)
    expect(res.headlineDelta).toBe(0)
  })
})

describe('wedge B — runValidateLossWithOptIns (opted-in, fakes only)', () => {
  it('VR-2: spawns once, headline +1, kills the still-alive PID, removes the worktree', async () => {
    const wt = fakeWorktree()
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const bundle: BackendWithPid = {
      backend: new FixedBackend(LONG_WITH_VERIFY),
      getPid: () => 4242,
    }

    const res = await runValidateLossWithOptIns({
      projectRoot: '/repo',
      env: env({ [VALIDATE_LOSS_ACP_ENV]: '1' }),
      makeWorktree: () => wt,
      makeBackend: (cwd) => {
        expect(cwd).toBe(wt.cwd) // the isolated worktree cwd is threaded in
        return bundle
      },
      isAlive: () => true, // pretend the process is still up
      killByPid: (pid, signal) => killed.push({ pid, signal }),
    })

    expect(res.spawned).toBe(true)
    expect(res.worktree).toBe(wt.cwd)
    expect(res.backendLabel).toBe('acp')
    expect(res.nSpawns).toBe(1)
    expect(res.candidateResponse).toBe(LONG_WITH_VERIFY)
    expect(res.baselineResponse).toBe(HEADLINE_TASK.intent)
    expect(res.headlineDelta).toBe(1)
    expect(res.pid).toBe(4242)
    expect(res.killedByPid).toBe(true)
    expect(res.pidAlreadyExited).toBe(false)
    expect(killed).toEqual([{ pid: 4242, signal: 'SIGKILL' }])
    expect(wt.cleanupCalls).toBe(1) // worktree torn down
  })

  it('VR-3: a backend failure propagates AND the worktree is still removed', async () => {
    const wt = fakeWorktree()
    let killCalls = 0

    await expect(
      runValidateLossWithOptIns({
        projectRoot: '/repo',
        env: env({ [VALIDATE_LOSS_ACP_ENV]: 'true' }),
        makeWorktree: () => wt,
        makeBackend: () => ({ backend: new ThrowingBackend(), getPid: () => null }),
        isAlive: () => true,
        killByPid: () => {
          killCalls++
        },
      }),
    ).rejects.toThrow(/boom/)

    expect(wt.cleanupCalls).toBe(1) // finally still ran
    expect(killCalls).toBe(0) // no PID was captured
  })

  it('VR-4: an already-exited PID is not killed (no pkill/killall)', async () => {
    const wt = fakeWorktree()
    let killCalls = 0

    const res = await runValidateLossWithOptIns({
      projectRoot: '/repo',
      env: env({ [VALIDATE_LOSS_ACP_ENV]: 'yes' }),
      makeWorktree: () => wt,
      makeBackend: () => ({ backend: new FixedBackend(LONG_WITH_VERIFY), getPid: () => 777 }),
      isAlive: () => false, // already gone (the backend closed its client)
      killByPid: () => {
        killCalls++
      },
    })

    expect(res.pid).toBe(777)
    expect(res.pidAlreadyExited).toBe(true)
    expect(res.killedByPid).toBe(false)
    expect(killCalls).toBe(0)
    expect(wt.cleanupCalls).toBe(1)
  })
})
