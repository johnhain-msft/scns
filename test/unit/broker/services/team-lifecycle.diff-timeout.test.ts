/**
 * Bounded staged-diff collection — postmortem: broker event-loop hang
 * (2026-06-05, first live autonomous suggestion→team spawns).
 *
 * When a brain-spawned team's last ACP agent process exited, the
 * spawner's exit handler synchronously called the team-lifecycle
 * controller's handleAgentExit → emitCompletion → collectDiff, which
 * ran `git diff --cached` via execSync WITHOUT a timeout, on the main
 * thread, inside the child-process 'exit' callback.
 *
 * A `sample(1)` of the wedged broker showed the main thread parked in
 * node::SyncProcessRunner::Spawn under ProcessWrap::OnExit — i.e. a
 * synchronous child spawn that never returned. HTTP went fully
 * unresponsive (curl exit 28) and the broker had to be force-restarted;
 * the self-heal watchdog could not fire because the event loop itself
 * was blocked.
 *
 * Fix: defaultCollectStagedDiff now bounds the execSync with a finite
 * `timeout` and `killSignal: 'SIGKILL'`, so a hung git can stall the
 * loop for at most STAGED_DIFF_TIMEOUT_MS and then recovers (returning
 * an empty diff, which downstream already handles as a no-diff
 * completion). The exec is injectable so this guarantee is unit-testable
 * without spawning a real hanging process.
 */

import { describe, it, expect, vi } from 'vitest'
import type { execSync as ExecSyncType } from 'node:child_process'
import {
  defaultCollectStagedDiff,
  STAGED_DIFF_TIMEOUT_MS,
} from '../../../../src/broker/services/team-lifecycle.js'

describe('defaultCollectStagedDiff — bounded timeout (postmortem: broker hang 2026-06-05)', () => {
  it('passes a finite timeout and SIGKILL so a hung git cannot block the event loop forever', () => {
    const exec = vi.fn().mockReturnValue('diff-output')
    const out = defaultCollectStagedDiff('/some/cwd', exec as unknown as typeof ExecSyncType)

    expect(out).toBe('diff-output')
    expect(exec).toHaveBeenCalledTimes(1)

    const opts = exec.mock.calls[0]![1] as { timeout?: number; killSignal?: string }
    expect(typeof opts.timeout).toBe('number')
    expect(opts.timeout).toBe(STAGED_DIFF_TIMEOUT_MS)
    expect(opts.timeout).toBeGreaterThan(0)
    expect(opts.timeout).toBeLessThanOrEqual(60_000)
    expect(opts.killSignal).toBe('SIGKILL')
  })

  it('returns an empty string when exec throws (e.g. ETIMEDOUT once the timeout fires)', () => {
    const exec = vi.fn(() => {
      const e = new Error('spawnSync git ETIMEDOUT') as Error & { code?: string }
      e.code = 'ETIMEDOUT'
      throw e
    })
    const out = defaultCollectStagedDiff('/some/cwd', exec as unknown as typeof ExecSyncType)
    expect(out).toBe('')
  })

  it('STAGED_DIFF_TIMEOUT_MS is a sane finite bound', () => {
    expect(Number.isFinite(STAGED_DIFF_TIMEOUT_MS)).toBe(true)
    expect(STAGED_DIFF_TIMEOUT_MS).toBeGreaterThan(0)
    expect(STAGED_DIFF_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })
})
