import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createEmbeddingClient,
  type WorkerHandle,
} from '../../../src/memory/embedding-client.js'
import type {
  WorkerInbound,
  WorkerOutbound,
} from '../../../src/memory/embedding-protocol.js'

interface FakeWorker {
  readonly handle: WorkerHandle
  readonly sent: WorkerInbound[]
  emit(msg: WorkerOutbound): void
  exit(code: number | null): void
  readonly killed: boolean
}

function makeFakeWorker(): FakeWorker {
  let msgCb: ((m: WorkerOutbound) => void) | null = null
  let exitCb: ((code: number | null) => void) | null = null
  const sent: WorkerInbound[] = []
  let killed = false
  return {
    handle: {
      send: (m) => sent.push(m),
      onMessage: (cb) => {
        msgCb = cb
      },
      onExit: (cb) => {
        exitCb = cb
      },
      kill: () => {
        killed = true
      },
    },
    sent,
    emit: (m) => msgCb?.(m),
    exit: (c) => exitCb?.(c),
    get killed() {
      return killed
    },
  }
}

const DIM = 3
function vec(n: number): number[] {
  return [n, n, n]
}

const flush = () => new Promise((r) => setImmediate(r))

afterEach(() => {
  vi.useRealTimers()
})

describe('createEmbeddingClient', () => {
  it('embeds a single batch and returns vectors in order', async () => {
    const fake = makeFakeWorker()
    const client = createEmbeddingClient({
      spawnWorker: () => fake.handle,
      dimensions: DIM,
    })

    const p = client.embed(['a', 'b'])
    await flush()
    fake.emit({ kind: 'ready' })
    await flush()

    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0]).toMatchObject({ kind: 'embed', texts: ['a', 'b'] })
    fake.emit({ kind: 'result', id: fake.sent[0]!.id, vectors: [vec(1), vec(2)] })

    const result = await p
    expect(result).toHaveLength(2)
    expect(Array.from(result[0]!)).toEqual([1, 1, 1])
    expect(Array.from(result[1]!)).toEqual([2, 2, 2])
    expect(client.state()).toBe('ready')
  })

  it('splits large inputs into bounded sub-batches dispatched sequentially', async () => {
    const fake = makeFakeWorker()
    const client = createEmbeddingClient({
      spawnWorker: () => fake.handle,
      dimensions: DIM,
      subBatchSize: 2,
    })

    const p = client.embed(['a', 'b', 'c', 'd', 'e'])
    await flush()
    fake.emit({ kind: 'ready' })
    await flush()

    // Only one request in flight at a time.
    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0]!.texts).toEqual(['a', 'b'])
    fake.emit({ kind: 'result', id: fake.sent[0]!.id, vectors: [vec(1), vec(2)] })
    await flush()

    expect(fake.sent).toHaveLength(2)
    expect(fake.sent[1]!.texts).toEqual(['c', 'd'])
    fake.emit({ kind: 'result', id: fake.sent[1]!.id, vectors: [vec(3), vec(4)] })
    await flush()

    expect(fake.sent).toHaveLength(3)
    expect(fake.sent[2]!.texts).toEqual(['e'])
    fake.emit({ kind: 'result', id: fake.sent[2]!.id, vectors: [vec(5)] })

    const result = await p
    expect(result.map((v) => v[0])).toEqual([1, 2, 3, 4, 5])
  })

  it('shares a single worker spawn across concurrent embed calls', async () => {
    let spawns = 0
    const fake = makeFakeWorker()
    const client = createEmbeddingClient({
      spawnWorker: () => {
        spawns++
        return fake.handle
      },
      dimensions: DIM,
    })

    const p1 = client.embed(['a'])
    const p2 = client.embed(['b'])
    await flush()
    fake.emit({ kind: 'ready' })
    await flush()

    expect(spawns).toBe(1)

    // Respond to both sequential requests.
    fake.emit({ kind: 'result', id: fake.sent[0]!.id, vectors: [vec(1)] })
    await flush()
    fake.emit({ kind: 'result', id: fake.sent[1]!.id, vectors: [vec(2)] })

    await expect(p1).resolves.toHaveLength(1)
    await expect(p2).resolves.toHaveLength(1)
  })

  it('rejects when the worker returns a wrong vector dimension', async () => {
    const fake = makeFakeWorker()
    const client = createEmbeddingClient({
      spawnWorker: () => fake.handle,
      dimensions: DIM,
    })
    const p = client.embed(['a'])
    await flush()
    fake.emit({ kind: 'ready' })
    await flush()
    fake.emit({ kind: 'result', id: fake.sent[0]!.id, vectors: [[1, 2]] })

    await expect(p).rejects.toThrow(/2 dimensions, expected 3/)
  })

  it('rejects (without crashing) when spawn throws synchronously', async () => {
    const client = createEmbeddingClient({
      spawnWorker: () => {
        throw new Error('fork failed')
      },
      dimensions: DIM,
    })
    await expect(client.embed(['a'])).rejects.toThrow(/fork failed/)
    expect(client.state()).toBe('idle')
  })

  it('rejects in-flight and queued requests when the worker exits', async () => {
    const fake = makeFakeWorker()
    const client = createEmbeddingClient({
      spawnWorker: () => fake.handle,
      dimensions: DIM,
      subBatchSize: 1,
    })
    const p = client.embed(['a', 'b'])
    await flush()
    fake.emit({ kind: 'ready' })
    await flush()

    expect(fake.sent).toHaveLength(1)
    fake.exit(1)

    await expect(p).rejects.toThrow(/exited \(code 1\)/)
    expect(client.isWorkerAlive()).toBe(false)
  })

  it('propagates a per-request error and keeps serving subsequent requests', async () => {
    const fake = makeFakeWorker()
    const client = createEmbeddingClient({
      spawnWorker: () => fake.handle,
      dimensions: DIM,
    })

    const p1 = client.embed(['a'])
    await flush()
    fake.emit({ kind: 'ready' })
    await flush()
    fake.emit({ kind: 'error', id: fake.sent[0]!.id, message: 'tokenize boom' })
    await expect(p1).rejects.toThrow(/tokenize boom/)

    // Worker is still alive; a new request is served.
    const p2 = client.embed(['b'])
    await flush()
    expect(fake.sent).toHaveLength(2)
    fake.emit({ kind: 'result', id: fake.sent[1]!.id, vectors: [vec(9)] })
    await expect(p2).resolves.toHaveLength(1)
    expect(fake.killed).toBe(false)
  })

  it('kills the worker and rejects on request timeout', async () => {
    vi.useFakeTimers()
    const fake = makeFakeWorker()
    const client = createEmbeddingClient({
      spawnWorker: () => fake.handle,
      dimensions: DIM,
      requestTimeoutMs: 1000,
    })
    const p = client.embed(['a'])
    await vi.advanceTimersByTimeAsync(0)
    fake.emit({ kind: 'ready' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.sent).toHaveLength(1)

    const assertion = expect(p).rejects.toThrow(/request timed out/)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    expect(fake.killed).toBe(true)
  })

  it('rejects on startup timeout when ready never arrives', async () => {
    vi.useFakeTimers()
    const fake = makeFakeWorker()
    const client = createEmbeddingClient({
      spawnWorker: () => fake.handle,
      dimensions: DIM,
      startupTimeoutMs: 500,
    })
    const p = client.embed(['a'])
    const assertion = expect(p).rejects.toThrow(/startup timed out/)
    await vi.advanceTimersByTimeAsync(500)
    await assertion
    expect(fake.killed).toBe(true)
  })

  it('kills the idle worker after the queue drains, respawning on next call', async () => {
    vi.useFakeTimers()
    let spawns = 0
    let fake = makeFakeWorker()
    const client = createEmbeddingClient({
      spawnWorker: () => {
        spawns++
        return fake.handle
      },
      dimensions: DIM,
      idleMs: 2000,
    })

    const p1 = client.embed(['a'])
    await vi.advanceTimersByTimeAsync(0)
    fake.emit({ kind: 'ready' })
    await vi.advanceTimersByTimeAsync(0)
    fake.emit({ kind: 'result', id: fake.sent[0]!.id, vectors: [vec(1)] })
    await p1

    expect(client.isWorkerAlive()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(client.isWorkerAlive()).toBe(false)
    expect(fake.killed).toBe(true)

    // Next request respawns a fresh worker.
    const prev = fake
    fake = makeFakeWorker()
    const p2 = client.embed(['b'])
    await vi.advanceTimersByTimeAsync(0)
    expect(spawns).toBe(2)
    expect(fake).not.toBe(prev)
    fake.emit({ kind: 'ready' })
    await vi.advanceTimersByTimeAsync(0)
    fake.emit({ kind: 'result', id: fake.sent[0]!.id, vectors: [vec(2)] })
    await expect(p2).resolves.toHaveLength(1)
  })

  it('shutdown is idempotent and rejects pending work', async () => {
    const fake = makeFakeWorker()
    const client = createEmbeddingClient({
      spawnWorker: () => fake.handle,
      dimensions: DIM,
    })
    const p = client.embed(['a'])
    await flush()
    fake.emit({ kind: 'ready' })
    await flush()

    client.shutdown()
    client.shutdown() // second call must not throw
    await expect(p).rejects.toThrow(/shut down/)
    expect(client.isWorkerAlive()).toBe(false)
  })

  it('returns empty array without spawning for empty input', async () => {
    let spawns = 0
    const client = createEmbeddingClient({
      spawnWorker: () => {
        spawns++
        return makeFakeWorker().handle
      },
      dimensions: DIM,
    })
    await expect(client.embed([])).resolves.toEqual([])
    expect(spawns).toBe(0)
  })
})
