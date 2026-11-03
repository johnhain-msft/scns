import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateExtensionSource } from '../../../src/copilot-extension/extension-template.js'
import { createIsolatedRoot, type IsolatedRoot } from '../../helpers/isolation.js'

const GLOBAL = 'http://127.0.0.1:3456'
const BLUE = 'http://127.0.0.1:3506'
const GREEN = 'http://127.0.0.1:3505'
const PROJECT = 'scns-test'
const RECOVERY_BUDGET_MS = 20_000

interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

interface ResponseLike {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}

type Fetch = (url: string, options?: RequestOptions) => Promise<ResponseLike>
type ToolHandler = (args: Record<string, unknown>) => Promise<string>

interface ExtensionOptions {
  tools: Array<{ name: string; handler: ToolHandler }>
  hooks: {
    onUserPromptSubmitted(
      input: { prompt: string; cwd: string },
      invocation: { sessionId: string },
    ): Promise<unknown>
  }
}

interface ExtensionRuntime {
  resolveBrokerUrl(trigger: string): Promise<void>
  fetchBroker(path: string, options?: RequestOptions): Promise<unknown>
  postBrokerVerbose(path: string, body: unknown): Promise<unknown>
  getInjectionConfig(): Promise<unknown>
  prompt(text: string): Promise<unknown>
  route(): { url: string; label: string; project: string | null }
  tool(name: string, args?: Record<string, unknown>): Promise<unknown>
  log: string[]
  notices: Array<{ message: string; level: string }>
  waitForNotices(): Promise<void>
}

function response(body: unknown, status = 200): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function running(url = GREEN, projectId = PROJECT): ResponseLike {
  return response({ resolved: true, projectId, brokerUrl: url, status: 'running' })
}

function recovering(status = 'failing'): ResponseLike {
  return response({ resolved: false, projectId: PROJECT, reason: `child-${status}`, status })
}

async function launchExtension(fetch: Fetch, env: Record<string, string> = {}) {
  const log: string[] = []
  const notices: Array<{ message: string; level: string }> = []
  let registered: ExtensionOptions | undefined
  const source = generateExtensionSource({ brokerUrl: GLOBAL, brokerToken: 'test-token' }).replace(
    'import { joinSession } from "@github/copilot-sdk/extension";',
    '',
  )
  const execute = new Function(
    'fetch',
    'process',
    'joinSession',
    'AbortSignal',
    'console',
    `return (async () => {
      ${source}
      return {
        resolveBrokerUrl,
        fetchBroker,
        postBrokerVerbose,
        getInjectionConfig,
        route: () => ({
          url: effectiveBrokerUrl,
          label: brokerRouteLabel,
          project: resolvedProjectId,
        }),
        waitForNotices: async () => {
          await awaitStartupResolution();
          if (typeof noticeQueue !== "undefined") await noticeQueue;
        },
      };
    })();`,
  ) as (
    fetch: Fetch,
    process: { cwd(): string; env: Record<string, string> },
    joinSession: (options: ExtensionOptions) => Promise<unknown>,
    abort: { timeout(ms: number): AbortSignal },
    console: { error(message: string): void },
  ) => Promise<Omit<ExtensionRuntime, 'tool' | 'log' | 'notices' | 'prompt'>>

  const runtime = await execute(
    fetch,
    { cwd: () => 'C:\\isolated\\scns-test', env: { SCNS_HOME: isolation.rootDir, ...env } },
    async (options) => {
      registered = options
      return {
        sessionId: 'recovery-test-session',
        workspacePath: isolation.rootDir,
        getEvents: async () => [{ type: 'session.start', id: 'recovery-test-activation' }],
        on() {},
        log: async (message: string, options?: { level: string }) => {
          log.push(message)
          notices.push({ message, level: options?.level ?? 'info' })
        },
      }
    },
    {
      timeout(ms) {
        const controller = new AbortController()
        setTimeout(() => controller.abort(new Error('probe timed out')), ms)
        return controller.signal
      },
    },
    {
      error: (message) => {
        log.push(message)
      },
    },
  )
  return {
    ...runtime,
    log,
    notices,
    async prompt(text: string) {
      if (!registered) throw new Error('Extension did not register its hooks')
      return registered.hooks.onUserPromptSubmitted(
        { prompt: text, cwd: 'C:\\isolated\\scns-test' },
        { sessionId: 'recovery-test-session' },
      )
    },
    async tool(name: string, args: Record<string, unknown> = {}) {
      const handler = registered?.tools.find((tool) => tool.name === name)?.handler
      if (!handler) throw new Error(`Missing generated handler: ${name}`)
      return JSON.parse(await handler(args)) as unknown
    },
  } satisfies ExtensionRuntime
}

let isolation: IsolatedRoot

describe('generated extension: project recovery without cross-project writes', () => {
  beforeEach(() => {
    isolation = createIsolatedRoot()
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    isolation.cleanup()
  })

  it('reports an unresolved startup as a warning rather than a healthy loaded notice', async () => {
    const extension = await launchExtension(async () =>
      response({ resolved: false, reason: 'no-project' }),
    )
    await extension.waitForNotices()
    expect(extension.notices).toEqual([
      expect.objectContaining({ level: 'warning', message: expect.stringContaining('no-project') }),
    ])
    expect(extension.notices.some((notice) => notice.message.includes('extension loaded'))).toBe(
      false,
    )
  })

  it('announces the recovered route and a later port change, but not unchanged resolutions', async () => {
    let current = BLUE
    let available = false
    const extension = await launchExtension(async (url) => {
      if (url.includes('/api/meta/resolve'))
        return available ? running(current) : response({ resolved: false, reason: 'no-project' })
      return response({ project_id: PROJECT, served: current })
    })
    await extension.waitForNotices()
    available = true
    await extension.resolveBrokerUrl('retry-project-route')
    await extension.waitForNotices()
    expect(extension.notices.at(-1)).toEqual({
      level: 'info',
      message: `SCNS extension loaded (broker: ${BLUE} [project:${PROJECT}])`,
    })
    const count = extension.notices.length
    await extension.resolveBrokerUrl('identity-mismatch')
    await extension.waitForNotices()
    expect(extension.notices).toHaveLength(count)
    current = GREEN
    await extension.resolveBrokerUrl('re-resolve-after-failure')
    await extension.waitForNotices()
    expect(extension.notices).toHaveLength(count + 1)
    expect(extension.notices.at(-1)?.message).toContain(GREEN)
  })

  it.each(['registered', 'starting', 'failing'])(
    'waits through child-%s and sends the first store only to the recovered child',
    async (status) => {
      let resolves = 0
      const writes: string[] = []
      const fetch = vi.fn<Fetch>(async (url, options) => {
        expect(options?.headers?.Authorization).toBe('Bearer test-token')
        if (url.includes('/api/meta/resolve')) {
          return ++resolves === 1 ? recovering(status) : running()
        }
        if (url.endsWith('/api/health')) return response({ project_id: PROJECT })
        writes.push(url)
        return response({ stored: true, key: 'recovery-test' })
      })
      const starting = launchExtension(fetch, { SCNS_REQUIRE_PROJECT_BROKER: '1' })
      await vi.advanceTimersByTimeAsync(500)
      const extension = await starting

      expect(extension.route()).toEqual({
        url: GREEN,
        label: `project:${PROJECT}`,
        project: PROJECT,
      })
      expect(
        await extension.tool('scns_memory_store', { key: 'recovery-test', value: 'isolated' }),
      ).toEqual({ stored: true, key: 'recovery-test' })
      expect(writes).toEqual([`${GREEN}/api/memory/store`])
      expect(resolves).toBe(2)
    },
  )

  it.each(['0', '1'])(
    'joins immediately, then refuses all writes while a known project is unavailable (strict=%s)',
    async (strict) => {
      const writes: string[] = []
      const fetch: Fetch = async (url, options) => {
        if (url.includes('/api/meta/resolve')) return recovering()
        if (url.endsWith('/api/health')) return response({ project_id: null })
        if (options?.method && options.method !== 'GET') writes.push(url)
        return response({ stored: true })
      }
      let joined = false
      const starting = launchExtension(fetch, { SCNS_REQUIRE_PROJECT_BROKER: strict }).then(
        (extension) => {
          joined = true
          return extension
        },
      )
      // The JOIN must not be gated on the recovery budget. It used to be, and a
      // load that blocks for CHILD_READY_TIMEOUT_MS is torn down and re-forked by
      // the CLI — measured 2026-09-15 as 5-8 extension hosts per session, each
      // re-printing the banner. Bounding startup was never the safety property;
      // refusing the writes below is, and that is unchanged.
      const extension = await starting
      expect(joined).toBe(true)

      // Resolution continues in the background and still exhausts its budget.
      await vi.advanceTimersByTimeAsync(RECOVERY_BUDGET_MS)

      expect(extension.route().project).toBe(PROJECT)
      expect(extension.log.join('\n')).toContain('child-failing')
      expect(
        await extension.tool('scns_memory_store', { key: 'test', value: 'isolated' }),
      ).toMatchObject({ stored: false, refused: true })
      expect(
        await extension.fetchBroker('/api/tasks/1', { method: 'PATCH', body: '{}' }),
      ).toMatchObject({ stored: false, refused: true })
      expect(
        await extension.postBrokerVerbose('/api/memory/negative', { feedback: 'isolated' }),
      ).toMatchObject({ ok: false, refused: true })
      expect(writes).toEqual([])
    },
  )

  it('recovers on the next strict-mode store even after the startup budget expired', async () => {
    let healthy = false
    const writes: string[] = []
    const extensionPromise = launchExtension(
      async (url, options) => {
        if (url.includes('/api/meta/resolve')) return healthy ? running() : recovering()
        if (url.endsWith('/api/health'))
          return response({ project_id: url.startsWith(GREEN) ? PROJECT : null })
        if (options?.method === 'POST') writes.push(url)
        return response({ stored: true })
      },
      { SCNS_REQUIRE_PROJECT_BROKER: '1' },
    )
    await vi.advanceTimersByTimeAsync(RECOVERY_BUDGET_MS)
    const extension = await extensionPromise
    healthy = true

    expect(await extension.tool('scns_memory_store', { key: 'test', value: 'isolated' })).toEqual({
      stored: true,
    })
    expect(writes).toEqual([`${GREEN}/api/memory/store`])
    expect(extension.route().label).toBe(`project:${PROJECT}`)
    expect(extension.log.join('\n')).toContain('[retry-project-route] broker=child')
  })

  it('does not reuse the global injection config after recovering the child route', async () => {
    let healthy = false
    const extensionPromise = launchExtension(
      async (url) => {
        if (url.includes('/api/meta/resolve')) return healthy ? running() : recovering()
        if (url.endsWith('/api/health')) return response({ project_id: PROJECT })
        if (url.endsWith('/api/extension/config')) {
          return response({ contextInjectionEnabled: url.startsWith(GREEN) })
        }
        return response({ stored: true })
      },
      { SCNS_REQUIRE_PROJECT_BROKER: '1' },
    )
    await vi.advanceTimersByTimeAsync(RECOVERY_BUDGET_MS)
    const extension = await extensionPromise
    expect(await extension.getInjectionConfig()).toEqual({ contextInjectionEnabled: false })
    healthy = true
    await extension.tool('scns_memory_store', { key: 'test', value: 'isolated' })

    expect(await extension.getInjectionConfig()).toEqual({ contextInjectionEnabled: true })
  })

  it.each([
    { globalEnabled: false, childEnabled: true },
    { globalEnabled: true, childEnabled: false },
  ])(
    'prompt-driven recovery uses the child config on the first recovered prompt ($childEnabled)',
    async ({ globalEnabled, childEnabled }) => {
      let healthy = false
      const contextRequests: Array<{ url: string; prompt: string }> = []
      const starting = launchExtension(async (url, options) => {
        if (url.includes('/api/meta/resolve')) return healthy ? running() : recovering()
        if (url.endsWith('/api/health')) {
          return response({ project_id: url.startsWith(GREEN) ? PROJECT : null })
        }
        if (url.endsWith('/api/extension/config')) {
          return response({
            contextInjectionEnabled: url.startsWith(GREEN) ? childEnabled : globalEnabled,
          })
        }
        if (url.endsWith('/api/extension/context')) {
          const body = JSON.parse(options?.body ?? '{}') as { prompt: string }
          contextRequests.push({ url, prompt: body.prompt })
          return response({ additionalContext: 'project-context' })
        }
        return response({ accepted: true })
      })
      await vi.advanceTimersByTimeAsync(RECOVERY_BUDGET_MS)
      const extension = await starting
      expect(await extension.prompt('before recovery')).toBeUndefined()
      await vi.advanceTimersByTimeAsync(0)
      expect(contextRequests).toEqual([])
      healthy = true

      const result = await extension.prompt('first recovered prompt')
      await vi.advanceTimersByTimeAsync(0)
      expect(result).toEqual(childEnabled ? { additionalContext: 'project-context' } : undefined)
      expect(contextRequests).toEqual(
        childEnabled
          ? [{ url: `${GREEN}/api/extension/context`, prompt: 'first recovered prompt' }]
          : [],
      )
    },
  )

  it('caps a slow recovery request at the remaining startup deadline', async () => {
    let resolves = 0
    const starting = launchExtension(async (_url, options) => {
      if (++resolves === 1) return recovering()
      return new Promise<ResponseLike>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('timed out')), {
          once: true,
        })
      })
    })
    let extension: ExtensionRuntime | undefined
    void starting.then((result) => {
      extension = result
    })
    await vi.advanceTimersByTimeAsync(RECOVERY_BUDGET_MS)

    expect(extension?.route().project).toBe(PROJECT)
    expect(extension?.log.join('\n')).toContain('timed out')
    expect(resolves).toBeGreaterThan(1)
    expect(resolves).toBeLessThan(10)
  })

  it('shares concurrent recovery attempts and writes only after the child returns', async () => {
    let healthy = false
    let resolves = 0
    let releaseResolve: (() => void) | undefined
    const writes: string[] = []
    const starting = launchExtension(async (url, options) => {
      if (url.includes('/api/meta/resolve')) {
        resolves++
        if (!healthy) return recovering()
        await new Promise<void>((resolve) => {
          releaseResolve = resolve
        })
        return running()
      }
      if (url.endsWith('/api/health')) return response({ project_id: PROJECT })
      if (options?.method === 'POST') writes.push(url)
      return response({ stored: true })
    })
    await vi.advanceTimersByTimeAsync(RECOVERY_BUDGET_MS)
    const extension = await starting
    const before = resolves
    healthy = true
    const first = extension.fetchBroker('/api/memory/store', { method: 'POST', body: '{}' })
    const second = extension.postBrokerVerbose('/api/memory/negative', { feedback: 'isolated' })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolves).toBe(before + 1)
    expect(writes).toEqual([])
    releaseResolve?.()

    expect(await first).toEqual({ stored: true })
    expect(await second).toMatchObject({ ok: true, broker: GREEN })
    expect(writes).toEqual([`${GREEN}/api/memory/store`, `${GREEN}/api/memory/negative`])
  })

  it.each(['no-project-for-path', 'no-meta-registry', 'child-failed', 'child-stopped'])(
    'does not poll a permanent resolution failure: %s',
    async (reason) => {
      const fetch = vi.fn<Fetch>(async () => response({ resolved: false, reason }))
      const extension = await launchExtension(fetch)
      expect(Date.now()).toBe(0)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(extension.route().label).toBe('global:fallback')
    },
  )

  it('does not retry an authorization failure', async () => {
    const fetch = vi.fn<Fetch>(async () => response({ error: 'unauthorized' }, 401))
    const extension = await launchExtension(fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(extension.log.join('\n')).toContain('HTTP 401')
  })

  it('keeps unregistered strict-mode sessions refused without polling for a new registration', async () => {
    const fetch = vi.fn<Fetch>(async () =>
      response({ resolved: false, reason: 'no-project-for-path' }),
    )
    const extension = await launchExtension(fetch, { SCNS_REQUIRE_PROJECT_BROKER: '1' })
    expect(await extension.tool('scns_memory_store')).toMatchObject({
      stored: false,
      refused: true,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not delay a healthy startup', async () => {
    const fetch = vi.fn<Fetch>(async () => running())
    const extension = await launchExtension(fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(Date.now()).toBe(0)
    expect(extension.route().url).toBe(GREEN)
  })

  it('does not adopt another project when the registry changes during startup recovery', async () => {
    let resolves = 0
    const writes: string[] = []
    const starting = launchExtension(async (url, options) => {
      if (url.includes('/api/meta/resolve')) {
        return ++resolves === 1 ? recovering() : running(GREEN, 'another-project')
      }
      if (options?.method === 'POST') writes.push(url)
      return response({ project_id: 'another-project', stored: true })
    })
    await vi.advanceTimersByTimeAsync(500)
    const extension = await starting

    expect(
      await extension.fetchBroker('/api/memory/store', { method: 'POST', body: '{}' }),
    ).toMatchObject({ stored: false, refused: true })
    expect(extension.route().project).toBe(PROJECT)
    expect(writes).toEqual([])
  })

  it('leaves an env-pinned team broker alone', async () => {
    const fetch = vi.fn<Fetch>()
    const extension = await launchExtension(fetch, {
      SCNS_BROKER_URL: BLUE,
      SCNS_TEAM_ID: 'team-test',
      SCNS_SESSION_ID: 'session-test',
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(extension.route().url).toBe(BLUE)
  })

  it('does not turn an identity failure into permission to write to global', async () => {
    let available = true
    const writes: string[] = []
    const extension = await launchExtension(async (url, options) => {
      if (url.includes('/api/meta/resolve')) return available ? running(BLUE) : recovering()
      if (url.endsWith('/api/health')) return response({ project_id: 'another-project' })
      if (options?.method === 'POST') writes.push(url)
      return response({ stored: true })
    })
    available = false

    expect(
      await extension.fetchBroker('/api/memory/store', { method: 'POST', body: '{}' }),
    ).toMatchObject({ stored: false, refused: true })
    expect(extension.route().project).toBe(PROJECT)
    expect(writes).toEqual([])
  })

  it.each(['ordinary', 'verbose'])(
    'rechecks identity before a %s write retry after a transport failure',
    async (kind) => {
      let resolves = 0
      const writes: string[] = []
      const extension = await launchExtension(async (url, options) => {
        if (url.includes('/api/meta/resolve')) return running(++resolves === 1 ? BLUE : GREEN)
        if (url.endsWith('/api/health')) {
          return response({ project_id: url.startsWith(BLUE) ? PROJECT : 'another-project' })
        }
        if (options?.method === 'POST') writes.push(url)
        if (url.startsWith(BLUE)) throw new Error('ECONNREFUSED')
        return response({ stored: true })
      })

      const result =
        kind === 'ordinary'
          ? await extension.fetchBroker('/api/memory/store', { method: 'POST', body: '{}' })
          : await extension.postBrokerVerbose('/api/memory/negative', { feedback: 'isolated' })
      expect(result).toMatchObject({ refused: true })
      expect(writes).toHaveLength(1)
      expect(writes[0]).toContain(BLUE)
    },
  )
})
