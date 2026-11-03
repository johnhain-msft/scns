/**
 * Project work-context snapshot (#73).
 *
 * The evidence a relevance decision is allowed to rest on: live sessions, task transitions,
 * unresolved coordination (unread messages, open file intents) and what the human actually
 * typed. The contract these tests pin is that MISSING evidence stays missing — an unreachable
 * broker, an absent transcript oracle or a schema that has drifted must degrade the snapshot's
 * completeness, never present itself as "no work found".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import {
  buildWorkContextSnapshot,
  summarizeWorkContext,
} from '../../../src/memory/work-context.js'
import type { SessionTranscript } from '../../../src/memory/session-transcript.js'

/**
 * Oracle stub with no turns.
 *
 * Without it these tests fall through to the real resolver and read the DEVELOPER's live
 * `~/.copilot/session-store.db`, which makes the result depend on whose machine is running and
 * reads a live store from a unit test. Every case here injects its transcript explicitly.
 */
function stubTranscript(turns: Record<string, readonly { turnIndex: number; text: string }[]> = {}) {
  return (): SessionTranscript => ({
    mode: 'oracle',
    reason: '',
    path: '(stub)',
    humanTurns: (sessionId: string) =>
      (turns[sessionId] ?? []).map((t) => ({ ...t, timestampMs: 1 })),
    close: () => {},
  })
}

function createBrokerDb(path: string): Database.Database {
  const db = new Database(path)
  // Mirrors src/broker/storage/schema.sql. In particular `tasks` carries NO `project_id` —
  // it is scoped through its team — and `teams` does. A fixture that invents a column
  // production lacks turns this suite green while the feature is inert on every real DB.
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, purpose TEXT, working_dir TEXT, worktree TEXT,
      repo_context TEXT, parent_session_id TEXT, branch_point_message_id TEXT,
      status TEXT DEFAULT 'active', project_id TEXT,
      last_heartbeat DATETIME, created_at DATETIME, archived_at DATETIME
    );
    CREATE TABLE teams (
      id TEXT PRIMARY KEY, name TEXT, description TEXT, parent_team_id TEXT,
      status TEXT, project_id TEXT, working_dir TEXT,
      created_at DATETIME, archived_at DATETIME
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL, seq INTEGER, subject TEXT,
      description TEXT, status TEXT DEFAULT 'pending', owner TEXT, active_form TEXT,
      created_at DATETIME, updated_at DATETIME
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, sender_id TEXT, receiver_id TEXT, content TEXT,
      story_id TEXT, reply_to TEXT, team_id TEXT, seq INTEGER, to_role TEXT, to_team TEXT,
      client_message_id TEXT,
      created_at DATETIME,
      -- Issue #70 delivery ladder: delivered_at -> read_at -> disposition.
      delivered_at DATETIME, read_at DATETIME,
      disposition TEXT CHECK (disposition IS NULL OR disposition IN ('accepted', 'rejected', 'deferred')),
      disposition_at DATETIME, disposition_note TEXT
    );
    CREATE TABLE file_intents (
      file_path TEXT, session_id TEXT, intent TEXT, declared_at DATETIME,
      PRIMARY KEY (file_path, session_id)
    );
  `)
  return db
}

describe('work-context snapshot', () => {
  let tmpDir: string
  let brokerDbPath: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scns-work-ctx-'))
    brokerDbPath = join(tmpDir, 'data.db')
    db = createBrokerDb(brokerDbPath)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      /* already closed */
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedSession(
    id: string,
    over: { status?: string; purpose?: string; archived?: boolean; projectId?: string } = {},
  ) {
    db.prepare(
      `INSERT INTO sessions (id, purpose, working_dir, status, project_id, last_heartbeat, created_at, archived_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)`,
    ).run(
      id,
      over.purpose ?? 'work',
      'C:/work/project',
      over.status ?? 'active',
      over.projectId ?? 'proj-alpha',
      over.archived ? new Date().toISOString() : null,
    )
  }

  it('collects live sessions, open tasks, unread coordination and open intents', () => {
    seedSession('s-active')
    seedSession('s-zombie', { status: 'zombie' })
    seedSession('s-archived', { archived: true })
    db.prepare("INSERT INTO teams (id, name, project_id) VALUES ('t1','team-one','proj-alpha')").run()
    db.prepare(
      `INSERT INTO tasks (team_id, subject, description, status, created_at, updated_at)
       VALUES ('t1', 'Ship the pruning command', 'body', 'in_progress', datetime('now'), datetime('now'))`,
    ).run()
    db.prepare(
      `INSERT INTO tasks (team_id, subject, status, created_at, updated_at)
       VALUES ('t1', 'Old finished work', 'completed', datetime('now'), datetime('now'))`,
    ).run()
    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at)
       VALUES ('m1', 's-active', 's-zombie', 'waiting on your branch', datetime('now'), NULL)`,
    ).run()
    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at)
       VALUES ('m2', 's-active', 's-zombie', 'already handled', datetime('now'), datetime('now'))`,
    ).run()
    db.prepare(
      `INSERT INTO file_intents (file_path, session_id, intent, declared_at)
       VALUES ('src/cli.ts', 's-active', 'edit', datetime('now'))`,
    ).run()

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    expect(snap.activeSessionIds).toEqual(['s-active'])
    expect(snap.sessions.map((s) => s.id).sort()).toEqual(['s-active', 's-zombie'])
    expect(snap.openTasks.map((t) => t.subject)).toEqual(['Ship the pruning command'])
    expect(snap.completedTasks.map((t) => t.subject)).toEqual(['Old finished work'])
    expect(snap.unreadMessages.map((m) => m.id)).toEqual(['m1'])
    expect(snap.openIntents.map((i) => i.filePath)).toEqual(['src/cli.ts'])
    expect(snap.completeness.level).toBe('complete')
    expect(snap.completeness.gaps).toEqual([])
  })

  it('scopes strictly to the project and never absorbs another project’s rows', () => {
    seedSession('s-mine')
    seedSession('s-theirs', { projectId: 'proj-beta' })
    db.prepare("INSERT INTO teams (id, name, project_id) VALUES ('t1','team-one','proj-beta')").run()
    db.prepare(
      `INSERT INTO tasks (team_id, subject, status, created_at, updated_at)
       VALUES ('t1', 'Foreign task', 'pending', datetime('now'), datetime('now'))`,
    ).run()

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    expect(snap.sessions.map((s) => s.id)).toEqual(['s-mine'])
    expect(snap.openTasks).toEqual([])
  })

  it('reports an unreachable broker as unavailable evidence, not as an empty project', () => {
    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath: join(tmpDir, 'no-such-broker.db'),
      openTranscript: stubTranscript(),
    })

    expect(snap.completeness.level).toBe('unavailable')
    expect(snap.completeness.brokerReachable).toBe(false)
    expect(snap.completeness.gaps.join(' ')).toMatch(/broker/i)
    expect(snap.sessions).toEqual([])
    // The distinction that matters: nothing here may be read as "no sessions exist".
    expect(snap.completeness.level).not.toBe('complete')
  })

  it('degrades to partial when the session schema has drifted', () => {
    db.exec('DROP TABLE tasks')
    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    expect(snap.completeness.level).toBe('partial')
    expect(snap.completeness.tasksAvailable).toBe(false)
    expect(snap.completeness.sessionsAvailable).toBe(true)
    expect(snap.completeness.gaps.join(' ')).toMatch(/task/i)
  })

  it('marks the human-turn oracle as a gap when the transcript store is missing', () => {
    seedSession('s-active')
    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      transcriptPath: join(tmpDir, 'no-session-store.db'),
    })

    expect(snap.completeness.transcriptsAvailable).toBe(false)
    expect(snap.completeness.level).toBe('partial')
    expect(snap.humanTurns).toEqual([])
    expect(snap.completeness.gaps.join(' ')).toMatch(/transcript|human turn/i)
  })

  it('reads human turns from the transcript oracle for live sessions', () => {
    seedSession('s-active')
    const storePath = join(tmpDir, 'session-store.db')
    const store = new Database(storePath)
    store.exec(
      'CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, timestamp TEXT)',
    )
    store
      .prepare('INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES (?,?,?,?)')
      .run('s-active', 0, 'the coordination with the other session is finished', '2026-09-17T10:00:00.000Z')
    store.close()

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      transcriptPath: storePath,
    })

    expect(snap.completeness.transcriptsAvailable).toBe(true)
    expect(snap.humanTurns).toHaveLength(1)
    expect(snap.humanTurns[0]!.text).toContain('coordination with the other session is finished')
    expect(snap.humanTurns[0]!.sessionId).toBe('s-active')
    expect(snap.completeness.level).toBe('complete')
  })

  // ── Orphaned coordination (#73 round-2 N1) ─────────────────────────────────
  //
  // `sessions` is project- AND archive-scoped, but `messages` / `file_intents` are read
  // DB-wide, so the `sessionIds` membership test does double duty: it scopes rows to the
  // project (correct) and it discards rows whose session row is gone (silent evidence loss).
  // The second behaviour is the one under test. A row we cannot attribute to ANY session row
  // is precisely the #70 case — the session vanished while its coordination is still alive —
  // so it must degrade the snapshot rather than disappear from it.

  it('surfaces coordination whose session row is gone instead of silently dropping it', () => {
    seedSession('s-active')
    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at)
       VALUES ('m-orphan', 's-ghost', NULL, 'still blocked on you', datetime('now'), NULL)`,
    ).run()
    db.prepare(
      `INSERT INTO file_intents (file_path, session_id, intent, declared_at)
       VALUES ('src/ghost.ts', 's-ghost', 'edit', datetime('now'))`,
    ).run()

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    // The sessions table itself was perfectly readable — this is not a blind-source case.
    expect(snap.completeness.sessionsAvailable).toBe(true)
    expect(snap.completeness.messagesAvailable).toBe(true)
    expect(snap.completeness.intentsAvailable).toBe(true)

    // The rows are not attributable, so they are NOT in the in-scope inventory …
    expect(snap.unreadMessages).toEqual([])
    expect(snap.openIntents).toEqual([])
    // … but they are still reported, with their content, rather than discarded.
    expect(snap.orphanedMessages.map((m) => m.id)).toEqual(['m-orphan'])
    expect(snap.orphanedMessages[0]?.content).toContain('still blocked on you')
    expect(snap.orphanedIntents.map((i) => i.filePath)).toEqual(['src/ghost.ts'])

    // And the snapshot must not claim complete evidence.
    expect(snap.completeness.coordinationAttributable).toBe(false)
    expect(snap.completeness.level).toBe('partial')
    expect(snap.completeness.gaps.join(' ')).toMatch(/s-ghost/)

    // The evidence text a human and an evaluator both read must say so.
    const text = summarizeWorkContext(snap)
    expect(text).not.toMatch(/evidence completeness: complete/i)
    expect(text).toContain('m-orphan')
    expect(text).toContain('still blocked on you')
    expect(text).toContain('src/ghost.ts')
  })

  it('counts a disposed-but-unread message as settled coordination (#70 ladder)', () => {
    // Issue #70 replaced "read" with a ladder: delivered_at -> read_at -> disposition.
    // The broker's own retention invariant treats a row as still-live only when it is
    // NEITHER read NOR disposed -- `countRetainedMessagesForSession` in
    // src/broker/storage/repositories/message-repository.ts filters
    // `read_at IS NULL AND disposition IS NULL`, and session-retirement.ts records the
    // settled policy that an explicit 'deferred' disposition COUNTS AS SETTLED. A
    // recipient can dispose without ever setting read_at, so keying this snapshot off
    // `read_at IS NULL` alone reports a completed acknowledgement cycle as unresolved
    // coordination and blocks pruning forever.
    seedSession('s-active')
    seedSession('s-peer', { status: 'active' })
    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at, disposition, disposition_at)
       VALUES ('m-deferred', 's-active', 's-peer', 'can you take this?', datetime('now'), NULL, 'deferred', datetime('now'))`,
    ).run()
    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at, disposition, disposition_at)
       VALUES ('m-rejected', 's-active', 's-peer', 'not doing that', datetime('now'), NULL, 'rejected', datetime('now'))`,
    ).run()
    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at, disposition)
       VALUES ('m-open', 's-active', 's-peer', 'still blocked on you', datetime('now'), NULL, NULL)`,
    ).run()

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    expect(snap.unreadMessages.map((m) => m.id)).toEqual(['m-open'])
  })

  it('still counts a delivered-but-unacknowledged message as unresolved (#70 ladder)', () => {
    // The complement of the test above, and the negative control for it: reaching the
    // recipient's context is NOT a verdict. `delivered_at` set with no read and no
    // disposition must stay unresolved, or the guard would release on delivery alone.
    seedSession('s-active')
    seedSession('s-peer')
    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, delivered_at, read_at, disposition)
       VALUES ('m-delivered', 's-active', 's-peer', 'please review', datetime('now'), datetime('now'), NULL, NULL)`,
    ).run()

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    expect(snap.unreadMessages.map((m) => m.id)).toEqual(['m-delivered'])
  })

  it('reads unresolved coordination from a pre-#70 broker DB that has no disposition column', () => {
    // Not hypothetical: the ladder columns are added by the ALTER TABLE migration loop in
    // src/broker/storage/db.ts, which runs only when that broker process next starts. On
    // 2026-09-18 all 10 deployed broker databases on the author's machine still had the
    // pre-#70 `messages` shape. A query naming `disposition` fails the entire read with
    // `no such column`, which would turn every unpinned memory `uncertain` and leave the
    // whole feature inert on every real machine while this suite stayed green.
    db.exec(`
      DROP TABLE messages;
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, sender_id TEXT, receiver_id TEXT, content TEXT,
        story_id TEXT, reply_to TEXT, team_id TEXT, seq INTEGER, to_role TEXT, to_team TEXT,
        created_at DATETIME, read_at DATETIME
      );
    `)
    seedSession('s-active')
    seedSession('s-peer')
    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at)
       VALUES ('m-legacy-open', 's-active', 's-peer', 'still blocked on you', datetime('now'), NULL)`,
    ).run()
    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at)
       VALUES ('m-legacy-read', 's-active', 's-peer', 'already handled', datetime('now'), datetime('now'))`,
    ).run()

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    expect(snap.unreadMessages.map((m) => m.id)).toEqual(['m-legacy-open'])
    // The narrower predicate is correct for that schema version, not a degraded read, so it
    // must not be reported as missing evidence.
    expect(snap.completeness.messagesAvailable).toBe(true)
    expect(snap.completeness.gaps.filter((g) => g.includes('messages'))).toEqual([])
  })

  it('treats a message whose endpoints were nulled by session deletion as orphaned', () => {
    // Production-reachable: `messages.sender_id`/`receiver_id` carry
    // `REFERENCES sessions(id) ON DELETE SET NULL`, so deleting a session leaves the message
    // with two NULL endpoints. The old filter dropped it on the `!== null` test alone.
    seedSession('s-active')
    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at)
       VALUES ('m-nulled', NULL, NULL, 'did you ever land the fix?', datetime('now'), NULL)`,
    ).run()

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    expect(snap.unreadMessages).toEqual([])
    expect(snap.orphanedMessages.map((m) => m.id)).toEqual(['m-nulled'])
    expect(snap.completeness.coordinationAttributable).toBe(false)
    expect(snap.completeness.level).toBe('partial')
  })

  it('keeps a row attributable to any in-scope session out of the orphan set', () => {
    // Half-resolvable: the receiver is a ghost but the sender is in scope, so the row is
    // already visible as ordinary coordination. It must not be double-counted as orphaned.
    seedSession('s-active')
    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at)
       VALUES ('m-half', 's-active', 's-ghost', 'ping', datetime('now'), NULL)`,
    ).run()

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    expect(snap.unreadMessages.map((m) => m.id)).toEqual(['m-half'])
    expect(snap.orphanedMessages).toEqual([])
    expect(snap.completeness.coordinationAttributable).toBe(true)
    expect(snap.completeness.level).toBe('complete')
  })

  it('discloses deliberately out-of-scope coordination as a count, without content or a gap', () => {
    // An archived session and another project's session both EXIST and are both attributable,
    // so excluding them is scoping, not evidence loss: it must not degrade completeness. But
    // the inventory still may not read as empty, and another project's content stays private.
    seedSession('s-active')
    seedSession('s-archived', { archived: true })
    seedSession('s-theirs', { projectId: 'proj-beta' })
    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at)
       VALUES ('m-arch', 's-archived', NULL, 'archived chatter', datetime('now'), NULL)`,
    ).run()
    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at)
       VALUES ('m-beta', 's-theirs', NULL, 'other project secret', datetime('now'), NULL)`,
    ).run()
    db.prepare(
      `INSERT INTO file_intents (file_path, session_id, intent, declared_at)
       VALUES ('other/proj.ts', 's-theirs', 'edit', datetime('now'))`,
    ).run()

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    expect(snap.unreadMessages).toEqual([])
    expect(snap.orphanedMessages).toEqual([])
    expect(snap.scopedOutCoordination).toEqual({ messages: 2, intents: 1, tasks: 0 })
    // Attributable ⇒ still complete; this must not become a blanket downgrade.
    expect(snap.completeness.coordinationAttributable).toBe(true)
    expect(snap.completeness.level).toBe('complete')
    expect(snap.completeness.gaps).toEqual([])

    const text = summarizeWorkContext(snap)
    expect(text).toMatch(/out of scope/i)
    // Counted, but never quoted across a project boundary.
    expect(text).not.toContain('other project secret')
    expect(text).not.toContain('archived chatter')
  })

  // ── Row-cap truncation (#73 round-3 N2) ────────────────────────────────────
  //
  // Same failure class as the orphan case, reached through a different route: every evidence
  // query is capped, so a project with more rows than the cap silently loses the tail. The
  // acceptance source is explicit that a truncated inventory is incomplete evidence, and the
  // dropped rows are exactly the ones a guard would have objected with.

  function seedUnread(count: number, over: { oldestContent?: string } = {}) {
    const insert = db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, created_at, read_at)
       VALUES (?, 's-peer', 's-active', ?, ?, NULL)`,
    )
    db.transaction(() => {
      for (let i = 0; i < count; i += 1) {
        // Ascending timestamps, so index 0 is the OLDEST — the row `created_at DESC` drops first.
        const ts = new Date(Date.UTC(2026, 8, 17, 0, 0, i)).toISOString()
        const content =
          i === 0 && over.oldestContent ? over.oldestContent : `routine coordination ${i}`
        insert.run(`m${i}`, content, ts)
      }
    })()
  }

  it('reports a row cap that truncated the evidence instead of presenting the tail as absent', () => {
    seedSession('s-active')
    seedSession('s-peer')
    seedUnread(501, { oldestContent: 'still blocked on you' })

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    // The cap still applies — it exists to bound memory — but it is no longer silent.
    expect(snap.unreadMessages).toHaveLength(500)
    expect(snap.unreadMessages.some((m) => m.content.includes('still blocked on you'))).toBe(false)
    expect(snap.completeness.messagesAvailable).toBe(true)
    expect(snap.completeness.inventoryComplete).toBe(false)
    expect(snap.completeness.level).toBe('partial')
    expect(snap.completeness.gaps.join(' ')).toMatch(/unread messages/i)
    expect(snap.completeness.gaps.join(' ')).toMatch(/500/)

    const text = summarizeWorkContext(snap)
    expect(text).not.toMatch(/evidence completeness: complete/i)
  })

  it('does not claim truncation when the row count exactly reaches the cap', () => {
    seedSession('s-active')
    seedSession('s-peer')
    seedUnread(500)

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    expect(snap.unreadMessages).toHaveLength(500)
    expect(snap.completeness.inventoryComplete).toBe(true)
    expect(snap.completeness.level).toBe('complete')
    expect(snap.completeness.gaps).toEqual([])
  })

  it('reports truncation of the task inventory as well as the coordination inventory', () => {
    seedSession('s-active')
    const insert = db.prepare(
      `INSERT INTO tasks (team_id, subject, status, created_at, updated_at)
       VALUES ('t1', ?, 'completed', datetime('now'), ?)`,
    )
    db.prepare("INSERT INTO teams (id, name, project_id) VALUES ('t1','team-one','proj-alpha')").run()
    db.transaction(() => {
      for (let i = 0; i < 501; i += 1) {
        insert.run(`task ${i}`, new Date(Date.UTC(2026, 8, 17, 0, 0, i)).toISOString())
      }
    })()

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    expect(snap.completeness.tasksAvailable).toBe(true)
    expect(snap.completeness.inventoryComplete).toBe(false)
    expect(snap.completeness.gaps.join(' ')).toMatch(/task/i)
  })

  // ── Task scoping through teams (#73 round-4 N3) ────────────────────────────
  //
  // `tasks` carries no `project_id` in schema.sql or in any deployed broker DB; it is scoped
  // through `teams.project_id`. Querying a column that does not exist makes `tasksAvailable`
  // false on every real database, which downgrades every destructive verdict — the feature
  // fails closed, but it never works.

  it('scopes tasks through their team against the production schema', () => {
    seedSession('s-active')
    db.prepare("INSERT INTO teams (id, name, project_id) VALUES ('t-mine','mine','proj-alpha')").run()
    db.prepare("INSERT INTO teams (id, name, project_id) VALUES ('t-theirs','theirs','proj-beta')").run()
    db.prepare(
      `INSERT INTO tasks (team_id, subject, status, created_at, updated_at)
       VALUES ('t-mine', 'My open task', 'in_progress', datetime('now'), datetime('now'))`,
    ).run()
    db.prepare(
      `INSERT INTO tasks (team_id, subject, status, created_at, updated_at)
       VALUES ('t-mine', 'My closed task', 'completed', datetime('now'), datetime('now'))`,
    ).run()
    db.prepare(
      `INSERT INTO tasks (team_id, subject, status, created_at, updated_at)
       VALUES ('t-theirs', 'Their task', 'in_progress', datetime('now'), datetime('now'))`,
    ).run()

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    // The query must RUN — the old `WHERE project_id = ?` threw `no such column`.
    expect(snap.completeness.tasksAvailable).toBe(true)
    expect(snap.completeness.tasksAttributable).toBe(true)
    expect(snap.openTasks.map((t) => t.subject)).toEqual(['My open task'])
    expect(snap.completedTasks.map((t) => t.subject)).toEqual(['My closed task'])
    expect(snap.completeness.level).toBe('complete')
  })

  it('reports a task whose owning project cannot be determined instead of dropping it', () => {
    seedSession('s-active')
    db.prepare("INSERT INTO teams (id, name, project_id) VALUES ('t-null','legacy',NULL)").run()
    db.prepare(
      `INSERT INTO tasks (team_id, subject, status, created_at, updated_at)
       VALUES ('t-null', 'Legacy task with no project', 'in_progress', datetime('now'), datetime('now'))`,
    ).run()

    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      openTranscript: stubTranscript(),
    })

    expect(snap.completeness.tasksAvailable).toBe(true)
    expect(snap.completeness.tasksAttributable).toBe(false)
    expect(snap.completeness.level).toBe('partial')
    expect(snap.completeness.gaps.join(' ')).toMatch(/task/i)
    expect(snap.orphanedTasks.map((t) => t.subject)).toEqual(['Legacy task with no project'])
  })

  it('summarizes the snapshot as evidence text without inventing facts', () => {
    seedSession('s-active', { purpose: 'implement pruning' })
    const snap = buildWorkContextSnapshot({
      projectId: 'proj-alpha',
      projectRoot: 'C:/work/project',
      brokerDbPath,
      transcriptPath: join(tmpDir, 'absent.db'),
    })
    const text = summarizeWorkContext(snap)

    expect(text).toContain('s-active')
    expect(text).toContain('implement pruning')
    // Gaps are stated explicitly so the evaluator can see what it does NOT know.
    expect(text).toMatch(/evidence completeness: partial/i)
    expect(text).toMatch(/transcript/i)
  })
})
