import { randomUUID } from 'node:crypto'
import type { Observer, ObserverState } from '../observer.js'
import { ObservationType, type Observation, type ObserverConfig } from '../types.js'
import { buildTags } from '../tags.js'
import type { CommandExecutor } from '../command-executor.js'
import type { createDailyLogWriter } from '../daily-log-writer.js'
import type { createPrivacyFilter } from '../privacy-filter.js'
import { logger } from '../../shared/logger.js'
import { createBrowserTabsBackend, type Platform } from './browser-tabs-backends.js'

export interface BrowserTabObserverOptions {
  readonly executor: CommandExecutor
  readonly logWriter: ReturnType<typeof createDailyLogWriter>
  readonly privacyFilter: ReturnType<typeof createPrivacyFilter>
  readonly config: ObserverConfig
  readonly intervalMs?: number
  readonly platform?: Platform
}

const DEFAULT_INTERVAL_MS = 60_000

export function createBrowserTabObserver(options: BrowserTabObserverOptions): Observer & {
  poll(): Promise<Observation[]>
} {
  const { executor, logWriter, privacyFilter, config } = options
  const intervalMs = options.intervalMs ?? config.intervalMs ?? DEFAULT_INTERVAL_MS
  // The start() support guard honors an injected platform (host platform
  // otherwise), so tests can exercise the polling loop on any OS. The
  // BACKEND keeps its legacy darwin default: poll()-level tests inject a
  // fake executor without a platform and rely on the darwin script shape.
  const platform = options.platform ?? (process.platform as Platform)
  const backend = createBrowserTabsBackend(options.platform ?? 'darwin')

  let state: ObserverState = 'idle'
  let timer: ReturnType<typeof setInterval> | null = null
  const lastTabs = new Map<string, string>()

  const log = logger.child({ observer: 'browser-tab' })

  async function poll(): Promise<Observation[]> {
    if (!config.optIn) return []

    const observations: Observation[] = []

    try {
      const tabs = await backend.poll(executor)

      for (const tab of tabs) {
        if (tab.url !== undefined && privacyFilter.isUrlExcluded(tab.url)) continue

        const dedupKey = `${tab.browser}:${tab.url ?? ''}:${tab.title}`
        if (lastTabs.get(tab.browser) === dedupKey) continue
        lastTabs.set(tab.browser, dedupKey)

        const observation: Observation = {
          id: randomUUID(),
          type: ObservationType.BrowserTab,
          timestamp: new Date().toISOString(),
          source: tab.browser,
          content: tab.title,
          tags: buildTags(ObservationType.BrowserTab, tab.browser),
          metadata: tab.url !== undefined ? { url: tab.url } : undefined,
        }

        logWriter.write(observation)
        observations.push(observation)
      }
    } catch (error) {
      log.error({ error }, 'Failed to poll browser tabs')
    }

    return observations
  }

  function start(): void {
    if (!config.optIn) return
    if (!config.enabled) return
    if (state === 'running') return

    // Browser-tab detection requires platform-specific tools (AppleScript, xdotool).
    // On unsupported platforms the noop backend always returns [], so skip polling.
    if (platform !== 'darwin' && platform !== 'linux') {
      log.warn({ platform }, 'Browser-tab observer not supported on this platform — skipping')
      return
    }

    state = 'running'
    timer = setInterval(() => {
      void poll()
    }, intervalMs)
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    state = 'idle'
  }

  return {
    type: ObservationType.BrowserTab,
    name: 'browser-tab',
    start,
    stop,
    isRunning: () => state === 'running',
    poll,
  }
}
