/**
 * Integration tests — full pipeline: write markdown -> index -> search -> retrieve.
 * Uses keyword-only search (no fastembed dependency for CI).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { createVault } from '../../../src/memory/vault.js'
import { indexVaultSync } from '../../../src/memory/indexer.js'
import { keywordOnlySearch } from '../../../src/memory/search.js'
import type Database from 'better-sqlite3'

describe('Memory pipeline integration', () => {
  let rootDir: string
  let db: Database.Database
  let vault: ReturnType<typeof createVault>

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'scns-pipeline-test-'))
    vault = createVault({ rootDir })
    db = openMemoryDb(':memory:')
  })

  afterEach(() => {
    closeMemoryDb(db)
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('write -> index -> search -> retrieve', () => {
    vault.write(
      'SOUL.md',
      '# Soul\nI am SCNS, an autonomous AI assistant that learns from observation.',
    )
    vault.write(
      'USER.md',
      '# User\nJohn is a full-stack developer who prefers TypeScript and uses Azure.',
    )

    const stats = indexVaultSync(db, vault)
    expect(stats.filesIndexed).toBe(2)

    const results = keywordOnlySearch(db, 'TypeScript developer')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.content).toContain('TypeScript')
  })

  it('daily logs are excluded from the search index (raw telemetry, M0)', () => {
    vault.appendDailyLog(
      'Worked on the session broker port today.',
      new Date('2026-04-04T10:00:00Z'),
    )
    vault.appendDailyLog('Fixed a bug in the heartbeat poller.', new Date('2026-04-04T14:00:00Z'))
    // The same fact, when promoted to a curated tier, stays searchable.
    vault.write('MEMORY.md', 'Key decision: fixed the heartbeat poller in the session broker.')

    const stats = indexVaultSync(db, vault)

    // daily/ logs are raw telemetry — deliberately kept OUT of the search index (M0).
    expect(stats.filesIndexed).toBe(1) // MEMORY.md only; the daily file is excluded
    const dailyChunks = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_path LIKE 'daily/%'")
      .get() as { n: number }
    expect(dailyChunks.n).toBe(0)

    // curated content remains retrievable
    const results = keywordOnlySearch(db, 'heartbeat poller')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.content).toContain('heartbeat')
  })

  it('re-indexing after update reflects new content', () => {
    vault.write('MEMORY.md', 'The project uses Express 4 for the HTTP server.')
    indexVaultSync(db, vault)

    // Update content. The indexer shortlists candidates by mtime (the
    // content-hash only gates files already shortlisted), so a second write
    // landing in the same mtime granule is invisible to it — that product gap
    // is issue #52 and has flaked this test on CI for months. This test is
    // about re-indexing an updated file, not about granule collisions, so
    // force the update into a fresh granule deterministically.
    vault.write('MEMORY.md', 'The project uses Express 5 for the HTTP server.')
    const bumped = new Date(Date.now() + 2000)
    utimesSync(join(rootDir, 'MEMORY.md'), bumped, bumped)
    indexVaultSync(db, vault)

    const results = keywordOnlySearch(db, 'Express')
    expect(results.length).toBeGreaterThan(0)
    // Should find the updated version
    expect(results[0]!.content).toContain('Express 5')
  })

  it('deleted files are removed from search results', () => {
    vault.write('TEMP.md', 'This is temporary experimental content about Kubernetes.')
    indexVaultSync(db, vault)

    // Verify it's searchable
    let results = keywordOnlySearch(db, 'Kubernetes')
    expect(results.length).toBeGreaterThan(0)

    // Delete and re-index
    vault.remove('TEMP.md')
    indexVaultSync(db, vault)

    results = keywordOnlySearch(db, 'Kubernetes')
    expect(results).toHaveLength(0)
  })

  it('concurrent reads do not block during indexing', () => {
    // Write several files
    for (let i = 0; i < 20; i++) {
      vault.write(`note-${i}.md`, `This is note number ${i} about software architecture.`)
    }
    indexVaultSync(db, vault)

    // Read while another indexing pass runs (no changed files)
    const results = keywordOnlySearch(db, 'architecture')
    expect(results.length).toBeGreaterThan(0)

    // Run indexing again (no changes, should be fast)
    const stats = indexVaultSync(db, vault)
    expect(stats.filesIndexed).toBe(0)

    // Reads still work
    const results2 = keywordOnlySearch(db, 'architecture')
    expect(results2.length).toBeGreaterThan(0)
  })

  it('handles many files (100+)', () => {
    for (let i = 0; i < 100; i++) {
      vault.write(
        `doc-${i.toString().padStart(3, '0')}.md`,
        `Document ${i}: This discusses topic ${i % 10} in detail. ${
          i % 3 === 0 ? 'Related to machine learning.' : 'Related to web development.'
        }`,
      )
    }

    const stats = indexVaultSync(db, vault)
    expect(stats.filesIndexed).toBe(100)
    expect(stats.chunksCreated).toBeGreaterThanOrEqual(100)

    const mlResults = keywordOnlySearch(db, 'machine learning', 20)
    expect(mlResults.length).toBeGreaterThan(0)

    const webResults = keywordOnlySearch(db, 'web development', 20)
    expect(webResults.length).toBeGreaterThan(0)
  })
})

/**
 * 10 hand-crafted relevance queries — Phase 1 gate requirement.
 */
describe('Search relevance: 10 hand-crafted queries', () => {
  let rootDir: string
  let db: Database.Database
  let vault: ReturnType<typeof createVault>

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'scns-relevance-test-'))
    vault = createVault({ rootDir })
    db = openMemoryDb(':memory:')

    // Seed a realistic vault
    vault.write(
      'SOUL.md',
      `# Soul
I am SCNS, the Second Central Nervous System. I observe, learn, and assist.
My goal is to progressively earn autonomy through reliable behavior.
I start as an Observer (L0) and can be promoted to Advisor, Assistant, and Autonomous.`,
    )

    vault.write(
      'USER.md',
      `# User Profile
Name: John Hain
Role: Full-stack developer
Languages: TypeScript, Python, Go, Java, C#
Cloud: Azure (primary), some AWS
Frontend: React, Next.js, Tailwind CSS
Backend: Node.js, Express, FastAPI, Django
Database: PostgreSQL, SQLite, MongoDB
Tools: Docker, Kubernetes, Terraform`,
    )

    vault.write(
      'MEMORY.md',
      `# Key Decisions
- Use SQLite with sqlite-vec for vector search (no separate process needed)
- Express 5 for HTTP server (session broker already uses it)
- FastEmbed BGE-small-en-v1.5 for local embeddings (384 dimensions)
- Hybrid search: 0.7 * vector score + 0.3 * keyword score
- AutoDream consolidation runs every 24 hours
- Rate limit detection: exponential backoff with 30s -> 1m -> 5m -> 15m
- Testing: Vitest is the test framework; every phase is TDD-gated with passing tests before merge
- SCNS yields to user interactive sessions (always)`,
    )

    vault.appendDailyLog(
      'Started Phase 0: project scaffolding. Set up TypeScript ESM, Vitest, ESLint, Prettier. Created CLI skeleton with Commander.js.',
      new Date('2026-04-04T10:00:00Z'),
    )
    vault.appendDailyLog(
      'Phase 0 complete. 22 tests passing. Build succeeds. CLI prints help for all commands.',
      new Date('2026-04-04T16:00:00Z'),
    )
    vault.appendDailyLog(
      'Started Phase 1: memory vault and hybrid search. Implemented SQLite schema with FTS5 and sqlite-vec.',
      new Date('2026-04-04T17:00:00Z'),
    )

    vault.write(
      'daily/2026-04-03.md',
      `## 09:00:00
Research session: explored second-brain-starter, claurst, and everything-copilot codebases.

## 14:00:00
Design decisions: chose TypeScript ESM, better-sqlite3, FastEmbed for local embeddings.

## 18:00:00
Finalized PLAN.md with 9 TDD-gated phases.`,
    )

    indexVaultSync(db, vault)
  })

  afterEach(() => {
    closeMemoryDb(db)
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('Q1: "What programming languages does the user know?"', () => {
    const results = keywordOnlySearch(db, 'programming languages')
    expect(results.length).toBeGreaterThan(0)
    const topContent = results.map((r) => r.content).join(' ')
    expect(topContent).toMatch(/TypeScript|Python|Go|Java/)
  })

  it('Q2: "What database is used for search?"', () => {
    const results = keywordOnlySearch(db, 'database search')
    expect(results.length).toBeGreaterThan(0)
    const topContent = results.map((r) => r.content).join(' ')
    expect(topContent).toMatch(/SQLite|sqlite-vec/)
  })

  it('Q3: "What is the autonomy model?"', () => {
    const results = keywordOnlySearch(db, 'autonomy Observer Advisor')
    expect(results.length).toBeGreaterThan(0)
    const topContent = results.map((r) => r.content).join(' ')
    expect(topContent).toMatch(/Observer|Advisor|Autonomous/)
  })

  it('Q4: "What happened on April 4th?"', () => {
    const results = keywordOnlySearch(db, 'Phase scaffolding TypeScript')
    expect(results.length).toBeGreaterThan(0)
    // Daily logs are excluded from search (M0); the durable match comes from curated tiers (USER.md).
    const topContent = results.map((r) => r.content).join(' ')
    expect(topContent).toMatch(/Phase|scaffolding|TypeScript/)
  })

  it('Q5: "What embedding model is used?"', () => {
    const results = keywordOnlySearch(db, 'embedding model FastEmbed')
    expect(results.length).toBeGreaterThan(0)
    const topContent = results.map((r) => r.content).join(' ')
    expect(topContent).toMatch(/FastEmbed|BGE|384/)
  })

  it('Q6: "How does hybrid search scoring work?"', () => {
    const results = keywordOnlySearch(db, 'hybrid search vector keyword score')
    expect(results.length).toBeGreaterThan(0)
    const topContent = results.map((r) => r.content).join(' ')
    expect(topContent).toMatch(/vector|keyword|0\.7|0\.3/)
  })

  it('Q7: "What cloud provider does the user prefer?"', () => {
    const results = keywordOnlySearch(db, 'cloud Azure AWS')
    expect(results.length).toBeGreaterThan(0)
    const topContent = results.map((r) => r.content).join(' ')
    expect(topContent).toContain('Azure')
  })

  it('Q8: "How does rate limiting work?"', () => {
    const results = keywordOnlySearch(db, 'rate limit backoff')
    expect(results.length).toBeGreaterThan(0)
    const topContent = results.map((r) => r.content).join(' ')
    expect(topContent).toMatch(/rate limit|backoff|exponential/)
  })

  it('Q9: "What HTTP framework is used?"', () => {
    const results = keywordOnlySearch(db, 'Express HTTP server')
    expect(results.length).toBeGreaterThan(0)
    const topContent = results.map((r) => r.content).join(' ')
    expect(topContent).toContain('Express')
  })

  it('Q10: "What testing framework is configured?"', () => {
    const results = keywordOnlySearch(db, 'Vitest testing')
    expect(results.length).toBeGreaterThan(0)
    const topContent = results.map((r) => r.content).join(' ')
    expect(topContent).toMatch(/Vitest|test/)
  })
})
