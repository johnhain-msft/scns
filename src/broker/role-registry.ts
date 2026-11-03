import type Database from 'better-sqlite3'

/**
 * De-hardcoded roles (P4): runtime role registry.
 *
 * Historically `team_members.role` was gated by a static `CHECK (role IN (...))`
 * allowlist baked into schema.sql + a Zod enum — which made it impossible for the
 * system to *self-innovate* (mint a brand-new agent role) without a code + schema
 * change. The CHECK is now dropped: `team_members.role` is free-text, and this
 * `agent_roles` table is a discoverability/metadata catalogue rather than a gate.
 *
 * - Builtin roles are seeded by the migration (see db.ts) and flagged builtin=1.
 * - `spawnable` marks roles that have a bespoke task-spawn prompt strategy
 *   (scns-manager/dev/qa) — see services/task-spawn-prompt.ts.
 * - Novel roles can be registered at runtime by agents (POST /api/agent-roles or
 *   the `register_role` MCP tool) or are auto-registered on first team-member use.
 */

export interface RegisterRoleInput {
  readonly role: string
  readonly description?: string | null
  readonly spawnable?: boolean
}

export interface RoleSummary {
  readonly role: string
  readonly description: string | null
  readonly builtin: boolean
  readonly spawnable: boolean
  readonly createdAt: string | null
}

/**
 * Upsert a role into the registry. Idempotent: re-registering updates the
 * description/spawnable metadata but never downgrades a builtin role's
 * `builtin` flag (so a runtime caller cannot un-builtin a core role).
 */
export function registerRole(db: Database.Database, input: RegisterRoleInput): void {
  const role = input.role.trim()
  if (role.length === 0) {
    throw new Error('registerRole: role must be a non-empty string')
  }
  db.prepare(
    `INSERT INTO agent_roles (role, description, builtin, spawnable, created_at)
     VALUES (@role, @description, 0, @spawnable, datetime('now'))
     ON CONFLICT(role) DO UPDATE SET
       description = excluded.description,
       spawnable = excluded.spawnable`,
  ).run({
    role,
    description: input.description ?? null,
    spawnable: input.spawnable ? 1 : 0,
  })
}

/**
 * Auto-register a role if it is not already known (used on the team-member
 * insert path so the catalogue stays complete without gating). Never updates
 * an existing row — first-use metadata is intentionally minimal.
 */
export function ensureRoleRegistered(db: Database.Database, role: string): void {
  const trimmed = role.trim()
  if (trimmed.length === 0) return
  db.prepare(
    `INSERT OR IGNORE INTO agent_roles (role, description, builtin, spawnable, created_at)
     VALUES (?, NULL, 0, 0, datetime('now'))`,
  ).run(trimmed)
}

export function isRoleRegistered(db: Database.Database, role: string): boolean {
  const row = db
    .prepare('SELECT 1 AS hit FROM agent_roles WHERE role = ?')
    .get(role.trim()) as { hit: number } | undefined
  return row !== undefined
}

export function listRoles(db: Database.Database): ReadonlyArray<RoleSummary> {
  const rows = db
    .prepare(
      `SELECT role, description, builtin, spawnable, created_at
       FROM agent_roles ORDER BY builtin DESC, role ASC`,
    )
    .all() as Array<{
    role: string
    description: string | null
    builtin: number
    spawnable: number
    created_at: string | null
  }>
  return rows.map((r) => ({
    role: r.role,
    description: r.description,
    builtin: r.builtin === 1,
    spawnable: r.spawnable === 1,
    createdAt: r.created_at,
  }))
}
