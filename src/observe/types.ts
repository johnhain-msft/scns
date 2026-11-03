import { z } from 'zod'

/** All supported observation types */
export const ObservationType = {
  ActiveApp: 'active-app',
  FileChange: 'file-change',
  ConfigChange: 'config-change',
  GitActivity: 'git-activity',
  TerminalHistory: 'terminal-history',
  BrowserTab: 'browser-tab',
  SessionHook: 'session-hook',
} as const

export type ObservationType = (typeof ObservationType)[keyof typeof ObservationType]

const observationTypeValues = Object.values(ObservationType) as [string, ...string[]]

/** Zod schema for a single observation event */
export const ObservationSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(observationTypeValues) as z.ZodType<ObservationType>,
  timestamp: z.string().datetime(),
  source: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  metadata: z.record(z.unknown()).optional(),
})

export type Observation = z.infer<typeof ObservationSchema>

/** Per-observer configuration */
export const ObserverConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMs: z.number().min(1000).optional(),
  directories: z.array(z.string()).optional(),
  repos: z.array(z.string()).optional(),
  optIn: z.boolean().default(false),
})

export type ObserverConfig = z.infer<typeof ObserverConfigSchema>

/** Global privacy settings */
export const PrivacyConfigSchema = z.object({
  excludeApps: z.array(z.string()).default([]),
  excludePaths: z.array(z.string()).default([]),
  excludeUrls: z.array(z.string()).default([]),
  sanitizeSecrets: z.boolean().default(true),
  terminalHistoryOptIn: z.boolean().default(false),
  browserTabsOptIn: z.boolean().default(false),
})

export type PrivacyConfig = z.infer<typeof PrivacyConfigSchema>
