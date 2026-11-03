/**
 * Legacy-database upgrade — regression for the 2026-09-17 deploy incident.
 *
 * A database created BEFORE issue #70's message columns must open cleanly:
 * schema.sql's CREATE TABLE IF NOT EXISTS skips the existing table, so any
 * column-dependent statement inside schema.sql executes against the OLD
 * shape before the ALTER migrations run. Putting idx_messages_client_id in
 * schema.sql aborted the whole schema exec with "no such column:
 * client_message_id" and crash-looped the live Cosmere child broker.
 * Column-dependent indexes belong in the db.ts migration loop, after their
 * ALTERs (the idx_tasks_dispatch_lookup rule).
 *
 * Fresh test databases cannot catch this class — the table is created with
 * the new columns inline — so this test builds the legacy shape explicitly.
 */

import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'

function createLegacyDb(path: string): void {
  const raw = new Database(path)
  // The messages/sessions shape as it existed on main before PR #72
  // (no client_message_id / delivered_at / disposition columns, and a
  // messages_history without the acknowledgement columns).
  raw.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      purpose TEXT,
      working_dir TEXT,
      worktree TEXT,
      repo_context TEXT,
      parent_session_id TEXT REFERENCES sessions(id),
      branch_point_message_id TEXT,
      status TEXT DEFAULT 'active',
      project_id TEXT,
      last_heartbeat DATETIME DEFAULT (datetime('now')),
      created_at DATETIME DEFAULT (datetime('now')),
      archived_at DATETIME DEFAULT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      receiver_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      content TEXT NOT NULL,
      story_id TEXT,
      reply_to TEXT REFERENCES messages(id) ON DELETE SET NULL,
      team_id TEXT,
      seq INTEGER,
      to_role TEXT,
      to_team TEXT,
      created_at DATETIME DEFAULT (datetime('now')),
      read_at DATETIME
    );
    CREATE TABLE messages_history (
      id TEXT NOT NULL,
      sender_id TEXT,
      receiver_id TEXT,
      content TEXT NOT NULL,
      story_id TEXT,
      reply_to TEXT,
      created_at DATETIME,
      read_at DATETIME,
      purged_at DATETIME DEFAULT (datetime('now'))
    );
    INSERT INTO sessions (id, purpose, working_dir) VALUES ('old-sess', 'legacy', '/w');
    INSERT INTO messages (id, sender_id, receiver_id, content)
      VALUES ('old-msg', 'old-sess', NULL, 'pre-upgrade row');
  `)
  raw.close()
}

describe('legacy database upgrade (2026-09-17 deploy incident)', () => {
  let dir: string | null = null

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('openDatabase upgrades a pre-#72 database instead of aborting on schema exec', () => {
    dir = mkdtempSync(join(tmpdir(), 'scns-legacy-db-'))
    const dbPath = join(dir, 'data.db')
    createLegacyDb(dbPath)

    // This is the exact call the crash-looping child broker died in.
    const db = openDatabase(dbPath)

    const messageCols = new Set(
      (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    )
    for (const col of [
      'client_message_id',
      'delivered_at',
      'disposition',
      'disposition_at',
      'disposition_note',
    ]) {
      expect(messageCols, `messages.${col} missing after upgrade`).toContain(col)
    }

    const historyCols = new Set(
      (db.prepare('PRAGMA table_info(messages_history)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    )
    for (const col of [
      'client_message_id',
      'delivered_at',
      'disposition',
      'disposition_at',
      'disposition_note',
    ]) {
      expect(historyCols, `messages_history.${col} missing after upgrade`).toContain(col)
    }

    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'idx_messages_client_id'")
      .get()
    expect(index, 'idempotency index missing after upgrade').toBeDefined()

    // Pre-existing rows survive and the upgraded write paths work.
    const legacyRow = db.prepare("SELECT content FROM messages WHERE id = 'old-msg'").get() as {
      content: string
    }
    expect(legacyRow.content).toBe('pre-upgrade row')
    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, client_message_id)
       VALUES ('new-msg', 'old-sess', NULL, 'post-upgrade row', 'cmid-1')`,
    ).run()

    closeDatabase(db)
  })

  it('opening the same upgraded database a second time is a clean no-op', () => {
    dir = mkdtempSync(join(tmpdir(), 'scns-legacy-db-'))
    const dbPath = join(dir, 'data.db')
    createLegacyDb(dbPath)

    closeDatabase(openDatabase(dbPath))
    const db = openDatabase(dbPath)
    expect(db.prepare('SELECT COUNT(*) AS c FROM messages').get()).toEqual({ c: 1 })
    closeDatabase(db)
  })
})
