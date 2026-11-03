import type Database from 'better-sqlite3'

/**
 * Multi-project foundation (P3): project registry + legacy backfill +
 * supervisor aggregation.
 *
 * The broker stores teams/sessions for a single shared SQLite DB. This module
 * maintains the `projects` metadata table, adopts pre-existing legacy NULL
 * rows that clearly belong to the current project, and exposes a read-only
 * cross-project summary for supervisor/admin tooling (the seed of a
 * meta-broker view).
 */

export interface BackfillInput {
  readonly projectId: string
  readonly projectRoot: string
}

export interface BackfillResult {
  readonly teams: number
  readonly sessions: number
}

export interface ProjectSummary {
  readonly projectId: string | null
  readonly projectRoot: string | null
  readonly teams: number
  readonly sessions: number
}

/** Upsert the project row, bumping last_seen_at on every startup. */
export function registerProject(
  db: Database.Database,
  projectId: string,
  projectRoot: string,
): void {
  db.prepare(
    `INSERT INTO projects (project_id, project_root, created_at, last_seen_at)
     VALUES (?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(project_id) DO UPDATE SET
       project_root = excluded.project_root,
       last_seen_at = datetime('now')`,
  ).run(projectId, projectRoot)
}

/**
 * Adopt legacy NULL-project rows whose working_dir is the project root or a
 * descendant of it. Rows already stamped with another project are never
 * overwritten; ambiguous rows (working_dir outside the root, or NULL) stay
 * NULL so they surface in the supervisor view as an explicit migration
 * concern rather than being silently mislabelled.
 *
 * Prefix matching is boundary-safe: `/repo/ab` is NOT treated as under
 * `/repo/a` (we match the exact root or `<root>/...`).
 */
export function backfillProjectId(
  db: Database.Database,
  input: BackfillInput,
): BackfillResult {
  const { projectId, projectRoot } = input
  // Escape LIKE wildcards in the root so a literal % or _ in a path cannot
  // widen the match; use an explicit ESCAPE clause.
  const escaped = projectRoot.replace(/[\\%_]/g, (c) => `\\${c}`)
  const underPrefix = `${escaped}/%`

  const teams = db
    .prepare(
      `UPDATE teams SET project_id = @projectId
       WHERE project_id IS NULL
         AND working_dir IS NOT NULL
         AND (working_dir = @projectRoot OR working_dir LIKE @underPrefix ESCAPE '\\')`,
    )
    .run({ projectId, projectRoot, underPrefix }).changes

  const sessions = db
    .prepare(
      `UPDATE sessions SET project_id = @projectId
       WHERE project_id IS NULL
         AND working_dir IS NOT NULL
         AND (working_dir = @projectRoot OR working_dir LIKE @underPrefix ESCAPE '\\')`,
    )
    .run({ projectId, projectRoot, underPrefix }).changes

  return { teams, sessions }
}

/**
 * Cross-project summary: one row per distinct project_id (including the
 * NULL/legacy bucket) with live team + session counts. Read-only — the
 * minimal supervisor "view" a meta-broker would consume.
 */
export function listProjects(db: Database.Database): ReadonlyArray<ProjectSummary> {
  const teamCounts = db
    .prepare(
      `SELECT project_id AS pid, COUNT(*) AS n FROM teams
       WHERE archived_at IS NULL GROUP BY project_id`,
    )
    .all() as Array<{ pid: string | null; n: number }>
  const sessionCounts = db
    .prepare(
      `SELECT project_id AS pid, COUNT(*) AS n FROM sessions
       WHERE archived_at IS NULL GROUP BY project_id`,
    )
    .all() as Array<{ pid: string | null; n: number }>
  const roots = db
    .prepare('SELECT project_id AS pid, project_root AS root FROM projects')
    .all() as Array<{ pid: string; root: string | null }>

  const byId = new Map<string | null, { projectId: string | null; projectRoot: string | null; teams: number; sessions: number }>()
  const ensure = (
    pid: string | null,
  ): { projectId: string | null; projectRoot: string | null; teams: number; sessions: number } => {
    let entry = byId.get(pid)
    if (!entry) {
      entry = { projectId: pid, projectRoot: null, teams: 0, sessions: 0 }
      byId.set(pid, entry)
    }
    return entry
  }

  for (const r of teamCounts) ensure(r.pid).teams = r.n
  for (const r of sessionCounts) ensure(r.pid).sessions = r.n
  for (const r of roots) {
    const entry = ensure(r.pid)
    entry.projectRoot = r.root
  }

  return [...byId.values()].map((e) => ({
    projectId: e.projectId,
    projectRoot: e.projectRoot,
    teams: e.teams,
    sessions: e.sessions,
  }))
}
