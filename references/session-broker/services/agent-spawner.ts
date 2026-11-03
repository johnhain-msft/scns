import { spawn as nodeSpawn, execSync as nodeExecSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { EventLog } from './event-log.js'
import {
  detectPlatform as defaultDetectPlatform,
  findCli as defaultFindCli,
  isTmuxAvailable as defaultIsTmuxAvailable,
  toWslPath,
} from './platform.js'
import type { Platform, CliInfo } from './platform.js'
import { buildAgentPrompt } from './prompt-builder.js'
import { createSession, deleteSession } from '../storage/repositories/session-repository.js'
import { addTeamMember, removeTeamMember } from '../storage/repositories/team-repository.js'
import { releaseIntentsBySession } from '../storage/repositories/intent-repository.js'
import { updateHeartbeat } from '../storage/repositories/session-repository.js'
import { deleteMessagesBySession } from '../storage/repositories/message-repository.js'

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
}

export interface SpawnResult {
  readonly sessionId: string
  readonly teamId: string
  readonly name: string
  readonly role: string
  readonly platform: Platform
  readonly launchMethod: 'tmux' | 'detached'
  readonly pid: number | null
  readonly tmuxSession: string | null
  readonly tmuxWindow: string | null
}

export interface SpawnedAgentInfo {
  readonly sessionId: string
  readonly teamId: string
  readonly name: string
  readonly role: string
  readonly pid: number | null
  readonly launchMethod: 'tmux' | 'detached'
  readonly startedAt: string
}

export interface AgentSpawner {
  spawn(input: SpawnInput): Promise<SpawnResult>
  getActiveAgents(): ReadonlyMap<string, SpawnedAgentInfo>
  cleanup(sessionId: string): void
  shutdownAll(): void
}

export interface SpawnerDeps {
  readonly detectPlatform: () => Platform
  readonly findCli: (platform: Platform) => CliInfo | null
  readonly isTmuxAvailable: () => boolean
  readonly spawnProcess: typeof import('node:child_process').spawn
  readonly execSync: typeof import('node:child_process').execSync
}

export interface AgentSpawnerOptions {
  readonly brokerUrl?: string
  readonly heartbeatMs?: number
  readonly workingDir?: string
  readonly deps?: Partial<SpawnerDeps>
}

interface InternalAgentEntry extends SpawnedAgentInfo {
  readonly heartbeatTimer: NodeJS.Timeout
  readonly process: ChildProcess | null
}

const DEFAULT_BROKER_URL = 'http://localhost:3456'
const DEFAULT_HEARTBEAT_MS = 25_000

export function createAgentSpawner(
  db: Database.Database,
  eventLog: EventLog,
  options?: AgentSpawnerOptions,
): AgentSpawner {
  const brokerUrl = options?.brokerUrl ?? DEFAULT_BROKER_URL
  const heartbeatMs = options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const workingDir = options?.workingDir ?? process.cwd()

  const deps: SpawnerDeps = {
    detectPlatform: options?.deps?.detectPlatform ?? defaultDetectPlatform,
    findCli: options?.deps?.findCli ?? defaultFindCli,
    isTmuxAvailable: options?.deps?.isTmuxAvailable ?? defaultIsTmuxAvailable,
    spawnProcess: options?.deps?.spawnProcess ?? nodeSpawn,
    execSync: options?.deps?.execSync ?? nodeExecSync,
  }

  const activeAgents = new Map<string, InternalAgentEntry>()

  function cleanupSession(sessionId: string): void {
    const entry = activeAgents.get(sessionId)
    if (!entry) return

    clearInterval(entry.heartbeatTimer)

    if (entry.process && !entry.process.killed) {
      try { entry.process.kill('SIGTERM') } catch { /* already dead */ }
    }

    try { deleteMessagesBySession(db, sessionId) } catch { /* best effort */ }
    try { releaseIntentsBySession(db, sessionId) } catch { /* best effort */ }
    try { removeTeamMember(db, entry.teamId, sessionId) } catch { /* best effort */ }
    try {
      deleteSession(db, sessionId)
      eventLog.sessionDeregistered(sessionId, { reason: 'cleanup' })
    } catch { /* best effort */ }

    activeAgents.delete(sessionId)
  }

  function permissionFlags(mode: PermissionMode): ReadonlyArray<string> {
    switch (mode) {
      case 'none': return []
      case 'default': return ['--allow-all-tools', '--allow-all-paths']
      case 'all': return ['--yolo']
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
  ): ChildProcess {
    const logDir = path.join(cwd, '.github', 'logs')
    try { mkdirSync(logDir, { recursive: true }) } catch { /* exists */ }
    const logFile = path.join(logDir, `agent-${sessionId}.log`)
    const logStream = createWriteStream(logFile, { flags: 'a' })

    const child = deps.spawnProcess(cli.command, [...args], {
      cwd,
      detached: true,
      stdio: ['ignore', logStream, logStream],
    })
    child.unref()

    return child
  }

  function launchTmux(
    cli: CliInfo,
    args: ReadonlyArray<string>,
    teamId: string,
    name: string,
    cwd: string,
  ): { tmuxSession: string; tmuxWindow: string } {
    const tmuxSession = `agents-${teamId.slice(0, 8)}`
    const tmuxWindow = `agent-${name}`

    // Write command to temp script to avoid shell escaping issues with complex prompts.
    // Prompts contain newlines, parentheses, quotes, etc. that break /bin/sh parsing
    // when passed directly to tmux. A temp script file avoids all escaping problems.
    const scriptPath = path.join(tmpdir(), `agent-${name}-${Date.now()}.sh`)
    const quotedArgs = args.map(shellQuote).join(' ')
    const normalizedCwd = toWslPath(cwd)
    writeFileSync(scriptPath, `#!/bin/sh\ncd ${shellQuote(normalizedCwd)}\nexec ${cli.command} ${quotedArgs}\n`, { mode: 0o755 })

    try {
      // Check if tmux session exists
      deps.execSync(`tmux has-session -t "${tmuxSession}" 2>/dev/null`)
      // Session exists, create new window
      deps.execSync(
        `tmux new-window -t "${tmuxSession}" -n "${tmuxWindow}" "${scriptPath}"`
      )
    } catch {
      // Session doesn't exist, create it
      deps.execSync(
        `tmux new-session -d -s "${tmuxSession}" -n "${tmuxWindow}" "${scriptPath}"`
      )
    }

    return { tmuxSession, tmuxWindow }
  }

  return {
    async spawn(input: SpawnInput): Promise<SpawnResult> {
      const platform = deps.detectPlatform()
      const cli = deps.findCli(platform)
      if (!cli) {
        throw new Error(
          'No compatible AI CLI found. Install copilot or claude CLI.'
        )
      }

      const role = input.role ?? 'dev'
      const agent = input.agent ?? 'teammate'
      const resolvedWorkingDir = input.working_dir ?? workingDir
      const sessionId = `${input.team_id.slice(0, 8)}-${input.name}-${Date.now()}`
      const purpose = `${role} agent for team ${input.team_id}: ${input.prompt ?? 'no specific task'}`

      // Register session in-process
      createSession(db, {
        id: sessionId,
        purpose,
        working_dir: resolvedWorkingDir,
        worktree: null,
      })
      eventLog.sessionRegistered(sessionId, {
        team_id: input.team_id,
        name: input.name,
        role,
      })

      // Add as team member
      addTeamMember(db, {
        team_id: input.team_id,
        session_id: sessionId,
        name: input.name,
        role,
        agent_type: agent,
      })
      eventLog.teamMemberJoined(sessionId, {
        team_id: input.team_id,
        name: input.name,
        role,
      })

      // Build prompt
      const prompt = buildAgentPrompt({
        sessionId,
        teamId: input.team_id,
        name: input.name,
        role,
        brokerUrl,
        workingDir: resolvedWorkingDir,
        customPrompt: input.prompt,
      })

      const permissions = input.permissions ?? 'default'
      const cliArgs = buildCliArgs(agent, prompt, permissions)
      const useTmux = deps.isTmuxAvailable()

      let childProcess: ChildProcess | null = null
      let tmuxSession: string | null = null
      let tmuxWindow: string | null = null
      let launchMethod: 'tmux' | 'detached' = 'detached'

      try {
        if (useTmux) {
          const tmuxInfo = launchTmux(cli, cliArgs, input.team_id, input.name, resolvedWorkingDir)
          tmuxSession = tmuxInfo.tmuxSession
          tmuxWindow = tmuxInfo.tmuxWindow
          launchMethod = 'tmux'
        } else {
          childProcess = launchDetached(cli, cliArgs, sessionId, resolvedWorkingDir)
          launchMethod = 'detached'
        }
      } catch (err) {
        // Spawn failed — clean up registration
        try { removeTeamMember(db, input.team_id, sessionId) } catch { /* */ }
        try { deleteSession(db, sessionId) } catch { /* */ }
        throw err
      }

      // Start heartbeat
      const heartbeatTimer = setInterval(() => {
        try {
          updateHeartbeat(db, sessionId)
        } catch {
          // DB closed or session deleted — stop heartbeat
          clearInterval(heartbeatTimer)
        }
      }, heartbeatMs)

      // Auto-cleanup on process exit (for detached launches)
      if (childProcess) {
        childProcess.on('exit', () => {
          cleanupSession(sessionId)
        })
      }

      const entry: InternalAgentEntry = {
        sessionId,
        teamId: input.team_id,
        name: input.name,
        role,
        pid: childProcess?.pid ?? null,
        launchMethod,
        startedAt: new Date().toISOString(),
        heartbeatTimer,
        process: childProcess,
      }
      activeAgents.set(sessionId, entry)

      return {
        sessionId,
        teamId: input.team_id,
        name: input.name,
        role,
        platform,
        launchMethod,
        pid: childProcess?.pid ?? null,
        tmuxSession,
        tmuxWindow,
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
        })
      }
      return snapshot
    },

    cleanup(sessionId: string): void {
      cleanupSession(sessionId)
    },

    shutdownAll(): void {
      const ids = [...activeAgents.keys()]
      for (const id of ids) {
        cleanupSession(id)
      }
    },
  }
}
