/**
 * P7 — Port allocator for child brokers (tests).
 */
import { describe, it, expect } from 'vitest'
import {
  allocatePort,
  type AllocatePortInput,
  DEFAULT_PORT_POOL_START,
  DEFAULT_PORT_POOL_SIZE,
} from '../../../src/meta-broker/port-allocator.js'
import { isPortInUse } from '../../../src/meta-broker/meta-supervisor.js'

function makeProbe(taken: Set<number>): (port: number) => boolean {
  return (port) => taken.has(port)
}

describe('allocatePort', () => {
  it('exposes a default pool of 100 starting at 3500', async () => {
    expect(DEFAULT_PORT_POOL_START).toBe(3500)
    expect(DEFAULT_PORT_POOL_SIZE).toBe(100)
  })

  it('returns the desired port when free and in range', async () => {
    const input: AllocatePortInput = {
      desired: 3500,
      taken: new Set(),
      isPortInUse: makeProbe(new Set()),
    }
    expect(await allocatePort(input)).toBe(3500)
  })

  it('falls back to the next free pool slot when desired is taken', async () => {
    const input: AllocatePortInput = {
      desired: 3500,
      taken: new Set([3500, 3501, 3502]),
      isPortInUse: makeProbe(new Set()),
    }
    expect(await allocatePort(input)).toBe(3503)
  })

  it('falls back when desired is in-use (port probe says taken)', async () => {
    const input: AllocatePortInput = {
      desired: 3500,
      taken: new Set(),
      isPortInUse: makeProbe(new Set([3500])),
    }
    expect(await allocatePort(input)).toBe(3501)
  })

  it('allocates first free pool slot when no desired is given', async () => {
    const input: AllocatePortInput = {
      taken: new Set([3500, 3501]),
      isPortInUse: makeProbe(new Set()),
    }
    expect(await allocatePort(input)).toBe(3502)
  })

  it('skips ports that are either registered OR live-in-use', async () => {
    const input: AllocatePortInput = {
      taken: new Set([3500]),
      isPortInUse: makeProbe(new Set([3501])),
    }
    expect(await allocatePort(input)).toBe(3502)
  })

  it('throws when the entire pool is exhausted', async () => {
    const allTaken = new Set<number>()
    for (let p = 3500; p < 3500 + 100; p++) allTaken.add(p)
    await expect(
      allocatePort({
        taken: allTaken,
        isPortInUse: makeProbe(new Set()),
      }),
    ).rejects.toThrow(/exhausted/i)
  })

  it('honors a custom pool start + size', async () => {
    expect(
      await allocatePort({
        desired: 4000,
        taken: new Set(),
        isPortInUse: makeProbe(new Set()),
        poolStart: 4000,
        poolSize: 5,
      }),
    ).toBe(4000)
  })

  // WI-6 revision: an explicitly registered port is operator intent — honor
  // it when free, even outside the pool. (The old skip-out-of-pool behavior
  // silently reassigned `meta-broker register --port N` and caused a
  // collision with a live broker's port.)
  it('honors a FREE desired port outside the pool', async () => {
    expect(
      await allocatePort({
        desired: 8080,
        taken: new Set(),
        isPortInUse: makeProbe(new Set()),
      }),
    ).toBe(8080)
  })

  it('falls back to the pool when the out-of-pool desired port is busy', async () => {
    expect(
      await allocatePort({
        desired: 8080,
        taken: new Set(),
        isPortInUse: makeProbe(new Set([8080])),
      }),
    ).toBe(3500)
  })

  it('supports an ASYNC in-use probe (the real net probe is async)', async () => {
    const probed: number[] = []
    const port = await allocatePort({
      desired: 3500,
      taken: new Set(),
      isPortInUse: async (p) => {
        probed.push(p)
        await new Promise((r) => setImmediate(r))
        return p === 3500 // 3500 is live — must NOT be handed out
      },
    })
    expect(port).toBe(3501)
    expect(probed).toContain(3500)
  })
})

describe('isPortInUse — real net probe (WI-6 regression)', () => {
  // The old sync-style probe answered before EADDRINUSE could fire and said
  // "free" for every port — which allocated a production child's port out
  // from under it. This pins the async probe against real sockets.
  it('detects a genuinely bound port and a genuinely free one', async () => {
    const { createServer } = await import('node:net')
    const holder = createServer()
    const boundPort: number = await new Promise((resolve) => {
      holder.listen(0, '127.0.0.1', () => resolve(holder.address().port))
    })
    try {
      expect(await isPortInUse(boundPort)).toBe(true)
    } finally {
      await new Promise((r) => holder.close(r))
    }
    expect(await isPortInUse(boundPort)).toBe(false)
  })
})
