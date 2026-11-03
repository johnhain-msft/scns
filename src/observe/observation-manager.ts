/**
 * Observation Manager — central lifecycle manager for all observers.
 */

import type { Observer } from './observer.js'
import type { ObserverPlugin } from './plugin.js'
import type { ObservationType, Observation } from './types.js'
import type { ObservationConfig } from './config.js'
import type { SessionEventData } from './observers/session-hooks.js'
import { createBuiltinAdapter } from './builtin-adapter.js'
import { OBSERVER_CAPABILITIES, OBSERVER_DESCRIPTIONS } from './builtin-capabilities.js'
import { createVault } from '../memory/vault.js'
import { createDailyLogWriter } from './daily-log-writer.js'
import { createPrivacyFilter } from './privacy-filter.js'
import { createSecretSanitizer } from './secret-sanitizer.js'
import { createSystemExecutor } from './command-executor.js'
import { createActiveAppObserver } from './observers/active-app.js'
import { createBrowserTabObserver } from './observers/browser-tabs.js'
import { detectPlatform } from '../broker/services/platform.js'
import { createFileChangeObserver } from './observers/file-changes.js'
import { createGitActivityObserver } from './observers/git-activity.js'
import { createTerminalHistoryObserver } from './observers/terminal-history.js'
import { createSessionHookHandler } from './observers/session-hooks.js'
import { createConfigChangeObserver } from './discovery/config-change-observer.js'
import { createChroniclePlugin } from './plugins/chronicle-reader.js'
import { createSessionStorePoller } from './plugins/session-store-poller.js'
import { logger } from '../shared/logger.js'

export interface ObserverFactory {
  createActiveApp(options: unknown): Observer
  createBrowserTabs(options: unknown): Observer
  createFileChanges(options: unknown): Observer
  createGitActivity(options: unknown): Observer
  createTerminalHistory(options: unknown): Observer
  createSessionHooks(
    options: unknown,
  ): Observer & { handleEvent(event: SessionEventData): Observation }
  createConfigChanges(options: unknown): Observer
}

export interface ObservationManagerOptions {
  readonly config: ObservationConfig
  readonly vaultRootDir: string
  readonly observerFactory?: ObserverFactory
  readonly maxBufferSize?: number
  /**
   * Repositories the git observer should poll first (e.g. the broker's own
   * project root) so their commit history seeds the buffer before slower repos.
   */
  readonly gitPriorityRepos?: readonly string[]
}

export interface ObservationManagerStatus {
  readonly state: 'idle' | 'running' | 'stopping'
  readonly observers: readonly {
    readonly name: string
    readonly type: string
    readonly running: boolean
  }[]
  readonly startedAt: string | null
  readonly observationCount: number
  /**
   * Observations whose daily-log write failed and were therefore never persisted.
   * `observationCount` deliberately counts durable writes only, and it gates the
   * brain's learning pass — so a vault that is unwritable from the first
   * observation would otherwise leave the brain idle with nothing to show why.
   */
  readonly droppedCount: number
  /** Message of the most recent daily-log write failure, or null if none. */
  readonly lastWriteError: string | null
}

function createDefaultFactory(): ObserverFactory {
  return {
    createActiveApp: (opts: unknown) =>
      createActiveAppObserver(opts as Parameters<typeof createActiveAppObserver>[0]),
    createBrowserTabs: (opts: unknown) =>
      createBrowserTabObserver(opts as Parameters<typeof createBrowserTabObserver>[0]),
    createFileChanges: (opts: unknown) =>
      createFileChangeObserver(opts as Parameters<typeof createFileChangeObserver>[0]),
    createGitActivity: (opts: unknown) =>
      createGitActivityObserver(opts as Parameters<typeof createGitActivityObserver>[0]),
    createTerminalHistory: (opts: unknown) =>
      createTerminalHistoryObserver(opts as Parameters<typeof createTerminalHistoryObserver>[0]),
    createSessionHooks: (opts: unknown) =>
      createSessionHookHandler(opts as Parameters<typeof createSessionHookHandler>[0]),
    createConfigChanges: (opts: unknown) =>
      createConfigChangeObserver(opts as Parameters<typeof createConfigChangeObserver>[0]),
  }
}

export function createObservationManager(options: ObservationManagerOptions) {
  const { config, vaultRootDir } = options
  const factory = options.observerFactory ?? createDefaultFactory()
  const maxBufferSize = options.maxBufferSize ?? 10_000
  const log = logger.child({ module: 'observation-manager' })

  interface ObserverEntry {
    readonly observer: Observer
    readonly plugin: ObserverPlugin
  }

  const entries: ObserverEntry[] = []
  const nativePlugins: ObserverPlugin[] = []
  let sessionHookHandler:
    | (Observer & { handleEvent(event: SessionEventData): Observation })
    | null = null
  let state: 'idle' | 'running' | 'stopping' = 'idle'
  let startedAt: string | null = null
  let observationCount = 0
  let droppedCount = 0
  let lastWriteError: string | null = null

  // GAP-021: In-memory observation buffer for query access.
  // Persists across stop/start cycles. Native plugins are not captured here.
  const observationBuffer: Observation[] = []

  function buildDeps() {
    const vault = createVault({ rootDir: vaultRootDir })
    const privacyFilter = createPrivacyFilter({ config: config.privacy })
    const secretSanitizer = createSecretSanitizer()
    const countingWriter = {
      appendDailyLog(entry: string, date?: Date) {
        // Observers write from timer callbacks, where a throw has no catch above
        // it and reaches the process-level uncaught handler — which shuts the
        // broker down. A failed observation must never take the broker with it,
        // so this logs loudly and continues rather than propagating.
        try {
          vault.appendDailyLog(entry, date)
          observationCount++
        } catch (err) {
          droppedCount++
          lastWriteError = err instanceof Error ? err.message : String(err)
          // Rate-limit: these run on timers, so an unwritable vault would
          // otherwise emit an identical line per observation forever. Child
          // logs already reach several MB.
          if (droppedCount === 1 || droppedCount % 50 === 0) {
            logger.error(
              { err, module: 'observation-manager', vaultRootDir, droppedCount },
              'daily-log append failed — observation dropped, broker continuing',
            )
          }
        }
      },
    }
    const logWriter = createDailyLogWriter(countingWriter, bufferObservation)
    const executor = createSystemExecutor()
    return { privacyFilter, secretSanitizer, logWriter, executor }
  }

  function createObservers() {
    const { privacyFilter, secretSanitizer, logWriter, executor } = buildDeps()
    const platform = detectPlatform()

    if (config.activeApp.enabled) {
      tryCreate('active-app', () =>
        factory.createActiveApp({
          executor,
          logWriter,
          privacyFilter,
          config: config.activeApp,
          platform,
        }),
      )
    }

    if (config.fileChanges.enabled) {
      tryCreate('file-change', () =>
        factory.createFileChanges({ logWriter, privacyFilter, config: config.fileChanges }),
      )
    }

    if (config.gitActivity.enabled) {
      tryCreate('git-activity', () =>
        factory.createGitActivity({
          logWriter,
          privacyFilter,
          config: config.gitActivity,
          priorityRepos: options.gitPriorityRepos ?? [],
        }),
      )
    }

    if (config.terminalHistory.enabled && config.terminalHistory.optIn) {
      tryCreate('terminal-history', () =>
        factory.createTerminalHistory({
          sanitizer: secretSanitizer,
          logWriter,
          privacyFilter,
          config: config.terminalHistory,
        }),
      )
    }

    if (config.browserTabs.enabled && config.browserTabs.optIn) {
      tryCreate('browser-tab', () =>
        factory.createBrowserTabs({
          executor,
          logWriter,
          privacyFilter,
          config: config.browserTabs,
          platform,
        }),
      )
    }

    if (config.sessionHooks.enabled) {
      try {
        const handler = factory.createSessionHooks({ logWriter, config: config.sessionHooks })
        sessionHookHandler = handler
        addEntry(handler)
      } catch (err) {
        log.warn({ err }, 'Failed to create session-hook observer')
      }
    }

    if (config.configChanges.enabled) {
      tryCreate('config-change', () =>
        factory.createConfigChanges({ logWriter, config: config.configChanges }),
      )
    }

    if (config.chronicle?.enabled) {
      try {
        const chroniclePlugin = createChroniclePlugin({
          chroniclePath: config.chronicle.chroniclePath,
          pollIntervalMs: config.chronicle.pollIntervalMs,
          maxEntriesPerPoll: config.chronicle.maxEntriesPerPoll,
        })
        nativePlugins.push(chroniclePlugin)
      } catch (err) {
        log.warn({ err }, 'Failed to create chronicle plugin')
      }
    }

    if (config.sessionStorePoller?.enabled) {
      try {
        const pollerPlugin = createSessionStorePoller({
          dbPath: config.sessionStorePoller.dbPath,
          pollIntervalMs: config.sessionStorePoller.pollIntervalMs,
          maxSessionsPerPoll: config.sessionStorePoller.maxSessionsPerPoll,
        })
        nativePlugins.push(pollerPlugin)
      } catch (err) {
        log.warn({ err }, 'Failed to create session-store poller plugin')
      }
    }
  }

  function wrapObserver(observer: Observer): ObserverPlugin {
    return createBuiltinAdapter(observer, {
      capabilities: OBSERVER_CAPABILITIES[observer.name],
      description: OBSERVER_DESCRIPTIONS[observer.name],
    })
  }

  function addEntry(observer: Observer): void {
    entries.push({ observer, plugin: wrapObserver(observer) })
  }

  function tryCreate(label: string, fn: () => Observer) {
    try {
      addEntry(fn())
    } catch (err) {
      log.warn({ err, observer: label }, 'Failed to create observer')
    }
  }

  function startAllObservers() {
    for (const { observer } of entries) {
      try {
        observer.start()
      } catch (err) {
        log.warn({ err, observer: observer.name }, 'Failed to start observer')
      }
    }
    for (const plugin of nativePlugins) {
      try {
        plugin.start()
      } catch (err) {
        log.warn({ err, plugin: plugin.metadata.name }, 'Failed to start native plugin')
      }
    }
  }

  function start(): void {
    if (state === 'running') return
    createObservers()
    startAllObservers()
    state = 'running'
    startedAt = new Date().toISOString()
  }

  function stop(): void {
    if (state === 'idle') return
    state = 'stopping'
    for (let i = nativePlugins.length - 1; i >= 0; i--) {
      try {
        nativePlugins[i]!.stop()
      } catch (err) {
        log.warn({ err, plugin: nativePlugins[i]!.metadata.name }, 'Failed to stop native plugin')
      }
    }
    nativePlugins.length = 0
    for (let i = entries.length - 1; i >= 0; i--) {
      try {
        entries[i]!.observer.stop()
      } catch (err) {
        log.warn({ err, observer: entries[i]!.observer.name }, 'Failed to stop observer')
      }
    }
    entries.length = 0
    sessionHookHandler = null
    state = 'idle'
  }

  function getStatus(): ObservationManagerStatus {
    return {
      state,
      observers: entries.map(({ observer }) => ({
        name: observer.name,
        type: observer.type,
        running: observer.isRunning(),
      })),
      startedAt,
      observationCount,
      droppedCount,
      lastWriteError,
    }
  }

  function isRunning(): boolean {
    return state === 'running'
  }

  function getObserver(type: ObservationType): Observer | undefined {
    return entries.find((e) => e.observer.type === type)?.observer
  }

  function getPlugins(): readonly ObserverPlugin[] {
    return [...entries.map((e) => e.plugin), ...nativePlugins]
  }

  function handleSessionEvent(event: SessionEventData): Observation | null {
    if (!sessionHookHandler) return null
    const obs = sessionHookHandler.handleEvent(event)
    // Ensure the observation is buffered even if the handler didn't go through logWriter
    // (logWriter.write also calls bufferObservation via the onObservation callback,
    // but defensive buffering avoids losing events if the path diverges)
    if (!observationBuffer.includes(obs)) {
      bufferObservation(obs)
    }
    return obs
  }

  function bufferObservation(obs: Observation): void {
    observationBuffer.push(obs)
    if (observationBuffer.length > maxBufferSize) {
      observationBuffer.splice(0, observationBuffer.length - maxBufferSize)
    }
  }

  function recordObservation(obs: Observation): void {
    bufferObservation(obs)
  }

  function getObservations(): readonly Observation[] {
    return [...observationBuffer]
  }

  return {
    start,
    stop,
    getStatus,
    isRunning,
    getObserver,
    getPlugins,
    handleSessionEvent,
    recordObservation,
    getObservations,
  }
}
