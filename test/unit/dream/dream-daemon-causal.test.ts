/**
 * M1.3 — dream-daemon causal-edge phase wiring (design-m1.md §5).
 *
 * Proves the additive, DEFAULT-OFF phase is gated correctly: the causal runner is
 * invoked ONLY when both the `causalEdgeInference` flag AND a `memoryDb` handle are
 * supplied; otherwise the phase is inert and the cycle is byte-identical to today.
 * The runner is mocked (spy) so no candidate scan / provider call happens here, and
 * `projectRoot` is a throwaway temp dir so the blind negative-memory applicator can
 * never touch the live guardrails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { causalSpy } = vi.hoisted(() => {
  const causalSpy = vi.fn(async () => ({
    ran: false,
    skipReason: 'null-provider' as string | undefined,
    providerLabel: 'null' as const,
    candidateCount: 0,
    inferred: 0,
    persisted: 0,
    rejectedLowConfidence: 0,
    cappedOut: 0,
  }))
  return { causalSpy }
})

vi.mock('../../../src/memory/causal-runner.js', () => ({
  runCausalEdgeInference: causalSpy,
}))

import { createDreamDaemon } from '../../../src/dream/dream-daemon.js'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { NULL_CAUSAL_PROVIDER, type CausalProvider } from '../../../src/memory/causal-provider.js'
import type Database from 'better-sqlite3'

let tmpRoot: string

beforeEach(() => {
  causalSpy.mockClear()
  tmpRoot = mkdtempSync(join(tmpdir(), 'causal-daemon-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function makeDaemon(over: {
  causalEdgeInference?: boolean
  memoryDb?: Database.Database
  causalProvider?: CausalProvider
}) {
  return createDreamDaemon({
    vaultRootDir: join(tmpRoot, 'vault'),
    dbPath: join(tmpRoot, 'dream.db'),
    projectRoot: join(tmpRoot, 'proj'), // throwaway — never the live checkout
    ...over,
  })
}

describe('M1.3 — dream daemon causal-edge phase routing', () => {
  it('CD-1: flag UNSET ⇒ causal runner NOT invoked (default-OFF, byte-identical)', async () => {
    const daemon = makeDaemon({})
    try {
      const res = await daemon.forceRun()
      expect(res.success).toBe(true)
      expect(causalSpy).not.toHaveBeenCalled()
    } finally {
      daemon.close()
    }
  })

  it('CD-2: flag SET but NO memoryDb ⇒ causal runner NOT invoked', async () => {
    const daemon = makeDaemon({ causalEdgeInference: true })
    try {
      const res = await daemon.forceRun()
      expect(res.success).toBe(true)
      expect(causalSpy).not.toHaveBeenCalled()
    } finally {
      daemon.close()
    }
  })

  it('CD-3: flag SET + memoryDb ⇒ causal runner invoked once with the db + provider', async () => {
    const memoryDb = openMemoryDb(':memory:')
    const daemon = makeDaemon({
      causalEdgeInference: true,
      memoryDb,
      causalProvider: NULL_CAUSAL_PROVIDER,
    })
    try {
      const res = await daemon.forceRun()
      expect(res.success).toBe(true)
      expect(causalSpy).toHaveBeenCalledTimes(1)
      const deps = causalSpy.mock.calls[0]![0] as { db: unknown; provider: unknown }
      expect(deps.db).toBe(memoryDb)
      expect(deps.provider).toBe(NULL_CAUSAL_PROVIDER)
    } finally {
      daemon.close()
      closeMemoryDb(memoryDb)
    }
  })

  it('CD-4: dry run ⇒ causal runner NOT invoked even when flag + memoryDb set', async () => {
    const memoryDb = openMemoryDb(':memory:')
    const daemon = createDreamDaemon({
      vaultRootDir: join(tmpRoot, 'vault'),
      dbPath: join(tmpRoot, 'dream.db'),
      projectRoot: join(tmpRoot, 'proj'),
      dryRun: true,
      causalEdgeInference: true,
      memoryDb,
    })
    try {
      const res = await daemon.forceRun()
      expect(res.success).toBe(true)
      expect(causalSpy).not.toHaveBeenCalled()
    } finally {
      daemon.close()
      closeMemoryDb(memoryDb)
    }
  })
})
