/**
 * Phase-1 wedge C — dream-daemon branch routing for the live gated applicator.
 *
 * Proves the additive, default-OFF swap is correct at the wiring level: with
 * `gatedNegativeMemoriesLive` UNSET the daemon runs the BLIND `applyNegativeMemories`
 * (byte-identical legacy path) and never the gated runner; with it SET it routes to
 * `runGatedNegativeMemoryApplyLive` and never the blind writer. Both negative-memory
 * sinks are mocked (spies), so no real file write/spawn/git happens; everything else
 * runs against fresh temp vault + dream DB dirs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { applySpy, runnerSpy } = vi.hoisted(() => {
  const applySpy = vi.fn(() => ({
    appliedCount: 0,
    skippedCount: 0,
    suppressedByCriticCount: 0,
    pendingReviewCount: 0,
    targetFile: '.github/copilot-instructions.md',
    errors: [] as string[],
  }))
  const runnerSpy = vi.fn(async () => ({
    ran: true,
    skipReason: undefined as string | undefined,
    backendLabel: 'mock' as const,
    spawned: false,
    worktree: null as string | null,
    pid: null as number | null,
    killedByPid: false,
    pidAlreadyExited: false,
    candidateCount: 0,
    currentRuleCount: 0,
    adopted: [] as string[],
    rejected: [] as string[],
    backups: [] as string[],
    appliedMemoryIds: [] as string[],
    targetFile: null as string | null,
  }))
  return { applySpy, runnerSpy }
})

vi.mock('../../../src/memory/negative-memory-applicator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/memory/negative-memory-applicator.js')>()
  return { ...actual, applyNegativeMemories: applySpy }
})

vi.mock('../../../src/memory/gated-negative-memory-runner.js', () => ({
  runGatedNegativeMemoryApplyLive: runnerSpy,
}))

import { createDreamDaemon } from '../../../src/dream/dream-daemon.js'

let tmpRoot: string

beforeEach(() => {
  applySpy.mockClear()
  runnerSpy.mockClear()
  tmpRoot = mkdtempSync(join(tmpdir(), 'gated-live-daemon-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function makeDaemon(gatedNegativeMemoriesLive: boolean) {
  return createDreamDaemon({
    vaultRootDir: join(tmpRoot, 'vault'),
    dbPath: join(tmpRoot, 'dream.db'),
    gatedNegativeMemoriesLive,
  })
}

describe('wedge C — dream daemon negative-memory branch routing', () => {
  it('GD-1: flag UNSET ⇒ blind applyNegativeMemories runs, gated runner NOT invoked', async () => {
    const daemon = makeDaemon(false)
    try {
      const res = await daemon.forceRun()
      expect(res.success).toBe(true)
      expect(applySpy).toHaveBeenCalledTimes(1)
      expect(runnerSpy).not.toHaveBeenCalled()
    } finally {
      daemon.close()
    }
  })

  it('GD-2: flag SET ⇒ gated runner runs, blind applyNegativeMemories NOT invoked', async () => {
    const daemon = makeDaemon(true)
    try {
      const res = await daemon.forceRun()
      expect(res.success).toBe(true)
      expect(runnerSpy).toHaveBeenCalledTimes(1)
      expect(applySpy).not.toHaveBeenCalled()
    } finally {
      daemon.close()
    }
  })
})
