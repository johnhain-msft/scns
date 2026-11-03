import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'

/**
 * Multi-project foundation (P3).
 *
 * SCNS stores teams/sessions/tasks in a single shared SQLite DB
 * (~/.session-broker/data.db). To let one broker be pointed at any repo
 * without acting on another project's teams, every project gets a stable,
 * deterministic `project_id` derived from its git work-tree root.
 */

export interface DeriveProjectIdOptions {
  /**
   * Explicit operator override (BROKER_PROJECT_ID). When set to a non-blank
   * string the id is the slugified override verbatim (no hash) so the same
   * logical project keeps a stable id across checkout moves.
   */
  readonly override?: string | null
  /**
   * Path canonicalizer. Defaults to fs.realpathSync (falling back to a
   * resolved absolute path when the path does not exist, e.g. in tests).
   * Injectable so unit tests stay filesystem-independent.
   */
  readonly canonicalize?: (p: string) => string
}

/**
 * Turn an arbitrary string into a safe, lowercase, dash-delimited slug.
 * Empty / symbol-only input collapses to the literal `project`.
 */
export function slugifyProjectId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'project'
}

function defaultCanonicalize(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/**
 * Derive a stable project id for a git work-tree root.
 *
 * - With an override: `slugify(override)` (stable across moves).
 * - Otherwise: `<repo-basename>-<8 hex of sha1(canonical path)>`, e.g.
 *   `scns-1a2b3c4d`. The basename keeps ids human-readable; the path hash
 *   keeps two clones of the same repo (or two repos with the same basename)
 *   isolated.
 */
export function deriveProjectId(
  projectRoot: string,
  opts?: DeriveProjectIdOptions,
): string {
  const override = opts?.override
  if (override && override.trim().length > 0) {
    return slugifyProjectId(override)
  }
  const canonicalize = opts?.canonicalize ?? defaultCanonicalize
  const canonical = canonicalize(projectRoot)
  const base = slugifyProjectId(basename(canonical) || 'root')
  const hash = createHash('sha1').update(canonical).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}
