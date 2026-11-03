import { z } from 'zod'
import { ObserverConfigSchema, PrivacyConfigSchema } from './types.js'
import { autoDetectProjectDirs, autoDetectGitRepos, getCommonCodeDirs } from './auto-detect.js'

/** Chronicle-specific configuration schema */
export const ChronicleObserverConfigSchema = z.object({
  enabled: z.boolean().default(false),
  chroniclePath: z.string().default('~/.copilot/chronicle'),
  pollIntervalMs: z.number().min(1000).default(30000),
  maxEntriesPerPoll: z.number().min(1).default(100),
})

export type ChronicleObserverConfig = z.infer<typeof ChronicleObserverConfigSchema>

/** Session-store poller configuration schema (used internally by ObservationConfigSchema) */
const SessionStorePollerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  dbPath: z.string().default('~/.copilot/session-store.db'),
  pollIntervalMs: z.number().min(5000).default(60000),
  maxSessionsPerPoll: z.number().min(1).default(50),
})

// SessionStorePollerConfig type used internally by ObservationConfigSchema below

/** Full observation configuration schema */
export const ObservationConfigSchema = z.object({
  privacy: PrivacyConfigSchema.default({}),
  activeApp: ObserverConfigSchema.default({ enabled: true, intervalMs: 30_000 }),
  fileChanges: ObserverConfigSchema.default({ enabled: true }),
  gitActivity: ObserverConfigSchema.default({ enabled: true, intervalMs: 300_000 }),
  terminalHistory: ObserverConfigSchema.default({
    enabled: false,
    intervalMs: 60_000,
    optIn: false,
  }),
  browserTabs: ObserverConfigSchema.default({ enabled: false, intervalMs: 60_000, optIn: false }),
  sessionHooks: ObserverConfigSchema.default({ enabled: true }),
  configChanges: ObserverConfigSchema.default({ enabled: true }),
  chronicle: ChronicleObserverConfigSchema.default({ enabled: false }),
  sessionStorePoller: SessionStorePollerConfigSchema.default({ enabled: true }),
})

export type ObservationConfig = z.infer<typeof ObservationConfigSchema>

function readInt(envVar: string | undefined, fallback: number): number {
  if (envVar === undefined) return fallback
  const parsed = Number(envVar)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readBool(envVar: string | undefined, fallback: boolean): boolean {
  if (envVar === undefined) return fallback
  if (envVar === 'true' || envVar === '1') return true
  if (envVar === 'false' || envVar === '0') return false
  return fallback
}

function readList(envVar: string | undefined): string[] | undefined {
  if (envVar === undefined || envVar === '') return undefined
  return envVar
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Load observation config from OBSERVE_* environment variables */
export function loadObservationConfig(): Readonly<ObservationConfig> {
  const terminalOptIn = readBool(process.env['OBSERVE_TERMINAL_OPT_IN'], false)
  const browserOptIn = readBool(process.env['OBSERVE_BROWSER_OPT_IN'], false)

  const config: ObservationConfig = {
    privacy: {
      excludeApps: readList(process.env['OBSERVE_EXCLUDE_APPS']) ?? [],
      excludePaths: readList(process.env['OBSERVE_EXCLUDE_PATHS']) ?? [],
      excludeUrls: readList(process.env['OBSERVE_EXCLUDE_URLS']) ?? [],
      sanitizeSecrets: readBool(process.env['OBSERVE_SANITIZE_SECRETS'], true),
      terminalHistoryOptIn: terminalOptIn,
      browserTabsOptIn: browserOptIn,
    },
    activeApp: {
      enabled: readBool(process.env['OBSERVE_ACTIVE_APP_ENABLED'], true),
      intervalMs: readInt(process.env['OBSERVE_ACTIVE_APP_INTERVAL_MS'], 30_000),
      optIn: false,
    },
    fileChanges: {
      enabled: readBool(process.env['OBSERVE_FILE_ENABLED'], true),
      directories:
        process.env['OBSERVE_FILE_DIRS'] !== undefined
          ? readList(process.env['OBSERVE_FILE_DIRS'])
          : autoDetectProjectDirs(getCommonCodeDirs()),
      optIn: false,
    },
    gitActivity: {
      enabled: readBool(process.env['OBSERVE_GIT_ENABLED'], true),
      intervalMs: readInt(process.env['OBSERVE_GIT_INTERVAL_MS'], 300_000),
      repos:
        process.env['OBSERVE_GIT_REPOS'] !== undefined
          ? readList(process.env['OBSERVE_GIT_REPOS'])
          : autoDetectGitRepos(getCommonCodeDirs()),
      optIn: false,
    },
    terminalHistory: {
      enabled: terminalOptIn,
      intervalMs: readInt(process.env['OBSERVE_TERMINAL_INTERVAL_MS'], 60_000),
      optIn: terminalOptIn,
    },
    browserTabs: {
      enabled: browserOptIn,
      intervalMs: readInt(process.env['OBSERVE_BROWSER_INTERVAL_MS'], 60_000),
      optIn: browserOptIn,
    },
    sessionHooks: {
      enabled: readBool(process.env['OBSERVE_SESSION_HOOKS_ENABLED'], true),
      optIn: false,
    },
    configChanges: {
      enabled: readBool(process.env['OBSERVE_CONFIG_CHANGES_ENABLED'], true),
      optIn: false,
    },
    chronicle: {
      enabled: readBool(process.env['OBSERVE_CHRONICLE_ENABLED'], false),
      chroniclePath: process.env['OBSERVE_CHRONICLE_PATH'] ?? '~/.copilot/chronicle',
      pollIntervalMs: readInt(process.env['OBSERVE_CHRONICLE_INTERVAL_MS'], 30_000),
      maxEntriesPerPoll: readInt(process.env['OBSERVE_CHRONICLE_MAX_ENTRIES'], 100),
    },
    sessionStorePoller: {
      enabled: readBool(process.env['OBSERVE_SESSION_STORE_ENABLED'], true),
      dbPath: process.env['OBSERVE_SESSION_STORE_PATH'] ?? '~/.copilot/session-store.db',
      pollIntervalMs: readInt(process.env['OBSERVE_SESSION_STORE_INTERVAL_MS'], 60_000),
      maxSessionsPerPoll: readInt(process.env['OBSERVE_SESSION_STORE_MAX_SESSIONS'], 50),
    },
  }

  return Object.freeze(config)
}
