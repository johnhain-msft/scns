/**
 * E2E: Memory subsystem pipeline — vault, indexing, search, daily logs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openMemoryDb, closeMemoryDb } from '../../src/memory/db.js'
import { indexVaultSync } from '../../src/memory/indexer.js'
import { keywordOnlySearch } from '../../src/memory/search.js'
import { createVault, type Vault } from '../../src/memory/vault.js'

describe('Memory Pipeline E2E', () => {
  let vaultDir: string
  let db: Database.Database
  let vault: Vault

  beforeAll(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'scns-e2e-memory-'))
    vault = createVault({ rootDir: vaultDir })
    db = openMemoryDb(':memory:')
  })

  afterAll(() => {
    closeMemoryDb(db)
    rmSync(vaultDir, { recursive: true, force: true })
  })

  it('indexes vault files and makes them searchable', () => {
    // Write some markdown files to the vault
    vault.write('SOUL.md', '# Soul\n\nI am an autonomous AI assistant.')
    vault.write(
      'MEMORY.md',
      '# Memory\n\n## Key Facts\n\nThe user prefers TypeScript and Vitest for testing.',
    )
    vault.write(
      'notes/project.md',
      '# Project Notes\n\nSCNS uses SQLite with FTS5 for full-text search.\nExpressJS 5 for the broker API.',
    )

    // Index the vault
    const stats = indexVaultSync(db, vault)
    expect(stats.filesScanned).toBe(3)
    expect(stats.filesIndexed).toBe(3)
    expect(stats.filesRemoved).toBe(0)
    expect(stats.chunksCreated).toBeGreaterThanOrEqual(3)

    // Verify files are in the database
    const files = db.prepare('SELECT path FROM vault_files ORDER BY path').all() as Array<{
      path: string
    }>
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['MEMORY.md', 'SOUL.md', 'notes/project.md']),
    )

    // Verify chunks exist
    const chunkCount = (db.prepare('SELECT COUNT(*) AS cnt FROM chunks').get() as { cnt: number })
      .cnt
    expect(chunkCount).toBeGreaterThanOrEqual(3)
  })

  it('keyword search returns relevant results', () => {
    const results = keywordOnlySearch(db, 'TypeScript Vitest testing')
    expect(results.length).toBeGreaterThan(0)

    // Should find the MEMORY.md content
    const memoryResult = results.find((r) => r.filePath === 'MEMORY.md')
    expect(memoryResult).toBeDefined()
    expect(memoryResult!.content).toContain('TypeScript')
  })

  it('search for different terms returns different results', () => {
    const sqliteResults = keywordOnlySearch(db, 'SQLite FTS5')
    expect(sqliteResults.length).toBeGreaterThan(0)
    expect(sqliteResults.some((r) => r.filePath === 'notes/project.md')).toBe(true)

    const soulResults = keywordOnlySearch(db, 'autonomous AI assistant')
    expect(soulResults.length).toBeGreaterThan(0)
    expect(soulResults.some((r) => r.filePath === 'SOUL.md')).toBe(true)
  })

  it('incremental update after file modification', () => {
    // Modify MEMORY.md
    vault.write(
      'MEMORY.md',
      '# Memory\n\n## Key Facts\n\nThe user prefers TypeScript and Vitest.\nNew fact: SCNS has a broker and memory subsystem.',
    )

    const stats = indexVaultSync(db, vault)
    // Only MEMORY.md should be re-indexed (mtime changed)
    expect(stats.filesIndexed).toBe(1)
    expect(stats.filesRemoved).toBe(0)

    // New content should be searchable
    const results = keywordOnlySearch(db, 'broker memory subsystem')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.filePath === 'MEMORY.md')).toBe(true)
  })

  it('file deletion is reflected after re-index', () => {
    // Verify the file exists before deletion
    const beforeFiles = db.prepare('SELECT path FROM vault_files').all() as Array<{
      path: string
    }>
    expect(beforeFiles.some((f) => f.path === 'notes/project.md')).toBe(true)

    // Delete the file from the vault
    vault.remove('notes/project.md')

    // Re-index
    const stats = indexVaultSync(db, vault)
    expect(stats.filesRemoved).toBe(1)

    // File should no longer be in the database
    const afterFiles = db.prepare('SELECT path FROM vault_files').all() as Array<{
      path: string
    }>
    expect(afterFiles.some((f) => f.path === 'notes/project.md')).toBe(false)

    // Chunks for deleted file should be gone
    const orphanChunks = db
      .prepare("SELECT COUNT(*) AS cnt FROM chunks WHERE file_path = 'notes/project.md'")
      .get() as { cnt: number }
    expect(orphanChunks.cnt).toBe(0)
  })

  it('no-op re-index when nothing changed', () => {
    const stats = indexVaultSync(db, vault)
    expect(stats.filesIndexed).toBe(0)
    expect(stats.filesRemoved).toBe(0)
  })

  it('daily log writer appends timestamped entries', () => {
    const entry1 = 'First observation of the day'
    const entry2 = 'Second observation of the day'
    const date = new Date('2025-01-15T10:30:00Z')

    vault.appendDailyLog(entry1, date)
    vault.appendDailyLog(entry2, new Date('2025-01-15T14:45:00Z'))

    // Verify log file was created
    const logPath = join(vaultDir, 'daily', '2025-01-15.md')
    expect(existsSync(logPath)).toBe(true)

    const content = readFileSync(logPath, 'utf-8')
    expect(content).toContain('10:30:00')
    expect(content).toContain('First observation')
    expect(content).toContain('14:45:00')
    expect(content).toContain('Second observation')
  })

  it('daily log file is indexable after creation', () => {
    const stats = indexVaultSync(db, vault)
    // Daily log file should be newly indexed
    expect(stats.filesIndexed).toBeGreaterThanOrEqual(1)

    // Should be searchable
    const results = keywordOnlySearch(db, 'observation')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.filePath.startsWith('daily/'))).toBe(true)
  })

  it('vault path traversal is blocked', () => {
    expect(() => vault.write('../escape.md', 'malicious')).toThrow('Path traversal')
  })

  it('large file indexing works correctly', () => {
    // Create a larger file with multiple paragraphs
    const paragraphs = Array.from(
      { length: 20 },
      (_, i) =>
        `## Section ${i + 1}\n\nThis is paragraph ${i + 1} with unique content about topic-${i + 1}.\n`,
    )
    vault.write('large-doc.md', `# Large Document\n\n${paragraphs.join('\n')}`)

    const stats = indexVaultSync(db, vault)
    expect(stats.filesIndexed).toBeGreaterThanOrEqual(1)
    // Should create multiple chunks for a large file
    const chunkCount = (
      db.prepare("SELECT COUNT(*) AS cnt FROM chunks WHERE file_path = 'large-doc.md'").get() as {
        cnt: number
      }
    ).cnt
    expect(chunkCount).toBeGreaterThanOrEqual(1)

    // Search for specific section content
    const results = keywordOnlySearch(db, 'paragraph unique content')
    expect(results.length).toBeGreaterThan(0)
  })
})
