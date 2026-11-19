import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWorkerLoop } from '../../../src/memory/embedding-worker.js'
import type { WorkerInbound, WorkerOutbound } from '../../../src/memory/embedding-protocol.js'

const flush = () => new Promise((r) => setImmediate(r))

afterEach(() => {
  vi.useRealTimers()
})

function harness(embedBatch: (texts: readonly string[]) => Promise<number[][]>, idleMs = 0) {
  let handler: ((m: WorkerInbound) => void) | null = null
  const sent: WorkerOutbound[] = []
  let exitCode: number | null = null
  const loop = createWorkerLoop({
    embedBatch,
    send: (m) => sent.push(m),
    onMessage: (cb) => {
      handler = cb
    },
    exit: (c) => {
      exitCode = c
    },
    idleMs,
  })
  return {
    loop,
    sent,
    deliver: (m: WorkerInbound) => handler?.(m),
    get exitCode() {
      return exitCode
    },
  }
}

describe('createWorkerLoop', () => {
  it('signals ready on startup', () => {
    const h = harness(async () => [])
    expect(h.sent[0]).toEqual({ kind: 'ready' })
  })

  it('answers an embed request with a matching result id', async () => {
    const h = harness(async (texts) => texts.map((_, i) => [i, i, i]))
    h.deliver({ kind: 'embed', id: 7, texts: ['a', 'b'] })
    await flush()
    const result = h.sent.find((m) => m.kind === 'result')
    expect(result).toEqual({
      kind: 'result',
      id: 7,
      vectors: [
        [0, 0, 0],
        [1, 1, 1],
      ],
    })
  })

  it('replies with an error message when embedding throws', async () => {
    const h = harness(async () => {
      throw new Error('model exploded')
    })
    h.deliver({ kind: 'embed', id: 3, texts: ['x'] })
    await flush()
    expect(h.sent.find((m) => m.kind === 'error')).toEqual({
      kind: 'error',
      id: 3,
      message: 'model exploded',
    })
  })

  it('ignores non-embed messages', async () => {
    const h = harness(async () => [[1]])
    // @ts-expect-error testing defensive handling of an unknown message
    h.deliver({ kind: 'bogus' })
    await flush()
    expect(h.sent.filter((m) => m.kind !== 'ready')).toHaveLength(0)
  })

  it('self-terminates after the idle timeout', () => {
    vi.useFakeTimers()
    const h = harness(async () => [], 1000)
    expect(h.exitCode).toBeNull()
    vi.advanceTimersByTime(1000)
    expect(h.exitCode).toBe(0)
  })

  it('resets the idle timer on each request', async () => {
    vi.useFakeTimers()
    const h = harness(async () => [[1]], 1000)
    vi.advanceTimersByTime(900)
    h.deliver({ kind: 'embed', id: 1, texts: ['a'] })
    await vi.advanceTimersByTimeAsync(0)
    vi.advanceTimersByTime(900)
    expect(h.exitCode).toBeNull() // timer was reset by the request
    vi.advanceTimersByTime(200)
    expect(h.exitCode).toBe(0)
  })

  it('stops processing after stop()', async () => {
    const h = harness(async () => [[1]])
    h.loop.stop()
    h.deliver({ kind: 'embed', id: 1, texts: ['a'] })
    await flush()
    expect(h.sent.filter((m) => m.kind === 'result')).toHaveLength(0)
  })
})

describe('entryIsThisModule', () => {
  // Regression for issue #78: the spawned worker decided it was NOT the
  // process entry point whenever any component of argv[1] was a symlink
  // (macOS tmpdir /var -> /private/var, symlinked checkouts), because
  // import.meta.url carries the ESM loader's REALPATH while argv[1] is the
  // unresolved spawn path. The worker then skipped runWorkerMain() and
  // exited 0 without ever signalling ready.
  it('treats a symlinked spawn path as the same entry file', async () => {
    const { entryIsThisModule } = await import('../../../src/memory/embedding-worker.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scns-entry-'))
    try {
      const real = path.join(dir, 'real')
      fs.mkdirSync(real)
      const entryFile = path.join(real, 'worker.js')
      fs.writeFileSync(entryFile, '// stub\n')
      let linkDir: string
      try {
        linkDir = path.join(dir, 'link')
        fs.symlinkSync(real, linkDir, 'dir')
      } catch {
        return // platforms where symlink creation is not permitted
      }
      const selfUrl = pathToFileURL(fs.realpathSync(entryFile)).href
      const spawnedVia = path.join(linkDir, 'worker.js')
      expect(entryIsThisModule(selfUrl, spawnedVia)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a different file and tolerates a missing one', async () => {
    const { entryIsThisModule } = await import('../../../src/memory/embedding-worker.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scns-entry-'))
    try {
      const a = path.join(dir, 'a.js')
      const b = path.join(dir, 'b.js')
      fs.writeFileSync(a, '// a\n')
      fs.writeFileSync(b, '// b\n')
      expect(entryIsThisModule(pathToFileURL(a).href, b)).toBe(false)
      expect(entryIsThisModule(pathToFileURL(a).href, path.join(dir, 'gone.js'))).toBe(false)
      expect(entryIsThisModule(pathToFileURL(a).href, undefined)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
