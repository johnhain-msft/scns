import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import type { AgentSpawner } from '../services/agent-spawner.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NAME_RE = /^[a-zA-Z0-9][-a-zA-Z0-9]*$/
const VALID_ROLES = ['lead', 'dev', 'qa', 'reviewer', 'general', 'manager', 'pm', 'scrum-master'] as const

function runScript(
  scriptPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(scriptPath, args, { cwd: process.cwd(), timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export interface SpawnAgentInput {
  readonly team_id: string
  readonly name: string
  readonly role?: string
  readonly prompt?: string
  readonly agent?: string
  readonly permissions?: 'none' | 'default' | 'all'
  readonly working_dir?: string
}

export async function handleSpawnAgent(
  _db: Database.Database,
  _eventLog: EventLog,
  input: SpawnAgentInput,
  spawner?: AgentSpawner,
): Promise<ToolResult> {
  // Validate input (runs before either path)
  if (!UUID_RE.test(input.team_id)) {
    return errorResult(
      `Invalid team_id: expected UUID (e.g. 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'), got '${input.team_id}'`,
    )
  }

  if (!NAME_RE.test(input.name)) {
    return errorResult(`Invalid name: must be alphanumeric with hyphens, got '${input.name}'`)
  }

  const role = input.role ?? 'dev'
  if (!VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
    return errorResult(`Invalid role '${role}'. Must be one of: ${VALID_ROLES.join(', ')}`)
  }

  // Use in-process spawner when available (cross-platform)
  if (spawner) {
    try {
      const result = await spawner.spawn({
        team_id: input.team_id,
        name: input.name,
        role,
        prompt: input.prompt,
        agent: input.agent,
        permissions: input.permissions,
        working_dir: input.working_dir,
      })
      return textResult({
        spawned: true,
        session_id: result.sessionId,
        team_id: result.teamId,
        name: result.name,
        role: result.role,
        platform: result.platform,
        launch_method: result.launchMethod,
        ...(result.pid ? { pid: result.pid } : {}),
        ...(result.tmuxSession ? { tmux_session: result.tmuxSession } : {}),
        ...(result.tmuxWindow ? { tmux_window: result.tmuxWindow } : {}),
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return errorResult(`Failed to spawn agent '${input.name}': ${message}`)
    }
  }

  // Fallback: shell script path (legacy, Linux-only)
  const scriptPath = path.join(process.cwd(), 'scripts', 'spawn-agent.sh')

  if (!existsSync(scriptPath)) {
    return errorResult(`Spawn script not found at ${scriptPath}`)
  }

  const args: string[] = [
    '--team', input.team_id,
    '--name', input.name,
    '--role', role,
    '--permissions', 'all',
  ]

  if (input.prompt) {
    args.push('--prompt', input.prompt)
  }

  if (input.agent) {
    args.push('--agent', input.agent)
  }

  try {
    const { stdout, stderr } = await runScript(scriptPath, args)

    const sessionIdMatch = stdout.match(/SESSION_ID=(.+)/)
    const sessionId = sessionIdMatch ? sessionIdMatch[1].trim() : 'unknown'

    return textResult({
      spawned: true,
      session_id: sessionId,
      team_id: input.team_id,
      name: input.name,
      role,
      output: stdout.trim(),
      ...(stderr.trim() ? { warnings: stderr.trim() } : {}),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return errorResult(`Failed to spawn agent '${input.name}': ${message}`)
  }
}
