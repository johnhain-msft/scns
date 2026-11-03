/**
 * Brain Spawn Adapter — bridges brain's onSpawnAgent callback to the
 * agent spawner with proper defaults, team management, and fallback.
 *
 * v1: solo spawn only. Team fan-out deferred.
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AgentSpawner, SpawnInput } from '../broker/services/agent-spawner.js'
import { logger } from '../shared/logger.js'
import { normalizeAgentRole } from '../shared/role-bridge.js'

const log = logger.child({ module: 'brain-spawn-adapter' })

const DEFAULT_SOLO_TEAM = 'brain-solo'

// ── Types ────────────────────────────────────────────────────────────────────

/** Dependencies required to create a brain spawn adapter. */
export interface BrainSpawnAdapterDeps {
  readonly db: Database.Database
  readonly spawner: AgentSpawner
  readonly preferredLaunchMethod?: 'acp' | 'tmux' | 'detached'
  readonly workingDir?: string
}

/** Adapter that bridges brain agent decisions to the agent spawner. */
export interface BrainSpawnAdapter {
  /** Spawn an agent from a brain decision. Returns the session ID. */
  spawnAgent(prompt: string, role: string, teamId?: string): Promise<string>
}

// ── Implementation ───────────────────────────────────────────────────────────

export function createBrainSpawnAdapter(deps: BrainSpawnAdapterDeps): BrainSpawnAdapter {
  const { db, spawner, preferredLaunchMethod = 'detached', workingDir } = deps

  function ensureTeam(teamId: string): void {
    const existing = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)
    if (!existing) {
      db.prepare(
        'INSERT INTO teams (id, name, description) VALUES (@id, @name, @description)',
      ).run({
        id: teamId,
        name: teamId,
        description: `Auto-created by brain agent`,
      })
      log.info({ teamId }, 'Auto-created team for brain spawn')
    }
  }

  function generateAgentName(role: string): string {
    const shortId = randomUUID().slice(0, 8)
    return `brain-${role}-${shortId}`
  }

  async function spawnAgent(prompt: string, role: string, teamId?: string): Promise<string> {
    const effectiveTeamId = teamId ?? DEFAULT_SOLO_TEAM
    ensureTeam(effectiveTeamId)

    // Record the canonical broker spawn-role so both brain spawn paths (planner
    // subtasks + suggestion→team) produce a team_members.role the broker
    // recognizes — e.g. QG's isAnalysisCompletion keys on `scns-researcher`.
    const spawnRole = normalizeAgentRole(role)

    const input: SpawnInput = {
      team_id: effectiveTeamId,
      name: generateAgentName(spawnRole),
      role: spawnRole,
      prompt,
      launch_method: preferredLaunchMethod,
      working_dir: workingDir,
    }

    try {
      const result = await spawner.spawn(input)
      log.info(
        { sessionId: result.sessionId, role: spawnRole, teamId: effectiveTeamId, method: result.launchMethod },
        'Brain spawned agent',
      )
      return result.sessionId
    } catch (err) {
      if (preferredLaunchMethod !== 'detached') {
        log.warn(
          { err, method: preferredLaunchMethod },
          'Brain spawn failed with preferred method, falling back to detached',
        )
        const fallbackInput: SpawnInput = { ...input, launch_method: 'detached' }
        const result = await spawner.spawn(fallbackInput)
        log.info(
          { sessionId: result.sessionId, role: spawnRole, method: 'detached' },
          'Brain spawned agent via fallback',
        )
        return result.sessionId
      }
      throw err
    }
  }

  return { spawnAgent }
}
