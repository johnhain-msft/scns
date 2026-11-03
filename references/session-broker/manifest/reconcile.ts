import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import type { TeamManifest, ManifestRole, ManifestTask } from './schema.js'
import {
  createTeam,
  findTeamByName,
  findTeamMembers,
} from '../storage/repositories/team-repository.js'
import {
  createTask,
  findTasksByTeam,
  addDependency,
  updateTask,
} from '../storage/repositories/task-repository.js'
import { upsertRespawnPolicy } from '../storage/repositories/respawn-repository.js'
import { upsertScalingPolicy } from '../storage/repositories/scaling-repository.js'
import { handleSpawnAgent, type SpawnAgentInput } from '../tools/spawn-agent.js'

export interface ReconcileResult {
  readonly team_id: string
  readonly team_name: string
  readonly created: boolean
  readonly roles: ReadonlyArray<RoleReconcileResult>
  readonly tasks: TaskReconcileResult
  readonly respawnPolicy: boolean
  readonly scalingPolicy: boolean
}

export interface RoleReconcileResult {
  readonly role: string
  readonly desired: number
  readonly current: number
  readonly spawned: number
  readonly errors: readonly string[]
}

export interface TaskReconcileResult {
  readonly created: number
  readonly existed: number
  readonly dependencies_set: number
}

export type SpawnFn = (input: SpawnAgentInput) => Promise<{ spawned: boolean; session_id?: string }>

function defaultSpawnFn(db: Database.Database, eventLog: EventLog): SpawnFn {
  return async (input: SpawnAgentInput) => {
    const result = await handleSpawnAgent(db, eventLog, input)
    if (result.isError) {
      const data = JSON.parse(result.content[0].text) as { error: string }
      throw new Error(data.error)
    }
    const data = JSON.parse(result.content[0].text) as { spawned: boolean; session_id?: string }
    return { spawned: data.spawned, session_id: data.session_id }
  }
}

function countMembersByRole(
  db: Database.Database,
  teamId: string,
  role: string,
): number {
  const members = findTeamMembers(db, teamId)
  return members.filter((m) => m.role === role).length
}

async function reconcileRoles(
  db: Database.Database,
  _eventLog: EventLog,
  teamId: string,
  roles: ReadonlyArray<ManifestRole>,
  spawnFn: SpawnFn,
): Promise<ReadonlyArray<RoleReconcileResult>> {
  const results: RoleReconcileResult[] = []

  for (const role of roles) {
    const current = countMembersByRole(db, teamId, role.name)
    const desired = role.count
    const toSpawn = Math.max(0, desired - current)
    let spawned = 0
    const errors: string[] = []

    for (let i = 0; i < toSpawn; i++) {
      try {
        const agentName = `${role.name}-${current + i + 1}`
        await spawnFn({
          team_id: teamId,
          name: agentName,
          role: role.name,
          agent: role.agent,
          prompt: role.prompt,
        })
        spawned++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push(message)
      }
    }

    results.push({
      role: role.name,
      desired,
      current,
      spawned,
      errors,
    })
  }

  return results
}

function reconcileTasks(
  db: Database.Database,
  eventLog: EventLog,
  teamId: string,
  manifestTasks: ReadonlyArray<ManifestTask>,
): TaskReconcileResult {
  const existingTasks = findTasksByTeam(db, teamId)
  const existingBySubject = new Map(existingTasks.map((t) => [t.subject, t]))

  let created = 0
  let existed = 0
  let dependenciesSet = 0

  // First pass: create tasks that don't exist
  const tasksBySubject = new Map(existingBySubject)

  for (const manifestTask of manifestTasks) {
    if (tasksBySubject.has(manifestTask.subject)) {
      existed++
      // Update owner if assignTo specified and task has no owner
      const existing = tasksBySubject.get(manifestTask.subject)!
      if (manifestTask.assignTo && !existing.owner) {
        updateTask(db, existing.id, { owner: manifestTask.assignTo })
      }
    } else {
      const task = createTask(db, {
        team_id: teamId,
        subject: manifestTask.subject,
        description: manifestTask.description ?? null,
      })

      if (manifestTask.assignTo) {
        updateTask(db, task.id, { owner: manifestTask.assignTo })
      }

      eventLog.taskCreated(null, {
        task_id: task.id,
        team_id: teamId,
        subject: task.subject,
      })

      tasksBySubject.set(task.subject, task)
      created++
    }
  }

  // Second pass: resolve blockedBy references
  for (const manifestTask of manifestTasks) {
    if (!manifestTask.blockedBy || manifestTask.blockedBy.length === 0) continue

    const task = tasksBySubject.get(manifestTask.subject)
    if (!task) continue

    for (const blockerSubject of manifestTask.blockedBy) {
      const blocker = tasksBySubject.get(blockerSubject)
      if (blocker) {
        addDependency(db, task.id, blocker.id)
        dependenciesSet++
      }
    }
  }

  return { created, existed, dependencies_set: dependenciesSet }
}

function reconcileRespawnPolicy(
  db: Database.Database,
  teamId: string,
  manifest: TeamManifest,
): boolean {
  if (!manifest.spec.respawnPolicy) return false

  const policy = manifest.spec.respawnPolicy
  for (const role of manifest.spec.roles) {
    upsertRespawnPolicy(db, {
      team_id: teamId,
      role: role.name,
      min_count: role.count,
      max_retries: policy.maxRetries,
      backoff_base_ms: policy.backoffBaseMs,
      enabled: policy.enabled,
    })
  }

  return true
}

function reconcileScalingPolicy(
  db: Database.Database,
  teamId: string,
  manifest: TeamManifest,
): boolean {
  if (!manifest.spec.scalingPolicy) return false

  const policy = manifest.spec.scalingPolicy
  for (const role of manifest.spec.roles) {
    upsertScalingPolicy(db, {
      team_id: teamId,
      role: role.name,
      min_count: policy.minCount,
      max_count: policy.maxCount,
      scale_up_threshold: policy.scaleUpThreshold,
      scale_down_threshold: policy.scaleDownThreshold,
      cooldown_ms: policy.cooldownMs,
      enabled: policy.enabled,
    })
  }

  return true
}

export async function reconcileManifest(
  db: Database.Database,
  eventLog: EventLog,
  manifest: TeamManifest,
  spawnFn?: SpawnFn,
): Promise<ReconcileResult> {
  const effectiveSpawnFn = spawnFn ?? defaultSpawnFn(db, eventLog)

  // Find or create team
  let team = findTeamByName(db, manifest.metadata.name)
  const created = !team

  if (!team) {
    team = createTeam(db, {
      id: randomUUID(),
      name: manifest.metadata.name,
      description: manifest.spec.description ?? null,
    })
    eventLog.teamCreated(null, {
      team_id: team.id,
      name: team.name,
    })
  }

  // Reconcile roles (spawn agents)
  const roles = await reconcileRoles(db, eventLog, team.id, manifest.spec.roles, effectiveSpawnFn)

  // Reconcile tasks
  const tasks = reconcileTasks(db, eventLog, team.id, manifest.spec.tasks ?? [])

  // Set respawn policies
  const respawnPolicy = reconcileRespawnPolicy(db, team.id, manifest)

  // Set scaling policies
  const scalingPolicy = reconcileScalingPolicy(db, team.id, manifest)

  return {
    team_id: team.id,
    team_name: team.name,
    created,
    roles,
    tasks,
    respawnPolicy,
    scalingPolicy,
  }
}
