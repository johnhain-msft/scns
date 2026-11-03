import type Database from 'better-sqlite3'

// ── Types ───────────────────────────────────────────────────────

export interface ScalingPolicy {
  readonly id: number
  readonly team_id: string
  readonly role: string
  readonly min_count: number
  readonly max_count: number
  readonly scale_up_threshold: number
  readonly scale_down_threshold: number
  readonly cooldown_ms: number
  readonly enabled: number
  readonly last_scale_action_at: string | null
}

// ── Input types ─────────────────────────────────────────────────

interface UpsertScalingPolicyInput {
  readonly team_id: string
  readonly role: string
  readonly min_count?: number
  readonly max_count?: number
  readonly scale_up_threshold?: number
  readonly scale_down_threshold?: number
  readonly cooldown_ms?: number
  readonly enabled?: number
}

// ── Scaling Policies ────────────────────────────────────────────

export function upsertScalingPolicy(
  db: Database.Database,
  input: UpsertScalingPolicyInput,
): ScalingPolicy {
  db.prepare(
    `INSERT INTO scaling_policies
       (team_id, role, min_count, max_count, scale_up_threshold, scale_down_threshold, cooldown_ms, enabled)
     VALUES
       (@team_id, @role, @min_count, @max_count, @scale_up_threshold, @scale_down_threshold, @cooldown_ms, @enabled)
     ON CONFLICT(team_id, role) DO UPDATE SET
       min_count = excluded.min_count,
       max_count = excluded.max_count,
       scale_up_threshold = excluded.scale_up_threshold,
       scale_down_threshold = excluded.scale_down_threshold,
       cooldown_ms = excluded.cooldown_ms,
       enabled = excluded.enabled`,
  ).run({
    team_id: input.team_id,
    role: input.role,
    min_count: input.min_count ?? 1,
    max_count: input.max_count ?? 5,
    scale_up_threshold: input.scale_up_threshold ?? 3,
    scale_down_threshold: input.scale_down_threshold ?? 0,
    cooldown_ms: input.cooldown_ms ?? 60000,
    enabled: input.enabled ?? 1,
  })

  const row = db
    .prepare('SELECT * FROM scaling_policies WHERE team_id = ? AND role = ?')
    .get(input.team_id, input.role) as ScalingPolicy

  return { ...row }
}

export function findScalingPolicy(
  db: Database.Database,
  teamId: string,
  role: string,
): ScalingPolicy | null {
  const row = db
    .prepare('SELECT * FROM scaling_policies WHERE team_id = ? AND role = ?')
    .get(teamId, role) as ScalingPolicy | undefined

  return row ? { ...row } : null
}

export function findScalingPoliciesByTeam(
  db: Database.Database,
  teamId: string,
): ReadonlyArray<ScalingPolicy> {
  const rows = db
    .prepare('SELECT * FROM scaling_policies WHERE team_id = ? ORDER BY role')
    .all(teamId) as ScalingPolicy[]

  return rows.map((row) => ({ ...row }))
}

export function deleteScalingPolicy(db: Database.Database, teamId: string, role: string): boolean {
  const result = db
    .prepare('DELETE FROM scaling_policies WHERE team_id = ? AND role = ?')
    .run(teamId, role)
  return result.changes > 0
}

export function recordScaleAction(db: Database.Database, teamId: string, role: string): boolean {
  const result = db
    .prepare(
      `UPDATE scaling_policies SET last_scale_action_at = datetime('now')
       WHERE team_id = ? AND role = ?`,
    )
    .run(teamId, role)
  return result.changes > 0
}
