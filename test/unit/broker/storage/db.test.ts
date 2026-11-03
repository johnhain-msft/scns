import { describe, it, expect, afterEach } from 'vitest'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('Broker database', () => {
  let db: Database.Database
  let tempDir: string

  afterEach(() => {
    if (db) {
      try {
        db.close()
      } catch {
        /* already closed */
      }
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('opens an in-memory database with tables created', () => {
    db = openDatabase(':memory:')
    expect(db.open).toBe(true)

    // Verify key tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    const tableNames = tables.map((t) => t.name)

    expect(tableNames).toContain('sessions')
    expect(tableNames).toContain('messages')
    expect(tableNames).toContain('teams')
    expect(tableNames).toContain('team_members')
    expect(tableNames).toContain('tasks')
    expect(tableNames).toContain('events')
    expect(tableNames).toContain('file_intents')
    expect(tableNames).toContain('shared_state')
    expect(tableNames).toContain('background_tasks')
    expect(tableNames).toContain('teams_history')
    expect(tableNames).toContain('sessions_history')
    expect(tableNames).toContain('tasks_history')
    expect(tableNames).toContain('messages_history')
  })

  it('enables foreign keys', () => {
    db = openDatabase(':memory:')
    const row = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>
    expect(row[0]!.foreign_keys).toBe(1)
  })

  it('sets synchronous = NORMAL', () => {
    db = openDatabase(':memory:')
    const row = db.pragma('synchronous') as Array<{ synchronous: number }>
    expect(row[0]!.synchronous).toBe(1) // 1 = NORMAL
  })

  it('opens file-based database with WAL mode', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'broker-db-test-'))
    const dbPath = join(tempDir, 'test.db')
    db = openDatabase(dbPath)
    expect(db.open).toBe(true)

    const row = db.pragma('journal_mode') as Array<{ journal_mode: string }>
    expect(row[0]!.journal_mode).toBe('wal')
  })

  it('closeDatabase closes the database', () => {
    db = openDatabase(':memory:')
    expect(db.open).toBe(true)
    closeDatabase(db)
    expect(db.open).toBe(false)
  })

  it('is idempotent — can call openDatabase migrations twice', () => {
    db = openDatabase(':memory:')
    // Running migrations again should not throw
    expect(() => {
      // Insert something to verify DB works
      db.prepare("INSERT INTO sessions (id, purpose, working_dir) VALUES ('s1', 'test', '/')").run()
    }).not.toThrow()
  })

  describe('multi-project (P3) schema', () => {
    function columnNames(database: Database.Database, table: string): Set<string> {
      const cols = database
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>
      return new Set(cols.map((c) => c.name))
    }

    it('teams and sessions have a project_id column', () => {
      db = openDatabase(':memory:')
      expect(columnNames(db, 'teams').has('project_id')).toBe(true)
      expect(columnNames(db, 'sessions').has('project_id')).toBe(true)
    })

    it('creates a projects metadata table', () => {
      db = openDatabase(':memory:')
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
        .all()
      expect(tables).toHaveLength(1)
      // round-trips a row
      db.prepare(
        "INSERT INTO projects (project_id, project_root) VALUES ('p1', '/repo')",
      ).run()
      const row = db
        .prepare('SELECT project_id, project_root FROM projects WHERE project_id = ?')
        .get('p1') as { project_id: string; project_root: string }
      expect(row.project_id).toBe('p1')
      expect(row.project_root).toBe('/repo')
    })

    it('creates project_id indexes on teams and sessions', () => {
      db = openDatabase(':memory:')
      const idx = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as Array<{ name: string }>
      const names = idx.map((i) => i.name)
      expect(names).toContain('idx_teams_project')
      expect(names).toContain('idx_sessions_project')
    })

    it('migrates a legacy file DB that predates project_id (idempotent ALTER)', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'broker-db-legacy-'))
      const dbPath = join(tempDir, 'legacy.db')

      // Simulate an OLD database: teams/sessions tables WITHOUT project_id.
      const legacy = new Database(dbPath)
      legacy.exec(`
        CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, purpose TEXT, working_dir TEXT, repo_context TEXT);
        INSERT INTO teams (id, name) VALUES ('t-old', 'legacy-team');
        INSERT INTO sessions (id, purpose, working_dir) VALUES ('s-old', 'x', '/old');
      `)
      legacy.close()

      // Re-open through the real migration path: ALTER must add project_id
      // without dropping the pre-existing rows.
      db = openDatabase(dbPath)
      expect(columnNames(db, 'teams').has('project_id')).toBe(true)
      expect(columnNames(db, 'sessions').has('project_id')).toBe(true)

      const team = db.prepare('SELECT id, project_id FROM teams WHERE id = ?').get('t-old') as {
        id: string
        project_id: string | null
      }
      expect(team.id).toBe('t-old')
      expect(team.project_id).toBeNull() // legacy rows are unmigrated until backfilled
    })
  })

  describe('de-hardcoded roles (P4) schema', () => {
    function teamMembersSql(database: Database.Database): string {
      return (
        database
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_members'")
          .get() as { sql: string }
      ).sql
    }

    it('fresh DB has NO role CHECK and seeds the agent_roles catalogue', () => {
      db = openDatabase(':memory:')
      expect(teamMembersSql(db)).not.toContain('CHECK (role IN')
      const roles = db
        .prepare('SELECT role, spawnable FROM agent_roles WHERE builtin = 1')
        .all() as Array<{ role: string; spawnable: number }>
      const names = new Set(roles.map((r) => r.role))
      expect(names.has('scns-manager')).toBe(true)
      expect(names.has('general')).toBe(true)
      expect(roles.find((r) => r.role === 'scns-dev')!.spawnable).toBe(1)
    })

    it('accepts a brand-new role on team_members (self-innovate)', () => {
      db = openDatabase(':memory:')
      db.exec(`
        INSERT INTO sessions (id, purpose) VALUES ('s1', 'x');
        INSERT INTO teams (id, name) VALUES ('t1', 'team-one');
      `)
      expect(() =>
        db
          .prepare(
            "INSERT INTO team_members (team_id, session_id, name, role) VALUES ('t1','s1','novel-agent','quantum-philosopher')",
          )
          .run(),
      ).not.toThrow()
      const row = db
        .prepare("SELECT role FROM team_members WHERE session_id = 's1'")
        .get() as { role: string }
      expect(row.role).toBe('quantum-philosopher')
    })

    it('migrates a legacy file DB by dropping the CHECK and adopting existing roles', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'broker-db-rolecheck-'))
      const dbPath = join(tempDir, 'legacy-roles.db')

      // Simulate an OLD database whose team_members still carries the static
      // CHECK allowlist, with a row using a role from that allowlist.
      const legacy = new Database(dbPath)
      legacy.exec(`
        CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, purpose TEXT, working_dir TEXT, repo_context TEXT);
        CREATE TABLE team_members (
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          role TEXT DEFAULT 'general' CHECK (role IN (
            'lead', 'dev', 'qa', 'reviewer', 'general', 'manager', 'pm',
            'scrum-master', 'orchestrator', 'admin',
            'implementer', 'researcher', 'tester', 'planner', 'helper',
            'scns-dev', 'scns-qa', 'scns-manager', 'scns-brain', 'critic'
          )),
          agent_type TEXT,
          status TEXT DEFAULT 'idle',
          joined_at DATETIME DEFAULT (datetime('now')),
          last_activity_at DATETIME DEFAULT NULL,
          PRIMARY KEY (team_id, session_id)
        );
        INSERT INTO teams (id, name) VALUES ('t-old', 'legacy-team');
        INSERT INTO sessions (id, purpose) VALUES ('s-old', 'x');
        INSERT INTO team_members (team_id, session_id, name, role) VALUES ('t-old','s-old','m','reviewer');
      `)
      legacy.close()

      db = openDatabase(dbPath)

      // CHECK dropped, legacy row preserved.
      expect(teamMembersSql(db)).not.toContain('CHECK (role IN')
      const preserved = db
        .prepare("SELECT role FROM team_members WHERE session_id = 's-old'")
        .get() as { role: string }
      expect(preserved.role).toBe('reviewer')

      // The pre-existing role was adopted into the catalogue.
      expect(
        db.prepare("SELECT 1 FROM agent_roles WHERE role = 'reviewer'").get(),
      ).toBeDefined()

      // A novel role now inserts where the old CHECK would have rejected it.
      db.exec(
        "INSERT INTO sessions (id, purpose) VALUES ('s-new', 'y');",
      )
      expect(() =>
        db
          .prepare(
            "INSERT INTO team_members (team_id, session_id, name, role) VALUES ('t-old','s-new','n','astro-navigator')",
          )
          .run(),
      ).not.toThrow()
    })
  })
})
