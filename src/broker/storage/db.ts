import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function runMigrations(db: Database.Database): void {
  const schemaPath = join(__dirname, 'schema.sql')
  const schema = readFileSync(schemaPath, 'utf-8')
  db.exec(schema)

  // Idempotent migrations for columns that may already exist
  const migrations = [
    'ALTER TABLE sessions ADD COLUMN archived_at DATETIME DEFAULT NULL',
    'ALTER TABLE teams ADD COLUMN archived_at DATETIME DEFAULT NULL',
    'ALTER TABLE teams ADD COLUMN parent_team_id TEXT REFERENCES teams(id) ON DELETE CASCADE',
    'ALTER TABLE sessions ADD COLUMN repo_context TEXT',
    'ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id)',
    'ALTER TABLE sessions ADD COLUMN branch_point_message_id TEXT',
    'ALTER TABLE messages ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE SET NULL',
    'ALTER TABLE messages ADD COLUMN seq INTEGER',
    'ALTER TABLE messages ADD COLUMN to_role TEXT',
    'ALTER TABLE messages ADD COLUMN to_team TEXT',
    'CREATE INDEX IF NOT EXISTS idx_messages_team_seq ON messages(team_id, seq)',
    // Phase 13.12.25: track last ACP activity per team member so the
    // team-reaper does not prematurely archive live agents whose status
    // column is momentarily outside ('working','idle') during long tool calls.
    'ALTER TABLE team_members ADD COLUMN last_activity_at DATETIME DEFAULT NULL',
    // WS P (Phase 13.13.x): durable dispatch audit columns on the tasks row.
    // The task row is the audit trail that survives messages + messages_history
    // purging, so manager-exit-monitor can short-circuit no_readback false-
    // positives without depending on still-resident message rows.
    'ALTER TABLE tasks ADD COLUMN dispatch_id TEXT',
    'ALTER TABLE tasks ADD COLUMN dispatch_readback_at TEXT',
    'ALTER TABLE tasks ADD COLUMN dispatch_manager_session_id TEXT',
    'ALTER TABLE tasks ADD COLUMN dispatch_dev_session_id TEXT',
    'ALTER TABLE tasks ADD COLUMN dispatch_qa_session_id TEXT',
    'CREATE INDEX IF NOT EXISTS idx_tasks_dispatch_lookup ON tasks(team_id, dispatch_manager_session_id, dispatch_readback_at)',
    // WS R (Phase 13.13.x): gate-driven task completion. The quality
    // gate verdict subscriber transitions the row directly when it
    // sees a passing PASS for a WS-P-attributed task. Idempotent
    // ALTERs — duplicate-column errors are swallowed by the loop.
    'ALTER TABLE tasks ADD COLUMN quality_check_id TEXT',
    'ALTER TABLE tasks ADD COLUMN completed_at TEXT',
    // P0.3 (2026-05-19): durable audit columns for auto-merge completions.
    // See task-completion-gate.ts:completeTaskByMerge. NULL on legacy rows.
    'ALTER TABLE tasks ADD COLUMN merge_sha TEXT',
    'ALTER TABLE tasks ADD COLUMN completion_source TEXT',
    // Task 34 (neuron fan-out): per-team isolated working tree. Idempotent
    // ALTER for existing DBs; schema.sql declares it for greenfield. See
    // commit f26cabf — column-dependent indexes belong in migrations, not
    // schema.sql, so any future index on working_dir would live here.
    'ALTER TABLE teams ADD COLUMN working_dir TEXT',
    // Multi-project foundation (P3): project_id on teams + sessions so a
    // broker pointed at repo A does not act on repo B's teams/sessions.
    // NULL on legacy rows (excluded from autonomous project-scoped reads).
    'ALTER TABLE teams ADD COLUMN project_id TEXT',
    'ALTER TABLE sessions ADD COLUMN project_id TEXT',
    'CREATE INDEX IF NOT EXISTS idx_teams_project ON teams(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)',
    // Issue #70: message delivery/acknowledgement ladder + idempotent sends.
    // client_message_id is unique per sender (partial index) so a retried send
    // with the same id lands as one logical message. delivered_at / disposition
    // separate "reached the recipient's context" and "explicit verdict" from
    // read_at. Idempotent ALTERs; duplicate-column errors swallowed by the loop.
    'ALTER TABLE messages ADD COLUMN client_message_id TEXT',
    'ALTER TABLE messages ADD COLUMN delivered_at DATETIME',
    // NOTE: `IN (..., NULL)` would be a no-op CHECK (three-valued logic makes
    // it pass for any value); the IS NULL OR form actually constrains.
    "ALTER TABLE messages ADD COLUMN disposition TEXT CHECK (disposition IS NULL OR disposition IN ('accepted', 'rejected', 'deferred'))",
    'ALTER TABLE messages ADD COLUMN disposition_at DATETIME',
    'ALTER TABLE messages ADD COLUMN disposition_note TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id ON messages(sender_id, client_message_id) WHERE client_message_id IS NOT NULL',
    // Issue #70: settlement carries the acknowledgement record into history.
    'ALTER TABLE messages_history ADD COLUMN client_message_id TEXT',
    'ALTER TABLE messages_history ADD COLUMN delivered_at DATETIME',
    'ALTER TABLE messages_history ADD COLUMN disposition TEXT',
    'ALTER TABLE messages_history ADD COLUMN disposition_at DATETIME',
    'ALTER TABLE messages_history ADD COLUMN disposition_note TEXT',
  ]
  for (const sql of migrations) {
    try {
      db.exec(sql)
    } catch {
      /* column already exists */
    }
  }

  // WS R (Phase 13.13.x): hard-verify the WS-P + WS-R additive columns
  // landed. The migration loop swallows ALL errors, so a non-duplicate
  // failure (e.g. transient lock, FS error) would silently leave the
  // tasks table in a degraded state and crash later SQL with confusing
  // "no such column" errors. Verify via PRAGMA and throw early.
  try {
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    const present = new Set(cols.map((c) => c.name))
    const required = [
      'dispatch_id',
      'dispatch_readback_at',
      'dispatch_manager_session_id',
      'dispatch_dev_session_id',
      'dispatch_qa_session_id',
      'quality_check_id',
      'completed_at',
    ]
    const missing = required.filter((c) => !present.has(c))
    if (missing.length > 0) {
      throw new Error(
        `tasks table is missing required columns after migrations: ${missing.join(', ')}`,
      )
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('tasks table is missing')) throw err
    /* PRAGMA itself failed — leave alone, tests will surface the issue */
  }

  // Multi-project (P3): hard-verify project_id landed on teams + sessions.
  // Same rationale as the tasks verification above — a swallowed non-duplicate
  // failure would leave project-scoped queries crashing with "no such column".
  try {
    const check = (table: string): void => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'project_id')) {
        throw new Error(`${table} table is missing required column project_id after migrations`)
      }
    }
    check('teams')
    check('sessions')
  } catch (err) {
    if (err instanceof Error && err.message.includes('missing required column project_id')) {
      throw err
    }
    /* PRAGMA itself failed — leave alone, tests will surface the issue */
  }

  // P4 (de-hardcode roles): seed the agent_roles catalogue + drop the static
  // CHECK allowlist on team_members.role so the system can self-innovate (mint
  // novel agent roles at runtime). schema.sql already CREATEs agent_roles and a
  // CHECK-free team_members for greenfield DBs; this block handles legacy files.
  try {
    // 1. Seed builtin roles (idempotent). spawnable=1 only for roles that have a
    //    bespoke task-spawn prompt strategy (see services/task-spawn-prompt.ts).
    const BUILTIN_ROLES: ReadonlyArray<{ role: string; spawnable: 0 | 1 }> = [
      { role: 'general', spawnable: 0 },
      { role: 'lead', spawnable: 0 },
      { role: 'dev', spawnable: 0 },
      { role: 'qa', spawnable: 0 },
      { role: 'reviewer', spawnable: 0 },
      { role: 'manager', spawnable: 0 },
      { role: 'pm', spawnable: 0 },
      { role: 'scrum-master', spawnable: 0 },
      { role: 'orchestrator', spawnable: 0 },
      { role: 'admin', spawnable: 0 },
      { role: 'implementer', spawnable: 0 },
      { role: 'researcher', spawnable: 0 },
      { role: 'tester', spawnable: 0 },
      { role: 'planner', spawnable: 0 },
      { role: 'helper', spawnable: 0 },
      { role: 'critic', spawnable: 0 },
      { role: 'scns-brain', spawnable: 0 },
      { role: 'scns-dev', spawnable: 1 },
      { role: 'scns-qa', spawnable: 1 },
      { role: 'scns-manager', spawnable: 1 },
      { role: 'scns-researcher', spawnable: 1 },
    ]
    const seedBuiltin = db.prepare(
      `INSERT INTO agent_roles (role, description, builtin, spawnable, created_at)
       VALUES (?, NULL, 1, ?, datetime('now'))
       ON CONFLICT(role) DO UPDATE SET builtin = 1, spawnable = excluded.spawnable`,
    )
    const seedTx = db.transaction(() => {
      for (const r of BUILTIN_ROLES) seedBuiltin.run(r.role, r.spawnable)
    })
    seedTx()

    // 2. Adopt any pre-existing roles already in team_members (live data or test
    //    fixtures) as non-builtin catalogue entries so dropping the CHECK never
    //    leaves an orphaned, undiscoverable role.
    db.exec(
      `INSERT OR IGNORE INTO agent_roles (role, description, builtin, spawnable, created_at)
       SELECT DISTINCT role, NULL, 0, 0, datetime('now')
       FROM team_members WHERE role IS NOT NULL AND trim(role) <> ''`,
    )
  } catch {
    /* best-effort seed; the CHECK-drop below + hard-verify is the real guard */
  }

  // SQLite cannot ALTER a CHECK constraint, so rebuild team_members WITHOUT the
  // old `CHECK (role IN (...))` allowlist. Idempotent: runs only while the live
  // table still carries the CHECK. Non-duplicate failures must NOT be swallowed
  // — a silent failure would leave self-innovation blocked, so we hard-verify.
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_members'")
      .get() as { sql: string } | undefined
    if (row && row.sql && row.sql.includes('CHECK (role IN')) {
      const fkPrev = (db.pragma('foreign_keys', { simple: true }) as number) ?? 1
      db.pragma('foreign_keys = OFF')
      try {
        db.exec(`
          BEGIN TRANSACTION;
          CREATE TABLE team_members_new (
            team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'general',
            agent_type TEXT,
            status TEXT DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'shutdown')),
            joined_at DATETIME DEFAULT (datetime('now')),
            last_activity_at DATETIME DEFAULT NULL,
            PRIMARY KEY (team_id, session_id)
          );
          INSERT INTO team_members_new (team_id, session_id, name, role, agent_type, status, joined_at, last_activity_at)
            SELECT team_id, session_id, name, role, agent_type, status, joined_at, last_activity_at FROM team_members;
          DROP TABLE team_members;
          ALTER TABLE team_members_new RENAME TO team_members;
          CREATE INDEX IF NOT EXISTS idx_team_members_session ON team_members(session_id);
          COMMIT;
        `)
      } catch (err) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* ignore */
        }
        throw err
      } finally {
        db.pragma(`foreign_keys = ${fkPrev ? 'ON' : 'OFF'}`)
      }
    }
  } catch (err) {
    // Re-throw genuine rebuild failures (transient lock, FS error) — unlike the
    // old swallow-everything behaviour, we surface them so the operator knows
    // self-innovation is still blocked rather than silently failing.
    throw err
  }

  // Hard-verify P4 postconditions: the CHECK is gone and the catalogue exists.
  try {
    const tmSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_members'")
        .get() as { sql: string } | undefined
    )?.sql
    if (tmSql && tmSql.includes('CHECK (role IN')) {
      throw new Error('team_members still carries the legacy role CHECK after migrations')
    }
    const haveRoles = db
      .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='agent_roles'")
      .get() as { hit: number } | undefined
    if (!haveRoles) {
      throw new Error('agent_roles table is missing after migrations')
    }
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('legacy role CHECK') ||
        err.message.includes('agent_roles table is missing'))
    ) {
      throw err
    }
    /* PRAGMA/SELECT itself failed — leave alone, tests will surface the issue */
  }

  // Trigger to clear parent_session_id when parent is deleted (idempotent)
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS clear_parent_session_on_delete
      AFTER DELETE ON sessions
      FOR EACH ROW
      BEGIN
        UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = OLD.id;
      END
    `)
  } catch {
    /* trigger already exists */
  }
}

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath)

  // WAL mode for file-based databases (in-memory uses 'memory' mode)
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL')
    // Task 44: explicitly cap the WAL file size after each checkpoint.
    // SQLite's `journal_size_limit` applies to WAL too: after a
    // successful checkpoint the file is truncated to this limit. We
    // set 64 MiB — enough headroom for one heavy housekeeping cycle
    // (~2M metrics row deletes) but small enough that a 342 MB WAL
    // blowup (observed 2026-05-15) is impossible once a checkpoint
    // actually completes.
    db.pragma('journal_size_limit = 67108864')
    // Pin the auto-checkpoint threshold so behaviour is independent of
    // the SQLite default (currently 1000 frames). PASSIVE auto-checkpoint
    // alone cannot reclaim the WAL file on disk; we still need an
    // explicit TRUNCATE in restart-manager / housekeeping, but a tighter
    // autocheckpoint reduces steady-state WAL size between truncates.
    db.pragma('wal_autocheckpoint = 1000')
  }
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db)

  // Task 44: a previous broker process may have left a large -wal file
  // (the symptom: 342 MB WAL surviving across a blue/green restart).
  // We are the sole connection at this point, so a TRUNCATE checkpoint
  // is guaranteed to make progress unless the OS denies the write.
  // Best-effort: swallow errors so a transient FS hiccup never blocks
  // broker startup.
  if (dbPath !== ':memory:') {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* non-fatal — auto-checkpoint will retry during normal use */
    }
  }

  return db
}

export function closeDatabase(db: Database.Database): void {
  db.close()
}
