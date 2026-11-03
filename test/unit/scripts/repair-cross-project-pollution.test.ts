import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runRepairPlan } from '../../../scripts/repair-cross-project-pollution.mjs'

describe('cross-project repair (isolated SQLite databases only)', () => {
  let home: string
  let dbPath: string
  let metaDb: string
  let sessionStoreDb: string
  let rootA: string
  let rootB: string
  let writer: Database.Database

  function plan() {
    return {
      version: 1,
      projects: [
        {
          projectId: 'a',
          deleteEvents: [{ sessionId: 'foreign-b', ownerProjectId: 'b', expectedEvents: 2 }],
          repairWorkingDirs: [
            {
              sessionId: 'native-a',
              expectedWorkingDir: rootB,
              correctedWorkingDir: rootA,
              expectedEvents: 1,
            },
          ],
        },
      ],
    }
  }

  function options(apply = true) {
    return {
      metaDb,
      projectsDir: join(home, 'projects'),
      sessionStoreDb,
      backupDir: join(home, 'backups'),
      apply,
    }
  }

  function discoveryPlan() {
    const native = new Database(sessionStoreDb)
    native.prepare('INSERT INTO sessions VALUES (?,?)').run('copy-b', rootB)
    native.close()
    writer.exec("ALTER TABLE events ADD COLUMN event_type TEXT DEFAULT 'hook_received'")
    writer
      .prepare("INSERT INTO sessions VALUES (?,?,'completed','discovered')")
      .run('copy-b', rootB)
    writer
      .prepare('INSERT INTO events VALUES (?,?,?,?)')
      .run(4, 'copy-b', '{"source":"discovery","pid":1234}', 'session_registered')
    return {
      version: 1,
      projects: [
        {
          projectId: 'a',
          deleteDiscoveryCopies: [{ sessionId: 'copy-b', ownerProjectId: 'b', expectedEvents: 1 }],
        },
      ],
    }
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'scns-repair-test-'))
    rootA = join(home, 'repo-a')
    rootB = join(home, 'repo-b')
    metaDb = join(home, 'meta.db')
    sessionStoreDb = join(home, 'copilot.db')
    mkdirSync(join(home, 'projects', 'a'), { recursive: true })
    dbPath = join(home, 'projects', 'a', 'data.db')
    const meta = new Database(metaDb)
    meta.exec('CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_root TEXT)')
    meta.prepare('INSERT INTO projects VALUES (?,?)').run('a', rootA)
    meta.prepare('INSERT INTO projects VALUES (?,?)').run('b', rootB)
    meta.close()
    const native = new Database(sessionStoreDb)
    native.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)')
    native.prepare('INSERT INTO sessions VALUES (?,?)').run('native-a', rootA)
    native.prepare('INSERT INTO sessions VALUES (?,?)').run('foreign-b', rootB)
    native.close()
    writer = new Database(dbPath)
    writer.pragma('journal_mode = WAL')
    writer.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT, status TEXT, purpose TEXT);
      CREATE TABLE events (id INTEGER PRIMARY KEY, session_id TEXT, payload TEXT);
      INSERT INTO events VALUES (1,'foreign-b','{"foreign":1}'),(2,'foreign-b','{"foreign":2}'),
                                (3,'native-a','{"native":"preserve me"}');
    `)
    writer
      .prepare("INSERT INTO sessions VALUES (?,?,'completed','original purpose')")
      .run('native-a', rootB)
  })

  afterEach(() => {
    writer.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('backs up committed WAL content, deletes only foreign events and repairs only the wrong cwd', async () => {
    const result = await runRepairPlan(plan(), options())
    expect(result.projects[0]).toMatchObject({ deletedEvents: 2, repairedSessions: 1 })
    expect(writer.prepare('SELECT * FROM events ORDER BY id').all()).toEqual([
      { id: 3, session_id: 'native-a', payload: '{"native":"preserve me"}' },
    ])
    expect(writer.prepare('SELECT * FROM sessions').get()).toEqual({
      id: 'native-a',
      working_dir: rootA,
      status: 'completed',
      purpose: 'original purpose',
    })
    const backup = new Database(result.projects[0].backupPath, { readonly: true })
    try {
      expect(backup.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 3 })
      expect(backup.prepare('SELECT working_dir FROM sessions').get()).toEqual({
        working_dir: rootB,
      })
      expect(backup.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally {
      backup.close()
    }
  })

  it('is read-only unless apply is explicit', async () => {
    const result = await runRepairPlan(plan(), options(false))
    expect(result.applied).toBe(false)
    expect(existsSync(options().backupDir)).toBe(false)
    expect(writer.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 3 })
    expect(writer.prepare('SELECT working_dir FROM sessions').get()).toEqual({ working_dir: rootB })
  })

  it('does nothing on a second run, without rewriting backups or requiring a new backup directory', async () => {
    await runRepairPlan(plan(), options())
    const result = await runRepairPlan(plan(), options())
    expect(result.projects[0]).toMatchObject({
      deletedEvents: 0,
      repairedSessions: 0,
      alreadyClean: true,
    })
    expect(writer.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 })
  })

  it('refuses unexpected row counts before making any change', async () => {
    writer.exec("INSERT INTO events VALUES (4,'foreign-b','new event after audit')")
    await expect(runRepairPlan(plan(), options())).rejects.toThrow(/count/i)
    expect(writer.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 4 })
    expect(existsSync(options().backupDir)).toBe(false)
  })

  it('refuses to delete native events even when the plan calls them foreign', async () => {
    const native = new Database(sessionStoreDb)
    native.prepare('UPDATE sessions SET cwd=? WHERE id=?').run(rootA, 'foreign-b')
    native.close()
    await expect(runRepairPlan(plan(), options())).rejects.toThrow(/ownership/i)
    expect(writer.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 3 })
  })

  it('rolls back if a trigger changes any untargeted event', async () => {
    writer.exec(`
      CREATE TRIGGER bad_delete AFTER DELETE ON events BEGIN
        DELETE FROM events WHERE session_id='native-a';
      END;
    `)
    await expect(runRepairPlan(plan(), options())).rejects.toThrow(/retained/i)
    expect(writer.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 3 })
    expect(writer.prepare('SELECT working_dir FROM sessions').get()).toEqual({ working_dir: rootB })
  })

  it('rejects duplicate project or session operations instead of applying them twice', async () => {
    const p = plan()
    p.projects.push(p.projects[0]!)
    await expect(runRepairPlan(p, options())).rejects.toThrow(/duplicate/i)
    expect(existsSync(options().backupDir)).toBe(false)
  })

  it('removes an approved foreign discovery copy without deleting any native session', async () => {
    const p = discoveryPlan()
    const nativeBefore = writer.prepare('SELECT * FROM sessions WHERE id=?').get('native-a')
    const result = await runRepairPlan(p, options())
    expect(result.projects[0]).toMatchObject({ deletedEvents: 1, deletedSessions: 1 })
    expect(writer.prepare('SELECT * FROM sessions WHERE id=?').get('copy-b')).toBeUndefined()
    expect(writer.prepare('SELECT * FROM events WHERE session_id=?').all('copy-b')).toEqual([])
    expect(writer.prepare('SELECT * FROM sessions WHERE id=?').get('native-a')).toEqual(
      nativeBefore,
    )
    expect((await runRepairPlan(p, options())).projects[0]).toMatchObject({
      deletedEvents: 0,
      deletedSessions: 0,
      alreadyClean: true,
    })
  })

  it('refuses a discovery-copy deletion when it has dependent data', async () => {
    const p = discoveryPlan()
    writer.exec(
      "CREATE TABLE dependent (session_id TEXT REFERENCES sessions(id)); INSERT INTO dependent VALUES ('copy-b')",
    )
    await expect(runRepairPlan(p, options())).rejects.toThrow(/dependent/i)
    expect(writer.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 2 })
    expect(existsSync(options().backupDir)).toBe(false)
  })

  it('refuses discovery cleanup if real hooks or non-discovery work have arrived', async () => {
    const p = discoveryPlan()
    writer.prepare("UPDATE events SET event_type='hook_received' WHERE id=4").run()
    await expect(runRepairPlan(p, options())).rejects.toThrow(/discovery/i)
    expect(writer.prepare('SELECT * FROM sessions WHERE id=?').get('copy-b')).toBeDefined()
  })
})
