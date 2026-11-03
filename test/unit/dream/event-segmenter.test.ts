/**
 * WS-1 event/outcome substrate — deterministic SEGMENTER unit tests.
 *
 * Proves the structured-first segmenter turns broker DECISION events + proposal_outcomes into
 * clean, narratable decision→action→outcome nodes with a REAL event-time τ (from the source row's
 * created_at, NOT a file mtime), that non-narratable content is filtered, and that the output is
 * deterministic (identical event_key set on re-run).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { isLowSignalContent } from '../../../src/memory/causal-edges.js'
import {
  normalizeTau,
  segmentProposalOutcomes,
  segmentBrokerDecisions,
  segmentStructuredEvents,
} from '../../../src/dream/event-segmenter.js'

function createBrokerEventsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      session_id TEXT,
      payload TEXT NOT NULL,
      created_at DATETIME DEFAULT (datetime('now'))
    );
  `)
}

function insertEvent(
  db: Database.Database,
  eventType: string,
  payload: Record<string, unknown>,
  createdAt: string,
): void {
  db.prepare(
    'INSERT INTO events (event_type, session_id, payload, created_at) VALUES (?, ?, ?, ?)',
  ).run(eventType, null, JSON.stringify(payload), createdAt)
}

function insertOutcome(
  db: Database.Database,
  row: { entity: string; family: string; title: string; verdict: string; rationale?: string; createdAt: string },
): void {
  db.prepare(
    `INSERT INTO proposal_outcomes (entity, family, title, verdict, score, suggestion_id, rationale, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.entity, row.family, row.title, row.verdict, null, null, row.rationale ?? null, row.createdAt)
}

describe('event-segmenter :: normalizeTau', () => {
  it('normalises a SQLite datetime to strict ISO-8601 Z', () => {
    expect(normalizeTau('2026-06-30 12:34:56')).toBe('2026-06-30T12:34:56Z')
  })
  it('passes an already-ISO / unrecognised value through unchanged', () => {
    expect(normalizeTau('2026-06-30T12:34:56Z')).toBe('2026-06-30T12:34:56Z')
    expect(normalizeTau('not-a-date')).toBe('not-a-date')
  })
})

describe('event-segmenter :: proposal_outcomes → event nodes', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  it('emits one narratable proposal-outcome node per row with τ from created_at', () => {
    insertOutcome(db, {
      entity: 'auto-merger',
      family: 'qg-rubric',
      title: 'Tighten quality-gate rubric scoring',
      verdict: 'implemented',
      rationale: 'merged after green suite',
      createdAt: '2026-01-02 03:04:05',
    })
    const nodes = segmentProposalOutcomes(db)
    expect(nodes).toHaveLength(1)
    const n = nodes[0]!
    expect(n.kind).toBe('proposal-outcome')
    expect(n.tau).toBe('2026-01-02T03:04:05Z')
    expect(n.entity).toBe('auto-merger')
    expect(n.outcome).toBe('verdict: implemented')
    expect(n.content).toContain('verdict: implemented')
    expect(n.content).toContain('auto-merger')
    expect(n.sourceRef).toBe('proposal_outcomes#1')
    expect(isLowSignalContent(n.content)).toBe(false)
  })
})

describe('event-segmenter :: broker events → event nodes', () => {
  let vaultDb: Database.Database
  let brokerDb: Database.Database
  beforeEach(() => {
    vaultDb = openMemoryDb(':memory:')
    brokerDb = openMemoryDb(':memory:')
    createBrokerEventsTable(brokerDb)
  })
  afterEach(() => {
    closeMemoryDb(vaultDb)
    closeMemoryDb(brokerDb)
  })

  it('maps quality_gate_verdict / auto_merged / kernel.decision using REAL payload keys', () => {
    insertEvent(
      brokerDb,
      'quality_gate_verdict',
      { team_id: 't1', passed: false, reason: 'build-failed', score: 0, branch: 'feat-x' },
      '2026-02-01 00:00:00',
    )
    insertEvent(
      brokerDb,
      'auto_merged',
      { branch: 'feat-x', team_id: 't1', merge_sha: 'abcdef1234567890' },
      '2026-02-01 00:00:10',
    )
    insertEvent(
      brokerDb,
      'kernel.decision',
      { gate: 'egress-allowlist', allow: false, tool: 'fetch', reason: 'off-list host' },
      '2026-02-01 00:00:20',
    )
    // A non-allowlisted event type must be ignored entirely.
    insertEvent(brokerDb, 'heartbeat_received', { n: 1 }, '2026-02-01 00:00:30')

    const nodes = segmentBrokerDecisions(brokerDb)
    expect(nodes).toHaveLength(3)
    const byRef = new Map(nodes.map((n) => [n.sourceRef, n]))

    const qg = byRef.get('events#1')!
    expect(qg.kind).toBe('broker-decision')
    expect(qg.tau).toBe('2026-02-01T00:00:00Z')
    expect(qg.outcome).toContain('failed')
    expect(qg.content).toContain('quality-gate review')

    const merge = byRef.get('events#2')!
    expect(merge.outcome).toContain('merged')

    const kernel = byRef.get('events#3')!
    expect(kernel.outcome).toContain('denied')
    expect(kernel.content).toContain('safety-kernel gate')

    for (const n of nodes) expect(isLowSignalContent(n.content)).toBe(false)
  })
})

describe('event-segmenter :: segmentStructuredEvents (combined)', () => {
  let vaultDb: Database.Database
  let brokerDb: Database.Database
  beforeEach(() => {
    vaultDb = openMemoryDb(':memory:')
    brokerDb = openMemoryDb(':memory:')
    createBrokerEventsTable(brokerDb)
  })
  afterEach(() => {
    closeMemoryDb(vaultDb)
    closeMemoryDb(brokerDb)
  })

  it('combines both sources, sorts by τ, and is deterministic across two runs', () => {
    insertOutcome(vaultDb, {
      entity: 'dream-daemon',
      family: 'seed-a',
      title: 'Consolidate sessions tier',
      verdict: 'merged',
      createdAt: '2026-03-01 09:00:00',
    })
    insertEvent(
      brokerDb,
      'team_completed',
      { team_id: 'team-9', aggregateOutcome: 'success' },
      '2026-03-01 08:00:00',
    )
    const run1 = segmentStructuredEvents({ vaultDb, brokerDb })
    const run2 = segmentStructuredEvents({ vaultDb, brokerDb })

    expect(run1).toHaveLength(2)
    // Sorted ascending by τ: the 08:00 broker event precedes the 09:00 outcome.
    expect(run1[0]!.tau < run1[1]!.tau).toBe(true)
    expect(run1.map((n) => n.eventKey)).toEqual(run2.map((n) => n.eventKey))
    for (const n of run1) expect(isLowSignalContent(n.content)).toBe(false)
  })

  it('segments outcomes only when no broker DB is supplied', () => {
    insertOutcome(vaultDb, {
      entity: 'auto-merger',
      family: 'seed-b',
      title: 'x',
      verdict: 'failed',
      createdAt: '2026-03-02 09:00:00',
    })
    const nodes = segmentStructuredEvents({ vaultDb })
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.kind).toBe('proposal-outcome')
  })
})
