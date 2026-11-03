import { homedir } from 'node:os'
import { join } from 'node:path'

// ─── Types ──────────────────────────────────────────────────────

export interface EnvValidationResult {
  readonly valid: boolean
  readonly errors: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
  readonly defaults: ReadonlyArray<string>
}

export interface StartupConfig {
  readonly port: number
  readonly token: string | null
  readonly dbPath: string
  readonly nodeEnv: string
  readonly healthUrl: string
  readonly liveUrl: string
}

export interface HealthCheckResult {
  readonly healthy: boolean
  readonly attempts: number
  readonly elapsedMs: number
  readonly lastError?: string
}

export interface HealthCheckOptions {
  readonly url: string
  readonly maxRetries?: number
  readonly retryIntervalMs?: number
  readonly fetcher?: (url: string) => Promise<{ ok: boolean; status: number }>
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_PORT = 3456
const DEFAULT_DB_PATH = join(homedir(), '.session-broker', 'data.db')
const DEFAULT_MAX_RETRIES = 30
const DEFAULT_RETRY_INTERVAL_MS = 1000
const MIN_PORT = 1
const MAX_PORT = 65535

// ─── Environment Validation ─────────────────────────────────────

function validatePort(portStr: string | undefined): ReadonlyArray<string> {
  if (portStr === undefined) return []
  const parsed = Number(portStr)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    return [`BROKER_PORT must be an integer between ${MIN_PORT} and ${MAX_PORT}, got: "${portStr}"`]
  }
  return []
}

function collectDefaults(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const defaults: string[] = []
  if (env.BROKER_PORT === undefined) {
    defaults.push(`BROKER_PORT=${DEFAULT_PORT}`)
  }
  if (env.BROKER_TOKEN === undefined) {
    defaults.push('BROKER_TOKEN=(not set, auth disabled)')
  }
  if (env.BROKER_DB_PATH === undefined) {
    defaults.push(`BROKER_DB_PATH=${DEFAULT_DB_PATH}`)
  }
  return defaults
}

function collectWarnings(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const warnings: string[] = []
  if (env.NODE_ENV === 'production' && !env.BROKER_TOKEN) {
    warnings.push('BROKER_TOKEN is not set in production — all endpoints are unauthenticated')
  }
  return warnings
}

export function validateEnv(): EnvValidationResult {
  const errors = [...validatePort(process.env.BROKER_PORT)]
  const warnings = [...collectWarnings(process.env)]
  const defaults = [...collectDefaults(process.env)]

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    defaults: Object.freeze(defaults),
  })
}

// ─── Configuration Resolution ───────────────────────────────────

function parsePort(portStr: string | undefined): number {
  if (portStr === undefined) return DEFAULT_PORT
  const parsed = Number(portStr)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT
}

export function resolveConfig(): StartupConfig {
  const port = parsePort(process.env.BROKER_PORT)
  const token = process.env.BROKER_TOKEN ?? null
  const dbPath = process.env.BROKER_DB_PATH ?? DEFAULT_DB_PATH
  const nodeEnv = process.env.NODE_ENV ?? 'development'

  return Object.freeze({
    port,
    token,
    dbPath,
    nodeEnv,
    healthUrl: `http://localhost:${port}/health/ready`,
    liveUrl: `http://localhost:${port}/health/live`,
  })
}

// ─── Health Check Retry ─────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForHealthy(options: HealthCheckOptions): Promise<HealthCheckResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
  const fetcher = options.fetcher ?? globalThis.fetch

  const startTime = Date.now()
  let lastError: string | undefined
  let attempts = 0

  for (let i = 0; i < maxRetries; i++) {
    attempts++
    try {
      const response = await fetcher(options.url)
      if (response.ok) {
        return Object.freeze({
          healthy: true,
          attempts,
          elapsedMs: Date.now() - startTime,
        })
      }
      lastError = `HTTP ${response.status}`
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    if (i < maxRetries - 1) {
      await sleep(retryIntervalMs)
    }
  }

  return Object.freeze({
    healthy: false,
    attempts,
    elapsedMs: Date.now() - startTime,
    lastError,
  })
}
