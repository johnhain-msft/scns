import {
  spawn as nodeSpawn,
  execSync as nodeExecSync,
  spawnSync as nodeSpawnSync,
} from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  createWriteStream as fsCreateWriteStream,
  mkdirSync as fsMkdirSync,
  writeFileSync as fsWriteFileSync,
  openSync as fsOpenSync,
  closeSync as fsCloseSync,
  existsSync as fsExistsSync,
} from 'node:fs'
import type { WriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { logger } from '../../shared/logger.js'
import {
  detectPlatform as defaultDetectPlatform,
  findCli as defaultFindCli,
  isTmuxAvailable as defaultIsTmuxAvailable,
  toWslPath,
} from './platform.js'
import type { Platform, CliInfo } from './platform.js'
import { buildAgentPrompt } from './prompt-builder.js'
import { createSession } from '../storage/repositories/session-repository.js'
import { terminateSession } from './session-retirement.js'
import {
  addTeamMember,
  removeTeamMember,
  touchMemberActivity,
  findTeamWorkingDir,
} from '../storage/repositories/team-repository.js'
import { ConfigurationError, ValidationError, AgentCapExceededError } from '../../shared/errors.js'
import { createAcpClient, AcpError, createDefaultPermissionPolicy } from './acp-client.js'
import type { SafetyKernel } from './safety-kernel/safety-kernel.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpMcpServer,
  AcpPermissionPolicy,
  AcpSessionUpdate,
} from './acp-client.js'
import { findTeamMembers } from '../storage/repositories/team-repository.js'
import { createMessage } from '../storage/repositories/message-repository.js'
import { markDispatched } from '../storage/repositories/task-repository.js'
import { randomUUID } from 'node:crypto'
import {
  planAutoDispatch,
  synthesizeReadbackBody,
  buildDispatchStartedPayload,
  type AutoDispatchOutcome,
  type AutoDispatchSpawnRequest,
} from './auto-dispatch.js'

/** Minimal EventLog interface for the spawner (avoids hard dep on full EventLog). */
export interface SpawnerEventLog {
  sessionRegistered(sessionId: string, data: Record<string, unknown>): unknown
  sessionDeregistered(sessionId: string, data: Record<string, unknown>): unknown
  teamMemberJoined(sessionId: string, data: Record<string, unknown>): unknown
  // WS K (Phase 13.13.x) — ACP / agent-spawn lifecycle instrumentation.
  // The four events below let operators see EXACTLY which stage of a launch
  // a given session reached. They are emitted by doSpawn() in this file:
  //   started   → right before launching the subprocess
  //   delivered → right after the prompt is handed to the transport
  //   first_out → on first non-empty agent output (ACP onUpdate / detached
  //               stdout 'data')
  //   failed    → on transport / spawn / prompt-write error, with a stage tag
  agentLaunchStarted?(sessionId: string, data: Record<string, unknown>): unknown
  agentPromptDelivered?(sessionId: string, data: Record<string, unknown>): unknown
  agentFirstOutputReceived?(sessionId: string, data: Record<string, unknown>): unknown
  agentLaunchFailed?(sessionId: string, data: Record<string, unknown>): unknown
  // WS L (Phase 13.13.x) — emitted each time a follow-up nudge prompt is
  // sent to an ACP dev session that returned without staging any work.
  agentNudgeSent?(sessionId: string, data: Record<string, unknown>): unknown
  // WS M (Phase 13.13.x) — emitted once per broker auto-dispatch with a
  // payload binding each spawned dev/qa session_id to its uuid dispatch_id
  // and the wall-clock start time. Optional: omitting it disables strict
  // attribution but does not break the dispatch flow.
  dispatchStarted?(sessionId: string | null, data: Record<string, unknown>): unknown
  // WS Q (Phase 13.13.x) — emitted after every ACP `sendPrompt` resolution
  // for dispatch-attributed dev sessions (one event per turn, including
  // WS-L nudge follow-ups). Payload binds the resolved stopReason and
  // wall-clock end time to the dispatch_id, so dev-productivity-monitor
  // can sample the staged numstat strictly AFTER the dev's turn ended.
  // Optional: omitting it falls back to WS-H session-deregistered
  // measurement (legacy, racey on purge timing).
  devTurnEnded?(sessionId: string | null, data: Record<string, unknown>): unknown
  // Phase 1.5 step 5 — cold-start timing probe. Emitted once per
  // successful ACP `createSession` resolution. Payload includes:
  //   - process_spawn_to_initialize_ms, session_new_ms, cold_start_ms
  //   - role, team_id, raw epoch marks
  // Used (eventually) to inform Step-5b warm-pool design: the cheaper
  // segment is the one a pool can't avoid (each spawn must still hit
  // session/new for cwd-binding), so the dominant segment determines
  // pool ROI. Optional: omitting it skips the emit silently — the
  // probe is observe-only and never blocks the spawn flow.
  agentAcpTiming?(sessionId: string, data: Record<string, unknown>): unknown
}

/**
 * Escape a string for safe inclusion in a POSIX single-quoted shell argument.
 * Works on Linux, macOS, and WSL.
 */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export type PermissionMode = 'none' | 'default' | 'all'

export interface SpawnInput {
  readonly team_id: string
  readonly name: string
  readonly role?: string
  readonly prompt?: string
  readonly agent?: string
  readonly permissions?: PermissionMode
  readonly working_dir?: string
  readonly launch_method?: 'tmux' | 'detached' | 'acp'
  /**
   * WS F (Phase 13.13.x) — present iff the caller is spawning against a
   * stored task. When `role === 'scns-manager'` AND `task` is set, the
   * spawner runs broker-mechanical auto-dispatch: it spawns one scns-dev
   * and one scns-qa for the same task on the same team, then synthesizes
   * a Dispatch Readback message into the team log so the WS C
   * manager-exit-monitor sees a complete dispatch. Setting `task` for
   * non-manager roles is a no-op.
   */
  readonly task?: {
    readonly id: number
    readonly subject: string
    readonly description?: string | null
  }
  /** Optional team display name; only used to enrich auto-dispatch prompts. */
  readonly team_name?: string | null
  /**
   * WS Q (Phase 13.13.x) — present iff this spawn is a broker-mechanical
   * auto-dispatch (runAutoDispatch passes plan.dev.dispatch_id /
   * plan.qa.dispatch_id here). When set AND `role === 'scns-dev'` AND
   * `launch_method === 'acp'`, the spawner emits a `dev_turn_ended`
   * event after every ACP `sendPrompt` resolution so
   * dev-productivity-monitor can sample the staged numstat at turn-end
   * (closes the WS-N measurement-window race). Unset for non-dispatch
   * spawns and for non-ACP transports — those have no turn-end signal.
   */
  readonly dispatch_id?: string
}

export interface SpawnResult {
  readonly sessionId: string
  readonly teamId: string
  readonly name: string
  readonly role: string
  readonly platform: Platform
  readonly launchMethod: 'tmux' | 'detached' | 'acp'
  readonly pid: number | null
  readonly tmuxSession: string | null
  readonly tmuxWindow: string | null
  readonly acpSessionId: string | null
}

export interface SpawnedAgentInfo {
  readonly sessionId: string
  readonly teamId: string
  readonly name: string
  readonly role: string
  readonly pid: number | null
  readonly launchMethod: 'tmux' | 'detached' | 'acp'
  readonly startedAt: string
  readonly acpSessionId: string | null
}

export interface SpawnStats {
  readonly activeCount: number
  readonly maxConcurrent: number
  readonly spawnsLast60s: number
  /**
   * Number of spawn() calls that have passed the cap check but have not yet
   * inserted into activeAgents (typically waiting on ACP initialize /
   * createSession). Callers that probe capacity should treat
   * activeCount + pendingCount as the true in-flight count.
   */
  readonly pendingCount: number
}

export interface AgentSpawner {
  spawn(input: SpawnInput): Promise<SpawnResult>
  sendMessage(sessionId: string, message: string): Promise<{ accepted: boolean; error?: string }>
  getActiveAgents(): ReadonlyMap<string, SpawnedAgentInfo>
  /** F1: current active-agent count, cap, and rolling 60s spawn count. */
  getSpawnStats(): SpawnStats
  cleanup(sessionId: string): Promise<void>
  shutdownAll(): Promise<void>
}

export interface SpawnerDeps {
  readonly detectPlatform: () => Platform
  readonly findCli: (platform: Platform) => CliInfo | null
  readonly isTmuxAvailable: () => boolean
  readonly spawnProcess: typeof import('node:child_process').spawn
  readonly spawnSync: typeof import('node:child_process').spawnSync
  readonly execSync: typeof import('node:child_process').execSync
  readonly mkdirSync: (path: string, options?: { recursive?: boolean }) => void
  readonly createWriteStream: (path: string, options?: { flags?: string }) => WriteStream
  readonly writeFileSync: (
    path: string,
    data: string,
    options?: { mode?: number; flag?: string },
  ) => void
  readonly openSync: (path: string, flags: string) => number
  readonly closeSync: (fd: number) => void
  /**
   * Layer-2 fix — test seam used to detect whether a working_dir
   * contains a usable `node_modules/.bin` directory. When true, the
   * spawner prepends that path to the spawned agent's PATH so bare
   * `vitest run …`, `eslint`, `tsc --noEmit` invocations in the dev/qa
   * task prompts resolve. Default is `node:fs.existsSync`. Optional
   * for backward compatibility with tests that construct SpawnerDeps
   * directly (older callers can omit it and get the default).
   */
  readonly existsSync?: (path: string) => boolean
}

export type AgentExitReasonTag = 'normal' | 'error' | 'killed' | 'zombie'

export interface AgentExitHookInfo {
  readonly sessionId: string
  readonly teamId: string
  readonly role: string
  readonly name: string
  readonly workingDir: string | null
  readonly logPath: string | null
  readonly launchMethod: 'tmux' | 'detached' | 'acp'
  readonly reason: AgentExitReasonTag
}

export interface AgentSpawnerOptions {
  readonly brokerUrl?: string
  readonly heartbeatMs?: number
  readonly workingDir?: string
  /**
   * Multi-project foundation (P3): stamp spawned-agent session rows with this
   * project id so they are attributable to the project the broker manages.
   */
  readonly projectId?: string
  readonly deps?: Partial<SpawnerDeps>
  readonly mcpServers?: ReadonlyArray<AcpMcpServer>
  /** OTel env vars to inject into spawned agents for telemetry capture */
  readonly otelEnv?: Readonly<Record<string, string>>
  /**
   * Phase 13.12.17 — internal token injected into spawned agent env as
   * SCNS_INTERNAL_TOKEN. Required for agents to fetch secrets via
   * POST /api/secrets/:key/fetch. Never logged.
   */
  readonly internalToken?: string
  /**
   * Phase 13.12.17 — supplies the current list of secret keys (never values)
   * to advertise in each spawned-agent prompt. Called at spawn time so new
   * secrets show up immediately without restarting the broker.
   */
  readonly getAvailableSecretKeys?: () => readonly string[]
  /**
   * Phase 13.12.18 — supplies the current list of skills (name + description)
   * to advertise in each spawned-agent prompt. Called at spawn time. Empty
   * list → no skills block is emitted.
   */
  readonly getAvailableSkills?: () => readonly {
    readonly name: string
    readonly description: string
  }[]
  /** Called after an agent's resources have been torn down. */
  readonly onAgentExit?: (info: AgentExitHookInfo) => void
  /**
   * Phase 13.12.21 — permission policy for ACP-launched agents. If unset,
   * defaults to the allow-safe-kinds policy (see createDefaultPermissionPolicy).
   *
   * Phase 1.5 step 4 note: for roles in `autopilotRoles`, this policy is
   * still wired in but most `session/request_permission` RPCs are
   * suppressed upstream by the `--allow-all-tools` CLI flag (which is
   * the only reliable autonomy lever under `--acp` — see live-probe
   * findings in commit/session notes). To force policy gating for
   * dev/qa, pass `autopilotRoles: []` instead of relying on this
   * option alone.
   */
  readonly permissionPolicy?: AcpPermissionPolicy
  /**
   * WS-0 — the Immutable Safety Kernel. When provided, EVERY spawned
   * agent's tool calls route through the kernel: egress + spend are denied
   * by deny-all defaults (allowlist ships empty), safe tools are delegated
   * to the base permission policy, and every decision is appended to the
   * immutable audit log. Wiring the kernel also drops `--allow-all-tools`
   * for autopilot roles (Decision A / Option A) so the kernel is not
   * bypassed. Unset → unchanged legacy behavior (back-compat).
   */
  readonly safetyKernel?: SafetyKernel
  /**
   * Phase 13.12.23 — per-prompt ACP `session/prompt` timeout in ms. Real
   * engineering tasks routinely need >5 min, so the default is 30m. Can also
   * be overridden via the `SCNS_ACP_PROMPT_TIMEOUT_MS` env var (positive
   * integer). The explicit option wins over the env var.
   */
  readonly acpPromptTimeoutMs?: number
  /**
   * Global cap on concurrent active agents. `spawn()` rejects with
   * `AgentCapExceededError` once `activeAgents.size >= maxConcurrentAgents`.
   * Precedence: explicit option > SCNS_MAX_CONCURRENT_AGENTS env var >
   * DEFAULT_MAX_CONCURRENT_AGENTS (4). Set to 0/Infinity to disable the cap
   * (tests only — production must keep it bounded).
   */
  readonly maxConcurrentAgents?: number
  /**
   * WS L (Phase 13.13.x) — bounded agentic-loop config for ACP dev sessions.
   *
   * Background: Copilot-CLI's ACP server returns `stopReason="end_turn"`
   * after the model's first response. If that response is text-only
   * (clarifying chat, ack), the dev never gets a second turn to invoke its
   * Edit/Bash tools and the working_dir's staged diff stays empty. The WS H
   * dev-productivity-monitor then fires `dev_no_work`.
   *
   * Fix: after each `sendPrompt` resolves with no staged changes, send a
   * follow-up nudge prompt to the same ACP session (up to N nudges). Stop
   * once a staged diff appears, the budget runs out, the wall-clock cap is
   * reached, or the transport errors out.
   */
  readonly agentNudgeBudget?: number
  /** Wall-clock cap for the entire nudge loop. Default: 10 min. */
  readonly agentNudgeWallClockMs?: number
  /** Roles eligible for the agentic loop. Default: `['scns-dev']`. */
  readonly nudgeRoles?: readonly string[]
  /**
   * Phase 1.5 step 4 — roles that run with `--allow-all-tools` (no
   * operator permission gating) AND get an allow-destructive permission
   * policy as defense-in-depth. Manager intentionally excluded by default
   * — it should plan + dispatch, not act unilaterally.
   *
   * Default: `DEFAULT_AUTOPILOT_ROLES` = `['scns-dev', 'scns-qa']`. Pass
   * `[]` to disable autopilot for all roles (back-compat with pre-step-4
   * behavior).
   *
   * Operational kill-switch: the `SCNS_ACP_AUTOPILOT_ROLES` env var
   * overrides the default when this option is unset. Format:
   * comma-separated role names, e.g. `SCNS_ACP_AUTOPILOT_ROLES=scns-dev`
   * (qa stays gated). An empty value (`SCNS_ACP_AUTOPILOT_ROLES=`)
   * disables autopilot for all roles, useful for live triage if
   * `--allow-all-tools` ever needs to be backed out without a code
   * deploy. The explicit option (when set) always wins.
   */
  readonly autopilotRoles?: readonly string[]
  /**
   * Factory for ACP clients. Defaults to `createAcpClient` from
   * `./acp-client.js`. Tests inject a mock factory to drive the loop
   * deterministically without spawning a real CLI subprocess.
   */
  readonly acpClientFactory?: (options?: AcpClientOptions) => AcpClient
  /**
   * Task 43 — wire point for the team-worktree-manager. Called with the
   * spawn target's team_id BEFORE the spawner reads `teams.working_dir`,
   * so the manager has a chance to provision a per-team git worktree
   * and persist the pin as a side effect. The return value is currently
   * advisory — the spawner re-reads `teams.working_dir` via
   * `findTeamWorkingDir` to pick up the pin so the existing Task 34 /
   * neuron-mode precedence rules (operator pin > resolver > caller >
   * broker cwd) keep working unchanged. Optional: omitting it leaves
   * pre-task-43 behaviour intact. Errors are swallowed (logged) so a
   * provisioning failure can never block agent spawning — the spawner
   * falls back to the caller's working_dir / broker cwd, exactly as
   * before.
   */
  readonly resolveTeamWorkingDir?: (teamId: string) => string | null
}

/** Default WS L nudge budget — 3 follow-ups after the initial prompt. */
export const DEFAULT_AGENT_NUDGE_BUDGET = 3
/** Default WS L wall-clock cap for the entire agentic loop — 10 minutes. */
export const DEFAULT_AGENT_NUDGE_WALL_CLOCK_MS = 10 * 60 * 1000
/** Default roles that participate in the WS L agentic loop. */
export const DEFAULT_NUDGE_ROLES: readonly string[] = ['scns-dev']

/**
 * Phase 1.5 step 4 — default roles that run autonomously (with
 * `--allow-all-tools` + allow-destructive permission policy). Manager
 * intentionally excluded — it should orchestrate via plan + dispatch, not
 * mutate state directly.
 */
export const DEFAULT_AUTOPILOT_ROLES: readonly string[] = ['scns-dev', 'scns-qa']

/**
 * Resolve the per-spawn autopilot role set from (1) explicit option, (2)
 * the `SCNS_ACP_AUTOPILOT_ROLES` env var (comma-separated; empty string
 * = no autopilot), (3) `DEFAULT_AUTOPILOT_ROLES`. The env override is
 * the operational kill-switch — set to empty to live-disable
 * `--allow-all-tools` for ALL roles without a code deploy.
 */
export function resolveAutopilotRoles(
  optionValue: readonly string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  if (optionValue !== undefined) return optionValue
  const raw = env['SCNS_ACP_AUTOPILOT_ROLES']
  if (raw === undefined) return DEFAULT_AUTOPILOT_ROLES
  // Empty value (`SCNS_ACP_AUTOPILOT_ROLES=`) is meaningful: it
  // explicitly disables autopilot, distinct from "env var unset".
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Resolve the WS L nudge budget from (1) explicit option, (2) the
 * SCNS_AGENT_NUDGE_BUDGET env var, (3) the DEFAULT_AGENT_NUDGE_BUDGET
 * constant. Negative / non-numeric env values are ignored. A value of 0
 * disables nudging entirely (single-prompt behaviour, like pre-WS L).
 */
export function resolveAgentNudgeBudget(
  optionValue: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof optionValue === 'number' && Number.isFinite(optionValue) && optionValue >= 0) {
    return Math.floor(optionValue)
  }
  const raw = env['SCNS_AGENT_NUDGE_BUDGET']
  if (raw !== undefined && raw !== '') {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return Math.floor(n)
  }
  return DEFAULT_AGENT_NUDGE_BUDGET
}

/** Resolve the WS L agentic-loop wall-clock cap (env: SCNS_AGENT_NUDGE_WALL_MS). */
export function resolveAgentNudgeWallClockMs(
  optionValue: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof optionValue === 'number' && Number.isFinite(optionValue) && optionValue > 0) {
    return Math.floor(optionValue)
  }
  const raw = env['SCNS_AGENT_NUDGE_WALL_MS']
  if (raw !== undefined && raw !== '') {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return DEFAULT_AGENT_NUDGE_WALL_CLOCK_MS
}

/**
 * Default concurrent-agent cap.
 *
 * Task 34 (neuron fan-out): bumped from 4 → 8. Rationale:
 *   - A single self-improve "neuron" runs 3 agents (manager + dev + qa).
 *   - Old cap of 4 hit immediately as soon as two neurons tried to run
 *     in parallel (6 agents needed). That blocked fan-out before it
 *     started.
 *   - 8 = (2 neurons × 3 agents) + 2 headroom for a transient fourth
 *     agent during a respawn / overlap window, or a brain/observer.
 *   - Per-team concurrency tracking is the cleaner long-term answer
 *     but is a bigger refactor; bump-the-cap is the minimum-viable
 *     change that unblocks fan-out without a sprawl. Operators that
 *     need more (3+ neurons) override via SCNS_MAX_CONCURRENT_AGENTS.
 *
 * Hardware sizing: each ACP subprocess costs ~150–300 MB RSS, so 8
 * agents ≈ 1.2–2.4 GB. Comfortably fits a 16 GB MacBook.
 */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 8

/**
 * Resolve the concurrent-agent cap from (1) explicit option, (2) the
 * SCNS_MAX_CONCURRENT_AGENTS env var, (3) the DEFAULT_MAX_CONCURRENT_AGENTS
 * constant. Non-positive / non-numeric env values are ignored. A sentinel
 * value of Infinity disables the cap (callers should not rely on this in
 * production).
 */
export function resolveMaxConcurrentAgents(
  optionValue: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (optionValue === Infinity) return Infinity
  if (typeof optionValue === 'number' && Number.isFinite(optionValue) && optionValue > 0) {
    return Math.floor(optionValue)
  }
  const raw = env['SCNS_MAX_CONCURRENT_AGENTS']
  if (raw !== undefined && raw !== '') {
    if (raw.toLowerCase() === 'infinity') return Infinity
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return DEFAULT_MAX_CONCURRENT_AGENTS
}

/** Default ACP prompt timeout: 30 minutes. */
export const DEFAULT_ACP_PROMPT_TIMEOUT_MS = 30 * 60 * 1000

/**
 * ACP `session/update` notification kinds that represent BOOTSTRAP signals,
 * not meaningful agent activity. These fire before the agent has reacted
 * to the prompt and must NOT satisfy `agent_first_output_received` — doing
 * so previously masked the "manager exited without dispatch" failure class
 * (handoff: "first_output sample='available_commands_update', NO message
 * events ever"). The probe at
 * `~/.copilot/session-state/5f85fde2.../files/mcp-tools-probe-v2.mjs`
 * confirmed `available_commands_update` carries Copilot CLI slash commands
 * + skills only and fires twice per bootstrap (initial + post-MCP-reg).
 * `config_option_update` is the parallel bootstrap signal for mode/model.
 */
export const ACP_BOOTSTRAP_UPDATE_KINDS: ReadonlySet<string> = new Set([
  'available_commands_update',
  'config_option_update',
])

/**
 * Resolve the ACP prompt timeout from (1) explicit option, (2) the
 * SCNS_ACP_PROMPT_TIMEOUT_MS env var, (3) the 30-minute default. Non-positive
 * or non-numeric env values are ignored.
 */
export function resolveAcpPromptTimeoutMs(
  optionValue: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof optionValue === 'number' && Number.isFinite(optionValue) && optionValue > 0) {
    return Math.floor(optionValue)
  }
  const raw = env['SCNS_ACP_PROMPT_TIMEOUT_MS']
  if (raw !== undefined && raw !== '') {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return DEFAULT_ACP_PROMPT_TIMEOUT_MS
}

interface InternalAgentEntry extends SpawnedAgentInfo {
  readonly heartbeatTimer: NodeJS.Timeout | null
  readonly process: ChildProcess | null
  acpClient: AcpClient | null
  readonly acpSessionId: string | null
  readonly workingDir: string | null
  readonly logPath: string | null
  exitReason: AgentExitReasonTag
}

const DEFAULT_BROKER_URL = 'http://localhost:3456'

export function createAgentSpawner(
  db: Database.Database,
  eventLog: SpawnerEventLog,
  options?: AgentSpawnerOptions,
): AgentSpawner {
  const brokerUrl = options?.brokerUrl ?? DEFAULT_BROKER_URL
  const workingDir = options?.workingDir ?? process.cwd()
  const spawnerProjectId = options?.projectId

  const deps: SpawnerDeps = {
    detectPlatform: options?.deps?.detectPlatform ?? defaultDetectPlatform,
    findCli: options?.deps?.findCli ?? defaultFindCli,
    isTmuxAvailable: options?.deps?.isTmuxAvailable ?? defaultIsTmuxAvailable,
    spawnProcess: options?.deps?.spawnProcess ?? nodeSpawn,
    spawnSync: options?.deps?.spawnSync ?? nodeSpawnSync,
    execSync: options?.deps?.execSync ?? nodeExecSync,
    mkdirSync: options?.deps?.mkdirSync ?? fsMkdirSync,
    createWriteStream: options?.deps?.createWriteStream ?? fsCreateWriteStream,
    writeFileSync: options?.deps?.writeFileSync ?? fsWriteFileSync,
    openSync: options?.deps?.openSync ?? fsOpenSync,
    closeSync: options?.deps?.closeSync ?? fsCloseSync,
    existsSync: options?.deps?.existsSync ?? fsExistsSync,
  }

  const activeAgents = new Map<string, InternalAgentEntry>()
  /**
   * F1 race-fix: synchronous reservation counter. Incremented atomically in
   * spawn() immediately after the cap check passes, before any await. Because
   * activeAgents.set() is delayed until after `await client.initialize()` /
   * `createSession()`, parallel callers could all pass a size-only check
   * before any of them inserted, briefly exceeding the cap by up to N−1.
   * Counting pending reservations in the cap check makes the check atomic.
   * Decremented unconditionally in the spawn() finally block, after either
   * the successful activeAgents.set() or a throw.
   */
  let pendingSpawns = 0
  const log = logger.child({ module: 'agent-spawner' })
  // WS K helper: optional event emit (SpawnerEventLog methods are optional
  // for backward-compat with the test mock; createEventLog provides them).
  const safeEmit = (
    fn: ((sessionId: string, data: Record<string, unknown>) => unknown) | undefined,
    sessionId: string,
    data: Record<string, unknown>,
  ): void => {
    if (!fn) return
    try {
      fn(sessionId, data)
    } catch (err) {
      log.debug({ err, sessionId }, 'WS K event emit failed (non-fatal)')
    }
  }
  const mcpServers = options?.mcpServers ?? []
  const otelEnv = options?.otelEnv ?? {}
  const internalToken = options?.internalToken
  const getAvailableSecretKeys = options?.getAvailableSecretKeys
  const getAvailableSkills = options?.getAvailableSkills
  const onAgentExit = options?.onAgentExit
  // Phase 1.5 step 4 — per-role permission + autopilot config.
  //
  // Two policy variants are pre-built at factory time so spawn() can pick
  // the right one in O(1) without re-running env reads.
  // - basePolicy: the historical default (env-driven allowDestructive).
  //   Used for non-autopilot roles (manager) — keeps existing tests/
  //   behavior intact.
  // - autopilotPolicy: allow-destructive on by default. Used for
  //   autopilotRoles (dev/qa).
  //
  // If the caller supplied an explicit `permissionPolicy`, BOTH variants
  // bind to that policy: caller wins for all roles. (Future per-role
  // override hook is left as a follow-up — keeps the API minimal.)
  const explicitPolicy = options?.permissionPolicy
  // WS-0 — when the Immutable Safety Kernel is wired in, every spawned
  // agent's tool calls route THROUGH the kernel: it can only ADD egress/
  // spend denials on top of the base policy below (safe tools delegate to
  // the base, so autopilot autonomy is preserved). Unset → no wrapping.
  const safetyKernel = options?.safetyKernel
  const wrapWithKernel = (p: AcpPermissionPolicy): AcpPermissionPolicy =>
    safetyKernel ? safetyKernel.asPermissionPolicy(p) : p
  const basePermissionPolicy = wrapWithKernel(
    explicitPolicy ??
      createDefaultPermissionPolicy({
        allowDestructive: process.env['SCNS_ACP_ALLOW_DESTRUCTIVE'] === '1',
      }),
  )
  const autopilotPermissionPolicy = wrapWithKernel(
    explicitPolicy ?? createDefaultPermissionPolicy({ allowDestructive: true }),
  )
  const autopilotRoles = new Set<string>(resolveAutopilotRoles(options?.autopilotRoles))
  const acpPromptTimeoutMs = resolveAcpPromptTimeoutMs(options?.acpPromptTimeoutMs)
  const maxConcurrentAgents = resolveMaxConcurrentAgents(options?.maxConcurrentAgents)
  // WS L: bounded agentic-loop config.
  const agentNudgeBudget = resolveAgentNudgeBudget(options?.agentNudgeBudget)
  const agentNudgeWallClockMs = resolveAgentNudgeWallClockMs(options?.agentNudgeWallClockMs)
  const nudgeRoles = new Set<string>(options?.nudgeRoles ?? DEFAULT_NUDGE_ROLES)
  const acpClientFactory = options?.acpClientFactory ?? createAcpClient
  // Rolling spawn-rate tracker — timestamps of spawn() invocations within
  // the last 60s. Exposed via getSpawnStats() for metrics and brownout logic.
  const recentSpawnTimestamps: number[] = []
  const pruneSpawnWindow = (now: number): void => {
    const cutoff = now - 60_000
    while (recentSpawnTimestamps.length > 0 && recentSpawnTimestamps[0]! < cutoff) {
      recentSpawnTimestamps.shift()
    }
  }

  async function cleanupSession(sessionId: string): Promise<void> {
    const entry = activeAgents.get(sessionId)
    if (!entry) return

    if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer)

    // Close ACP client if present
    if (entry.acpClient) {
      try {
        await entry.acpClient.close()
      } catch (err) {
        log.warn({ err, sessionId }, 'Cleanup: failed to close ACP client')
      }
    }

    if (entry.process && !entry.process.killed) {
      try {
        entry.process.kill('SIGTERM')
      } catch (err) {
        log.warn({ err, sessionId }, 'Failed to kill agent process')
      }
    }

    try {
      // Issue #70: the agent process is gone, so terminate with settlement —
      // its inbox and settled correspondence archive to history, but unread
      // directed mail it sent to live participants stays in their inboxes
      // (deferring the physical row delete until that mail settles).
      // Terminate BEFORE removing team membership so sessions_history keeps
      // the team_name (the row delete cascades team_members anyway).
      const result = terminateSession(db, sessionId)
      eventLog.sessionDeregistered(sessionId, {
        reason: 'cleanup',
        messages_archived: result.messages_archived,
        messages_retained: result.messages_retained,
        identity_retained: result.deferred,
      })
    } catch (err) {
      log.warn({ err, sessionId }, 'Cleanup: failed to terminate session')
    }
    try {
      // No-op when the row was purged (CASCADE already removed membership);
      // needed when termination deferred and the row survives.
      removeTeamMember(db, entry.teamId, sessionId)
    } catch (err) {
      log.warn({ err, sessionId }, 'Cleanup: failed to remove team member')
    }

    activeAgents.delete(sessionId)

    if (onAgentExit) {
      try {
        onAgentExit({
          sessionId: entry.sessionId,
          teamId: entry.teamId,
          role: entry.role,
          name: entry.name,
          workingDir: entry.workingDir,
          logPath: entry.logPath,
          launchMethod: entry.launchMethod,
          reason: entry.exitReason,
        })
      } catch (err) {
        log.warn({ err, sessionId }, 'onAgentExit hook threw')
      }
    }
  }

  function permissionFlags(mode: PermissionMode): ReadonlyArray<string> {
    switch (mode) {
      case 'none':
        return []
      case 'default':
        return ['--allow-all-tools', '--allow-all-paths']
      case 'all':
        return ['--yolo']
    }
  }

  function buildCliArgs(
    agent: string,
    prompt: string,
    permissions: PermissionMode = 'default',
  ): ReadonlyArray<string> {
    return [...permissionFlags(permissions), '--agent', agent, '-p', prompt]
  }

  function launchDetached(
    cli: CliInfo,
    args: ReadonlyArray<string>,
    sessionId: string,
    cwd: string,
    scnsEnv: Record<string, string>,
  ): ChildProcess {
    const logDir = path.join(cwd, '.github', 'logs')
    try {
      deps.mkdirSync(logDir, { recursive: true })
    } catch (err) {
      log.debug({ err, logDir }, 'mkdirSync for log dir (may already exist)')
    }
    const logFile = path.join(logDir, `agent-${sessionId}.log`)

    let logFd: number
    try {
      logFd = deps.openSync(logFile, 'a')
    } catch (err) {
      log.error({ err, sessionId, logFile }, 'Failed to open log file for agent')
      throw err
    }

    let child: ChildProcess
    try {
      child = deps.spawnProcess(cli.command, [...args], {
        cwd,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, ...scnsEnv },
      })
    } catch (err) {
      log.error({ err, sessionId, cli: cli.command }, 'Failed to spawn agent process')
      try {
        deps.closeSync(logFd)
      } catch (cleanupErr) {
        log.debug({ err: cleanupErr, sessionId }, 'Best-effort logFd cleanup after spawn failure')
      }
      throw err
    }

    // Child has inherited a dup of the fd; close our parent-side copy best-effort.
    try {
      deps.closeSync(logFd)
    } catch (cleanupErr) {
      log.debug({ err: cleanupErr, sessionId }, 'Best-effort post-spawn logFd close')
    }

    child.unref()
    return child
  }

  function launchTmux(
    cli: CliInfo,
    args: ReadonlyArray<string>,
    teamId: string,
    name: string,
    cwd: string,
    scnsEnv: Record<string, string>,
  ): { tmuxSession: string; tmuxWindow: string } {
    const tmuxSession = `agents-${teamId.slice(0, 8)}`
    const tmuxWindow = `agent-${name}`

    const scriptPath = path.join(tmpdir(), `agent-${name}-${Date.now()}.sh`)
    const quotedArgs = args.map(shellQuote).join(' ')
    const normalizedCwd = toWslPath(cwd)
    const envExports = Object.entries(scnsEnv)
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join('\n')
    deps.writeFileSync(
      scriptPath,
      `#!/bin/sh\ncd ${shellQuote(normalizedCwd)}\n${envExports}\nexec ${cli.command} ${quotedArgs}\n`,
      { mode: 0o755 },
    )

    const hasSession = deps.spawnSync('tmux', ['has-session', '-t', tmuxSession], {
      stdio: 'ignore',
    })

    let result: ReturnType<SpawnerDeps['spawnSync']>
    if (hasSession.status === 0) {
      result = deps.spawnSync('tmux', [
        'new-window',
        '-t',
        tmuxSession,
        '-n',
        tmuxWindow,
        scriptPath,
      ])
    } else {
      result = deps.spawnSync('tmux', [
        'new-session',
        '-d',
        '-s',
        tmuxSession,
        '-n',
        tmuxWindow,
        scriptPath,
      ])
    }

    if (result.error) {
      const errMsg = `tmux command failed: ${result.error.message}`
      log.error({ err: result.error, tmuxSession, tmuxWindow, teamId }, errMsg)
      throw new ConfigurationError(errMsg)
    }

    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim() ?? 'unknown error'
      const errMsg = `tmux session creation failed (exit ${result.status}): ${stderr}`
      log.error({ tmuxSession, tmuxWindow, teamId, exitCode: result.status, stderr }, errMsg)
      throw new ConfigurationError(errMsg)
    }

    return { tmuxSession, tmuxWindow }
  }

  /**
   * WS F (Phase 13.13.x) — Broker-mechanical auto-dispatch.
   * Invoked after a successful manager-role spawn when SpawnInput.task is
   * present. Spawns one scns-dev and one scns-qa for the same task on the
   * same team, then writes a synthesized Dispatch Readback message into the
   * team log. Best-effort: failures are logged but never re-thrown — the
   * manager spawn itself has already succeeded by the time we get here.
   */
  async function runAutoDispatch(opts: {
    readonly task: NonNullable<SpawnInput['task']>
    readonly managerSessionId: string
    readonly teamId: string
    readonly teamName: string | null
    readonly workingDir: string
    readonly launchMethod: 'tmux' | 'detached' | 'acp'
  }): Promise<void> {
    const plan = planAutoDispatch({
      task: opts.task,
      managerSession: { sessionId: opts.managerSessionId },
      team: { id: opts.teamId, name: opts.teamName },
      workingDir: opts.workingDir,
    })

    const existing = (() => {
      try {
        return findTeamMembers(db, opts.teamId)
      } catch (err) {
        log.warn({ err, teamId: opts.teamId }, 'auto-dispatch: failed to list team members')
        return [] as ReadonlyArray<{ readonly role: string; readonly session_id: string }>
      }
    })()
    const existingByRole = new Map<string, string>()
    for (const m of existing) {
      if (!existingByRole.has(m.role)) existingByRole.set(m.role, m.session_id)
    }

    async function dispatchOne(req: AutoDispatchSpawnRequest): Promise<AutoDispatchOutcome> {
      const owner = existingByRole.get(req.role)
      if (owner) {
        log.info(
          { teamId: opts.teamId, role: req.role, existingOwner: owner },
          'auto-dispatch: existing team member for role; recording 409',
        )
        return { kind: 'existing_owner', existingOwner: owner }
      }
      try {
        const result = await doSpawn({
          team_id: req.team_id,
          name: req.name,
          role: req.role,
          prompt: req.prompt,
          working_dir: req.working_dir,
          launch_method: opts.launchMethod,
          permissions: 'default',
          // WS Q: thread the per-role dispatch_id so the ACP turn-end
          // hook can emit `dev_turn_ended` attributed to this dispatch.
          dispatch_id: req.dispatch_id,
          task: opts.task,
        })
        return { kind: 'spawned', sessionId: result.sessionId }
      } catch (err) {
        log.error(
          { err, role: req.role, teamId: opts.teamId, taskId: opts.task.id },
          'auto-dispatch: dev/qa spawn failed',
        )
        return { kind: 'existing_owner', existingOwner: `spawn-failed:${req.role}` }
      }
    }

    const devOutcome = await dispatchOne(plan.dev)
    const qaOutcome = await dispatchOne(plan.qa)

    // WS P (Phase 13.13.x) — durable readback flag. Stamp the dispatch
    // audit columns on the task row synchronously, BEFORE the
    // dispatch_started event emit and BEFORE the readback message
    // INSERT. The task row is the audit trail that survives messages +
    // messages_history purging; once stamped, manager-exit-monitor will
    // short-circuit no_readback false-positives even if the broadcast
    // row is purged before the monitor runs.
    //
    // dispatch_id stored is dev.dispatch_id (primary work attribution
    // channel used by WS-Q dev-productivity-monitor and WS-R task
    // completion gate). Dev/qa session ids are encoded the same way
    // synthesizeReadbackBody encodes them so the monitor's target
    // validation sees the same 409/spawn-failed tokens.
    const devSessionToken =
      devOutcome.kind === 'spawned' ? devOutcome.sessionId : `409:${devOutcome.existingOwner}`
    const qaSessionToken =
      qaOutcome.kind === 'spawned' ? qaOutcome.sessionId : `409:${qaOutcome.existingOwner}`
    try {
      const stampRes = markDispatched(db, {
        taskId: opts.task.id,
        dispatchId: plan.dev.dispatch_id,
        readbackAt: new Date().toISOString(),
        managerSessionId: opts.managerSessionId,
        devSessionId: devSessionToken,
        qaSessionId: qaSessionToken,
      })
      if (!stampRes.stamped) {
        log.warn(
          {
            taskId: opts.task.id,
            teamId: opts.teamId,
            existingDispatchId: stampRes.existingDispatchId,
            attemptedDispatchId: plan.dev.dispatch_id,
          },
          'auto-dispatch: task already dispatched (WS-P stamp skipped, first dispatch wins)',
        )
      }
    } catch (err) {
      // Stamp failure must not break dispatch — the manager spawn has
      // already succeeded and event/message emits below are still
      // best-effort. Worst case: legacy WS-J broadcast lookup is the
      // only signal for this dispatch (pre-WS-P behavior).
      log.error(
        { err, teamId: opts.teamId, taskId: opts.task.id },
        'auto-dispatch: failed to stamp WS-P dispatch flag on task row',
      )
    }

    // WS M (Phase 13.13.x) — emit `dispatch_started` BEFORE the readback
    // insert so downstream consumers see attribution as soon as either
    // dev/qa session is registered. Best-effort: emission failures must
    // not break the dispatch (the manager spawn already succeeded).
    if (eventLog.dispatchStarted) {
      try {
        const payload = buildDispatchStartedPayload({
          plan,
          devOutcome,
          qaOutcome,
          task: { id: opts.task.id },
          teamId: opts.teamId,
          managerSessionId: opts.managerSessionId,
          startedAt: new Date(),
        })
        eventLog.dispatchStarted(
          opts.managerSessionId,
          payload as unknown as Record<string, unknown>,
        )
      } catch (err) {
        log.error(
          { err, teamId: opts.teamId, taskId: opts.task.id },
          'auto-dispatch: failed to emit dispatch_started event',
        )
      }
    }

    const body = synthesizeReadbackBody({
      devOutcome,
      qaOutcome,
      notes: `broker auto-dispatch for task ${opts.task.id} (manager ${opts.managerSessionId})`,
    })

    try {
      createMessage(db, {
        id: randomUUID(),
        sender_id: opts.managerSessionId,
        receiver_id: null,
        team_id: opts.teamId,
        content: body,
        story_id: null,
      })
      log.info(
        {
          teamId: opts.teamId,
          managerSessionId: opts.managerSessionId,
          taskId: opts.task.id,
          devOutcome,
          qaOutcome,
        },
        'auto-dispatch: synthesized Dispatch Readback into team log',
      )
    } catch (err) {
      log.error(
        { err, teamId: opts.teamId, managerSessionId: opts.managerSessionId },
        'auto-dispatch: failed to insert synthesized readback',
      )
    }
  }

  async function doSpawn(input: SpawnInput): Promise<SpawnResult> {
    // F1 (global concurrency cap): refuse new spawns once the active-agent
    // count reaches the cap. Callers (recovery, respawn, brain) must treat
    // AgentCapExceededError as retryable and back off. Unbounded spawning
    // is the primary driver of the auto-restart CPU/RAM runaway — each
    // ACP subprocess costs ~150–300 MB RSS, so a cap is a hard backstop.
    //
    // Race-fix: include `pendingSpawns` in the cap check. activeAgents.set()
    // happens after `await` points (ACP initialize/createSession), so a
    // size-only check would let N parallel callers all pass before any of
    // them inserted. `pendingSpawns` is incremented synchronously here and
    // decremented in the finally below, making the cap effectively atomic.
    const inFlight = activeAgents.size + pendingSpawns
    if (inFlight >= maxConcurrentAgents) {
      log.warn(
        {
          active: activeAgents.size,
          pending: pendingSpawns,
          max: maxConcurrentAgents,
          team_id: input.team_id,
          name: input.name,
          role: input.role,
        },
        'agent-spawner: rejecting spawn — concurrent-agent cap reached',
      )
      throw new AgentCapExceededError(inFlight, maxConcurrentAgents)
    }
    pendingSpawns++
    try {
      recentSpawnTimestamps.push(Date.now())
      pruneSpawnWindow(Date.now())

      const platform = deps.detectPlatform()
      const cli = deps.findCli(platform)
      if (!cli) {
        throw new ConfigurationError('No compatible AI CLI found. Install copilot or claude CLI.')
      }

      const role = input.role ?? 'dev'
      const agent = input.agent ?? 'teammate'
      // Task 43 — give the team-worktree-manager (if injected) a chance
      // to provision a per-team git worktree and persist the pin to
      // `teams.working_dir` BEFORE we read it below. Errors are
      // swallowed: a provisioning failure must not block the spawn,
      // because the spawner has a working fallback (caller dir / broker
      // cwd) and surfacing a hard failure here would make the broker
      // worse than before this hook existed.
      if (options?.resolveTeamWorkingDir) {
        try {
          options.resolveTeamWorkingDir(input.team_id)
        } catch (err) {
          log.warn(
            { err, teamId: input.team_id },
            'agent-spawner: resolveTeamWorkingDir hook threw; falling back to default working_dir resolution',
          )
        }
      }
      // Task 34 (neuron fan-out): a team's configured working_dir is the
      // source of truth and ALWAYS wins over the caller-supplied directory.
      // This guarantees that once an operator pins a neuron to a checkout,
      // nothing — autospawner, manager auto-dispatch, manual /spawn — can
      // accidentally drop an agent into the wrong tree and tangle staged
      // diffs across concurrent neurons. NULL = legacy behaviour: fall back
      // to the caller's working_dir, else the broker's cwd.
      const teamWorkingDir = findTeamWorkingDir(db, input.team_id)
      const candidateDir = teamWorkingDir ?? input.working_dir ?? workingDir
      const resolvedWorkingDir = path.resolve(candidateDir)
      if (resolvedWorkingDir.includes('..')) {
        throw new ValidationError(
          `Invalid working_dir: path traversal detected in '${candidateDir}'`,
        )
      }
      const sessionId = `${input.team_id.slice(0, 8)}-${input.name}-${Date.now()}`
      const purpose = `${role} agent for team ${input.team_id}: ${input.prompt ?? 'no specific task'}`

      // Phase 13.12.20: wrap session insert + team-member insert in a single
      // transaction so that a CHECK-constraint failure on the role (or any
      // other team-member validation) rolls back the session row. This
      // prevents the orphan-session leak described in DOGFOOD-EVIDENCE-
      // 13-12-20 where failed spawns left `team_id=null` session rows.
      const insertMemberTxn = db.transaction(() => {
        createSession(db, {
          id: sessionId,
          purpose,
          working_dir: resolvedWorkingDir,
          worktree: null,
          project_id: spawnerProjectId ?? null,
        })
        addTeamMember(db, {
          team_id: input.team_id,
          session_id: sessionId,
          name: input.name,
          role,
          agent_type: agent,
        })
      })
      try {
        insertMemberTxn()
      } catch (err) {
        log.error(
          { err, sessionId, teamId: input.team_id, role },
          'Agent spawn: session+team-member transaction failed — no orphan rows',
        )
        throw err
      }

      // Emit events AFTER DB commit so downstream consumers never see
      // sessionRegistered without a matching team-member row.
      eventLog.sessionRegistered(sessionId, {
        team_id: input.team_id,
        name: input.name,
        role,
      })
      eventLog.teamMemberJoined(sessionId, {
        team_id: input.team_id,
        name: input.name,
        role,
      })

      const prompt = buildAgentPrompt({
        sessionId,
        teamId: input.team_id,
        name: input.name,
        role,
        brokerUrl,
        workingDir: resolvedWorkingDir,
        customPrompt: input.prompt,
        availableSecretKeys: getAvailableSecretKeys ? getAvailableSecretKeys() : undefined,
        availableSkills: getAvailableSkills ? getAvailableSkills() : undefined,
      })

      const permissions = input.permissions ?? 'default'
      const scnsEnv: Record<string, string> = {
        SCNS_SESSION_ID: sessionId,
        SCNS_TEAM_ID: input.team_id,
        SCNS_ROLE: role,
        SCNS_BROKER_URL: brokerUrl,
        ...otelEnv,
        // Phase 13.12.17: inject internal token for secret vault access.
        // Do NOT log this value anywhere.
        ...(internalToken ? { SCNS_INTERNAL_TOKEN: internalToken } : {}),
      }

      // Layer-2 fix — when the resolved working_dir is a worktree
      // bridged by team-worktree-manager, prepend
      // `<cwd>/node_modules/.bin` to PATH so the bare `vitest run …`,
      // `tsc --noEmit`, `eslint`, `prettier` invocations in the
      // dev/qa task prompts resolve. Production payoff: dev/qa ACP
      // turns no longer exit with "command not found" the moment they
      // try to run the very first npm-script the prompt asks for
      // (live observation 2026-05-16 team 4fde2759 had 100% silent
      // exits because every test/typecheck/lint invocation in the
      // prompt returned 127 instantly).
      //
      // Mechanics:
      //   - launchDetached → `env: {...process.env, ...scnsEnv}` so
      //     scnsEnv.PATH overrides the inherited PATH cleanly.
      //   - ACP launch    → acp-client.ts:394 builds env the same way,
      //     so the override propagates to the copilot child too.
      //   - launchTmux    → writes `export PATH=…` lines after the cd
      //     in the generated shell script; the export replaces the
      //     inherited PATH for the child.
      // No-op when the directory does not exist (caller-supplied
      // working_dir, broker fallback, or bridge-failed worktree).
      const existsSyncImpl = deps.existsSync ?? fsExistsSync
      const wtBinDir = path.join(resolvedWorkingDir, 'node_modules', '.bin')
      if (existsSyncImpl(wtBinDir)) {
        const inheritedPath = process.env['PATH'] ?? ''
        scnsEnv['PATH'] = inheritedPath ? `${wtBinDir}${path.delimiter}${inheritedPath}` : wtBinDir
      }

      // Determine launch method
      const useAcp = input.launch_method === 'acp' && cli.command.includes('copilot')
      let launchMethod: 'tmux' | 'detached' | 'acp'
      if (useAcp) {
        launchMethod = 'acp'
      } else if (input.launch_method === 'acp') {
        log.warn(
          { cli: cli.command, sessionId },
          'ACP requested but CLI is not copilot — falling back to detached',
        )
        launchMethod = deps.isTmuxAvailable() ? 'tmux' : 'detached'
      } else if (input.launch_method) {
        launchMethod = input.launch_method
      } else {
        launchMethod = deps.isTmuxAvailable() ? 'tmux' : 'detached'
      }

      let childProcess: ChildProcess | null = null
      let tmuxSession: string | null = null
      let tmuxWindow: string | null = null
      let acpClient: AcpClient | null = null
      let acpSessionId: string | null = null

      // WS K: instrumentation. Capture launch start time so first-output
      // latency can be reported on the agent_first_output_received event.
      const launchStartedAt = Date.now()
      let firstOutputEmitted = false
      const emitFirstOutput = (sample: string): void => {
        if (firstOutputEmitted) return
        firstOutputEmitted = true
        const trimmed = sample.length > 200 ? sample.slice(0, 200) : sample
        safeEmit(eventLog.agentFirstOutputReceived, sessionId, {
          role,
          team_id: input.team_id,
          launch_method: launchMethod,
          latency_ms: Date.now() - launchStartedAt,
          sample: trimmed,
        })
      }
      safeEmit(eventLog.agentLaunchStarted, sessionId, {
        role,
        team_id: input.team_id,
        task_id: input.task?.id ?? null,
        working_dir: resolvedWorkingDir,
        launch_method: launchMethod,
        cli: cli.command,
      })

      try {
        if (launchMethod === 'acp') {
          // Phase 13.12.21: per-session ACP JSONL log so operators can inspect
          // permission + tool-call traffic when a diff comes back empty. Lives
          // alongside the detached log format so team-lifecycle's readLogTail
          // works uniformly via entry.logPath.
          const acpLogDir = path.join(resolvedWorkingDir, '.github', 'logs')
          const acpLogFile = path.join(acpLogDir, `acp-${sessionId}.log`)
          try {
            deps.mkdirSync(acpLogDir, { recursive: true })
          } catch (err) {
            log.debug({ err, acpLogDir }, 'mkdirSync for ACP log dir (may already exist)')
          }
          const appendAcpLog = (entry: Record<string, unknown>): void => {
            try {
              deps.writeFileSync(acpLogFile, JSON.stringify(entry) + '\n', { flag: 'a' })
            } catch (err) {
              log.warn({ err, acpLogFile }, 'Failed to append ACP log entry')
            }
          }
          // Phase 1.5 step 4 — per-role autopilot selection. Roles in
          // `autopilotRoles` (default: scns-dev + scns-qa) get
          // `--allow-all-tools` at the CLI flag level AND an
          // allow-destructive permission policy as defense-in-depth.
          // Manager (not in autopilotRoles by default) keeps gated
          // behavior so plan/dispatch stays a deliberate operator step.
          const usesAutopilot = autopilotRoles.has(role)
          const spawnPermissionPolicy = usesAutopilot
            ? autopilotPermissionPolicy
            : basePermissionPolicy
          // WS-0 Option A — when the kernel is enforcing, autopilot must NOT
          // run with `--allow-all-tools`: that flag suppresses the per-call
          // permission RPCs and would BYPASS the kernel's egress/spend gates.
          // The kernel-wrapped policy already auto-allows safe tools (so
          // autonomy is preserved) while denying egress/spend. Without a
          // kernel, behavior is unchanged (legacy back-compat).
          const allowAllToolsForSpawn = usesAutopilot && !safetyKernel
          // Phase 1.5 step 4 — record autopilot state on the spawn audit
          // entry so post-hoc forensics can distinguish "no permission
          // RPCs because none were needed" from "no permission RPCs
          // because --allow-all-tools suppressed them upstream".
          const permissionPolicyKind: 'autopilot' | 'base' | 'explicit' = explicitPolicy
            ? 'explicit'
            : usesAutopilot
              ? 'autopilot'
              : 'base'
          appendAcpLog({
            t: new Date().toISOString(),
            type: 'spawn',
            sessionId,
            teamId: input.team_id,
            role,
            name: input.name,
            usesAutopilot,
            allowAllTools: allowAllToolsForSpawn,
            permissionPolicyKind,
          })

          // WS-0 — audit the spawn through the kernel (observe-only this
          // cycle: checkSpawn is default-allow, but records an audit row).
          safetyKernel?.checkSpawn({ sessionId, role, teamId: input.team_id })

          const client = acpClientFactory({
            cwd: resolvedWorkingDir,
            env: scnsEnv,
            spawnFn: deps.spawnProcess as typeof import('node:child_process').spawn,
            permissionPolicy: spawnPermissionPolicy,
            allowAllTools: allowAllToolsForSpawn,
            promptTimeoutMs: acpPromptTimeoutMs,
            onPermissionDecision: (entry) => {
              appendAcpLog({ type: 'permission', ...entry })
            },
            onProcessExit: ({ code, signal }) => {
              appendAcpLog({
                t: new Date().toISOString(),
                type: 'exit',
                sessionId,
                code,
                signal,
              })
              const entry = activeAgents.get(sessionId)
              if (entry) {
                if (signal) entry.exitReason = 'killed'
                else if (typeof code === 'number' && code !== 0) entry.exitReason = 'error'
                else entry.exitReason = 'normal'
              }
              void cleanupSession(sessionId)
            },
          })
          // Capture tool-call updates + message chunks into the ACP log for
          // post-hoc debugging (prompt tuning, diff-empty triage, etc.).
          client.onUpdate((update: AcpSessionUpdate) => {
            try {
              const kind = update?.update?.sessionUpdate
              if (!kind) return
              // WS K + Phase 1.5 step 2: count only MEANINGFUL agent activity
              // as "first output". Bootstrap-stream notifications
              // (available_commands_update, config_option_update) fire BEFORE
              // the agent has reacted to the prompt and previously falsely
              // satisfied agent_first_output_received — masking the
              // "manager exited without dispatch" failure class where the
              // catalog arrives but no actual response ever does. The
              // observed failure pattern (handoff: "first_output sample=
              // 'available_commands_update', NO message_sent events ever")
              // is exactly that masking case.
              if (!firstOutputEmitted && !ACP_BOOTSTRAP_UPDATE_KINDS.has(kind)) {
                let sample = kind
                try {
                  const u = update.update as Record<string, unknown>
                  const content = u?.['content'] as { text?: string } | undefined
                  if (content?.text && typeof content.text === 'string') {
                    sample = `${kind}: ${content.text}`
                  }
                } catch {
                  /* best-effort sample extraction */
                }
                emitFirstOutput(sample)
              }
              // Phase 13.12.25: heartbeat on ANY ACP activity so team-reaper
              // treats the team as live even if `status` momentarily dips
              // outside ('working','idle') during a long tool call.
              try {
                touchMemberActivity(db, sessionId)
              } catch (err) {
                log.debug({ err, sessionId }, 'touchMemberActivity failed')
              }
              if (kind === 'agent_message_chunk') return // too noisy; captured in output
              appendAcpLog({
                t: new Date().toISOString(),
                type: 'update',
                updateKind: kind,
                payload: update.update,
              })
            } catch (err) {
              log.debug({ err }, 'ACP log update capture failed')
            }
          })
          await client.initialize()
          const aSessionId = await client.createSession(resolvedWorkingDir, [...mcpServers])
          acpClient = client
          acpSessionId = aSessionId
          childProcess = null

          // Phase 1.5 step 5 — emit the cold-start timing probe. All four
          // marks should be populated by a successful initialize +
          // createSession; if any is missing (e.g. a test double that
          // doesn't bother), skip the emit rather than synthesizing a
          // misleading delta. The probe is observe-only — never blocks
          // the spawn flow or surfaces to the agent. See
          // event-dispatcher.ts `'agent_acp_timing'` for the consumer
          // contract.
          try {
            const t = client.timings
            if (
              t.processSpawnStartedAt !== null &&
              t.initializeResolvedAt !== null &&
              t.sessionNewStartedAt !== null &&
              t.sessionNewResolvedAt !== null
            ) {
              const processSpawnToInitializeMs = t.initializeResolvedAt - t.processSpawnStartedAt
              const sessionNewMs = t.sessionNewResolvedAt - t.sessionNewStartedAt
              const coldStartMs = t.sessionNewResolvedAt - t.processSpawnStartedAt
              safeEmit(eventLog.agentAcpTiming, sessionId, {
                role,
                team_id: input.team_id,
                acp_session_id: aSessionId,
                process_spawn_to_initialize_ms: processSpawnToInitializeMs,
                session_new_ms: sessionNewMs,
                cold_start_ms: coldStartMs,
                process_spawn_started_at: t.processSpawnStartedAt,
                initialize_resolved_at: t.initializeResolvedAt,
                session_new_started_at: t.sessionNewStartedAt,
                session_new_resolved_at: t.sessionNewResolvedAt,
              })
            }
          } catch (err) {
            // Never let the probe disrupt a successful spawn. The fact
            // that timings are missing is itself a signal — pool design
            // can detect it via the absence of agent_acp_timing events.
            log.debug({ err, sessionId }, 'agent_acp_timing emit failed')
          }

          // WS K: prompt is about to be handed to the ACP transport. Emit
          // BEFORE sendPrompt so the event is observable even if sendPrompt
          // never resolves (the dev-silence symptom).
          safeEmit(eventLog.agentPromptDelivered, sessionId, {
            role,
            team_id: input.team_id,
            transport: 'acp',
            prompt_byte_count: Buffer.byteLength(prompt, 'utf8'),
            acp_session_id: aSessionId,
          })

          // WS L: replace single fire-and-forget sendPrompt with a bounded
          // agentic loop for nudge-eligible roles. Other roles preserve the
          // legacy single-turn behaviour.
          const useAgenticLoop = nudgeRoles.has(role) && agentNudgeBudget > 0
          const loopStartedAt = Date.now()

          const checkStaged = (): boolean => {
            try {
              const res = deps.spawnSync('git', ['diff', '--cached', '--quiet'], {
                cwd: resolvedWorkingDir,
                stdio: 'ignore',
                // Bounded so a wedged worktree git can't park the main-thread
                // event loop during the WS-L nudge loop (cf. 2026-06-05 hang).
                timeout: 10_000,
                killSignal: 'SIGKILL',
              })
              // exit 0 = clean (no staged); exit 1 = staged changes; other = error
              return res.status === 1
            } catch (err) {
              log.debug({ err, sessionId }, 'WS L: git stage check failed')
              return false
            }
          }

          const buildNudgePrompt = (nudgeIndex: number, budget: number): string =>
            [
              `Heads up — nudge ${nudgeIndex} of ${budget}:`,
              '',
              'Your previous response did not stage any changes (`git diff --cached`',
              'is still empty in the working directory). The SCNS quality gate only',
              'sees STAGED work; chat-only responses are invisible to it.',
              '',
              'Required next action:',
              '  1. Use your Edit / Write / Bash tools NOW to make the change the',
              '     task above asks for. Do NOT respond with chat alone.',
              '  2. Run `git add -A` (via your Bash tool) to stage the work.',
              '  3. If the task GENUINELY requires no code changes, briefly',
              '     explain why and then exit cleanly.',
              '',
              'After this round I will re-check `git diff --cached`. If it is',
              `still empty after ${budget} nudges, the session will be closed.`,
            ].join('\n')

          const closeClient = (reason: string): void => {
            log.info({ sessionId, reason }, 'WS L: closing ACP client')
            void client.close().catch((err) => {
              log.warn({ err, sessionId }, 'ACP post-loop close failed')
            })
          }

          const runAgenticLoop = async (): Promise<void> => {
            // Iteration 0 = the initial prompt; iterations 1..N = nudges.
            let nudgeIndex = 0
            let currentPrompt = prompt
            const budget = useAgenticLoop ? agentNudgeBudget : 0

            for (;;) {
              const result = await client.sendPrompt(aSessionId, currentPrompt)
              appendAcpLog({
                t: new Date().toISOString(),
                type: nudgeIndex === 0 ? 'prompt_result' : 'nudge_result',
                stopReason: result.stopReason,
                nudgeIndex,
              })
              log.info(
                { sessionId, acpSessionId: aSessionId, stopReason: result.stopReason, nudgeIndex },
                nudgeIndex === 0 ? 'ACP initial prompt completed' : 'ACP nudge prompt completed',
              )

              // WS Q (Phase 13.13.x) — emit `dev_turn_ended` for every
              // ACP turn that resolved on a dispatch-attributed dev
              // session. Fires per-turn (initial + each nudge), so
              // dev-productivity-monitor samples the staged numstat at
              // turn-end instead of on a timer / session_deregistered.
              //
              // WS-Q² race fix: sample WS-L's `git diff --cached --quiet`
              // ONCE here and pass the result into the event. The
              // monitor uses this as a vote against `silent_exit` when
              // its own numstat read races against an in-flight `git
              // add` (see task-24 22:08:43 broker.log). The same value
              // is reused for the WS-L close decision below to keep the
              // two signals consistent (single source of truth).
              const stagedDiffDetected = checkStaged()
              if (role === 'scns-dev' && input.dispatch_id) {
                safeEmit(eventLog.devTurnEnded, sessionId, {
                  dispatch_id: input.dispatch_id,
                  session_id: sessionId,
                  role: 'scns-dev',
                  team_id: input.team_id,
                  task_id: input.task?.id ?? null,
                  working_dir: resolvedWorkingDir,
                  stop_reason: result.stopReason ?? null,
                  nudge_index: nudgeIndex,
                  ended_at: new Date().toISOString(),
                  staged_diff_detected: stagedDiffDetected,
                })
              }

              if (!useAgenticLoop) {
                closeClient('non-nudge-role')
                return
              }

              // Stop conditions checked AFTER each prompt resolves.
              if (stagedDiffDetected) {
                closeClient('staged-diff-detected')
                return
              }
              if (nudgeIndex >= budget) {
                closeClient('nudge-budget-exhausted')
                return
              }
              if (Date.now() - loopStartedAt >= agentNudgeWallClockMs) {
                closeClient('wall-clock-exceeded')
                return
              }
              if (client.state === 'closed') {
                log.info({ sessionId }, 'WS L: ACP client already closed; ending loop')
                return
              }

              nudgeIndex += 1
              const reason =
                'no_staged_changes_after_end_turn (stopReason=' + result.stopReason + ')'
              safeEmit(eventLog.agentNudgeSent, sessionId, {
                role,
                team_id: input.team_id,
                acp_session_id: aSessionId,
                nudge_index: nudgeIndex,
                budget,
                reason,
              })
              appendAcpLog({
                t: new Date().toISOString(),
                type: 'nudge_sent',
                nudgeIndex,
                budget,
                reason,
              })
              currentPrompt = buildNudgePrompt(nudgeIndex, budget)
            }
          }

          // Fire-and-forget the agentic loop — don't block spawn.
          runAgenticLoop().catch((err) => {
            if (!(err instanceof AcpError && client.state === 'closed')) {
              log.error({ err, sessionId }, 'ACP agentic loop failed')
            }
            appendAcpLog({
              t: new Date().toISOString(),
              type: 'prompt_error',
              error: String(err),
            })
            safeEmit(eventLog.agentLaunchFailed, sessionId, {
              role,
              team_id: input.team_id,
              stage: 'prompt',
              transport: 'acp',
              error: err instanceof Error ? err.message : String(err),
              error_class: err instanceof Error ? err.constructor.name : 'unknown',
            })
            const entry = activeAgents.get(sessionId)
            if (entry) entry.exitReason = 'error'
            void cleanupSession(sessionId)
          })
        } else if (launchMethod === 'tmux') {
          const cliArgs = buildCliArgs(agent, prompt, permissions)
          const tmuxInfo = launchTmux(
            cli,
            cliArgs,
            input.team_id,
            input.name,
            resolvedWorkingDir,
            scnsEnv,
          )
          tmuxSession = tmuxInfo.tmuxSession
          tmuxWindow = tmuxInfo.tmuxWindow
          // WS K: for tmux, the prompt is in argv — handed to the OS as soon
          // as launchTmux returns. There is no clean way to tap stdout
          // (tmux owns the pty), so first_output_received is not emitted on
          // this transport. Documented in the WS K diagnosis.
          safeEmit(eventLog.agentPromptDelivered, sessionId, {
            role,
            team_id: input.team_id,
            transport: 'tmux',
            prompt_byte_count: Buffer.byteLength(prompt, 'utf8'),
            tmux_session: tmuxSession,
          })
        } else {
          const cliArgs = buildCliArgs(agent, prompt, permissions)
          childProcess = launchDetached(cli, cliArgs, sessionId, resolvedWorkingDir, scnsEnv)
          // WS K: prompt is in argv for detached launches too.
          safeEmit(eventLog.agentPromptDelivered, sessionId, {
            role,
            team_id: input.team_id,
            transport: 'detached',
            prompt_byte_count: Buffer.byteLength(prompt, 'utf8'),
            pid: childProcess.pid ?? null,
          })
          // WS K: tap stdout if it is a stream (it normally is redirected to
          // a log fd via launchDetached, in which case childProcess.stdout
          // is null and this listener never fires — the diagnostic harness
          // notes the gap and the operator falls back to tailing the log).
          const stdout = childProcess.stdout
          if (stdout && typeof stdout.on === 'function') {
            stdout.on('data', (chunk: Buffer | string) => {
              const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
              const trimmed = text.trim()
              if (trimmed.length === 0) return
              emitFirstOutput(trimmed)
            })
          }
        }
      } catch (err) {
        log.error(
          { err, sessionId, platform, launchMethod, cli: cli.command },
          'Agent launch failed',
        )
        safeEmit(eventLog.agentLaunchFailed, sessionId, {
          role,
          team_id: input.team_id,
          stage: launchMethod === 'acp' ? 'acp_handshake' : 'spawn',
          transport: launchMethod,
          error: err instanceof Error ? err.message : String(err),
          error_class: err instanceof Error ? err.constructor.name : 'unknown',
        })
        try {
          removeTeamMember(db, input.team_id, sessionId)
        } catch (err) {
          log.warn({ err, sessionId }, 'Spawn cleanup: failed to remove team member')
        }
        try {
          // Issue #70: settlement-aware rollback — if anything already
          // addressed this never-launched session, that mail archives rather
          // than silently disappearing.
          terminateSession(db, sessionId)
        } catch (err) {
          log.warn({ err, sessionId }, 'Spawn cleanup: failed to delete session')
        }
        throw err
      }

      if (childProcess) {
        childProcess.on('error', (err) => {
          log.error(
            { err, sessionId, platform, launchMethod, cli: cli.command },
            'Agent child process error',
          )
          const entry = activeAgents.get(sessionId)
          if (entry) entry.exitReason = 'error'
          void cleanupSession(sessionId)
        })
        childProcess.on('exit', (code, signal) => {
          const entry = activeAgents.get(sessionId)
          if (entry) {
            if (signal) entry.exitReason = 'killed'
            else if (typeof code === 'number' && code !== 0) entry.exitReason = 'error'
            else entry.exitReason = 'normal'
          }
          void cleanupSession(sessionId)
        })
      }

      const logPath =
        launchMethod === 'detached'
          ? path.join(resolvedWorkingDir, '.github', 'logs', `agent-${sessionId}.log`)
          : launchMethod === 'acp'
            ? path.join(resolvedWorkingDir, '.github', 'logs', `acp-${sessionId}.log`)
            : null

      const entry: InternalAgentEntry = {
        sessionId,
        teamId: input.team_id,
        name: input.name,
        role,
        pid: acpClient?.pid ?? childProcess?.pid ?? null,
        launchMethod,
        startedAt: new Date().toISOString(),
        heartbeatTimer: null,
        process: childProcess,
        acpClient,
        acpSessionId,
        workingDir: resolvedWorkingDir,
        logPath,
        exitReason: 'normal',
      }
      activeAgents.set(sessionId, entry)

      const spawnResult: SpawnResult = {
        sessionId,
        teamId: input.team_id,
        name: input.name,
        role,
        platform,
        launchMethod,
        pid: acpClient?.pid ?? childProcess?.pid ?? null,
        tmuxSession,
        tmuxWindow,
        acpSessionId,
      }

      // WS F (Phase 13.13.x): broker-mechanical auto-dispatch. When the
      // caller spawns a manager bound to a stored task, immediately spawn
      // the dev + qa for that task on the same team and synthesize the
      // Dispatch Readback so the WS C manager-exit-monitor sees a complete
      // dispatch. Only triggers for role === 'scns-manager' AND task set.
      if (role === 'scns-manager' && input.task) {
        try {
          await runAutoDispatch({
            task: input.task,
            managerSessionId: sessionId,
            teamId: input.team_id,
            teamName: input.team_name ?? null,
            workingDir: resolvedWorkingDir,
            launchMethod,
          })
        } catch (err) {
          log.error(
            { err, sessionId, teamId: input.team_id, taskId: input.task.id },
            'auto-dispatch threw despite internal catches — manager spawn already succeeded',
          )
        }
      }

      return spawnResult
    } finally {
      pendingSpawns--
    }
  }

  return {
    spawn: doSpawn,

    async sendMessage(
      sessionId: string,
      message: string,
    ): Promise<{ accepted: boolean; error?: string }> {
      const entry = activeAgents.get(sessionId)
      if (!entry) {
        return { accepted: false, error: 'Agent not found' }
      }
      if (!entry.acpClient || !entry.acpSessionId) {
        return {
          accepted: false,
          error: 'Agent is not an ACP agent — cannot send follow-up messages',
        }
      }
      if (entry.acpClient.state === 'prompting') {
        return { accepted: false, error: 'Agent is busy processing a prompt' }
      }
      if (entry.acpClient.state !== 'ready') {
        return { accepted: false, error: `Agent is in state: ${entry.acpClient.state}` }
      }

      try {
        const result = await entry.acpClient.sendPrompt(entry.acpSessionId, message)
        log.info(
          { sessionId, acpSessionId: entry.acpSessionId, stopReason: result.stopReason },
          'ACP follow-up prompt completed',
        )
        return { accepted: true }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        log.error({ err, sessionId }, 'ACP follow-up prompt failed')
        return { accepted: false, error: errMsg }
      }
    },

    getActiveAgents(): ReadonlyMap<string, SpawnedAgentInfo> {
      const snapshot = new Map<string, SpawnedAgentInfo>()
      for (const [id, entry] of activeAgents) {
        snapshot.set(id, {
          sessionId: entry.sessionId,
          teamId: entry.teamId,
          name: entry.name,
          role: entry.role,
          pid: entry.pid,
          launchMethod: entry.launchMethod,
          startedAt: entry.startedAt,
          acpSessionId: entry.acpSessionId,
        })
      }
      return snapshot
    },

    getSpawnStats(): SpawnStats {
      pruneSpawnWindow(Date.now())
      return {
        activeCount: activeAgents.size,
        maxConcurrent: maxConcurrentAgents,
        spawnsLast60s: recentSpawnTimestamps.length,
        pendingCount: pendingSpawns,
      }
    },

    async cleanup(sessionId: string): Promise<void> {
      await cleanupSession(sessionId)
    },

    async shutdownAll(): Promise<void> {
      const ids = [...activeAgents.keys()]
      await Promise.all(ids.map((id) => cleanupSession(id)))
    },
  }
}
