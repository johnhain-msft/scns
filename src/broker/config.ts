import { homedir } from 'node:os'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { mkdirSync, existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { logger } from '../shared/logger.js'
import { isUnattendedEnabled } from '../shared/unattended.js'
import { deriveProjectId } from './project-identity.js'

const log = logger.child({ module: 'broker-config' })

export interface BrokerConfig {
  readonly port: number
  /**
   * WI-2a — interface the broker (and each child broker, which inherits the
   * env) listens on. Defaults to loopback: every known client (Copilot
   * extension, dashboard, meta-resolve) connects via localhost, and loopback
   * avoids Windows Defender Firewall prompts on the work machine. Set
   * BROKER_BIND=0.0.0.0 only for deliberate LAN exposure.
   */
  readonly bind: string
  readonly dbPath: string
  /**
   * Absolute path to the git repository the broker manages. Drives the
   * team-worktree-manager, auto-merger, quality-gate-arbiter, dream daemon,
   * brain spawn adapter, and team-task-autospawner. Configurable via the
   * `BROKER_PROJECT_ROOT` env var; defaults to `process.cwd()` (which on the
   * production launchd plist is the SCNS source tree, preserving today's
   * behavior). This is the cardinal hook that lets one broker be pointed at
   * any git repo — the "multi-project unblock" north-star wedge.
   *
   * Validation rules (enforced in `loadConfig`):
   *   - When `BROKER_PROJECT_ROOT` is explicitly set, the path MUST exist,
   *     be a directory, and resolve to a valid git work tree (verified via
   *     `git rev-parse --is-inside-work-tree`). Misconfig → throws at
   *     startup with a clear operator-actionable error.
   *   - When unset (default cwd), a missing git work tree only emits a
   *     warning — preserving compat for unit-test brokers in tmpdirs and
   *     for unusual deployments.
   *
   * Symlinks: the value is `path.resolve()`d (not `realpath`d) so the
   * operator-visible path is preserved end-to-end.
   */
  readonly projectRoot: string
  /**
   * Multi-project foundation (P3): stable id for the project the broker
   * manages, derived from `projectRoot` (or the `BROKER_PROJECT_ID` override).
   * Teams/sessions created by this broker are stamped with it, and autonomous
   * project-scoped reads filter on it so one broker never acts on another
   * project's teams. See src/broker/project-identity.ts.
   */
  readonly projectId: string
  readonly heartbeatIntervalMs: number
  readonly heartbeatTimeoutMs: number
  readonly zombieGraceMs: number
  readonly brokerToken: string | null
  readonly autoRespawn: boolean
  readonly maxRespawnRetries: number
  readonly respawnBackoffBaseMs: number
  readonly autoScaleIntervalMs: number
  readonly autoScaleEnabled: boolean
  readonly teamReaperEnabled: boolean
  readonly teamReaperIntervalMs: number
  readonly teamReaperGraceMs: number
  readonly teamReaperExemptionMaxAgeMs: number
  readonly autospawn: {
    readonly enabled: boolean
    readonly intervalMs: number
    readonly cooldownMs: number
  }
  readonly qualityGate: {
    readonly baselineLintEnabled: boolean
    readonly baselineTestsEnabled: boolean
  }
}

/** Broker defaults. Exported so docs/tests can assert against them rather than a copy. */
export const DEFAULTS = {
  port: 3456,
  bind: '127.0.0.1',
  dbPath: join(homedir(), '.session-broker', 'data.db'),
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 20_000,
  zombieGraceMs: 300_000,
  autoRespawn: true,
  maxRespawnRetries: 3,
  respawnBackoffBaseMs: 5000,
  autoScaleIntervalMs: 30_000,
  autoScaleEnabled: false,
  teamReaperEnabled: true,
  teamReaperIntervalMs: 60_000,
  teamReaperGraceMs: 300_000,
  teamReaperExemptionMaxAgeMs: 86_400_000,
  autospawnEnabled: true,
  autospawnIntervalMs: 30_000,
  autospawnCooldownMs: 300_000,
} as const

const BrokerConfigSchema = z.object({
  BROKER_PORT: z.coerce.number().int().positive().catch(DEFAULTS.port),
  BROKER_BIND: z.string().min(1).catch(DEFAULTS.bind),
  BROKER_DB_PATH: z.string().min(1).catch(DEFAULTS.dbPath),
  BROKER_HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .catch(DEFAULTS.heartbeatIntervalMs),
  BROKER_HEARTBEAT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .catch(DEFAULTS.heartbeatTimeoutMs),
  BROKER_ZOMBIE_GRACE_MS: z.coerce.number().int().positive().catch(DEFAULTS.zombieGraceMs),
  BROKER_TOKEN: z.string().nullable().catch(null),
  BROKER_AUTO_RESPAWN: z.string().catch('true'),
  BROKER_MAX_RESPAWN_RETRIES: z.coerce.number().int().positive().catch(DEFAULTS.maxRespawnRetries),
  BROKER_RESPAWN_BACKOFF_BASE_MS: z.coerce
    .number()
    .int()
    .positive()
    .catch(DEFAULTS.respawnBackoffBaseMs),
  BROKER_AUTO_SCALE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .catch(DEFAULTS.autoScaleIntervalMs),
  BROKER_AUTO_SCALE: z.string().catch('false'),
  BROKER_TEAM_REAPER_ENABLED: z.string().catch('true'),
  BROKER_TEAM_REAPER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .catch(DEFAULTS.teamReaperIntervalMs),
  BROKER_TEAM_REAPER_GRACE_MS: z.coerce.number().int().positive().catch(DEFAULTS.teamReaperGraceMs),
  BROKER_TEAM_REAPER_EXEMPTION_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .catch(DEFAULTS.teamReaperExemptionMaxAgeMs),
  BROKER_AUTOSPAWN_ENABLED: z.string().catch('true'),
  BROKER_AUTOSPAWN_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .catch(DEFAULTS.autospawnIntervalMs),
  BROKER_AUTOSPAWN_COOLDOWN_MS: z.coerce
    .number()
    .int()
    .positive()
    .catch(DEFAULTS.autospawnCooldownMs),
  SCNS_QG_BASELINE_LINT: z.string().catch('true'),
  SCNS_QG_BASELINE_TESTS: z.string().catch('true'),
  BROKER_PROJECT_ROOT: z.string().optional(),
  BROKER_PROJECT_ID: z.string().optional(),
})

/**
 * Resolve and validate the broker's project root. Returns an absolute path.
 *
 * - When `explicit` is true (`BROKER_PROJECT_ROOT` was set), enforce strict
 *   validation: directory must exist and be a valid git work tree.
 * - When `explicit` is false (default cwd), only warn on a missing
 *   `.git` toplevel (preserves backward compat for unit-test brokers in
 *   tmpdirs and unusual deployments).
 *
 * Uses `git rev-parse --is-inside-work-tree` (and `--show-toplevel`) instead
 * of checking for a `.git/` directory because git worktrees and submodules
 * use a `.git` FILE that points elsewhere — a directory check would
 * spuriously reject otherwise-valid roots.
 */
export function resolveProjectRoot(
  rawValue: string | undefined,
  cwd: string = process.cwd(),
  runGit: (args: readonly string[], cwd: string) => { status: number | null; stdout: string } = (
    args,
    gitCwd,
  ) => {
    const res = spawnSync('git', [...args], { cwd: gitCwd, encoding: 'utf-8', windowsHide: true })
    return { status: res.status, stdout: res.stdout ?? '' }
  },
): string {
  const explicit = rawValue !== undefined && rawValue.trim() !== ''
  const target = explicit ? resolvePath(rawValue!.trim()) : resolvePath(cwd)

  if (explicit) {
    if (!existsSync(target)) {
      throw new Error(
        `BROKER_PROJECT_ROOT=${rawValue} resolved to ${target}, which does not exist. ` +
          `Set BROKER_PROJECT_ROOT to an absolute path of a git repository, or unset it to use process.cwd().`,
      )
    }
    if (!statSync(target).isDirectory()) {
      throw new Error(
        `BROKER_PROJECT_ROOT=${rawValue} (${target}) is not a directory. ` +
          `Set BROKER_PROJECT_ROOT to an absolute path of a git repository.`,
      )
    }
    const insideRes = runGit(['rev-parse', '--is-inside-work-tree'], target)
    if (insideRes.status !== 0 || insideRes.stdout.trim() !== 'true') {
      throw new Error(
        `BROKER_PROJECT_ROOT=${rawValue} (${target}) is not inside a git work tree. ` +
          `The broker uses git for worktree management, auto-merge, and quality-gate verification — ` +
          `set BROKER_PROJECT_ROOT to a git repository, or unset it to use process.cwd().`,
      )
    }
    log.info({ projectRoot: target, source: 'BROKER_PROJECT_ROOT' }, 'projectRoot resolved')
    return target
  }

  // Default (cwd) path — soft validation only.
  const insideRes = runGit(['rev-parse', '--is-inside-work-tree'], target)
  if (insideRes.status !== 0 || insideRes.stdout.trim() !== 'true') {
    log.warn(
      { projectRoot: target },
      'projectRoot (cwd) is not inside a git work tree — worktree-manager/auto-merger/quality-gate may not function. ' +
        'Set BROKER_PROJECT_ROOT to a git repository to silence this warning.',
    )
  } else {
    log.info({ projectRoot: target, source: 'cwd' }, 'projectRoot resolved')
  }
  return target
}

export function ensureDbDirectory(dbPath: string): void {
  if (dbPath === ':memory:') return
  const dir = dirname(dbPath)
  mkdirSync(dir, { recursive: true })
}

export function loadConfig(): BrokerConfig {
  const parsed = BrokerConfigSchema.parse({
    BROKER_PORT: process.env.BROKER_PORT,
    BROKER_BIND: process.env.BROKER_BIND,
    BROKER_DB_PATH: process.env.BROKER_DB_PATH,
    BROKER_HEARTBEAT_INTERVAL_MS: process.env.BROKER_HEARTBEAT_INTERVAL_MS,
    BROKER_HEARTBEAT_TIMEOUT_MS: process.env.BROKER_HEARTBEAT_TIMEOUT_MS,
    BROKER_ZOMBIE_GRACE_MS: process.env.BROKER_ZOMBIE_GRACE_MS,
    BROKER_TOKEN: process.env.BROKER_TOKEN ?? null,
    BROKER_AUTO_RESPAWN: process.env.BROKER_AUTO_RESPAWN,
    BROKER_MAX_RESPAWN_RETRIES: process.env.BROKER_MAX_RESPAWN_RETRIES,
    BROKER_RESPAWN_BACKOFF_BASE_MS: process.env.BROKER_RESPAWN_BACKOFF_BASE_MS,
    BROKER_AUTO_SCALE_INTERVAL_MS: process.env.BROKER_AUTO_SCALE_INTERVAL_MS,
    BROKER_AUTO_SCALE: process.env.BROKER_AUTO_SCALE,
    BROKER_TEAM_REAPER_ENABLED: process.env.BROKER_TEAM_REAPER_ENABLED,
    BROKER_TEAM_REAPER_INTERVAL_MS: process.env.BROKER_TEAM_REAPER_INTERVAL_MS,
    BROKER_TEAM_REAPER_GRACE_MS: process.env.BROKER_TEAM_REAPER_GRACE_MS,
    BROKER_TEAM_REAPER_EXEMPTION_MAX_AGE_MS: process.env.BROKER_TEAM_REAPER_EXEMPTION_MAX_AGE_MS,
    BROKER_AUTOSPAWN_ENABLED: process.env.BROKER_AUTOSPAWN_ENABLED,
    BROKER_AUTOSPAWN_INTERVAL_MS: process.env.BROKER_AUTOSPAWN_INTERVAL_MS,
    BROKER_AUTOSPAWN_COOLDOWN_MS: process.env.BROKER_AUTOSPAWN_COOLDOWN_MS,
    SCNS_QG_BASELINE_LINT: process.env.SCNS_QG_BASELINE_LINT,
    SCNS_QG_BASELINE_TESTS: process.env.SCNS_QG_BASELINE_TESTS,
    BROKER_PROJECT_ROOT: process.env.BROKER_PROJECT_ROOT,
    BROKER_PROJECT_ID: process.env.BROKER_PROJECT_ID,
  })

  const projectRoot = resolveProjectRoot(parsed.BROKER_PROJECT_ROOT)
  const projectId = deriveProjectId(projectRoot, { override: parsed.BROKER_PROJECT_ID })
  log.info({ projectId, projectRoot }, 'projectId resolved')

  return Object.freeze({
    port: parsed.BROKER_PORT,
    bind: parsed.BROKER_BIND,
    dbPath: parsed.BROKER_DB_PATH,
    projectRoot,
    projectId,
    heartbeatIntervalMs: parsed.BROKER_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: parsed.BROKER_HEARTBEAT_TIMEOUT_MS,
    zombieGraceMs: parsed.BROKER_ZOMBIE_GRACE_MS,
    brokerToken: parsed.BROKER_TOKEN,
    autoRespawn: parsed.BROKER_AUTO_RESPAWN !== 'false',
    maxRespawnRetries: parsed.BROKER_MAX_RESPAWN_RETRIES,
    respawnBackoffBaseMs: parsed.BROKER_RESPAWN_BACKOFF_BASE_MS,
    autoScaleIntervalMs: parsed.BROKER_AUTO_SCALE_INTERVAL_MS,
    autoScaleEnabled: parsed.BROKER_AUTO_SCALE === 'true',
    teamReaperEnabled: parsed.BROKER_TEAM_REAPER_ENABLED !== 'false',
    teamReaperIntervalMs: parsed.BROKER_TEAM_REAPER_INTERVAL_MS,
    teamReaperGraceMs: parsed.BROKER_TEAM_REAPER_GRACE_MS,
    teamReaperExemptionMaxAgeMs: parsed.BROKER_TEAM_REAPER_EXEMPTION_MAX_AGE_MS,
    autospawn: Object.freeze({
      // Opt-IN (#53 AC4): spawning agents spends the operator's credits,
      // so it stays off until BROKER_AUTOSPAWN_ENABLED / SCNS_UNATTENDED
      // says otherwise. Read from process.env directly — the schema above
      // defaults this key to 'true', which would read as consent.
      enabled: isUnattendedEnabled('team-task-autospawner'),
      intervalMs: parsed.BROKER_AUTOSPAWN_INTERVAL_MS,
      cooldownMs: parsed.BROKER_AUTOSPAWN_COOLDOWN_MS,
    }),
    qualityGate: Object.freeze({
      baselineLintEnabled:
        parsed.SCNS_QG_BASELINE_LINT !== 'false' && parsed.SCNS_QG_BASELINE_LINT !== '0',
      baselineTestsEnabled:
        parsed.SCNS_QG_BASELINE_TESTS !== 'false' && parsed.SCNS_QG_BASELINE_TESTS !== '0',
    }),
  })
}
