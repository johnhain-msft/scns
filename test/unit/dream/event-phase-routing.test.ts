/**
 * WS-1 — dream-daemon event-segmentation phase wiring (mirrors dream-daemon-causal.test.ts).
 *
 * Proves the additive, DEFAULT-OFF phase is gated correctly: the segmenter + writer run ONLY when
 * both the `eventSegmentation` flag AND a `memoryDb` handle are supplied (and not in dry-run);
 * otherwise the phase is inert (NEGATIVE control = byte-identical to today). Both collaborators are
 * mocked (spies) so no DB work happens here; `projectRoot` is a throwaway temp dir so the blind
 * negative-memory applicator can never touch the live guardrails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { segmentSpy, writeSpy } = vi.hoisted(() => {
  const segmentSpy = vi.fn((_sources: unknown) => [] as unknown[])
  const writeSpy = vi.fn(async (_db: unknown, _records: unknown) => ({
    considered: 0,
    written: 0,
    skippedExisting: 0,
    embeddingsWritten: 0,
  }))
  return { segmentSpy, writeSpy }
})

vi.mock('../../../src/dream/event-segmenter.js', () => ({
  segmentStructuredEvents: segmentSpy,
}))
vi.mock('../../../src/memory/event-nodes.js', () => ({
  writeEventNodes: writeSpy,
}))

import { createDreamDaemon } from '../../../src/dream/dream-daemon.js'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import type Database from 'better-sqlite3'

let tmpRoot: string

beforeEach(() => {
  segmentSpy.mockClear()
  writeSpy.mockClear()
  tmpRoot = mkdtempSync(join(tmpdir(), 'event-phase-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function makeDaemon(over: {
  eventSegmentation?: boolean
  memoryDb?: Database.Database
  brokerDb?: Database.Database
  dryRun?: boolean
}) {
  return createDreamDaemon({
    vaultRootDir: join(tmpRoot, 'vault'),
    dbPath: join(tmpRoot, 'dream.db'),
    projectRoot: join(tmpRoot, 'proj'), // throwaway — never the live checkout
    ...over,
  })
}

describe('WS-1 — dream daemon event-segmentation phase routing', () => {
  it('EP-1: flag UNSET ⇒ segmenter/writer NOT invoked (default-OFF, byte-identical)', async () => {
    const daemon = makeDaemon({})
    try {
      const res = await daemon.forceRun()
      expect(res.success).toBe(true)
      expect(segmentSpy).not.toHaveBeenCalled()
      expect(writeSpy).not.toHaveBeenCalled()
    } finally {
      daemon.close()
    }
  })

  it('EP-2: flag SET but NO memoryDb ⇒ segmenter/writer NOT invoked', async () => {
    const daemon = makeDaemon({ eventSegmentation: true })
    try {
      const res = await daemon.forceRun()
      expect(res.success).toBe(true)
      expect(segmentSpy).not.toHaveBeenCalled()
      expect(writeSpy).not.toHaveBeenCalled()
    } finally {
      daemon.close()
    }
  })

  it('EP-3: flag SET + memoryDb ⇒ segment+write invoked once with the vault db', async () => {
    const memoryDb = openMemoryDb(':memory:')
    const daemon = makeDaemon({ eventSegmentation: true, memoryDb })
    try {
      const res = await daemon.forceRun()
      expect(res.success).toBe(true)
      expect(segmentSpy).toHaveBeenCalledTimes(1)
      const sources = segmentSpy.mock.calls[0]![0] as { vaultDb: unknown; brokerDb?: unknown }
      expect(sources.vaultDb).toBe(memoryDb)
      expect(sources.brokerDb).toBeUndefined() // no broker handle supplied

      expect(writeSpy).toHaveBeenCalledTimes(1)
      const writeArgs = writeSpy.mock.calls[0]!
      expect(writeArgs[0]).toBe(memoryDb)
      expect(writeArgs[1]).toBe(segmentSpy.mock.results[0]!.value) // exactly the segmenter's output
    } finally {
      daemon.close()
      closeMemoryDb(memoryDb)
    }
  })

  it('EP-4: flag SET + memoryDb + brokerDb ⇒ broker handle threaded into the segmenter sources', async () => {
    const memoryDb = openMemoryDb(':memory:')
    const brokerDb = openMemoryDb(':memory:')
    const daemon = makeDaemon({ eventSegmentation: true, memoryDb, brokerDb })
    try {
      const res = await daemon.forceRun()
      expect(res.success).toBe(true)
      expect(segmentSpy).toHaveBeenCalledTimes(1)
      const sources = segmentSpy.mock.calls[0]![0] as { vaultDb: unknown; brokerDb?: unknown }
      expect(sources.vaultDb).toBe(memoryDb)
      expect(sources.brokerDb).toBe(brokerDb)
      expect(writeSpy).toHaveBeenCalledTimes(1)
    } finally {
      daemon.close()
      closeMemoryDb(memoryDb)
      closeMemoryDb(brokerDb)
    }
  })

  it('EP-5: dry run ⇒ segmenter/writer NOT invoked even when flag + memoryDb set', async () => {
    const memoryDb = openMemoryDb(':memory:')
    const daemon = makeDaemon({ eventSegmentation: true, memoryDb, dryRun: true })
    try {
      const res = await daemon.forceRun()
      expect(res.success).toBe(true)
      expect(segmentSpy).not.toHaveBeenCalled()
      expect(writeSpy).not.toHaveBeenCalled()
    } finally {
      daemon.close()
      closeMemoryDb(memoryDb)
    }
  })
})
