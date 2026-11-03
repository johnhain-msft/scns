import type Database from 'better-sqlite3'
import type { EventLog } from './event-log.js'
import type { ScalingPolicy } from '../types.js'
import type { ToolResult } from '../tools/helpers.js'
import { findScalingPoliciesByTeam, updateLastScaleAction } from '../storage/repositories/scaling-repository.js'
import { findAllTeams } from '../storage/repositories/team-repository.js'
import { countTeamMembersByRole, findTeamMembers } from '../storage/repositories/team-repository.js'
import { countPendingTasksByTeam } from '../storage/repositories/task-repository.js'

export type ScaleSpawnFn = (input: {
  readonly team_id: string
  readonly name: string
  readonly role?: string
}) => Promise<ToolResult>

export interface AutoScaler {
  stop(): void
  evaluateOnce(): Promise<void>
}

function isCooldownActive(policy: ScalingPolicy): boolean {
  if (!policy.last_scale_action_at) return false
  const lastAction = new Date(policy.last_scale_action_at).getTime()
  return (Date.now() - lastAction) < policy.cooldown_ms
}

export function createAutoScaler(
  db: Database.Database,
  eventLog: EventLog,
  spawnFn: ScaleSpawnFn,
  options?: { readonly intervalMs?: number },
): AutoScaler {
  const intervalMs = options?.intervalMs ?? 30_000

  async function evaluateOnce(): Promise<void> {
    const teams = findAllTeams(db, 'active')

    for (const team of teams) {
      const policies = findScalingPoliciesByTeam(db, team.id)

      for (const policy of policies) {
        if (policy.enabled === 0) continue
        if (isCooldownActive(policy)) continue

        const activeCount = countTeamMembersByRole(db, team.id, policy.role)
        const pendingTasks = countPendingTasksByTeam(db, team.id)

        // Scale UP: pending tasks exceed threshold AND active < max
        if (pendingTasks >= policy.scale_up_threshold && activeCount < policy.max_count) {
          const agentName = `${policy.role}-${activeCount + 1}`
          try {
            await spawnFn({
              team_id: team.id,
              name: agentName,
              role: policy.role,
            })
            updateLastScaleAction(db, team.id, policy.role)
            eventLog.agentScaledUp(null, {
              team_id: team.id,
              role: policy.role,
              name: agentName,
              pending_tasks: pendingTasks,
              active_count: activeCount + 1,
            })
          } catch (err) {
            process.stdout.write(
              `Auto-scale up failed for ${team.id}/${policy.role}: ${err instanceof Error ? err.message : String(err)}\n`
            )
          }
          continue
        }

        // Scale DOWN: excess agents when idle
        if (
          activeCount > policy.min_count &&
          (activeCount > policy.max_count || pendingTasks <= policy.scale_down_threshold)
        ) {
          const members = findTeamMembers(db, team.id)
          const roleMembers = members.filter((m) => m.role === policy.role)
          // Pick the most recently joined member to shut down
          const target = roleMembers[roleMembers.length - 1]
          if (target) {
            eventLog.agentScaledDown(null, {
              team_id: team.id,
              role: policy.role,
              session_id: target.session_id,
              name: target.name,
              pending_tasks: pendingTasks,
              active_count: activeCount - 1,
            })
            updateLastScaleAction(db, team.id, policy.role)
          }
        }
      }
    }
  }

  const intervalId = setInterval(() => {
    evaluateOnce().catch((err) => {
      process.stdout.write(`Auto-scaler error: ${err instanceof Error ? err.message : String(err)}\n`)
    })
  }, intervalMs)

  return {
    stop(): void {
      clearInterval(intervalId)
    },
    evaluateOnce,
  }
}
