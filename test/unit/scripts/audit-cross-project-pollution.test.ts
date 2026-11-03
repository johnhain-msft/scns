import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

interface AuditReport {
  nSess: number
  nSessEv: number
  nStranded: number
  nMetadataMismatches: number
  nConflicts: number
  nUnknownEventRows: number
  complete: boolean
  errors: string[]
  report: Array<{
    projectId: string
    foreignSessions: Array<{ sessionId: string }>
    foreignEvents: Array<{ sessionId: string; belongsTo: string; events: number }>
    metadataMismatches: Array<{ sessionId: string; expectedWorkingDir: string; events: number }>
  }>
}

describe('cross-project auditor CLI (isolated SQLite fixtures only)', () => {
  let home: string
  let metaPath: string
  let sessionStorePath: string
  let projectsDir: string
  let rootA: string
  let rootB: string

  function withDb(path: string, work: (db: Database.Database) => void): void {
    const db = new Database(path)
    try {
      work(db)
    } finally {
      db.close()
    }
  }

  function project(id: string, root: string): string {
    withDb(metaPath, (db) => {
      db.prepare('INSERT INTO projects VALUES (?,?)').run(id, root)
    })
    const dir = join(projectsDir, id)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'data.db')
    withDb(path, (db) => {
      db.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT, status TEXT);
        CREATE TABLE sessions_history (id TEXT, working_dir TEXT);
        CREATE TABLE events (id INTEGER PRIMARY KEY, session_id TEXT, payload TEXT);
      `)
    })
    return path
  }

  function owner(id: string, cwd: string): void {
    withDb(sessionStorePath, (db) => {
      db.prepare('INSERT INTO sessions VALUES (?,?)').run(id, cwd)
    })
  }

  function run(overrides: Record<string, string> = {}) {
    const result = spawnSync(
      process.execPath,
      [resolve('scripts', 'audit-cross-project-pollution.mjs'), '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          SCNS_HOME: home,
          BROKER_DB_PATH: join(home, 'unused-broker.db'),
          SCNS_META_DB: metaPath,
          SCNS_PROJECT_DB_DIR: projectsDir,
          SCNS_SESSION_STORE_DB: sessionStorePath,
          ...overrides,
        },
      },
    )
    expect(result.error).toBeUndefined()
    return { code: result.status, report: JSON.parse(result.stdout) as AuditReport }
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'scns-audit-test-'))
    metaPath = join(home, 'meta.db')
    sessionStorePath = join(home, 'session-store.db')
    projectsDir = join(home, 'projects')
    rootA = join(home, 'repo-a')
    rootB = join(home, 'repo-b')
    mkdirSync(projectsDir)
    withDb(metaPath, (db) => {
      db.exec('CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_root TEXT)')
    })
    withDb(sessionStorePath, (db) => {
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)')
    })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('finds orphaned foreign events using native session history after broker rows are reaped', () => {
    project('a', rootA)
    const b = project('b', rootB)
    owner('orphan-from-a', rootA)
    withDb(b, (db) => {
      db.exec("INSERT INTO events VALUES (1,'orphan-from-a','{}'),(2,'orphan-from-a','{}')")
    })
    const result = run()
    expect(result.code).toBe(1)
    expect(result.report.nStranded).toBe(2)
    expect(result.report.report.find((p) => p.projectId === 'b')?.foreignEvents).toEqual([
      expect.objectContaining({ sessionId: 'orphan-from-a', belongsTo: 'a', events: 2 }),
    ])
  })

  it('does not call native events pollution because a hook used the broker cwd as metadata', () => {
    project('a', rootA)
    const b = project('b', rootB)
    owner('native-b', rootB)
    withDb(b, (db) => {
      db.prepare("INSERT INTO sessions VALUES (?,?,'completed')").run('native-b', rootA)
      db.exec("INSERT INTO events VALUES (1,'native-b','{}'),(2,'native-b','{}')")
    })
    const result = run()
    expect(result.report.nSess).toBe(0)
    expect(result.report.nSessEv).toBe(0)
    expect(result.report.nStranded).toBe(0)
    expect(result.report.nMetadataMismatches).toBe(1)
    expect(result.report.report.find((p) => p.projectId === 'b')?.metadataMismatches).toEqual([
      expect.objectContaining({ sessionId: 'native-b', expectedWorkingDir: rootB, events: 2 }),
    ])
  })

  it('keeps unknown reaped events separate from proven contamination', () => {
    const a = project('a', rootA)
    withDb(a, (db) => {
      db.exec("INSERT INTO events VALUES (1,'reaped-unknown','{}'),(2,NULL,'{}')")
    })
    const result = run()
    expect(result.code).toBe(0)
    expect(result.report.nStranded).toBe(0)
    expect(result.report.nUnknownEventRows).toBe(1)
  })

  it('does not resolve contradictory broker ownership by whichever directory is read first', () => {
    const a = project('a', rootA)
    const b = project('b', rootB)
    withDb(a, (db) => {
      db.prepare("INSERT INTO sessions VALUES (?,?,'completed')").run('ambiguous', rootA)
    })
    withDb(b, (db) => {
      db.prepare('INSERT INTO sessions_history VALUES (?,?)').run('ambiguous', rootB)
      db.exec("INSERT INTO events VALUES (1,'ambiguous','{}')")
    })
    const result = run()
    expect(result.report.nStranded).toBe(0)
    expect(result.report.nConflicts).toBeGreaterThan(0)
  })

  it('uses the deepest registered root rather than the first containing parent', () => {
    const parent = project('a-parent', rootA)
    const childRoot = join(rootA, 'nested')
    project('z-child', childRoot)
    owner('nested-session', childRoot)
    withDb(parent, (db) => {
      db.exec("INSERT INTO events VALUES (1,'nested-session','{}')")
    })
    const result = run()
    expect(result.report.report.find((p) => p.projectId === 'a-parent')?.foreignEvents).toEqual([
      expect.objectContaining({ sessionId: 'nested-session', belongsTo: 'z-child' }),
    ])
  })

  it('fails explicitly when the registry is missing, rather than reporting skipped DBs as clean', () => {
    project('a', rootA)
    const result = run({ SCNS_META_DB: join(home, 'missing-meta.db') })
    expect(result.code).toBe(2)
    expect(result.report.complete).toBe(false)
    expect(result.report.errors.length).toBeGreaterThan(0)
  })

  it('does not modify any input database', () => {
    const a = project('a', rootA)
    owner('native-a', rootA)
    withDb(a, (db) => {
      db.prepare("INSERT INTO sessions VALUES (?,?,'active')").run('native-a', rootA)
    })
    const paths = [a, metaPath, sessionStorePath]
    const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
    const before = paths.map(digest)
    expect(run().code).toBe(0)
    expect(paths.map(digest)).toEqual(before)
  })
})
