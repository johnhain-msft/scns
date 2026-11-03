/* eslint-disable no-console */
/**
 * Apply an explicitly approved, exact-count repair plan. Dry-run by default.
 * Session deletion is limited to explicitly approved, completed discovery copies
 * with native ownership evidence, registration-only events, and no dependents.
 * SQLite backups include committed WAL content; every write is transactional
 * and checked against all retained events and all expected session fields.
 *
 * node scripts/repair-cross-project-pollution.mjs --plan plan.json
 * Add --apply --backup-dir <new-directory> only after reviewing the preview.
 * Database locations use the same SCNS_* overrides as the read-only auditor.
 */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/)
const pathSchema = z.string().refine(isAbsolute, 'must be an absolute path')
const planSchema = z
  .object({
    version: z.literal(1),
    projects: z
      .array(
        z
          .object({
            projectId: projectIdSchema,
            deleteDiscoveryCopies: z
              .array(
                z
                  .object({
                    sessionId: z.string().min(1),
                    ownerProjectId: projectIdSchema,
                    expectedEvents: z.number().int().positive(),
                  })
                  .strict(),
              )
              .default([]),
            deleteEvents: z
              .array(
                z
                  .object({
                    sessionId: z.string().min(1),
                    ownerProjectId: projectIdSchema,
                    expectedEvents: z.number().int().positive(),
                  })
                  .strict(),
              )
              .default([]),
            repairWorkingDirs: z
              .array(
                z
                  .object({
                    sessionId: z.string().min(1),
                    expectedWorkingDir: pathSchema,
                    correctedWorkingDir: pathSchema,
                    expectedEvents: z.number().int().nonnegative(),
                  })
                  .strict(),
              )
              .default([]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()

function canonical(path) {
  const value = resolve(path)
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function inside(path, root) {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  const rel = relative(canonical(root), canonical(path))
  return !isAbsolute(rel) && rel.split(sep)[0] !== '..'
}

const hash = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex')
const open = (path, readonly = true) =>
  new Database(path, { readonly, fileMustExist: true, timeout: 5_000 })

export async function runRepairPlan(input, options) {
  const plan = planSchema.parse(input)
  const seenProjects = new Set()
  for (const project of plan.projects) {
    if (seenProjects.has(project.projectId)) throw new Error('Duplicate project in repair plan')
    seenProjects.add(project.projectId)
    const ids = [
      ...project.deleteEvents,
      ...project.deleteDiscoveryCopies,
      ...project.repairWorkingDirs,
    ].map((op) => op.sessionId)
    if (new Set(ids).size !== ids.length)
      throw new Error('Duplicate session operation in repair plan')
  }
  const meta = open(options.metaDb)
  let roots
  try {
    roots = meta.prepare('SELECT project_id, project_root FROM projects').all()
  } finally {
    meta.close()
  }
  for (const root of roots) pathSchema.parse(root.project_root)
  if (new Set(roots.map((r) => canonical(r.project_root))).size !== roots.length) {
    throw new Error('Duplicate registry root makes ownership ambiguous')
  }
  roots.sort((a, b) => canonical(b.project_root).length - canonical(a.project_root).length)
  const ownerOf = (cwd) => roots.find((r) => inside(cwd, r.project_root))?.project_id
  const native = open(options.sessionStoreDb)
  const report = { applied: Boolean(options.apply), projects: [] }
  try {
    const nativeCwd = native.prepare('SELECT cwd FROM sessions WHERE id=?')
    function inspect(db, project) {
      const sessions = db.prepare('SELECT * FROM sessions ORDER BY id').all()
      const events = db.prepare('SELECT * FROM events ORDER BY id').all()
      const eventOperations = [...project.deleteEvents, ...project.deleteDiscoveryCopies]
      const deletionIds = new Set(eventOperations.map((op) => op.sessionId))
      const deletedSessions = []
      for (const op of eventOperations) {
        const cwd = nativeCwd.get(op.sessionId)?.cwd
        if (op.ownerProjectId === project.projectId || ownerOf(cwd) !== op.ownerProjectId) {
          throw new Error(
            `Native ownership does not authorize deleting ${op.sessionId} from ${project.projectId}`,
          )
        }
        const row = sessions.find((s) => s.id === op.sessionId)
        const discoveryCopy = project.deleteDiscoveryCopies.includes(op)
        if (row && !discoveryCopy) {
          throw new Error(
            `Session ${op.sessionId} still exists; this tool only deletes stranded events`,
          )
        }
        const matchingEvents = events.filter((e) => e.session_id === op.sessionId)
        const count = matchingEvents.length
        if (discoveryCopy) {
          if (
            matchingEvents.some(
              (e) =>
                e.event_type !== 'session_registered' ||
                JSON.parse(e.payload).source !== 'discovery',
            )
          ) {
            throw new Error(`Non-discovery work exists for ${op.sessionId}`)
          }
          if (row) {
            if (
              row.purpose !== 'discovered' ||
              row.status !== 'completed' ||
              typeof row.working_dir !== 'string' ||
              canonical(row.working_dir) !== canonical(cwd) ||
              count !== op.expectedEvents
            ) {
              throw new Error(
                `Session is not the approved completed discovery copy: ${op.sessionId}`,
              )
            }
            const quote = (name) => `"${name.replaceAll('"', '""')}"`
            for (const table of db
              .prepare("SELECT name FROM sqlite_master WHERE type='table'")
              .all()) {
              for (const fk of db.prepare(`PRAGMA foreign_key_list(${quote(table.name)})`).all()) {
                if (fk.table !== 'sessions') continue
                const references = db
                  .prepare(
                    `SELECT COUNT(*) AS n FROM ${quote(table.name)} WHERE ${quote(fk.from)}=?`,
                  )
                  .get(op.sessionId).n
                if (references)
                  throw new Error(`Dependent data in ${table.name} for ${op.sessionId}`)
              }
            }
            deletedSessions.push(row)
          }
        }
        if (count !== 0 && count !== op.expectedEvents) {
          throw new Error(
            `Event count changed for ${op.sessionId}: expected ${op.expectedEvents}, found ${count}`,
          )
        }
      }
      const repairs = []
      for (const op of project.repairWorkingDirs) {
        const cwd = nativeCwd.get(op.sessionId)?.cwd
        if (
          ownerOf(cwd) !== project.projectId ||
          canonical(cwd) !== canonical(op.correctedWorkingDir)
        ) {
          throw new Error(`Native ownership does not authorize the cwd repair for ${op.sessionId}`)
        }
        const row = sessions.find((s) => s.id === op.sessionId)
        if (!row) throw new Error(`Session disappeared before metadata repair: ${op.sessionId}`)
        if (row.working_dir === op.correctedWorkingDir) continue
        if (row.working_dir !== op.expectedWorkingDir) {
          throw new Error(`Unexpected current working_dir for ${op.sessionId}`)
        }
        const count = events.filter((e) => e.session_id === op.sessionId).length
        if (count !== op.expectedEvents)
          throw new Error(`Native event count changed for ${op.sessionId}`)
        repairs.push(op)
      }
      const deleted = events.filter((e) => deletionIds.has(e.session_id))
      const retained = events.filter((e) => !deletionIds.has(e.session_id))
      const deletedSessionIds = new Set(deletedSessions.map((s) => s.id))
      const expectedSessions = sessions
        .filter((row) => !deletedSessionIds.has(row.id))
        .map((row) => {
          const repair = repairs.find((op) => op.sessionId === row.id)
          return repair ? { ...row, working_dir: repair.correctedWorkingDir } : row
        })
      return {
        deleted,
        deletedSessions,
        repairs,
        deletedHash: hash(deleted),
        retainedEventsHash: hash(retained),
        expectedSessionsHash: hash(expectedSessions),
      }
    }

    const prepared = plan.projects.map((project) => {
      if (!roots.some((r) => r.project_id === project.projectId)) {
        throw new Error(`Project is not registered: ${project.projectId}`)
      }
      const dbPath = join(options.projectsDir, project.projectId, 'data.db')
      const db = open(dbPath)
      try {
        return { project, dbPath, before: db.transaction(() => inspect(db, project))() }
      } finally {
        db.close()
      }
    })
    const pending = prepared.filter(
      (p) => p.before.deleted.length || p.before.repairs.length || p.before.deletedSessions.length,
    )
    if (!options.apply || pending.length === 0) {
      report.projects = prepared.map((p) => ({
        projectId: p.project.projectId,
        deletedEvents: options.apply ? 0 : p.before.deleted.length,
        deletedSessions: options.apply ? 0 : p.before.deletedSessions.length,
        repairedSessions: options.apply ? 0 : p.before.repairs.length,
        alreadyClean:
          p.before.deleted.length === 0 &&
          p.before.repairs.length === 0 &&
          p.before.deletedSessions.length === 0,
      }))
      return report
    }
    pathSchema.parse(options.backupDir)
    if (existsSync(options.backupDir))
      throw new Error('Backup directory already exists; refusing to overwrite')
    mkdirSync(dirname(options.backupDir), { recursive: true })
    mkdirSync(options.backupDir)
    writeFileSync(join(options.backupDir, 'repair-plan.json'), JSON.stringify(plan, null, 2), {
      flag: 'wx',
    })

    // Complete and verify every backup before changing the first database.
    for (const item of pending) {
      item.backupPath = join(options.backupDir, `${item.project.projectId}.db`)
      const source = open(item.dbPath)
      try {
        await source.backup(item.backupPath)
      } finally {
        source.close()
      }
      const backup = open(item.backupPath)
      try {
        if (backup.pragma('integrity_check', { simple: true }) !== 'ok') {
          throw new Error(`Backup integrity check failed: ${item.backupPath}`)
        }
        const saved = inspect(backup, item.project)
        if (
          saved.deletedHash !== item.before.deletedHash ||
          hash(saved.deletedSessions) !== hash(item.before.deletedSessions) ||
          hash(saved.repairs) !== hash(item.before.repairs)
        ) {
          throw new Error(`Target rows changed during backup: ${item.project.projectId}`)
        }
      } finally {
        backup.close()
      }
    }

    for (const item of pending) {
      const db = open(item.dbPath, false)
      try {
        db.pragma('foreign_keys = ON')
        const applied = db
          .transaction(() => {
            const current = inspect(db, item.project)
            if (
              current.deletedHash !== item.before.deletedHash ||
              hash(current.deletedSessions) !== hash(item.before.deletedSessions) ||
              hash(current.repairs) !== hash(item.before.repairs)
            ) {
              throw new Error(`Target rows changed after backup: ${item.project.projectId}`)
            }
            const remove = db.prepare('DELETE FROM events WHERE session_id=?')
            let deletedEvents = 0
            for (const op of [...item.project.deleteEvents, ...item.project.deleteDiscoveryCopies])
              deletedEvents += remove.run(op.sessionId).changes
            const removeSession = db.prepare(
              "DELETE FROM sessions WHERE id=? AND purpose='discovered' AND status='completed' AND working_dir=?",
            )
            let deletedSessions = 0
            for (const row of current.deletedSessions) {
              deletedSessions += removeSession.run(row.id, row.working_dir).changes
            }
            const update = db.prepare(
              'UPDATE sessions SET working_dir=? WHERE id=? AND working_dir=?',
            )
            let repairedSessions = 0
            for (const op of current.repairs) {
              repairedSessions += update.run(
                op.correctedWorkingDir,
                op.sessionId,
                op.expectedWorkingDir,
              ).changes
            }
            if (
              deletedEvents !== current.deleted.length ||
              deletedSessions !== current.deletedSessions.length ||
              repairedSessions !== current.repairs.length
            ) {
              throw new Error('Affected row counts differ from the approved targets')
            }
            if (
              hash(db.prepare('SELECT * FROM events ORDER BY id').all()) !==
              current.retainedEventsHash
            ) {
              throw new Error('Retained event content changed; rolling back')
            }
            if (
              hash(db.prepare('SELECT * FROM sessions ORDER BY id').all()) !==
              current.expectedSessionsHash
            ) {
              throw new Error('Retained session content changed; rolling back')
            }
            if (db.pragma('foreign_key_check').length !== 0)
              throw new Error('Foreign-key check failed; rolling back')
            return {
              projectId: item.project.projectId,
              deletedEvents,
              deletedSessions,
              repairedSessions,
              backupPath: item.backupPath,
              retainedEventsHash: current.retainedEventsHash,
              expectedSessionsHash: current.expectedSessionsHash,
            }
          })
          .immediate()
        report.projects.push(applied)
      } finally {
        db.close()
      }
    }
    return report
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    error.completedProjects = report.projects
    throw error
  } finally {
    native.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const arg = (name) => {
    const index = args.indexOf(name)
    return index < 0 ? undefined : args[index + 1]
  }
  try {
    const planPath = arg('--plan')
    if (!planPath)
      throw new Error('Pass --plan <approved-plan.json>; writes additionally require --apply')
    const report = await runRepairPlan(JSON.parse(readFileSync(planPath, 'utf8')), {
      metaDb: process.env.SCNS_META_DB ?? join(homedir(), '.scns', 'meta-broker.db'),
      projectsDir:
        process.env.SCNS_PROJECT_DB_DIR ?? join(homedir(), '.session-broker', 'projects'),
      sessionStoreDb:
        process.env.SCNS_SESSION_STORE_DB ?? join(homedir(), '.copilot', 'session-store.db'),
      backupDir: arg('--backup-dir'),
      apply: args.includes('--apply'),
    })
    console.log(JSON.stringify({ ok: true, ...report }, null, 2))
  } catch (err) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          completedProjects: err.completedProjects ?? [],
        },
        null,
        2,
      ),
    )
    process.exitCode = 2
  }
}
