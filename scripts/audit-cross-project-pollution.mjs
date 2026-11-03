#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Read-only cross-project audit. Never use an unmatched broker working_dir
 * alone as permission to delete events: older hook registration substituted
 * the SCNS process cwd for native project sessions.
 *
 * Copilot's native session cwd takes precedence over broker metadata. Without
 * it, consistent broker records provide explicitly marked inferred ownership;
 * conflicting records and unknown/reaped IDs remain unclassified.
 *
 * node scripts/audit-cross-project-pollution.mjs [--json]
 * Env: SCNS_META_DB, SCNS_PROJECT_DB_DIR, SCNS_SESSION_STORE_DB.
 * Exit 0 = no identified issue (NOT proof that unknown events are native),
 * 1 = foreign rows / metadata mismatch / conflicting evidence, 2 = incomplete.
 */
import Database from 'better-sqlite3'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const asJson = process.argv.includes('--json')
const projectsDir =
  process.env.SCNS_PROJECT_DB_DIR ?? join(homedir(), '.session-broker', 'projects')
const metaDb = process.env.SCNS_META_DB ?? join(homedir(), '.scns', 'meta-broker.db')
const sessionStoreDb =
  process.env.SCNS_SESSION_STORE_DB ?? join(homedir(), '.copilot', 'session-store.db')
const result = {
  version: 2,
  generatedAt: new Date().toISOString(),
  complete: true,
  nSess: 0,
  nSessEv: 0,
  nStranded: 0,
  nMetadataMismatches: 0,
  nConflicts: 0,
  nUnknownEventRows: 0,
  errors: [],
  report: [],
}

function canonical(path) {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isPathInside(candidate, root) {
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) return false
  const rel = relative(canonical(root), canonical(candidate))
  return !isAbsolute(rel) && rel.split(sep)[0] !== '..'
}

function readOnly(path, read) {
  if (!existsSync(path)) throw new Error(`Database does not exist: ${path}`)
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    return db.transaction(() => read(db))()
  } finally {
    db.close()
  }
}

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
}

function audit() {
  const roots = readOnly(metaDb, (db) =>
    db.prepare('SELECT project_id, project_root FROM projects').all(),
  )
  const seenRoots = new Set()
  for (const root of roots) {
    if (typeof root.project_root !== 'string' || !isAbsolute(root.project_root)) {
      throw new Error(`Invalid registered root for ${root.project_id}`)
    }
    const normalized = canonical(root.project_root)
    if (seenRoots.has(normalized))
      throw new Error(`Ambiguous duplicate registered root: ${root.project_root}`)
    seenRoots.add(normalized)
  }
  roots.sort((a, b) => canonical(b.project_root).length - canonical(a.project_root).length)
  const ownerOfPath = (path) =>
    roots.find((r) => isPathInside(path, r.project_root))?.project_id ?? null
  const rootById = new Map(roots.map((r) => [r.project_id, r.project_root]))
  if (!existsSync(projectsDir)) throw new Error(`No project DB directory at ${projectsDir}`)

  const snapshots = []
  const brokerEvidence = new Map()
  const allIds = new Set()
  const directories = readdirSync(projectsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(projectsDir, e.name, 'data.db')))
    .map((e) => e.name)
    .sort()

  for (const projectId of directories) {
    const root = rootById.get(projectId)
    if (!root) {
      result.errors.push(`No registered project_root for database ${projectId}`)
      continue
    }
    try {
      const snapshot = readOnly(join(projectsDir, projectId, 'data.db'), (db) => ({
        projectId,
        root,
        sessions: db.prepare('SELECT id, working_dir, status FROM sessions').all(),
        history: hasTable(db, 'sessions_history')
          ? db.prepare('SELECT id, working_dir FROM sessions_history').all()
          : [],
        events: db
          .prepare(
            'SELECT session_id, COUNT(*) AS n FROM events WHERE session_id IS NOT NULL GROUP BY session_id',
          )
          .all(),
      }))
      snapshots.push(snapshot)
      for (const [table, rows] of [
        ['sessions', snapshot.sessions],
        ['sessions_history', snapshot.history],
      ]) {
        for (const row of rows) {
          allIds.add(row.id)
          if (!row.working_dir || !isAbsolute(row.working_dir)) continue
          const evidence = brokerEvidence.get(row.id) ?? []
          evidence.push({
            project: ownerOfPath(row.working_dir),
            workingDir: row.working_dir,
            source: `${projectId}/${table}`,
          })
          brokerEvidence.set(row.id, evidence)
        }
      }
      for (const row of snapshot.events) allIds.add(row.session_id)
    } catch (err) {
      result.errors.push(`${projectId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const native = readOnly(sessionStoreDb, (db) => {
    const query = db.prepare('SELECT cwd FROM sessions WHERE id=?')
    const rows = new Map()
    for (const id of allIds) {
      const row = query.get(id)
      if (typeof row?.cwd === 'string' && isAbsolute(row.cwd)) rows.set(id, row.cwd)
    }
    return rows
  })

  function ownership(id) {
    const cwd = native.get(id)
    if (cwd)
      return {
        project: ownerOfPath(cwd),
        workingDir: cwd,
        source: 'copilot-session-store',
        confidence: 'native',
      }
    const evidence = brokerEvidence.get(id) ?? []
    const owners = new Set(evidence.filter((e) => e.project !== null).map((e) => e.project))
    if (owners.size > 1) return { conflict: evidence }
    if (owners.size === 1) {
      const known = evidence.find((e) => e.project !== null)
      return {
        project: known.project,
        workingDir: known.workingDir,
        source: 'broker-records',
        confidence: 'inferred',
      }
    }
    return null
  }

  for (const snapshot of snapshots) {
    const project = {
      projectId: snapshot.projectId,
      projectRoot: snapshot.root,
      foreignSessions: [],
      foreignEvents: [],
      metadataMismatches: [],
      conflicts: [],
      unknownEventRows: 0,
    }
    const sessions = new Map(snapshot.sessions.map((s) => [s.id, s]))
    const events = new Map(snapshot.events.map((e) => [e.session_id, e.n]))
    const ids = new Set([...sessions.keys(), ...events.keys()])
    for (const id of ids) {
      const row = sessions.get(id)
      const count = events.get(id) ?? 0
      const own = ownership(id)
      if (own?.conflict) {
        project.conflicts.push({ sessionId: id, evidence: own.conflict, events: count })
        continue
      }
      if (!own) {
        project.unknownEventRows += count
        continue
      }
      if (own.project !== snapshot.projectId) {
        const foreign = {
          sessionId: id,
          belongsTo: own.project ?? '(unregistered)',
          events: count,
          ownership: own,
        }
        if (row) {
          project.foreignSessions.push({
            ...foreign,
            workingDir: row.working_dir,
            status: row.status,
          })
        } else {
          project.foreignEvents.push(foreign)
        }
      } else if (
        row &&
        own.confidence === 'native' &&
        !isPathInside(row.working_dir, snapshot.root)
      ) {
        project.metadataMismatches.push({
          sessionId: id,
          workingDir: row.working_dir,
          expectedWorkingDir: own.workingDir,
          events: count,
          ownership: own,
        })
      }
    }
    result.report.push(project)
    result.nSess += project.foreignSessions.length
    result.nSessEv += project.foreignSessions.reduce((n, s) => n + s.events, 0)
    result.nStranded += project.foreignEvents.reduce((n, s) => n + s.events, 0)
    result.nMetadataMismatches += project.metadataMismatches.length
    result.nConflicts += project.conflicts.length
    result.nUnknownEventRows += project.unknownEventRows
  }
}

try {
  audit()
} catch (err) {
  result.errors.push(err instanceof Error ? err.message : String(err))
}
result.complete = result.errors.length === 0

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  for (const project of result.report) {
    console.log(`[${project.projectId}] root=${project.projectRoot}`)
    for (const row of [...project.foreignSessions, ...project.foreignEvents]) {
      console.log(
        `  FOREIGN ${row.sessionId} owner=${row.belongsTo} events=${row.events} evidence=${row.ownership.source}/${row.ownership.confidence}`,
      )
    }
    for (const row of project.metadataMismatches) {
      console.log(
        `  METADATA MISMATCH ${row.sessionId} cwd=${row.workingDir} native=${row.expectedWorkingDir}; preserve ${row.events} native events`,
      )
    }
    for (const row of project.conflicts)
      console.log(`  CONFLICT ${row.sessionId}; do not infer ownership`)
    console.log(
      `  unknown event rows: ${project.unknownEventRows} (not classified as contamination)`,
    )
  }
  for (const error of result.errors) console.error(`INCOMPLETE: ${error}`)
  console.log(
    `foreign sessions: ${result.nSess} (${result.nSessEv} events); stranded foreign events: ${result.nStranded}; metadata mismatches: ${result.nMetadataMismatches}; conflicts: ${result.nConflicts}`,
  )
}

process.exitCode = !result.complete
  ? 2
  : result.nSess + result.nStranded + result.nMetadataMismatches + result.nConflicts > 0
    ? 1
    : 0
