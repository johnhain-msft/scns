/**
 * P7 — Meta-broker project registry.
 *
 * Stores the canonical list of registered projects + their per-child runtime
 * state. Distinct from the per-project `~/.session-broker/projects/<id>/data.db`
 * (which holds teams/sessions/etc for ONE project). This registry lives at
 * `~/.scns/meta-broker.db` and is GLOBAL across projects.
 *
 * Design notes (rubber-duck P7 — 2026-06-03):
 *  - Per-project DBs are the long-term model per locked north-star. This
 *    module does NOT migrate the existing single-broker shared data.db.
 *    Existing single-broker setups keep working unchanged; the meta-broker
 *    is opt-in via `scns meta-broker run`.
 *  - status field is a small state machine:
 *      registered → starting → running ⇄ failing → failed | stopped
 *  - `instance_id` is a one-shot token meta passes to the child on spawn
 *    and validates against `/api/health`. Guards against PID reuse pointing
 *    at the wrong process.
 *  - `child_pid` is advisory only — never trust it for identity.
 *  - `health_failures` counts consecutive probe failures (reset on first
 *    success). Used by the restart-policy to decide when to act.
 */
import type Database from 'better-sqlite3'
import nodePath from 'node:path'

import { isAbsolutePath, resolveDeepestRootIndex, type PlatformPath } from '../shared/paths.js'

export type ProjectStatus = 'registered' | 'starting' | 'running' | 'failing' | 'failed' | 'stopped'

export interface ProjectRow {
  readonly projectId: string
  readonly projectRoot: string
  readonly desiredPort: number | null
  readonly boundPort: number | null
  readonly status: ProjectStatus
  readonly instanceId: string | null
  readonly childPid: number | null
  readonly lastSeenAt: string | null
  readonly lastError: string | null
  readonly healthFailures: number
  /** Gap 5 — per-project autonomy level passed to the spawned child broker. */
  readonly autonomyLevel: number | null
  /** Gap 5 — per-project SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD for the child. */
  readonly autoApproveThreshold: number | null
  /**
   * Track-2 — per-project GitHub `owner/name` for the child's self-issue-ingest.
   * Threaded to the child as `SCNS_SELF_ISSUE_REPO` so it ingests ITS OWN repo's
   * issues (never the SCNS singleton's). null → child does not ingest issues.
   */
  readonly selfIssueRepo: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface RegisterProjectInput {
  readonly projectId: string
  readonly projectRoot: string
  readonly desiredPort?: number | null
  readonly autonomyLevel?: number | null
  readonly autoApproveThreshold?: number | null
  readonly selfIssueRepo?: string | null
}

export interface ProjectChildState {
  readonly status: ProjectStatus
  readonly boundPort: number | null
  readonly childPid: number | null
  readonly instanceId: string | null
  readonly lastSeenAt: string | null
}

interface RawRow {
  readonly project_id: string
  readonly project_root: string
  readonly desired_port: number | null
  readonly bound_port: number | null
  readonly status: ProjectStatus
  readonly instance_id: string | null
  readonly child_pid: number | null
  readonly last_seen_at: string | null
  readonly last_error: string | null
  readonly health_failures: number
  readonly autonomy_level: number | null
  readonly auto_approve_threshold: number | null
  readonly self_issue_repo: string | null
  readonly created_at: string
  readonly updated_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  project_id      TEXT PRIMARY KEY,
  project_root    TEXT NOT NULL,
  desired_port    INTEGER,
  bound_port      INTEGER,
  status          TEXT NOT NULL DEFAULT 'registered'
                  CHECK (status IN ('registered','starting','running','failing','failed','stopped')),
  instance_id     TEXT,
  child_pid       INTEGER,
  last_seen_at    TEXT,
  last_error      TEXT,
  health_failures INTEGER NOT NULL DEFAULT 0,
  autonomy_level  INTEGER,
  auto_approve_threshold REAL,
  self_issue_repo TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_root ON projects(project_root);
`

export function applyMetaSchema(db: Database.Database): void {
  db.exec(SCHEMA)
  // Gap 5 — additive migration for registries created before per-project
  // config existed. Idempotent: only adds a column when it is missing.
  const cols = new Set(
    (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map((c) => c.name),
  )
  if (!cols.has('autonomy_level')) {
    db.exec('ALTER TABLE projects ADD COLUMN autonomy_level INTEGER')
  }
  if (!cols.has('auto_approve_threshold')) {
    db.exec('ALTER TABLE projects ADD COLUMN auto_approve_threshold REAL')
  }
  if (!cols.has('self_issue_repo')) {
    db.exec('ALTER TABLE projects ADD COLUMN self_issue_repo TEXT')
  }
}

function rowToProject(r: RawRow): ProjectRow {
  return {
    projectId: r.project_id,
    projectRoot: r.project_root,
    desiredPort: r.desired_port,
    boundPort: r.bound_port,
    status: r.status,
    instanceId: r.instance_id,
    childPid: r.child_pid,
    lastSeenAt: r.last_seen_at,
    lastError: r.last_error,
    healthFailures: r.health_failures,
    autonomyLevel: r.autonomy_level,
    autoApproveThreshold: r.auto_approve_threshold,
    selfIssueRepo: r.self_issue_repo,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function registerProject(
  db: Database.Database,
  input: RegisterProjectInput,
  pp: PlatformPath = nodePath,
): void {
  if (!input.projectId || input.projectId.trim() === '') {
    throw new Error('registerProject: projectId must be a non-empty string')
  }
  if (!isAbsolutePath(input.projectRoot, pp)) {
    throw new Error('registerProject: projectRoot must be an absolute path')
  }
  db.prepare(
    `INSERT INTO projects (project_id, project_root, desired_port, autonomy_level, auto_approve_threshold, self_issue_repo)
     VALUES (@projectId, @projectRoot, @desiredPort, @autonomyLevel, @autoApproveThreshold, @selfIssueRepo)
     ON CONFLICT(project_id) DO UPDATE SET
       project_root = excluded.project_root,
       desired_port = COALESCE(excluded.desired_port, projects.desired_port),
       autonomy_level = COALESCE(excluded.autonomy_level, projects.autonomy_level),
       auto_approve_threshold = COALESCE(excluded.auto_approve_threshold, projects.auto_approve_threshold),
       self_issue_repo = COALESCE(excluded.self_issue_repo, projects.self_issue_repo),
       updated_at = datetime('now')`,
  ).run({
    projectId: input.projectId,
    projectRoot: input.projectRoot,
    desiredPort: input.desiredPort ?? null,
    autonomyLevel: input.autonomyLevel ?? null,
    autoApproveThreshold: input.autoApproveThreshold ?? null,
    selfIssueRepo: input.selfIssueRepo ?? null,
  })
}

export function getProject(db: Database.Database, projectId: string): ProjectRow | null {
  const row = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as
    | RawRow
    | undefined
  return row ? rowToProject(row) : null
}

export function getProjectByRoot(db: Database.Database, projectRoot: string): ProjectRow | null {
  const row = db
    .prepare('SELECT * FROM projects WHERE project_root = ? LIMIT 1')
    .get(projectRoot) as RawRow | undefined
  return row ? rowToProject(row) : null
}

/**
 * W5 routing — resolve which registered project owns a filesystem path.
 * Returns the DEEPEST registered `project_root` containing `path`, so any
 * subdirectory of a project resolves to it and nested roots pick the longest
 * prefix. Sibling directories sharing a name prefix never match (comparison is
 * per whole path segment). On win32 the comparison is case-insensitive and
 * tolerates mixed separators; callers omit `pp` to get host semantics.
 */
export function resolveProjectForPath(
  db: Database.Database,
  path: string,
  pp: PlatformPath = nodePath,
): ProjectRow | null {
  const projects = listProjects(db)
  const idx = resolveDeepestRootIndex(
    projects.map((p) => p.projectRoot),
    path,
    pp,
  )
  return idx === -1 ? null : projects[idx]!
}

export function listProjects(db: Database.Database): ReadonlyArray<ProjectRow> {
  const rows = db
    .prepare('SELECT * FROM projects ORDER BY created_at ASC, project_id ASC')
    .all() as RawRow[]
  return rows.map(rowToProject)
}

export function removeProject(db: Database.Database, projectId: string): boolean {
  return db.prepare('DELETE FROM projects WHERE project_id = ?').run(projectId).changes > 0
}

/**
 * Clear a terminal state so the supervisor will spawn the child again.
 *
 * `registerProject` deliberately upserts only operator-supplied configuration
 * (`project_root`, `desired_port`, autonomy, …) and never `status` — so
 * re-registering a suspended project is a no-op against `failed`, and the only
 * recovery was hand-editing the registry DB. This is that edit, as a supported
 * operation.
 *
 * `desired_port` is preserved on purpose: the project keeps the address its
 * sessions have pinned. Runtime identity (`bound_port`, `instance_id`,
 * `child_pid`, `last_seen_at`) is cleared because none of it describes a live
 * process any more — `last_seen_at` in particular would otherwise read as a
 * suspension timestamp if the reset row ever re-enters `failed`.
 *
 * Restricted to `failed`/`stopped` — the statuses a project cannot leave on its
 * own. Resetting a `running` or `failing` row would drop the identity of a
 * child that is still alive, and the next tick would spawn a second broker for
 * the same project.
 *
 * @returns true when a row was actually reset.
 */
export function resetProject(db: Database.Database, projectId: string): boolean {
  return (
    db
      .prepare(
        `UPDATE projects SET
           status = 'registered',
           health_failures = 0,
           bound_port = NULL,
           instance_id = NULL,
           child_pid = NULL,
           last_seen_at = NULL,
           last_error = NULL,
           updated_at = datetime('now')
         WHERE project_id = ? AND status IN ('failed','stopped')`,
      )
      .run(projectId).changes > 0
  )
}

/**
 * The port a project should try to reclaim on its next spawn.
 *
 * `desiredPort` is operator intent (`meta-broker register --port N`) and always
 * wins. Falling back to `boundPort` is what keeps ports STABLE across a
 * meta-broker restart: without it every row started with `desired_port` NULL,
 * `pickPort` passed `undefined`, and the allocator re-dealt the whole pool —
 * silently handing a live session's port to a different project.
 */
export function stickyDesiredPort(
  project: Pick<ProjectRow, 'desiredPort' | 'boundPort'>,
): number | undefined {
  return project.desiredPort ?? project.boundPort ?? undefined
}

/**
 * Record a health-verified port as the project's durable anchor.
 *
 * `bound_port` is cleared when a child exits, so it cannot be the only anchor —
 * a clean shutdown would lose it and the next start would re-deal. Only fills
 * a NULL `desired_port`, so an operator-registered port is never overwritten.
 */
export function persistDesiredPort(db: Database.Database, projectId: string, port: number): void {
  db.prepare(
    `UPDATE projects SET desired_port = @port, updated_at = datetime('now')
     WHERE project_id = @projectId AND desired_port IS NULL`,
  ).run({ projectId, port })
}

export function updateChildState(
  db: Database.Database,
  projectId: string,
  state: ProjectChildState,
): void {
  const result = db
    .prepare(
      `UPDATE projects SET
         status = @status,
         bound_port = @boundPort,
         child_pid = @childPid,
         instance_id = @instanceId,
         last_seen_at = @lastSeenAt,
         updated_at = datetime('now')
       WHERE project_id = @projectId`,
    )
    .run({
      projectId,
      status: state.status,
      boundPort: state.boundPort,
      childPid: state.childPid,
      instanceId: state.instanceId,
      lastSeenAt: state.lastSeenAt,
    })
  if (result.changes === 0) {
    throw new Error(`updateChildState: project '${projectId}' not registered`)
  }
}

export function recordHealthFailure(
  db: Database.Database,
  projectId: string,
  errorMessage: string,
): void {
  db.prepare(
    `UPDATE projects SET
       health_failures = health_failures + 1,
       last_error = @errorMessage,
       updated_at = datetime('now')
     WHERE project_id = @projectId`,
  ).run({ projectId, errorMessage })
}

export function resetHealthFailures(db: Database.Database, projectId: string): void {
  db.prepare(
    "UPDATE projects SET health_failures = 0, updated_at = datetime('now') WHERE project_id = ?",
  ).run(projectId)
}
