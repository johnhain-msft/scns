import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createContextInjector } from '../../../src/copilot-extension/context-injector.js'

describe('context-injector', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  describe('isInjectionEnabled', () => {
    it('returns false when broker is unreachable', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const injector = createContextInjector({ brokerUrl: 'http://localhost:9999' })
      const enabled = await injector.isInjectionEnabled()

      expect(enabled).toBe(false)
    })

    it('returns false when config says disabled', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ contextInjectionEnabled: false }), { status: 200 }),
      )

      const injector = createContextInjector({ brokerUrl: 'http://localhost:3456' })
      const enabled = await injector.isInjectionEnabled()

      expect(enabled).toBe(false)
    })

    it('returns true when config says enabled', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ contextInjectionEnabled: true }), { status: 200 }),
      )

      const injector = createContextInjector({ brokerUrl: 'http://localhost:3456' })
      const enabled = await injector.isInjectionEnabled()

      expect(enabled).toBe(true)
    })

    it('caches config for TTL duration', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ contextInjectionEnabled: true }), { status: 200 }),
      )

      const injector = createContextInjector({
        brokerUrl: 'http://localhost:3456',
        configCacheTtlMs: 60_000,
      })

      await injector.isInjectionEnabled()
      await injector.isInjectionEnabled()
      await injector.isInjectionEnabled()

      // Should only call fetch once due to caching
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('re-fetches after cache expires', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ contextInjectionEnabled: true }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ contextInjectionEnabled: false }), { status: 200 }),
        )

      const injector = createContextInjector({
        brokerUrl: 'http://localhost:3456',
        configCacheTtlMs: 1, // 1ms TTL for test
      })

      const first = await injector.isInjectionEnabled()
      expect(first).toBe(true)

      // Wait for cache to expire
      await new Promise((r) => setTimeout(r, 10))

      const second = await injector.isInjectionEnabled()
      expect(second).toBe(false)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('uses cached value on subsequent fetch failure', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ contextInjectionEnabled: true }), { status: 200 }),
        )
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const injector = createContextInjector({
        brokerUrl: 'http://localhost:3456',
        configCacheTtlMs: 1,
      })

      const first = await injector.isInjectionEnabled()
      expect(first).toBe(true)

      await new Promise((r) => setTimeout(r, 10))

      // On failure, should fall back to cached value
      const second = await injector.isInjectionEnabled()
      expect(second).toBe(true)
    })
  })

  describe('getContext', () => {
    it('returns undefined when injection is disabled', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ contextInjectionEnabled: false }), { status: 200 }),
      )

      const injector = createContextInjector({ brokerUrl: 'http://localhost:3456' })
      const ctx = await injector.getContext('How do I fix this bug?')

      expect(ctx).toBeUndefined()
    })

    it('returns context when injection is enabled and broker responds', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ contextInjectionEnabled: true }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              additionalContext: 'Relevant memory: always use ESM imports.',
              memoriesUsed: 2,
              suggestionsUsed: 1,
            }),
            { status: 200 },
          ),
        )

      const injector = createContextInjector({ brokerUrl: 'http://localhost:3456' })
      const ctx = await injector.getContext('How do I fix this import?', '/home/user/project')

      expect(ctx).toBeDefined()
      expect(ctx!.additionalContext).toBe('Relevant memory: always use ESM imports.')
      expect(ctx!.memoriesUsed).toBe(2)
      expect(ctx!.suggestionsUsed).toBe(1)
    })

    it('returns undefined when context endpoint fails', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ contextInjectionEnabled: true }), { status: 200 }),
        )
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const injector = createContextInjector({ brokerUrl: 'http://localhost:3456' })
      const ctx = await injector.getContext('test prompt')

      expect(ctx).toBeUndefined()
    })

    it('returns undefined when response has no additionalContext', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ contextInjectionEnabled: true }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ memoriesUsed: 0 }), { status: 200 }))

      const injector = createContextInjector({ brokerUrl: 'http://localhost:3456' })
      const ctx = await injector.getContext('test prompt')

      expect(ctx).toBeUndefined()
    })

    it('sends prompt and cwd in POST body', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ contextInjectionEnabled: true }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ additionalContext: 'ctx', memoriesUsed: 1, suggestionsUsed: 0 }),
            { status: 200 },
          ),
        )

      const injector = createContextInjector({ brokerUrl: 'http://localhost:3456' })
      await injector.getContext('fix bug', '/home/user/project')

      const contextCall = fetchSpy.mock.calls[1]!
      expect(contextCall[0]).toBe('http://localhost:3456/api/extension/context')
      const body = JSON.parse(contextCall[1]?.body as string)
      expect(body.prompt).toBe('fix bug')
      expect(body.cwd).toBe('/home/user/project')
    })
  })

  describe('invalidateCache', () => {
    it('forces re-fetch on next call', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ contextInjectionEnabled: true }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ contextInjectionEnabled: false }), { status: 200 }),
        )

      const injector = createContextInjector({
        brokerUrl: 'http://localhost:3456',
        configCacheTtlMs: 60_000,
      })

      const first = await injector.isInjectionEnabled()
      expect(first).toBe(true)

      injector.invalidateCache()

      const second = await injector.isInjectionEnabled()
      expect(second).toBe(false)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })
  })
})
