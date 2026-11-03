/**
 * Context Injector — queries SCNS broker for relevant context to inject into Copilot sessions.
 *
 * Opt-in by default (OFF). Checks broker config with 60s TTL cache.
 * 500ms timeout on all calls. Returns undefined on any failure.
 */

export interface InjectionConfig {
  readonly contextInjectionEnabled: boolean
  readonly maxMemories?: number
  readonly maxSuggestions?: number
}

export interface InjectionContext {
  readonly additionalContext: string
  readonly memoriesUsed: number
  readonly suggestionsUsed: number
}

export interface ContextInjectorConfig {
  readonly brokerUrl: string
  readonly timeoutMs?: number
  readonly configCacheTtlMs?: number
}

interface CachedConfig {
  config: InjectionConfig
  fetchedAt: number
}

export interface ContextInjectorApi {
  isInjectionEnabled(): Promise<boolean>
  getContext(prompt: string, cwd?: string): Promise<InjectionContext | undefined>
  invalidateCache(): void
}

/** Create a context injector that queries the SCNS broker */
export function createContextInjector(config: ContextInjectorConfig): ContextInjectorApi {
  const timeoutMs = config.timeoutMs ?? 500
  const cacheTtlMs = config.configCacheTtlMs ?? 60_000
  let cachedConfig: CachedConfig | null = null

  async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      })
      if (!response.ok) return null
      return (await response.json()) as T
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** Check if context injection is enabled (cached with TTL) */
  async function isInjectionEnabled(): Promise<boolean> {
    const now = Date.now()

    if (cachedConfig && now - cachedConfig.fetchedAt < cacheTtlMs) {
      return cachedConfig.config.contextInjectionEnabled
    }

    const result = await fetchJson<InjectionConfig>(`${config.brokerUrl}/api/extension/config`)

    if (result) {
      cachedConfig = { config: result, fetchedAt: now }
      return result.contextInjectionEnabled
    }

    // On failure, use cached value if available, otherwise assume disabled
    return cachedConfig?.config.contextInjectionEnabled ?? false
  }

  /** Query broker for context to inject based on a user prompt */
  async function getContext(prompt: string, cwd?: string): Promise<InjectionContext | undefined> {
    const enabled = await isInjectionEnabled()
    if (!enabled) return undefined

    const result = await fetchJson<{
      additionalContext?: string
      memoriesUsed?: number
      suggestionsUsed?: number
    }>(`${config.brokerUrl}/api/extension/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, cwd }),
    })

    if (!result?.additionalContext) return undefined

    return {
      additionalContext: result.additionalContext,
      memoriesUsed: result.memoriesUsed ?? 0,
      suggestionsUsed: result.suggestionsUsed ?? 0,
    }
  }

  /** Invalidate the cached config (for testing or config changes) */
  function invalidateCache(): void {
    cachedConfig = null
  }

  return { isInjectionEnabled, getContext, invalidateCache }
}
