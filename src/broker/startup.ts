/**
 * Broker startup — initializes all components and starts listening.
 */

import type { Server } from 'node:http'
import { loadConfig, ensureDbDirectory, type BrokerConfig } from './config.js'
import { openDatabase, closeDatabase } from './storage/db.js'
import { registerProject, backfillProjectId } from './project-registry.js'
import { createEventLog } from './services/event-log.js'
import { createEventDispatcher } from './event-dispatcher.js'
import { cleanupStaleSessionsOnStartup } from './startup-cleanup.js'
import { startHeartbeatPoller } from './heartbeat-poller.js'
import { startSessionDiscovery } from './session-discovery.js'
import { createBrokerServer, type BrokerServer, type BrokerServerOptions } from './server.js'
import { ShutdownManager } from './shutdown.js'
import { logger } from '../shared/logger.js'
import { isUnattendedEnabled, unattendedStatusDetail } from '../shared/unattended.js'
import { seedDefaultTasks } from './storage/repositories/scheduler-repository.js'
import { createAgentSpawner, type AgentSpawner } from './services/agent-spawner.js'
import { createSafetyKernel } from './services/safety-kernel/safety-kernel.js'
import { loadAllowlist } from './services/safety-kernel/kernel-allowlist.js'
import { SAFETY_ALLOWLIST_PATH } from './services/safety-kernel/protected-paths.js'
import { appendEvent } from './storage/repositories/event-repository.js'
import {
  realGitDiffChecker,
  handleQualityGateVerdictForTaskCompletion,
} from './services/task-completion-gate.js'
import { createTaskScheduler, type TaskHandler } from './services/task-scheduler.js'
import {
  loadPendingSnapshots,
  recoverAgents,
  expireOldSnapshotsHours,
  snapshotActiveAgents,
  recordBrokerStartup,
  crashLoopDetectedOnStartup,
  RECOVERY_SNAPSHOT_MAX_AGE_HOURS,
} from './services/session-recovery.js'
import { listenWithRetry, parseListenFd, listenOnFd } from './listen-retry.js'
import { createHealthWatchdog, type HealthCheck } from './services/health-watchdog.js'
import { consumeLastExitReason } from './services/self-heal.js'
import { createSelfHealTrigger } from './services/self-heal-trigger.js'
import { describeSupervision, detectSupervision } from './services/supervision.js'
import {
  brokerPidfilePath,
  removeBrokerPidfile,
  writeBrokerPidfile,
} from './services/broker-pidfile.js'
import { createRateMonitor } from '../rate-limit/rate-monitor.js'
import { resolveScnsHome } from '../shared/scns-home.js'
import { createTeamOrchestrator, type TeamOrchestrator } from './a2a/team-orchestrator.js'
import {
  createTeamLifecycleController,
  type TeamLifecycleController,
} from './services/team-lifecycle.js'
import { createTeamReaper, type TeamReaper } from './services/team-reaper.js'
import { createTeamTaskAutospawner } from './services/team-task-autospawner.js'
import {
  createTeamWorktreeManager,
  type TeamWorktreeManager,
} from './services/team-worktree-manager.js'
import { createSelfImproveFollowupCreator } from './services/self-improve-followup-creator.js'
import {
  createManagerExitMonitor,
  type ManagerExitMonitor,
} from './services/manager-exit-monitor.js'
import { findLatestManagerBroadcast } from './storage/repositories/message-repository.js'
import { findDispatchForManagerExit as findDispatchForManagerExitRepo } from './storage/repositories/task-repository.js'
import {
  createDevProductivityMonitor,
  type DevProductivityMonitor,
} from './services/dev-productivity-monitor.js'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, join as pathJoin } from 'node:path'
import { homedir } from 'node:os'
import { parseNumstatZ } from './services/dev-productivity-monitor.js'

/**
 * Phase 13.12.18 — discover available skills for advertisement in agent
 * prompts. Reads `~/.copilot/skills/workflows.json` if present; otherwise
 * falls back to scanning directories for a `SKILL.md`. Always safe (never
 * throws).
 */
function discoverAvailableSkills(): readonly {
  readonly name: string
  readonly description: string
}[] {
  const skillsDir = join(homedir(), '.copilot', 'skills')
  const out: { name: string; description: string }[] = []
  try {
    const wf = join(skillsDir, 'workflows.json')
    if (existsSync(wf)) {
      const parsed = JSON.parse(readFileSync(wf, 'utf-8')) as {
        skills?: Record<string, { title?: string; description?: string }>
      }
      if (parsed?.skills) {
        for (const [name, entry] of Object.entries(parsed.skills)) {
          out.push({
            name: entry?.title ?? name,
            description: (entry?.description ?? `Skill at ~/.copilot/skills/${name}/`).slice(
              0,
              280,
            ),
          })
        }
      }
    } else if (existsSync(skillsDir)) {
      for (const dirent of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue
        const skillMd = join(skillsDir, dirent.name, 'SKILL.md')
        if (!existsSync(skillMd)) continue
        out.push({ name: dirent.name, description: `Skill at ~/.copilot/skills/${dirent.name}/` })
      }
    }
  } catch {
    // Non-fatal — just advertise no skills on read error.
  }
  return out
}
import type { EventDispatcher } from './event-dispatcher.js'
import type { EventLog } from './services/event-log.js'

export interface BrokerStartupConfig extends Partial<BrokerConfig> {
  readonly handleSessionEvent?: BrokerServerOptions['handleSessionEvent']
  readonly agentSpawner?: AgentSpawner
  readonly rotationController?: BrokerServerOptions['rotationController']
  readonly compactionDetector?: BrokerServerOptions['compactionDetector']
  readonly costTracker?: BrokerServerOptions['costTracker']
  readonly sentimentAnalyzer?: BrokerServerOptions['sentimentAnalyzer']
  readonly negativeMemoryStore?: BrokerServerOptions['negativeMemoryStore']
  readonly onSessionCompleted?: BrokerServerOptions['onSessionCompleted']
  /** OTel env vars to inject into spawned agents */
  readonly otelEnv?: Readonly<Record<string, string>>
  /** Whether to attempt session recovery from pre-restart snapshots */
  readonly enableRecovery?: boolean
  /** Phase 13.12.17 — credential vault deps. */
  readonly secretStore?: import('../secrets/secret-store.js').SecretStore
  readonly internalToken?: string
}

export interface BrokerHandle {
  readonly server: Server
  readonly broker: BrokerServer
  readonly db: import('better-sqlite3').Database
  readonly agentSpawner: AgentSpawner
  readonly orchestrator: TeamOrchestrator
  readonly teamLifecycle: TeamLifecycleController
  readonly teamReaper: TeamReaper
  readonly eventLog: EventLog
  readonly dispatcher: EventDispatcher
  registerTaskHandler(taskId: string, handler: TaskHandler): void
  startScheduler(): void
  /** WI-6 — execute one scheduled task's real handler immediately (dashboard run-now). */
  runScheduledTask(taskId: string): Promise<'ran' | 'no-task' | 'no-handler'>
  stop(): Promise<void>
}

export async function startBroker(config?: BrokerStartupConfig): Promise<BrokerHandle> {
  const {
    handleSessionEvent,
    agentSpawner: injectedSpawner,
    rotationController,
    compactionDetector,
    costTracker,
    sentimentAnalyzer,
    negativeMemoryStore,
    onSessionCompleted,
    otelEnv,
    enableRecovery,
    secretStore,
    internalToken,
    ...rest
  } = config ?? {}
  const cfg = { ...loadConfig(), ...rest }
  const log = logger.child({ module: 'broker-startup' })

  // 1. Open database
  ensureDbDirectory(cfg.dbPath)
  const db = openDatabase(cfg.dbPath)

  // 2. Create event log + dispatcher
  const dispatcher = createEventDispatcher()
  const eventLog = createEventLog(db, dispatcher)

  // 2a. Multi-project foundation (P3): register this project and adopt any
  // legacy NULL-project rows that clearly belong to it (working_dir under the
  // project root). Best-effort — never block startup. Rows that cannot be
  // confidently attributed stay NULL and surface via the supervisor view.
  try {
    registerProject(db, cfg.projectId, cfg.projectRoot)
    const adopted = backfillProjectId(db, {
      projectId: cfg.projectId,
      projectRoot: cfg.projectRoot,
    })
    if (adopted.teams > 0 || adopted.sessions > 0) {
      log.info(
        { projectId: cfg.projectId, teams: adopted.teams, sessions: adopted.sessions },
        'P3 backfill: adopted legacy rows into current project',
      )
    }
  } catch (err) {
    log.warn(
      { err, projectId: cfg.projectId },
      'P3 project registration/backfill failed — continuing',
    )
  }

  // 3. Startup cleanup + seed default scheduler tasks
  // Wrap in try/catch as an additional belt-and-braces boundary: the cleanup
  // function itself is designed not to throw, but if a future dependency
  // introduces an uncaught error path we still must not crash the broker.
  try {
    const cleanupResult = cleanupStaleSessionsOnStartup(db, eventLog)
    if (cleanupResult.sessions_failed > 0 || cleanupResult.teams_failed > 0) {
      log.warn(
        {
          sessionsFailed: cleanupResult.sessions_failed,
          teamsFailed: cleanupResult.teams_failed,
        },
        'startup-cleanup completed with per-row failures — broker continuing',
      )
    }
  } catch (err) {
    log.error({ err }, 'startup-cleanup threw unexpectedly — broker continuing without cleanup')
  }
  seedDefaultTasks(db)

  // 4. Start session discovery poller (finds running Copilot CLI processes via ps)
  const sessionDiscovery = startSessionDiscovery(db, eventLog)

  // 5. Create agent spawner (use injected or create default).
  //    Forward exits into the team-lifecycle controller (created next) AND
  //    the manager-exit monitor (WS C).
  let teamLifecycleRef: TeamLifecycleController | null = null
  let managerExitMonitorRef: ManagerExitMonitor | null = null
  let devProductivityMonitorRef: DevProductivityMonitor | null = null

  // Task 43 — per-team git worktree sandbox. Defaults ON (BROKER_TEAM_WORKTREES
  // unset or '1' enables; '0' / 'false' disables). When enabled, the spawner
  // calls `ensureWorktreeForTeam(teamId)` BEFORE reading `teams.working_dir`,
  // so every team's first spawn provisions a sandbox under
  // ~/.session-broker/team-worktrees/<teamId>/wt and pins the team to it.
  // QA-NOTES on team 4b84c0b5 (task 50) documented three concrete
  // cross-team `.git/index` races within a 10-minute window; this manager
  // is the load-bearing fix. The team-reaper cleans up sandboxes on archive.
  const worktreeManagerEnabledRaw = process.env['BROKER_TEAM_WORKTREES']
  const worktreeManagerEnabled =
    worktreeManagerEnabledRaw === undefined ||
    worktreeManagerEnabledRaw === '' ||
    !['0', 'false', 'off', 'no'].includes(worktreeManagerEnabledRaw.toLowerCase())
  const worktreeManager: TeamWorktreeManager = createTeamWorktreeManager({
    db,
    projectRoot: cfg.projectRoot,
    enabled: worktreeManagerEnabled,
    // Layer-2 fix — emit `worktree_provisioning` events from the
    // per-team bridge into the same channel as the QG arbiter's
    // Phase-13.12.32 emissions, so operators have one unified audit
    // feed for "was node_modules actually wired into this worktree".
    eventLog,
  })
  log.info(
    {
      enabled: worktreeManagerEnabled,
      baseDir: worktreeManager.getBaseDir(),
      projectRoot: cfg.projectRoot,
    },
    worktreeManagerEnabled
      ? 'team-worktree-manager enabled (BROKER_TEAM_WORKTREES on)'
      : 'team-worktree-manager DISABLED (BROKER_TEAM_WORKTREES=0)',
  )

  // Phase 1.5 Step 2 — wire the broker's session-broker MCP into every
  // spawned ACP agent so dev/qa/manager agents actually GET the broker
  // tools (send_message, register_session, list_sessions, heartbeat,
  // create_team, join_team, etc.) at the ACP transport. Without this,
  // `createSession` was being called with `mcpServers: []` and spawned
  // agents had ZERO broker MCP tools — the manager-silent-exit failure
  // class was a downstream symptom of that gap.
  //
  // Wire shape matches what Copilot CLI's params schema validates:
  //   `{ name, type: 'http', url, headers: [] }`.
  // Probe at ~/.copilot/session-state/5f85fde2.../files/mcp-tools-probe-v2.mjs
  // confirmed tools surface as `tool_call` notifications namespaced
  // `<server-name>-<tool-name>` (e.g. `session-broker-list_sessions`).
  //
  // Opt-out via `BROKER_AGENT_MCP=0` (anything truthy or unset → on).
  const agentMcpEnabledRaw = process.env['BROKER_AGENT_MCP']
  const agentMcpEnabled =
    agentMcpEnabledRaw === undefined ||
    agentMcpEnabledRaw === '' ||
    !['0', 'false', 'off', 'no'].includes(agentMcpEnabledRaw.toLowerCase())
  const agentMcpServers = agentMcpEnabled
    ? [
        {
          name: 'session-broker',
          type: 'http' as const,
          url: `http://localhost:${cfg.port}/mcp`,
          headers: [],
        },
      ]
    : []
  log.info(
    {
      enabled: agentMcpEnabled,
      count: agentMcpServers.length,
      url: agentMcpServers[0]?.url ?? null,
    },
    agentMcpEnabled
      ? 'agent ACP MCP servers wired (BROKER_AGENT_MCP on)'
      : 'agent ACP MCP servers DISABLED (BROKER_AGENT_MCP=0) — spawned agents will have NO broker tools',
  )

  // WS-0 — construct the ONE Immutable Safety Kernel and inject it into the
  // spawner (Decision A / Option A). The kernel routes every spawned agent's
  // tool calls through its deny-all egress/spend gates + immutable audit, and
  // its presence drops `--allow-all-tools` for autopilot roles so the gates
  // cannot be bypassed in-process. The allowlist ships EMPTY (deny-all) and
  // loads fail-closed; each decision is mirrored to the append-only event
  // stream for brain/observability.
  const safetyKernel = createSafetyKernel({
    db,
    allowlist: loadAllowlist(SAFETY_ALLOWLIST_PATH),
    eventSink: {
      kernelDecision: (p) =>
        appendEvent(db, {
          event_type: 'kernel.decision',
          session_id: p.sessionId,
          payload: JSON.stringify(p),
        }),
    },
  })

  const agentSpawner =
    injectedSpawner ??
    createAgentSpawner(db, eventLog, {
      safetyKernel,
      brokerUrl: `http://localhost:${cfg.port}`,
      // Cardinal default so omitted `working_dir` (in API, MCP, brain
      // spawn paths) lands in the configured project root, not the
      // broker process's cwd. Closes the leak surface that
      // `BROKER_PROJECT_ROOT` exists to eliminate.
      workingDir: cfg.projectRoot,
      projectId: cfg.projectId,
      mcpServers: agentMcpServers,
      otelEnv: otelEnv ?? {},
      internalToken,
      getAvailableSecretKeys: secretStore ? () => secretStore.list().map((s) => s.key) : undefined,
      getAvailableSkills: () => discoverAvailableSkills(),
      onAgentExit: (info) => {
        teamLifecycleRef?.handleAgentExit(info)
        managerExitMonitorRef?.handleAgentExit(info)
        devProductivityMonitorRef?.handleAgentExit(info)
      },
      // Task 43 — let the worktree-manager pin the team's working_dir
      // before the spawner reads it. Idempotent and safe when disabled.
      resolveTeamWorkingDir: (teamId: string) => worktreeManager.ensureWorktreeForTeam(teamId),
    })

  // 5a. Team lifecycle controller — emits team_completed events, scales on backlog.
  const teamLifecycle = createTeamLifecycleController({
    db,
    eventLog,
    spawner: agentSpawner,
    options: {
      // Gap 1 — close the delivery loop: auto-stage agent work in the
      // managed per-team worktree before collecting the completion diff,
      // so untracked/unstaged work is not lost. Gated to this base dir,
      // so it never `git add -A`s the live main repo.
      managedWorktreeBaseDir: worktreeManager.getBaseDir(),
    },
  })
  teamLifecycleRef = teamLifecycle

  // 5a.bis. Manager-exit monitor (WS C) — verifies that exiting scns-manager
  //         agents emitted a final dispatch readback naming registered dev/qa
  //         sessions; emits manager_dispatch_incomplete on violations.
  //         Observe-only: never blocks the manager exit, never auto-respawns.
  const managerExitMonitor = createManagerExitMonitor({
    eventLog,
    // WS P (Phase 13.13.x) — durable readback flag short-circuit. Lookup
    // the most recently stamped task whose dispatch_manager_session_id
    // matches the exiting manager; correlation by manager id prevents a
    // stale stamped row on the same team from masking a real no_readback.
    findDispatchForManagerExit: (teamId, managerSessionId) => {
      try {
        return findDispatchForManagerExitRepo(db, teamId, managerSessionId)
      } catch {
        return null
      }
    },
    findLatestManagerBroadcast: (teamId, managerSessionId) =>
      findLatestManagerBroadcast(db, teamId, managerSessionId),
    wasSessionRegistered: (sessionId) => {
      try {
        // Sessions may already be cleaned up by the time the manager exits,
        // so we consult the durable events log rather than the live sessions
        // table. A session_registered row with this id proves it existed.
        const row = db
          .prepare(
            `SELECT 1 AS hit FROM events
             WHERE event_type = 'session_registered' AND session_id = ?
             LIMIT 1`,
          )
          .get(sessionId) as { hit?: number } | undefined
        return Boolean(row?.hit)
      } catch {
        return false
      }
    },
  })
  managerExitMonitorRef = managerExitMonitor

  // 5a.ter. Dev-productivity monitor (WS H) — when an exiting scns-dev
  //         leaves with zero `message_sent` events AND zero diff bytes
  //         attributable to its dispatch, emit `dev_no_work` with reason
  //         `silent_exit`. Observe-only: does not block exit, does not
  //         auto-respawn (per next-loop-plan WS H "Out of scope").
  //
  //         Diff attribution is degraded: WS F stores dispatch_id only in
  //         the dev's prompt extra_context (not in a queryable event), so
  //         the production heuristic here totals the staged diff size in
  //         the dev's working_dir. This over-fires `silent_exit` only when
  //         BOTH zero messages AND zero staged bytes; it cannot wrongly
  //         clear a truly silent exit.
  const devProductivityMonitor = createDevProductivityMonitor({
    eventLog,
    countDevMessages: (sessionId) => {
      try {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS n FROM events
             WHERE event_type = 'message_sent' AND session_id = ?`,
          )
          .get(sessionId) as { n?: number } | undefined
        return Number(row?.n ?? 0)
      } catch {
        return 0
      }
    },
    // WS M (Phase 13.13.x) — strict dispatch_id attribution. Look up the
    // most recent `dispatch_started` event whose payload's dev.session_id
    // matches the exiting session. Returns null if no such event exists
    // (legacy fallback — pre-WS-M dispatches have no attribution row).
    lookupDispatch: (sessionId) => {
      try {
        const row = db
          .prepare(
            `SELECT payload FROM events
             WHERE event_type = 'dispatch_started'
               AND json_extract(payload, '$.dev.session_id') = ?
             ORDER BY id DESC LIMIT 1`,
          )
          .get(sessionId) as { payload?: string } | undefined
        if (!row?.payload) return null
        const parsed = JSON.parse(row.payload) as {
          dev?: { dispatch_id?: string }
          started_at?: string
        }
        const dispatchId = parsed.dev?.dispatch_id
        const startedAtIso = parsed.started_at
        if (!dispatchId || !startedAtIso) return null
        const startedAt = new Date(startedAtIso)
        if (Number.isNaN(startedAt.getTime())) return null
        return { dispatchId, startedAt }
      } catch {
        return null
      }
    },
    // WS M — when attribution is known, sum only files whose mtime is
    // at-or-after the dispatch start time. This filters out staged work
    // authored by earlier sessions / other dispatches against the same
    // working_dir. When attribution is null, fall back to the WS H
    // degraded total (sum of all staged numstat in the working_dir).
    getDispatchDiffBytes: (sessionId, attribution) => {
      try {
        const row = db.prepare(`SELECT working_dir FROM sessions WHERE id = ?`).get(sessionId) as
          | { working_dir?: string | null }
          | undefined
        const cwd = row?.working_dir
        if (!cwd) return 0
        if (attribution) {
          // Strict path: enumerate staged files, keep only those with
          // mtime >= dispatch.startedAt, then sum numstat for that subset.
          const namesResult = spawnSync('git', ['-C', cwd, 'diff', '--cached', '--name-only'], {
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
          })
          if (namesResult.status !== 0 || !namesResult.stdout) return 0
          const cutoff = attribution.startedAt.getTime()
          const attributable = new Set<string>()
          for (const rel of namesResult.stdout
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)) {
            try {
              const stat = statSync(pathJoin(cwd, rel))
              if (stat.mtime.getTime() >= cutoff) attributable.add(rel)
            } catch {
              // file may be staged-deletion; skip
            }
          }
          if (attributable.size === 0) return 0
          const numstatResult = spawnSync('git', ['-C', cwd, 'diff', '--cached', '--numstat'], {
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
          })
          if (numstatResult.status !== 0 || !numstatResult.stdout) return 0
          let total = 0
          for (const line of numstatResult.stdout.split('\n')) {
            const parts = line.trim().split(/\s+/)
            if (parts.length < 3) continue
            const file = parts.slice(2).join(' ')
            if (!attributable.has(file)) continue
            const added = Number(parts[0])
            const deleted = Number(parts[1])
            if (Number.isFinite(added)) total += added
            if (Number.isFinite(deleted)) total += deleted
          }
          return total
        }
        // Legacy WS H fallback: total all staged numstat with no per-file
        // mtime filter. Used when a dispatch_started event is not present
        // (older auto-dispatches, manual spawns, etc.).
        const result = spawnSync('git', ['-C', cwd, 'diff', '--cached', '--numstat'], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        })
        if (result.status !== 0 || !result.stdout) return 0
        let total = 0
        for (const line of result.stdout.split('\n')) {
          const parts = line.trim().split(/\s+/)
          if (parts.length < 2) continue
          const added = Number(parts[0])
          const deleted = Number(parts[1])
          if (Number.isFinite(added)) total += added
          if (Number.isFinite(deleted)) total += deleted
        }
        return total
      } catch {
        return 0
      }
    },
    // WS Q (Phase 13.13.x) — turn-end-anchored numstat reader. Runs
    // `git diff --cached --numstat -z` against workingDir and parses
    // with parseNumstatZ for atomic, NUL-terminated, rename-safe output.
    // The monitor calls this only on the dev_turn_ended ingress path —
    // there is no setInterval / setTimeout driving diff sampling.
    getStagedNumstat: (workingDir) => {
      try {
        const result = spawnSync('git', ['-C', workingDir, 'diff', '--cached', '--numstat', '-z'], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        })
        if (result.status !== 0 || !result.stdout) {
          return { entries: [], totalLines: 0 }
        }
        return parseNumstatZ(result.stdout)
      } catch {
        return { entries: [], totalLines: 0 }
      }
    },
  })
  devProductivityMonitorRef = devProductivityMonitor

  // WS Q (Phase 13.13.x) — subscribe handleDevTurnEnded to dev_turn_ended
  // events emitted by agent-spawner after each ACP `sendPrompt` resolution
  // on dispatch-attributed dev sessions. Sampling at turn-end (never on a
  // timer) is the WS-N race fix.
  if (typeof dispatcher.subscribe === 'function') {
    dispatcher.subscribe({ event_types: ['dev_turn_ended'] }, (evt) => {
      try {
        const payload = JSON.parse(evt.payload) as {
          dispatch_id?: string
          session_id?: string
          team_id?: string | null
          task_id?: number | null
          working_dir?: string
          stop_reason?: string | null
          ended_at?: string
          staged_diff_detected?: boolean
        }
        const sessionId = payload.session_id ?? evt.session_id
        const dispatchId = payload.dispatch_id
        const workingDir = payload.working_dir
        if (!sessionId || !dispatchId || !workingDir) return
        devProductivityMonitor.handleDevTurnEnded({
          sessionId,
          dispatchId,
          teamId: payload.team_id ?? null,
          taskId: typeof payload.task_id === 'number' ? payload.task_id : null,
          workingDir,
          stopReason: payload.stop_reason ?? null,
          endedAt: payload.ended_at ? new Date(payload.ended_at) : new Date(),
          stagedDiffDetected:
            typeof payload.staged_diff_detected === 'boolean'
              ? payload.staged_diff_detected
              : undefined,
        })
      } catch {
        /* never let a malformed payload kill the broker */
      }
    })

    // WS R (Phase 13.13.x) — gate-driven task completion. Subscribe to
    // every `quality_gate_verdict` event. On a passing verdict for a
    // WS-P-attributed task, the broker itself transitions the task to
    // status='completed' and emits a `task_completed` audit event. The
    // status-guarded UPDATE in completeTaskBySystem is idempotent, so
    // a flaky verdict bus that fires twice is safe.
    dispatcher.subscribe({ event_types: ['quality_gate_verdict'] }, (evt) => {
      try {
        const payload = JSON.parse(evt.payload) as {
          team_id?: string
          passed?: boolean
          qualityCheckId?: string | null
        }
        handleQualityGateVerdictForTaskCompletion({
          db,
          eventLog,
          gitDiffChecker: realGitDiffChecker,
          verdict: {
            team_id: payload.team_id,
            passed: payload.passed,
            qualityCheckId: payload.qualityCheckId ?? null,
          },
        })
      } catch {
        /* never let a malformed payload kill the broker */
      }
    })
  }

  // 5b. Team reaper — periodically archives empty/orphan teams.
  //     F6: supply a getActiveTeamIds probe so teams with live ACP members
  //     in the spawner's map are exempted from archival, even if the SQL
  //     heuristics think they're idle.
  //     Task 43: onTeamArchived hook reclaims the worktree sandbox on
  //     archival. Manager itself rejects non-UUID / external / live-member
  //     paths internally, so the wiring is a thin pass-through.
  const teamReaper = createTeamReaper({
    db,
    eventLog,
    options: {
      graceMs: cfg.teamReaperGraceMs,
      intervalMs: cfg.teamReaperIntervalMs,
      exemptionMaxAgeMs: cfg.teamReaperExemptionMaxAgeMs,
      getActiveTeamIds: () => {
        const ids = new Set<string>()
        for (const info of agentSpawner.getActiveAgents().values()) {
          ids.add(info.teamId)
        }
        return ids
      },
      onTeamArchived: (teamId: string) => worktreeManager.removeWorktreeForTeam(teamId),
    },
  })
  if (cfg.teamReaperEnabled) {
    teamReaper.start()
    log.info(
      { intervalMs: cfg.teamReaperIntervalMs, graceMs: cfg.teamReaperGraceMs },
      'Team reaper started',
    )
  } else {
    log.info('Team reaper disabled via BROKER_TEAM_REAPER_ENABLED=false')
  }

  // WS-S meta-fix: team-task-autospawner closes the dogfood loop by
  // auto-spawning a scns-manager when a team has a pending unowned task
  // and no active manager session. Without it, every task requires a
  // human to call POST /api/tasks/:id/spawn before any dispatch starts.
  const teamTaskAutospawner = createTeamTaskAutospawner(
    {
      db,
      agentSpawner,
      logger: {
        info: (msg, fields) => log.info(fields ?? {}, msg),
        warn: (msg, fields) => log.warn(fields ?? {}, msg),
        error: (msg, fields) => log.error(fields ?? {}, msg),
      },
    },
    {
      enabled: cfg.autospawn?.enabled ?? false,
      intervalMs: cfg.autospawn?.intervalMs ?? 30_000,
      cooldownMs: cfg.autospawn?.cooldownMs ?? 300_000,
      workingDir: cfg.projectRoot,
      projectId: cfg.projectId,
    },
  )
  if (cfg.autospawn?.enabled ?? false) {
    teamTaskAutospawner.start()
    log.info(
      {
        intervalMs: cfg.autospawn?.intervalMs ?? 30_000,
        cooldownMs: cfg.autospawn?.cooldownMs ?? 300_000,
      },
      'Team task autospawner started',
    )
  } else {
    log.info(`Team task autospawner ${unattendedStatusDetail('team-task-autospawner')}`)
  }

  // Periodic backlog tick — uses heartbeatIntervalMs for cadence.
  const backlogTickMs = Math.max(5_000, Math.min(cfg.heartbeatIntervalMs, 30_000))
  const backlogTimer = setInterval(() => {
    teamLifecycle.tickBacklog().catch((err) => {
      log.warn({ err }, 'Team lifecycle backlog tick failed')
    })
  }, backlogTickMs)
  backlogTimer.unref?.()

  // 6. Create rate monitor + team orchestrator (A2A coordination)
  const rateMonitor = createRateMonitor()

  // Cache the team-existence check as a prepared statement. The orchestrator
  // calls `onSpawn` per zombie respawn, so we want this hot path to skip the
  // SQL parser. The check is the defensive layer that prevents the historical
  // FK loop (see `auto-scaler bug` memory): when a team has been archived or
  // disbanded between zombie detection and respawn — for example after a
  // sleep-induced catch-up burst — we must NOT attempt the spawn, because
  // `team_members.team_id` would FK-fail and saturate the event loop.
  const teamActiveStmt = db.prepare(
    `SELECT 1 FROM teams WHERE id = ? AND status = 'active' AND archived_at IS NULL`,
  )

  const orchestrator = createTeamOrchestrator({
    rateMonitor,
    onSpawn: async (opts) => {
      if (!opts.teamId) {
        log.warn(
          { role: opts.role },
          'Spawn requested without teamId — skipping (no team context available)',
        )
        return null
      }
      const teamActive = teamActiveStmt.get(opts.teamId)
      if (!teamActive) {
        log.warn(
          { teamId: opts.teamId, role: opts.role },
          'Spawn requested for unknown or inactive team — skipping',
        )
        return null
      }
      const result = await agentSpawner.spawn({
        team_id: opts.teamId,
        name: `${opts.role}-${Date.now()}`,
        role: opts.role,
        prompt: opts.context ?? `You are a ${opts.role} agent.`,
        launch_method: 'detached',
      })
      return result.sessionId
    },
    onKill: async (sessionId: string) => {
      await agentSpawner.cleanup(sessionId)
    },
  })

  // 7. Start heartbeat poller (use zombieGraceMs, NOT heartbeatTimeoutMs)
  //    Wire onZombieDetected BEFORE deletion so respawn has team/role data
  const heartbeatPoller = startHeartbeatPoller(db, eventLog, {
    intervalMs: cfg.heartbeatIntervalMs,
    graceSeconds: Math.floor(cfg.zombieGraceMs / 1000),
    onZombieDetected: (dead) => {
      if (!dead.teamId) return
      orchestrator.respawnDeadAgent(dead).catch((err) => {
        log.warn({ err, sessionId: dead.sessionId }, 'Failed to respawn dead agent')
      })
    },
  })

  // 8. Create broker server
  const shutdownManager = new ShutdownManager()
  const broker = createBrokerServer(db, eventLog, shutdownManager, dispatcher, {
    handleSessionEvent,
    agentSpawner,
    orchestrator,
    rateMonitor,
    rotationController,
    compactionDetector,
    costTracker,
    sentimentAnalyzer,
    negativeMemoryStore,
    onSessionCompleted,
    secretStore,
    internalToken,
    gitDiffChecker: realGitDiffChecker,
    projectId: cfg.projectId,
    safetyKernel,
  })

  // 9. Start listening. Under launchd socket activation (zero-downtime restart)
  //    SCNS_LISTEN_FD carries a launchd-held listening socket — listen on it so
  //    the kernel queues connections across a `kickstart -k` restart. Otherwise
  //    bind the port with EADDRINUSE retry (dev / canary / tests).
  let server: Server
  const listenFd = parseListenFd(process.env['SCNS_LISTEN_FD'])
  try {
    if (listenFd !== null) {
      server = await listenOnFd((handle) => broker.app.listen(handle), listenFd)
      logger.info({ fd: listenFd, port: cfg.port }, 'Broker listening on launchd socket (fd)')
    } else {
      server = await listenWithRetry((port) => broker.app.listen(port, cfg.bind), cfg.port, {
        maxRetries: 3,
        baseDelayMs: 2000,
        // Supervisor-spawned children run with BROKER_LISTEN_KILL_STALE=false:
        // the supervisor owns port assignment, so on EADDRINUSE the child must
        // fail (and be reallocated) rather than kill the port's rightful owner.
        killStale: process.env['BROKER_LISTEN_KILL_STALE'] !== 'false',
      })
      logger.info({ port: cfg.port, bind: cfg.bind }, 'Broker listening')
    }
    eventLog.brokerStarted({ port: cfg.port })
    // #61 — record our pid so a supervisor on a platform with no service
    // manager can stop a HUNG broker before spawning its replacement. Node has
    // no portable port→pid lookup, and launchd/systemd never needed one.
    // Best-effort: a missing pidfile degrades to "nothing to stop".
    writeBrokerPidfile(brokerPidfilePath(resolveScnsHome(), cfg.port), {
      pid: process.pid,
      port: cfg.port,
      startedAt: Date.now(),
      execPath: process.execPath,
    })
  } catch (err) {
    // Clean up partially-started resources on bind failure
    heartbeatPoller.stop()
    sessionDiscovery.stop()
    closeDatabase(db)
    throw err
  }

  // 7. DB integrity check — opt-in via BROKER_STARTUP_INTEGRITY_CHECK=1.
  //    Disabled by default: pragma('integrity_check') on a multi-GB database
  //    blocks the event loop for 30-90s, making the broker unresponsive for
  //    minutes after listen. The health-watchdog polls DB health every 60s
  //    on a live connection, so corruption is still detected post-startup.
  //    (Phase 13.9.4)
  if (process.env['BROKER_STARTUP_INTEGRITY_CHECK'] === '1') {
    setImmediate(() => {
      const t0 = Date.now()
      try {
        const integrityResult = db.pragma('integrity_check') as Array<{ integrity_check: string }>
        const elapsed = Date.now() - t0
        if (integrityResult[0]?.integrity_check !== 'ok') {
          log.error(
            { result: integrityResult, elapsedMs: elapsed },
            'Database integrity check FAILED',
          )
        } else {
          log.info({ elapsedMs: elapsed }, 'Database integrity check passed')
        }
      } catch (err) {
        log.error({ err, elapsedMs: Date.now() - t0 }, 'Database integrity check error')
      }
    })
  }

  // 8. Start health watchdog. On sustained critical failure the `onUnhealthy`
  //    callback hands off to `triggerSelfHeal` (defined after `stop` below),
  //    which drains and exit(1)s so launchd KeepAlive relaunches a fresh
  //    process. Forward-declared because the trigger needs `stop`.
  //
  //    Thresholds are env-tunable so operators can make self-heal more or less
  //    aggressive (and so it can be exercised in a controlled live test)
  //    without a code change. Defaults preserve prior behaviour.
  const envInt = (name: string, fallback: number): number => {
    const raw = process.env[name]
    if (raw === undefined || raw === '') return fallback
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  const healthIntervalMs = envInt('SCNS_BROKER_HEALTH_INTERVAL_MS', 60_000)
  const healthMaxRssMb = envInt('SCNS_BROKER_MAX_RSS_MB', 1536)
  const selfHealMinFailures = envInt('SCNS_BROKER_SELF_HEAL_MIN_FAILURES', 5)
  const selfHealCooldownMs = envInt('SCNS_BROKER_SELF_HEAL_COOLDOWN_MS', 10 * 60_000)

  let triggerSelfHeal: (failures: number, checks: readonly HealthCheck[]) => void = () => {}
  const healthWatchdog = createHealthWatchdog(db, {
    intervalMs: healthIntervalMs,
    maxConsecutiveFailures: 3,
    maxMemoryMb: healthMaxRssMb,
    onUnhealthy: (failures, checks) => {
      log.error(
        { failures, unhealthy: checks.filter((c) => !c.healthy).map((c) => c.name) },
        'Health watchdog: broker critically unhealthy',
      )
      triggerSelfHeal(failures, checks)
    },
  })
  healthWatchdog.start()

  // 9. Create task scheduler (started later via startScheduler after handlers are registered)
  const taskHandlers = new Map<string, TaskHandler>()
  const scheduler = createTaskScheduler(db, taskHandlers, { intervalMs: 60_000 })

  // 10. Register shutdown handlers (order matters!)
  // Snapshot agents FIRST (before spawner cleanup destroys them)
  shutdownManager.register('recovery-snapshots', async () => {
    try {
      const activeAgents = agentSpawner.getActiveAgents()
      if (activeAgents.size > 0) {
        const getSession = db.prepare('SELECT working_dir FROM sessions WHERE id = ?')
        const agentInfos = [...activeAgents.entries()].map(([sessionId, info]) => {
          const session = getSession.get(sessionId) as { working_dir: string | null } | undefined
          return {
            sessionId,
            teamId: info.teamId ?? 'default',
            name: info.name ?? 'agent',
            role: info.role ?? 'general',
            launchMethod: info.launchMethod,
            workingDir: session?.working_dir ?? cfg.projectRoot,
          }
        })
        snapshotActiveAgents(db, agentInfos)
        log.info({ count: agentInfos.length }, 'Snapshotted active agents for recovery')
      }
    } catch (err) {
      log.warn({ err }, 'Failed to snapshot agents for recovery')
    }
  })

  shutdownManager.register('team-lifecycle', async () => {
    clearInterval(backlogTimer)
    teamLifecycle.stop()
  })

  shutdownManager.register('team-reaper', async () => {
    teamReaper.stop()
  })

  shutdownManager.register('team-task-autospawner', async () => {
    teamTaskAutospawner.stop()
  })

  // Task 26 — perpetual self-improvement loop. Subscribes to
  // `quality_gate_verdict` and, for teams whose name starts with
  // `scns-self-improve`, auto-creates a postmortem follow-up task that
  // the team-task-autospawner picks up on its next tick. Closes the
  // gap where managers run one ACP turn and exit (non-nudge-role).
  // Opt-IN (#53 AC4) — it feeds the autospawner, which spends credits:
  // set BROKER_SELF_IMPROVE_FOLLOWUPS=1 (or SCNS_UNATTENDED=1).
  const selfImproveFollowupsEnabled = isUnattendedEnabled('self-improve-followups')
  const selfImproveFollowupCreator = createSelfImproveFollowupCreator({
    db,
    dispatcher,
    options: {
      logger: {
        info: (msg, fields) => log.info(fields ?? {}, msg),
        warn: (msg, fields) => log.warn(fields ?? {}, msg),
      },
    },
  })
  if (selfImproveFollowupsEnabled) {
    selfImproveFollowupCreator.start()
    log.info('Self-improve follow-up creator started')
  } else {
    log.info(`Self-improve follow-up creator ${unattendedStatusDetail('self-improve-followups')}`)
  }
  shutdownManager.register('self-improve-followup-creator', async () => {
    selfImproveFollowupCreator.stop()
  })

  shutdownManager.register('agent-spawner', async () => {
    await agentSpawner.shutdownAll()
  })

  shutdownManager.register('task-scheduler', async () => {
    scheduler.stop()
  })

  shutdownManager.register('health-watchdog', async () => {
    healthWatchdog.stop()
  })

  shutdownManager.register('heartbeat-poller', async () => {
    heartbeatPoller.stop()
  })

  shutdownManager.register('session-discovery', async () => {
    sessionDiscovery.stop()
  })

  shutdownManager.register('broker-server', async () => {
    await broker.close()
  })

  shutdownManager.register('http-server', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  // #61 — drop the pidfile last-but-one, so a supervisor polling during the
  // drain still sees the pid it may need to stop. A crash skips this; that is
  // what readLiveBrokerPid's stale-file cleanup is for.
  shutdownManager.register('broker-pidfile', async () => {
    removeBrokerPidfile(brokerPidfilePath(resolveScnsHome(), cfg.port))
  })

  // Drop the FastEmbed/ONNX singleton BEFORE we close the database. This lets
  // V8 finalize the JS reference graph for the inference session while libuv
  // still has its native worker threads alive in a known state — which avoids
  // the libc++abi "mutex lock failed: Invalid argument" abort observed during
  // the 2026-04-22 soak (native destructors racing pthread teardown at
  // process exit). Cheap if the embedder was never initialized.
  shutdownManager.register('reset-embeddings', async () => {
    const { resetEmbeddingClient } = await import('../memory/embeddings.js')
    await resetEmbeddingClient()
  })

  shutdownManager.register('database', async () => {
    closeDatabase(db)
  })

  const stop = async (): Promise<void> => {
    eventLog.brokerStopped({ port: cfg.port })
    await shutdownManager.shutdown()
  }

  // Self-heal: when the watchdog reports sustained critical failure, drain
  // gracefully then exit(1) so the supervisor relaunches a fresh process.
  //
  // #61 — that last clause is a CONTRACT, not a given. `createSelfHealTrigger`
  // refuses to arm when no relaunch substrate exists (Windows with no
  // supervisor), because an exit into the void is strictly worse than never
  // self-healing: the health watchdog keeps observing either way, but nothing
  // would bring the broker back. Otherwise unchanged — gated by `decideSelfHeal`
  // (consecutive-failure threshold + persisted cooldown + bounded escalation +
  // shared_state kill-switch) and the `SCNS_BROKER_SELF_HEAL` env override.
  const selfHeal = createSelfHealTrigger({
    db,
    platform: process.platform,
    env: process.env,
    drain: stop,
    exit: (code) => process.exit(code),
    stopWatchdog: () => healthWatchdog.stop(),
    log: {
      info: (fields, msg) => log.info(fields, msg),
      warn: (fields, msg) => log.warn(fields, msg),
      error: (fields, msg) => log.error(fields, msg),
    },
    minFailures: selfHealMinFailures,
    cooldownMs: selfHealCooldownMs,
  })
  triggerSelfHeal = selfHeal.trigger
  log.info(
    { armed: selfHeal.armed, reason: selfHeal.arming.reason },
    `Self-heal ${selfHeal.armed ? 'armed' : 'disarmed'} — ${describeSupervision(
      detectSupervision({ platform: process.platform, env: process.env }),
    )}`,
  )

  // Handle process signals
  const onSignal = () => {
    stop().catch((err) => {
      log.error({ err }, 'Shutdown error')
    })
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  // 8. Session recovery — attempt to respawn agents from pre-restart snapshots.
  //    F3: detect crash loops (two startups within 60s) and hard-disable
  //    recovery until the operator clears the flag. F4: bounded fan-out
  //    with an early-stop when the spawner reaches half-capacity.
  const previousStartupMs = recordBrokerStartup(db)
  const crashLooping = crashLoopDetectedOnStartup(db, previousStartupMs)
  // If the previous shutdown was a self-heal restart driven by memory pressure,
  // don't rehydrate agents — respawning them risks re-bloating immediately and
  // defeating the heal. One-shot: consumeLastExitReason clears the flag.
  const lastExitReason = consumeLastExitReason(db)
  const selfHealMemoryExit =
    lastExitReason !== null &&
    lastExitReason.startsWith('self_heal:') &&
    lastExitReason.includes('memory')
  if (enableRecovery !== false && !crashLooping && !selfHealMemoryExit) {
    try {
      // Expire stale snapshots older than RECOVERY_SNAPSHOT_MAX_AGE_HOURS (1h).
      // Previous 1-day TTL produced too large a replay blast radius under
      // auto-restart cycling.
      const expired = expireOldSnapshotsHours(db, RECOVERY_SNAPSHOT_MAX_AGE_HOURS)
      if (expired > 0) {
        log.info(
          { expired, ttlHours: RECOVERY_SNAPSHOT_MAX_AGE_HOURS },
          'Expired old recovery snapshots',
        )
      }

      const pendingSnapshots = loadPendingSnapshots(db)
      if (pendingSnapshots.length > 0) {
        log.info(
          { count: pendingSnapshots.length },
          'Found pending recovery snapshots — attempting agent recovery',
        )
        // Fire-and-forget recovery — don't block startup. F4: supply a
        // capacityProbe so recovery backs off when the spawner is half-full.
        recoverAgents(db, (input) => agentSpawner.spawn(input), pendingSnapshots, {
          capacityProbe: {
            getActiveCount: () => agentSpawner.getSpawnStats().activeCount,
            getMaxConcurrent: () => agentSpawner.getSpawnStats().maxConcurrent,
          },
        })
          .then((results) => {
            const succeeded = results.filter((r) => r.success).length
            const failed = results.filter((r) => !r.success).length
            log.info({ succeeded, failed, total: results.length }, 'Session recovery complete')
          })
          .catch((err) => {
            log.error({ err }, 'Session recovery failed')
          })
      }
    } catch (err) {
      log.error({ err }, 'Recovery snapshot check failed')
    }
  } else if (crashLooping) {
    log.warn('Session recovery skipped: crash-loop detected (broker:recovery_hard_disabled set)')
  } else if (selfHealMemoryExit) {
    log.warn(
      { lastExitReason },
      'Session recovery skipped: previous exit was a self-heal memory restart — not rehydrating agents to avoid re-bloat',
    )
  }

  const registerTaskHandler = (taskId: string, handler: TaskHandler): void => {
    scheduler.registerHandler(taskId, handler)
  }

  const startScheduler = (): void => {
    scheduler.start()
  }

  const runScheduledTask = (taskId: string): Promise<'ran' | 'no-task' | 'no-handler'> =>
    scheduler.runNow(taskId)

  return {
    server,
    broker,
    db,
    stop,
    agentSpawner,
    orchestrator,
    teamLifecycle,
    teamReaper,
    eventLog,
    dispatcher,
    registerTaskHandler,
    startScheduler,
    runScheduledTask,
  }
}
