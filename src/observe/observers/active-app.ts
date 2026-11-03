import { randomUUID } from 'node:crypto'
import type { Observer, ObserverState } from '../observer.js'
import { ObservationType, type Observation, type ObserverConfig } from '../types.js'
import { buildTags } from '../tags.js'
import type { CommandExecutor } from '../command-executor.js'
import type { createDailyLogWriter } from '../daily-log-writer.js'
import type { createPrivacyFilter } from '../privacy-filter.js'
import { logger } from '../../shared/logger.js'
import { createActiveAppBackend, type Platform } from './active-app-backends.js'

export interface ActiveAppObserverOptions {
  readonly executor: CommandExecutor
  readonly logWriter: ReturnType<typeof createDailyLogWriter>
  readonly privacyFilter: ReturnType<typeof createPrivacyFilter>
  readonly config: ObserverConfig
  readonly intervalMs?: number
  readonly platform?: Platform
}

const DEFAULT_INTERVAL_MS = 30_000

export function createActiveAppObserver(options: ActiveAppObserverOptions): Observer & {
  poll(): Promise<Observation | null>
  getLastApp(): string | null
} {
  const { executor, logWriter, privacyFilter, config } = options
  const intervalMs = options.intervalMs ?? config.intervalMs ?? DEFAULT_INTERVAL_MS
  // The start() support guard honors an injected platform (host platform
  // otherwise), so tests can exercise the polling loop on any OS. The
  // BACKEND keeps its legacy darwin default: poll()-level tests inject a
  // fake executor without a platform and rely on the darwin script shape.
  const platform = options.platform ?? (process.platform as Platform)
  const backend = createActiveAppBackend(options.platform ?? 'darwin')

  let state: ObserverState = 'idle'
  let timer: ReturnType<typeof setInterval> | null = null
  let lastApp: string | null = null

  const log = logger.child({ observer: 'active-app' })

  async function poll(): Promise<Observation | null> {
    try {
      const info = await backend.poll(executor)
      if (info === null) return null

      const { appName, windowTitle } = info

      if (appName === lastApp) {
        return null
      }

      if (privacyFilter.isAppExcluded(appName)) {
        return null
      }

      lastApp = appName

      const observation: Observation = {
        id: randomUUID(),
        type: ObservationType.ActiveApp,
        timestamp: new Date().toISOString(),
        source: appName,
        content: windowTitle,
        tags: buildTags(ObservationType.ActiveApp, appName),
      }

      logWriter.write(observation)
      return observation
    } catch (error) {
      log.error({ error }, 'Failed to poll active app')
      return null
    }
  }

  function start(): void {
    if (!config.enabled) return
    if (state === 'running') return

    // Active-app detection requires platform-specific tools (AppleScript, xdotool).
    // On unsupported platforms the noop backend always returns null, so skip polling.
    if (platform !== 'darwin' && platform !== 'linux') {
      log.warn({ platform }, 'Active-app observer not supported on this platform — skipping')
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
    type: ObservationType.ActiveApp,
    name: 'active-app',
    start,
    stop,
    isRunning: () => state === 'running',
    poll,
    getLastApp: () => lastApp,
  }
}
