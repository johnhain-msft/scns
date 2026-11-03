import type Database from 'better-sqlite3'
import type { ScalingPolicy } from '../../types.js'

interface UpsertScalingPolicyInput {
  readonly team_id: string
  readonly role: string
  readonly min_count?: number
  readonly max_count?: number
  readonly scale_up_threshold?: number
  readonly scale_down_threshold?: number
  readonly cooldown_ms?: number
  readonly enabled?: boolean
}

export function upsertScalingPolicy(
  db: Database.Database,
  input: UpsertScalingPolicyInput,
): ScalingPolicy {
  db.prepare(
    `INSERT INTO scaling_policies (team_id, role, min_count, max_count, scale_up_threshold, scale_down_threshold, cooldown_ms, enabled)
     VALUES (@team_id, @role, @min_count, @max_count, @scale_up_threshold, @scale_down_threshold, @cooldown_ms, @enabled)
     ON CONFLICT(team_id, role) DO UPDATE SET
       min_count = @min_count,
       max_count = @max_count,
       scale_up_threshold = @scale_up_threshold,
       scale_down_threshold = @scale_down_threshold,
       cooldown_ms = @cooldown_ms,
       enabled = @enabled`
  ).run({
    team_id: input.team_id,
    role: input.role,
    min_count: input.min_count ?? 1,
    max_count: input.max_count ?? 5,
    scale_up_threshold: input.scale_up_threshold ?? 3,
    scale_down_threshold: input.scale_down_threshold ?? 0,
    cooldown_ms: input.cooldown_ms ?? 60000,
    enabled: (input.enabled ?? true) ? 1 : 0,
  })

  return findScalingPolicy(db, input.team_id, input.role)!
}

export function findScalingPolicy(
  db: Database.Database,
  teamId: string,
  role: string,
): ScalingPolicy | null {
  const row = db.prepare(
    'SELECT * FROM scaling_policies WHERE team_id = ? AND role = ?'
  ).get(teamId, role) as ScalingPolicy | undefined
  return row ? { ...row } : null
}

export function findScalingPoliciesByTeam(
  db: Database.Database,
  teamId: string,
): ReadonlyArray<ScalingPolicy> {
  const rows = db.prepare(
    'SELECT * FROM scaling_policies WHERE team_id = ? ORDER BY role'
  ).all(teamId) as ScalingPolicy[]
  return rows.map((row) => ({ ...row }))
}

export function updateLastScaleAction(
  db: Database.Database,
  teamId: string,
  role: string,
): void {
  db.prepare(
    `UPDATE scaling_policies SET last_scale_action_at = datetime('now')
     WHERE team_id = ? AND role = ?`
  ).run(teamId, role)
}

export function deleteScalingPoliciesByTeam(
  db: Database.Database,
  teamId: string,
): number {
  const result = db.prepare(
    'DELETE FROM scaling_policies WHERE team_id = ?'
  ).run(teamId)
  return result.changes
}

export function deleteAllScalingPolicies(db: Database.Database): number {
  const result = db.prepare('DELETE FROM scaling_policies').run()
  return result.changes
}
