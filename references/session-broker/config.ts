import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

export interface BrokerConfig {
  readonly port: number
  readonly dbPath: string
  readonly heartbeatIntervalMs: number
  readonly heartbeatTimeoutMs: number
  readonly zombieGraceMs: number
  readonly brokerToken: string | null
  readonly autoRespawn: boolean
  readonly maxRespawnRetries: number
  readonly respawnBackoffBaseMs: number
  readonly autoScaleIntervalMs: number
  readonly autoScaleEnabled: boolean
}

const DEFAULTS: BrokerConfig = {
  port: 3456,
  dbPath: join(homedir(), '.session-broker', 'data.db'),
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 20_000,
  zombieGraceMs: 300_000,
  brokerToken: null,
  autoRespawn: true,
  maxRespawnRetries: 3,
  respawnBackoffBaseMs: 5000,
  autoScaleIntervalMs: 30_000,
  autoScaleEnabled: false,
}

export function ensureDbDirectory(dbPath: string): void {
  if (dbPath === ':memory:') return
  const dir = dirname(dbPath)
  mkdirSync(dir, { recursive: true })
}

function readInt(envVar: string | undefined, fallback: number): number {
  if (envVar === undefined) return fallback
  const parsed = Number(envVar)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function loadConfig(): BrokerConfig {
  return Object.freeze({
    port: readInt(process.env.BROKER_PORT, DEFAULTS.port),
    dbPath: process.env.BROKER_DB_PATH ?? DEFAULTS.dbPath,
    heartbeatIntervalMs: readInt(process.env.BROKER_HEARTBEAT_INTERVAL_MS, DEFAULTS.heartbeatIntervalMs),
    heartbeatTimeoutMs: readInt(process.env.BROKER_HEARTBEAT_TIMEOUT_MS, DEFAULTS.heartbeatTimeoutMs),
    zombieGraceMs: readInt(process.env.BROKER_ZOMBIE_GRACE_MS, DEFAULTS.zombieGraceMs),
    brokerToken: process.env.BROKER_TOKEN ?? DEFAULTS.brokerToken,
    autoRespawn: process.env.BROKER_AUTO_RESPAWN !== 'false',
    maxRespawnRetries: readInt(process.env.BROKER_MAX_RESPAWN_RETRIES, DEFAULTS.maxRespawnRetries),
    respawnBackoffBaseMs: readInt(process.env.BROKER_RESPAWN_BACKOFF_BASE_MS, DEFAULTS.respawnBackoffBaseMs),
    autoScaleIntervalMs: readInt(process.env.BROKER_AUTO_SCALE_INTERVAL_MS, DEFAULTS.autoScaleIntervalMs),
    autoScaleEnabled: process.env.BROKER_AUTO_SCALE === 'true',
  })
}
