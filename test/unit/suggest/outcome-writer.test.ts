import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { rebuildMemoryEdges } from '../../../src/memory/entities/edges.js'
import {
  statusToVerdict,
  resolveOutcomeTarget,
  recordSuggestionOutcome,
} from '../../../src/suggest/outcome-writer.js'
import {
  selectMemoryDerivedSeeds,
  makeMemorySeedReaders,
} from '../../../src/suggest/memory-self-improvement.js'
import { openExperienceStore, logRetrievalExperience } from '../../../src/memory/experience-store.js'
import type { Suggestion } from '../../../src/suggest/types.js'
import type Database from 'better-sqlite3'

function sugg(overrides: Partial<Suggestion> & Pick<Suggestion, 'tags'>): Suggestion {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    type: 'agentic-workflow',
    title: 'Document + test the broker port override precedence',
    description: 'd',
    status: 'implemented',
    confidence: 0.9,
    evidence: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    actionable: true,
    estimatedComplexity: 'solo',
    attemptCount: 0,
    lastError: null,
    lastAttemptAt: null,
    nextRetryAt: null,
    allowRepoWrites: false,
    inflightTeamId: null,
    ...overrides,
  } as Suggestion
}

describe('statusToVerdict', () => {
  it('maps terminal statuses to verdicts and non-terminal to null', () => {
    expect(statusToVerdict('implemented')).toBe('implemented')
    expect(statusToVerdict('failed')).toBe('failed')
    expect(statusToVerdict('rejected')).toBe('rejected')
    expect(statusToVerdict('needs-human')).toBe('needs-human')
    expect(statusToVerdict('pending')).toBeNull()
    expect(statusToVerdict('approved')).toBeNull()
    expect(statusToVerdict('in-progress')).toBeNull()
    expect(statusToVerdict('blocked-autonomy')).toBeNull()
  })
})

describe('resolveOutcomeTarget', () => {
  it('extracts entity + family from a memory-path self-improvement suggestion', () => {
    const t = resolveOutcomeTarget(
      sugg({ tags: ['self-improvement', 'scns-self-improvement', 'broker', 'broker-port-precedence'] }),
    )
    expect(t).toEqual({ entity: 'broker', family: 'broker-port-precedence' })
  })

  it('returns null for a hardcoded seed with no gazetteer entity tag', () => {
    const t = resolveOutcomeTarget(
      sugg({ tags: ['self-improvement', 'scns-self-improvement', 'dev-prompt-staging'] }),
    )
    expect(t).toBeNull()
  })

  it('returns null for a non-self-improvement suggestion', () => {
    expect(resolveOutcomeTarget(sugg({ tags: ['skill', 'vscode'] }))).toBeNull()
  })
})

describe('recordSuggestionOutcome', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => {
    closeMemoryDb(db)
  })

  it('records a row + writes a curated event entry for a terminal entity-anchored suggestion', () => {
    const writes: Array<{ key: string; content: string }> = []
    const res = recordSuggestionOutcome(
      {
        db,
        vault: { write: (key, content) => void writes.push({ key, content }) },
        now: () => new Date('2026-06-26T12:00:00Z'),
      },
      sugg({
        id: 'abcdef00-0000-0000-0000-000000000000',
        tags: ['self-improvement', 'scns-self-improvement', 'broker', 'broker-port-precedence'],
      }),
      'implemented',
      0.97,
    )
    expect(res.recorded).toBe(true)
    expect(res.row!.entity).toBe('broker')
    expect(res.row!.family).toBe('broker-port-precedence')
    expect(res.row!.verdict).toBe('implemented')
    expect(res.row!.score).toBe(0.97)
    // the discrete event entry (causal-candidate source) was written under outcomes/
    expect(writes).toHaveLength(1)
    expect(writes[0]!.key).toMatch(/^outcomes\/2026-06-26-broker-port-precedence-abcdef00\.md$/)
    expect(writes[0]!.content).toContain('broker')
    expect(writes[0]!.content).toContain('implemented')
  })

  it('skips a non-terminal status', () => {
    const res = recordSuggestionOutcome(
      { db },
      sugg({ tags: ['self-improvement', 'scns-self-improvement', 'broker', 'broker-port-precedence'] }),
      'pending',
    )
    expect(res.recorded).toBe(false)
    expect(res.skipReason).toBe('non-terminal-status')
  })

  it('skips a suggestion that does not map to a gazetteer entity', () => {
    const res = recordSuggestionOutcome(
      { db },
      sugg({ tags: ['self-improvement', 'scns-self-improvement', 'dev-prompt-staging'] }),
      'implemented',
    )
    expect(res.recorded).toBe(false)
    expect(res.skipReason).toBe('not-entity-anchored')
  })
})

describe('FULL D2 LOOP — read → write → re-read learns (MAGMA Eq.1-2)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => {
    closeMemoryDb(db)
  })

  function addChunk(path: string, mtimeMs: number, content: string, idx = 0): void {
    db.prepare(
      `INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms`,
    ).run(path, mtimeMs, content.length)
    db.prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, ?, ?, 0, ?, 1)`,
    ).run(path, idx, content, content.length)
  }

  it('a recorded landing suppresses that family on the next ideation read', () => {
    // make the broker hot in the graph
    addChunk('weekly/2026-W20.md', 2000, 'broker port 3456 health endpoint refused to merge', 0)
    addChunk('weekly/2026-W21.md', 3000, 'the broker daemon restarted on port 3456', 0)
    rebuildMemoryEdges(db)
    const readers = makeMemorySeedReaders(db)

    // READ #1 — broker-port-precedence is a live candidate (graph-hot, no prior outcome)
    const before = selectMemoryDerivedSeeds(readers)
    expect(before.some((s) => s.family === 'broker-port-precedence')).toBe(true)

    // WRITE — the proposal lands (quality-gate PASS → merged → implemented)
    const res = recordSuggestionOutcome(
      { db },
      sugg({
        id: 'feedfeed-0000-0000-0000-000000000000',
        tags: ['self-improvement', 'scns-self-improvement', 'broker', 'broker-port-precedence'],
      }),
      'implemented',
      0.98,
    )
    expect(res.recorded).toBe(true)

    // READ #2 — same readers, same graph: the landed family is now suppressed (the loop learned)
    const after = selectMemoryDerivedSeeds(readers)
    expect(after.some((s) => s.family === 'broker-port-precedence')).toBe(false)
  })
})

describe('recordSuggestionOutcome — Phase D human-outcome settle (optional experienceStore)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => {
    closeMemoryDb(db)
  })

  it('settles the verdict-mapped gradient onto matching unsettled retrieval rows (audit ids returned)', () => {
    const store = openExperienceStore(':memory:')
    const rid = logRetrievalExperience(store, {
      queryText: 'broker port precedence details',
      levers: {},
      retrievedChunkIds: [1],
    })
    const res = recordSuggestionOutcome(
      { db, experienceStore: store },
      sugg({ tags: ['self-improvement', 'scns-self-improvement', 'broker', 'broker-port-precedence'] }),
      'implemented',
    )
    expect(res.recorded).toBe(true)
    expect(res.humanOutcomeSettled).toEqual([rid]) // implemented → accepted (1.0)
    const r = store.db
      .prepare(`SELECT human_outcome AS h FROM retrieval_experience WHERE id = ?`)
      .get(rid) as { h: number }
    expect(r.h).toBe(1.0)
    store.close()
  })

  it('needs-human (pending) settles NOTHING; absent store settles nothing (default-OFF)', () => {
    const store = openExperienceStore(':memory:')
    logRetrievalExperience(store, { queryText: 'broker x', levers: {}, retrievedChunkIds: [] })
    const pending = recordSuggestionOutcome(
      { db, experienceStore: store },
      sugg({ id: 'aaaaaaaa-0000-0000-0000-000000000001', tags: ['self-improvement', 'scns-self-improvement', 'broker', 'fam-a'] }),
      'needs-human',
    )
    expect(pending.recorded).toBe(true)
    expect(pending.humanOutcomeSettled).toBeUndefined()
    const noStore = recordSuggestionOutcome(
      { db },
      sugg({ id: 'aaaaaaaa-0000-0000-0000-000000000002', tags: ['self-improvement', 'scns-self-improvement', 'broker', 'fam-b'] }),
      'implemented',
    )
    expect(noStore.recorded).toBe(true)
    expect(noStore.humanOutcomeSettled).toBeUndefined()
    store.close()
  })
})
