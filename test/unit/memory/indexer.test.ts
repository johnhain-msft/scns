import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { createVault } from '../../../src/memory/vault.js'
import { indexVaultSync } from '../../../src/memory/indexer.js'
import type Database from 'better-sqlite3'

describe('indexVaultSync', () => {
  let rootDir: string
  let db: Database.Database
  let vault: ReturnType<typeof createVault>

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'scns-indexer-test-'))
    vault = createVault({ rootDir })
    db = openMemoryDb(':memory:')
  })

  afterEach(() => {
    closeMemoryDb(db)
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('indexes new files', () => {
    vault.write('SOUL.md', 'I am an AI assistant.')
    vault.write('USER.md', 'The user is a developer.')

    const stats = indexVaultSync(db, vault)
    expect(stats.filesScanned).toBe(2)
    expect(stats.filesIndexed).toBe(2)
    expect(stats.chunksCreated).toBeGreaterThanOrEqual(2)
  })

  it('excludes daily/ logs from the search index by default (telemetry noise)', () => {
    vault.write('daily/2026-01-01.md', '## 10:00:00\n\n**[file-change]** change: src/x.ts')
    vault.write('SOUL.md', 'I am an AI assistant.')

    const stats = indexVaultSync(db, vault)

    // daily/ is excluded; only SOUL.md is indexed
    expect(stats.filesScanned).toBe(1)
    expect(stats.filesIndexed).toBe(1)
    const dailyChunks = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_path LIKE 'daily/%'")
      .get() as { n: number }
    expect(dailyChunks.n).toBe(0)
    const soulChunks = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_path = 'SOUL.md'")
      .get() as { n: number }
    expect(soulChunks.n).toBeGreaterThan(0)
  })

  it('removes previously-indexed daily/ chunks on the next pass (one-time cleanup)', () => {
    vault.write('daily/2026-01-02.md', '**[session-hook]** Tool used: bash')
    vault.write('SOUL.md', 'hello')

    // Simulate a vault indexed BEFORE the exclusion existed (exclude nothing).
    indexVaultSync(db, vault, undefined, [])
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_path LIKE 'daily/%'")
      .get() as { n: number }
    expect(before.n).toBeGreaterThan(0)

    // Re-run with the default exclusion → daily chunks are dropped as "deleted".
    const stats = indexVaultSync(db, vault)
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_path LIKE 'daily/%'")
      .get() as { n: number }
    expect(after.n).toBe(0)
    expect(stats.filesRemoved).toBeGreaterThanOrEqual(1)
  })

  it('prunes low-signal telemetry chunks when pruneLowSignal is enabled', () => {
    // A stat-table / telemetry chunk (pipe-dominated) + a narrative chunk in one file.
    const telemetry =
      '# Weekly Summary\n| tool | count |\n| view | 1030 |\n| bash | 374 |\n| rg | 319 |'
    const narrative = 'The user asked to investigate and fix the login bug; we resolved it.'
    vault.write('weekly/W17.md', telemetry)
    vault.write('USER.md', narrative)

    // Default OFF: both files index their chunks (byte-identical to today).
    const baseline = indexVaultSync(db, vault)
    expect(baseline.chunksSkippedLowSignal).toBe(0)
    const totalDefault = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n
    expect(totalDefault).toBeGreaterThanOrEqual(2)

    // ON: telemetry chunk dropped, narrative kept.
    db.exec('DELETE FROM chunks; DELETE FROM vault_files')
    const pruned = indexVaultSync(db, vault, undefined, undefined, { pruneLowSignal: true })
    expect(pruned.chunksSkippedLowSignal).toBeGreaterThan(0)
    const weekly = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_path = 'weekly/W17.md'")
      .get() as { n: number }
    expect(weekly.n).toBe(0)
    const user = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_path = 'USER.md'")
      .get() as { n: number }
    expect(user.n).toBeGreaterThan(0)
  })

  it('skips unchanged files on second run', () => {
    vault.write('SOUL.md', 'I am an AI assistant.')
    indexVaultSync(db, vault)

    // Second run — no changes
    const stats = indexVaultSync(db, vault)
    expect(stats.filesIndexed).toBe(0)
    expect(stats.chunksCreated).toBe(0)
  })

  it('re-indexes modified files', () => {
    vault.write('SOUL.md', 'Version 1')
    indexVaultSync(db, vault)

    vault.write('SOUL.md', 'Version 2 with more content')

    // Force the stored mtime to differ, exactly as the content-hash test below does.
    // The old comment here said "need a small delay for mtime to change" but no delay
    // was ever added, which left the test a coin flip: two writes this close together
    // routinely land in the SAME millisecond (measured 108/200 on Windows), and
    // `indexVaultSync` gates candidacy on mtime BEFORE consulting the content hash —
    // so on a collision the file never becomes a candidate and filesIndexed is 0.
    // That is what failed windows-smoke (20) on 2026-09-28 while (22) and (24) passed
    // the identical commit. Bumping the stored row removes the clock dependency while
    // still exercising the thing under test: changed CONTENT must re-index.
    db.prepare('UPDATE vault_files SET mtime_ms = mtime_ms - 9999 WHERE path = ?').run('SOUL.md')

    const stats = indexVaultSync(db, vault)
    expect(stats.filesIndexed).toBe(1)

    // Verify new content is in DB
    const chunks = db
      .prepare("SELECT content FROM chunks WHERE file_path = 'SOUL.md'")
      .all() as Array<{ content: string }>
    expect(chunks.some((c) => c.content.includes('Version 2'))).toBe(true)
  })

  it('content-hash gates re-indexing when mtime changes but content is identical', () => {
    // Phase 13.9.4: prevents CPU-hog from background writers that touch files
    // without changing content (e.g. atomic write-replace with same body).
    vault.write('SOUL.md', 'same content always')
    indexVaultSync(db, vault)
    const firstChunkIds = (
      db
        .prepare("SELECT id FROM chunks WHERE file_path = 'SOUL.md' ORDER BY chunk_index")
        .all() as Array<{ id: number }>
    ).map((r) => r.id)

    // Forcibly bump mtime in the stored row to simulate a background writer
    // touching the file (mtime differs) but content hash stays the same.
    db.prepare('UPDATE vault_files SET mtime_ms = mtime_ms - 9999 WHERE path = ?').run('SOUL.md')

    const stats = indexVaultSync(db, vault)
    expect(stats.filesIndexed).toBe(0)
    expect(stats.chunksCreated).toBe(0)

    // Chunk IDs must be preserved — no delete+reinsert churn
    const secondChunkIds = (
      db
        .prepare("SELECT id FROM chunks WHERE file_path = 'SOUL.md' ORDER BY chunk_index")
        .all() as Array<{ id: number }>
    ).map((r) => r.id)
    expect(secondChunkIds).toEqual(firstChunkIds)

    // And mtime should have been updated forward
    const row = db.prepare('SELECT mtime_ms FROM vault_files WHERE path = ?').get('SOUL.md') as {
      mtime_ms: number
    }
    expect(row.mtime_ms).toBeGreaterThan(0)
  })

  it('removes entries for deleted files', () => {
    vault.write('TEMP.md', 'Temporary file')
    indexVaultSync(db, vault)

    // Delete the file
    vault.remove('TEMP.md')
    const stats = indexVaultSync(db, vault)
    expect(stats.filesRemoved).toBe(1)

    // Verify removed from DB
    const files = db.prepare("SELECT * FROM vault_files WHERE path = 'TEMP.md'").all()
    expect(files).toHaveLength(0)
  })

  it('chunks are searchable via FTS5 after indexing', () => {
    vault.write(
      'NOTES.md',
      'TypeScript is a strongly typed programming language built on JavaScript.',
    )
    indexVaultSync(db, vault)

    const results = db
      .prepare(
        `SELECT c.content FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH '"TypeScript"'`,
      )
      .all() as Array<{ content: string }>
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.content).toContain('TypeScript')
  })

  it('handles empty vault', () => {
    const stats = indexVaultSync(db, vault)
    expect(stats.filesScanned).toBe(0)
    expect(stats.filesIndexed).toBe(0)
    expect(stats.chunksCreated).toBe(0)
  })

  it('handles large files by splitting into chunks', () => {
    const longContent = 'This is a paragraph about software engineering. '.repeat(100)
    vault.write('LARGE.md', longContent)
    const stats = indexVaultSync(db, vault)
    expect(stats.chunksCreated).toBeGreaterThan(1)
  })

  it('tracks file metadata in vault_files table', () => {
    vault.write('META.md', 'Some content here')
    indexVaultSync(db, vault)

    const row = db
      .prepare('SELECT path, mtime_ms, size_bytes FROM vault_files WHERE path = ?')
      .get('META.md') as { path: string; mtime_ms: number; size_bytes: number }
    expect(row).toBeTruthy()
    expect(row.path).toBe('META.md')
    expect(row.mtime_ms).toBeGreaterThan(0)
    expect(row.size_bytes).toBeGreaterThan(0)
  })
})
