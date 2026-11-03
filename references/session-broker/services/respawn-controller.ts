import type Database from 'better-sqlite3'
import type { EventLog } from './event-log.js'
import type { ToolResult } from '../tools/helpers.js'
import {
  findRespawnPolicy,
  createRespawnAttempt,
  updateRespawnAttempt,
  countRecentFailures,
} from '../storage/repositories/respawn-repository.js'
import { findTeamById, countTeamMembersByRole } from '../storage/repositories/team-repository.js'

export interface ZombieMemberSnapshot {
  readonly session_id: string
  readonly team_id: string
  readonly role: string
  readonly name: string
  readonly agent_type: string | null
}

export interface RespawnControllerConfig {
  readonly autoRespawn: boolean
  readonly maxRetries: number
  readonly backoffBaseMs: number
}

export type SpawnFn = (input: {
  readonly team_id: string
  readonly name: string
  readonly role?: string
  readonly agent?: string
}) => Promise<ToolResult>

export interface RespawnController {
  checkAndRespawn(snapshot: ZombieMemberSnapshot): Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createRespawnController(
  db: Database.Database,
  eventLog: EventLog,
  config: RespawnControllerConfig,
  spawnFn: SpawnFn,
): RespawnController {
  return {
    async checkAndRespawn(snapshot: ZombieMemberSnapshot): Promise<void> {
      if (!config.autoRespawn) return

      const policy = findRespawnPolicy(db, snapshot.team_id, snapshot.role)
      if (!policy || policy.enabled === 0) return

      const team = findTeamById(db, snapshot.team_id)
      if (!team || team.status !== 'active') return

      const maxRetries = policy.max_retries ?? config.maxRetries
      const recentFailures = countRecentFailures(db, snapshot.team_id, snapshot.role)

      if (recentFailures >= maxRetries) {
        const attempt = createRespawnAttempt(db, {
          team_id: snapshot.team_id,
          original_session_id: snapshot.session_id,
          role: snapshot.role,
          name: snapshot.name,
          agent_type: snapshot.agent_type,
          attempt: recentFailures + 1,
        })
        updateRespawnAttempt(db, attempt.id, { status: 'abandoned' })

        eventLog.agentAbandoned(snapshot.session_id, {
          team_id: snapshot.team_id,
          role: snapshot.role,
          name: snapshot.name,
          failures: recentFailures,
          max_retries: maxRetries,
        })
        return
      }

      const currentCount = countTeamMembersByRole(db, snapshot.team_id, snapshot.role)
      if (currentCount >= policy.min_count) return

      const backoffMs = (policy.backoff_base_ms ?? config.backoffBaseMs) * Math.pow(2, recentFailures)
      if (backoffMs > 0) {
        await delay(backoffMs)
      }

      const attempt = createRespawnAttempt(db, {
        team_id: snapshot.team_id,
        original_session_id: snapshot.session_id,
        role: snapshot.role,
        name: snapshot.name,
        agent_type: snapshot.agent_type,
        attempt: recentFailures + 1,
      })

      try {
        const result = await spawnFn({
          team_id: snapshot.team_id,
          name: snapshot.name,
          role: snapshot.role,
          agent: snapshot.agent_type ?? undefined,
        })

        if (result.isError) {
          updateRespawnAttempt(db, attempt.id, {
            status: 'failed',
            error_message: result.content[0]?.text ?? 'spawn returned error',
          })
          return
        }

        const parsed = JSON.parse(result.content[0].text) as { session_id?: string }
        updateRespawnAttempt(db, attempt.id, {
          status: 'spawned',
          new_session_id: parsed.session_id ?? null,
        })

        eventLog.agentRespawned(snapshot.session_id, {
          team_id: snapshot.team_id,
          role: snapshot.role,
          name: snapshot.name,
          new_session_id: parsed.session_id ?? null,
          attempt: recentFailures + 1,
        })
      } catch (err) {
        updateRespawnAttempt(db, attempt.id, {
          status: 'failed',
          error_message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}
