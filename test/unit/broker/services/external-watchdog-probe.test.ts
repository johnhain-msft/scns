import { afterEach, describe, expect, it, vi } from 'vitest'
import { httpHealthProbe } from '../../../../src/broker/services/external-watchdog.js'

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { child: () => log },
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('httpHealthProbe diagnostics', () => {
  it('logs the actual status and latency of a responsive probe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('healthy', { status: 200 })))
    expect(await httpHealthProbe('http://127.0.0.1:19001')).toEqual({ ok: true, status: 200 })
    expect(log.info).toHaveBeenCalledWith(
      {
        url: 'http://127.0.0.1:19001/api/health',
        durationMs: expect.any(Number),
        probe: { ok: true, status: 200 },
      },
      'external-watchdog: HTTP probe',
    )
  })

  it('preserves the transport cause rather than logging only fetch failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          new TypeError('fetch failed', {
            cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
          }),
        ),
    )
    const result = await httpHealthProbe('http://127.0.0.1:19001')
    expect(result).toEqual({ ok: false, error: 'fetch failed', errorCode: 'ECONNREFUSED' })
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ probe: result }),
      'external-watchdog: HTTP probe',
    )
  })

  it('distinguishes a real timeout from a connection failure', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, opts: RequestInit) =>
          new Promise((_resolve, reject) => {
            opts.signal!.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'))
            })
          }),
      ),
    )
    const pending = httpHealthProbe('http://127.0.0.1:19001', 50)
    await vi.advanceTimersByTimeAsync(50)
    const result = await pending
    expect(result).toEqual({ ok: false, timedOut: true })
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ probe: result, durationMs: 50 }),
      'external-watchdog: HTTP probe',
    )
    expect(vi.getTimerCount()).toBe(0)
  })
})
