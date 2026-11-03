import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { rebuildMemoryEdges } from '../../../src/memory/entities/edges.js'
import {
  runCausalEdgeInference,
  createAcpCausalProvider,
  CAUSAL_ACP_ENV,
} from '../../../src/memory/causal-runner.js'
import {
  NULL_CAUSAL_PROVIDER,
  type CausalProvider,
  type CausalEdge,
} from '../../../src/memory/causal-provider.js'
import type Database from 'better-sqlite3'

function count(db: Database.Database, sql: string, ...p: unknown[]): number {
  return (db.prepare(sql).get(...p) as { n: number }).n
}

function addChunk(db: Database.Database, path: string, mtimeMs: number, content: string): number {
  db.prepare(
    `INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms`,
  ).run(path, mtimeMs, content.length)
  return db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, 0, ?, 0, ?, 1)`,
    )
    .run(path, content, content.length).lastInsertRowid as number
}

/** A scripted provider that echoes the candidate keys back as edges with a fixed confidence. */
function scriptedProvider(confidence = 0.9): CausalProvider {
  return {
    async infer({ candidates }) {
      return candidates.map(
        (c): CausalEdge => ({
          causeKey: c.causeKey,
          effectKey: c.effectKey,
          confidence,
          rationale: `scripted: ${c.entity}`,
        }),
      )
    },
  }
}

function seedCuratedNeighborhood(db: Database.Database): void {
  addChunk(db, 'weekly/2026-W16.md', 1000, 'the auto-merger refused the dirty merge')
  addChunk(db, 'weekly/2026-W17.md', 2000, 'later the auto-merger merged cleanly')
  rebuildMemoryEdges(db)
}

/** Seed two chunk-backed broker EVENT NODES (τ-consecutive) so buildEventCausalCandidates fires. */
function seedEventNodes(db: Database.Database): void {
  db.prepare(
    `INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES ('event-nodes/broker.md', 0, 0)
     ON CONFLICT(path) DO NOTHING`,
  ).run()
  const mk = (content: string, tau: string, idx: number): void => {
    const id = db
      .prepare(
        `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
         VALUES ('event-nodes/broker.md', ?, ?, 0, ?, 1)`,
      )
      .run(idx, content, content.length).lastInsertRowid
    db.prepare(
      `INSERT INTO event_nodes (chunk_id, event_key, tau, entity, kind, source_ref)
       VALUES (?, ?, ?, 'broker', 'broker-decision', ?)`,
    ).run(id, `ek${idx}`, tau, `events#${idx}`)
  }
  mk('On 2026-06-04T02:04:35Z the broker quality-gate review passed', '2026-06-04T02:04:35Z', 2_000_000)
  mk('On 2026-06-04T02:07:57Z the broker auto-merged the branch', '2026-06-04T02:07:57Z', 2_000_001)
}

describe('runCausalEdgeInference — default-OFF', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  it('with NO provider and NO env flag, writes zero edges (the default-OFF proof)', async () => {
    seedCuratedNeighborhood(db)
    const res = await runCausalEdgeInference({ db, env: {} })
    expect(res.ran).toBe(false)
    expect(res.skipReason).toBe('null-provider')
    expect(res.persisted).toBe(0)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_causal')).toBe(0)
  })

  it('with the explicit NULL provider, writes zero edges', async () => {
    seedCuratedNeighborhood(db)
    const res = await runCausalEdgeInference({ db, provider: NULL_CAUSAL_PROVIDER, env: {} })
    expect(res.ran).toBe(false)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_causal')).toBe(0)
  })

  it('with the env flag set but no factory, stays inert (no real spawn fallback)', async () => {
    seedCuratedNeighborhood(db)
    const res = await runCausalEdgeInference({ db, env: { [CAUSAL_ACP_ENV]: '1' } })
    expect(res.ran).toBe(false)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_causal')).toBe(0)
  })
})

describe('runCausalEdgeInference — scripted provider', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  it('persists inferred edges with stable content-hash keys', async () => {
    seedCuratedNeighborhood(db)
    const res = await runCausalEdgeInference({ db, provider: scriptedProvider(0.9), env: {} })
    expect(res.ran).toBe(true)
    expect(res.candidateCount).toBeGreaterThanOrEqual(1)
    expect(res.persisted).toBeGreaterThanOrEqual(1)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_causal')).toBe(res.persisted)
    const row = db.prepare('SELECT cause_key, effect_key, provider FROM memory_causal').get() as {
      cause_key: string
      effect_key: string
      provider: string
    }
    expect(row.cause_key).toMatch(/^[0-9a-f]{16}$/)
    expect(row.effect_key).toMatch(/^[0-9a-f]{16}$/)
  })

  it('skips when there are no candidates', async () => {
    // no chunks indexed → no temporal backbone → no candidates
    const res = await runCausalEdgeInference({ db, provider: scriptedProvider(), env: {} })
    expect(res.ran).toBe(false)
    expect(res.skipReason).toBe('no-candidates')
  })

  it('applies the confidence gate', async () => {
    seedCuratedNeighborhood(db)
    const res = await runCausalEdgeInference({
      db,
      provider: scriptedProvider(0.4),
      minConfidence: 0.7,
      env: {},
    })
    expect(res.rejectedLowConfidence).toBeGreaterThanOrEqual(1)
    expect(res.persisted).toBe(0)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_causal')).toBe(0)
  })

  it('routes through an env-gated factory when the flag is set (no real process)', async () => {
    seedCuratedNeighborhood(db)
    let factoryCalls = 0
    const res = await runCausalEdgeInference({
      db,
      env: { [CAUSAL_ACP_ENV]: '1' },
      makeAcpProvider: () => {
        factoryCalls++
        return scriptedProvider(0.95)
      },
    })
    expect(factoryCalls).toBe(1)
    expect(res.ran).toBe(true)
    expect(res.providerLabel).toBe('acp')
    expect(res.persisted).toBeGreaterThanOrEqual(1)
  })

  it('does NOT call the factory when the flag is absent', async () => {
    seedCuratedNeighborhood(db)
    let factoryCalls = 0
    const res = await runCausalEdgeInference({
      db,
      env: {},
      makeAcpProvider: () => {
        factoryCalls++
        return scriptedProvider()
      },
    })
    expect(factoryCalls).toBe(0)
    expect(res.ran).toBe(false)
  })

  it('draws event-level candidates from proposal_outcomes (no chunk backbone needed)', async () => {
    // NO chunks / NO temporal backbone — only an entity's decision→result history.
    db.prepare(
      `INSERT INTO proposal_outcomes (entity, family, title, verdict, rationale, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('broker', 'startup', 'raise git poll timeout', 'implemented', 'first-poll contention', '2026-06-01')
    db.prepare(
      `INSERT INTO proposal_outcomes (entity, family, title, verdict, rationale, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('broker', 'startup', 'broker first poll now succeeds', 'merged', 'contention fixed', '2026-06-02')

    const res = await runCausalEdgeInference({ db, provider: scriptedProvider(0.9), env: {} })
    expect(res.ran).toBe(true)
    expect(res.candidateCount).toBeGreaterThanOrEqual(1) // the outcome pair became a candidate
    expect(res.persisted).toBeGreaterThanOrEqual(1)
    const row = db
      .prepare('SELECT entity FROM memory_causal ORDER BY id DESC LIMIT 1')
      .get() as { entity: string }
    expect(row.entity).toBe('broker')
  })

  it('with a SINGLE proposal_outcome (no pair) and no chunks, stays inert', async () => {
    db.prepare(
      `INSERT INTO proposal_outcomes (entity, family, title, verdict, rationale, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('broker', 'startup', 'only one record', 'rejected', null, '2026-06-01')
    const res = await runCausalEdgeInference({ db, provider: scriptedProvider(0.9), env: {} })
    expect(res.ran).toBe(false)
    expect(res.skipReason).toBe('no-candidates')
    expect(count(db, 'SELECT COUNT(*) n FROM memory_causal')).toBe(0)
  })

  it('WS-2b: materializes persisted edges into chunk→chunk memory_edges(causal) the beam reads', async () => {
    seedCuratedNeighborhood(db)
    const res = await runCausalEdgeInference({ db, provider: scriptedProvider(0.9), env: {} })
    expect(res.ran).toBe(true)
    expect(res.persisted).toBeGreaterThanOrEqual(1)
    // The persisted memory_causal rows are materialized into the readable graph (default 'both').
    expect(res.materialized).toBeGreaterThanOrEqual(1)
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='causal'")).toBe(
      res.materialized,
    )
  })

  it('WS-2b: sources EVENT-NODE candidates first (no chunk backbone / no outcomes needed)', async () => {
    seedEventNodes(db) // ONLY event nodes — no temporal backbone, no proposal_outcomes
    const res = await runCausalEdgeInference({ db, provider: scriptedProvider(0.9), env: {} })
    expect(res.ran).toBe(true)
    expect(res.candidateCount).toBeGreaterThanOrEqual(1) // the τ-consecutive event pair
    expect(res.persisted).toBeGreaterThanOrEqual(1)
    expect(res.materialized).toBeGreaterThanOrEqual(1)
    // The materialized causal edge connects the two event-node chunks (both directions by default).
    const causalEdges = count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='causal'")
    expect(causalEdges).toBe(res.materialized)
    expect(causalEdges).toBeGreaterThanOrEqual(2)
  })

  it('WS-2b: inert when the event substrate is empty (segmentation OFF) — falls back cleanly', async () => {
    // No event_nodes, no outcomes, no chunks ⇒ event candidates [] ⇒ union empty ⇒ skip (byte-identical
    // to today). This is the default-prod control: pointing at event nodes changes nothing until they exist.
    const res = await runCausalEdgeInference({ db, provider: scriptedProvider(0.9), env: {} })
    expect(res.ran).toBe(false)
    expect(res.skipReason).toBe('no-candidates')
    expect(res.materialized).toBe(0)
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='causal'")).toBe(0)
  })
})

describe('createAcpCausalProvider — transport (injected fake client, no spawn)', () => {
  it('initialises, sends the prompt, and parses the JSON response', async () => {
    const candidates = [
      {
        causeKey: 'AAA',
        effectKey: 'BBB',
        causeContent: 'cause text',
        effectContent: 'effect text',
        entity: 'broker',
        causeFilePath: 'weekly/a.md',
        effectFilePath: 'weekly/b.md',
      },
    ]
    let sawInit = false
    let sentPrompt = ''
    const fakeClient = {
      async initialize() {
        sawInit = true
      },
      async createSession() {
        return 'session-1'
      },
      async sendPrompt(_sessionId: string, prompt: string) {
        sentPrompt = prompt
        return { output: JSON.stringify([{ causeKey: 'AAA', effectKey: 'BBB', confidence: 0.8 }]) }
      },
      async close() {},
    }
    const provider = createAcpCausalProvider({
      cwd: '/tmp/scns-causal-test-isolated',
      createClient: () => fakeClient as never,
    })
    const edges = await provider.infer({ candidates })
    expect(sawInit).toBe(true)
    expect(sentPrompt).toContain('AAA')
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ causeKey: 'AAA', effectKey: 'BBB', confidence: 0.8 })
  })

  it('requires an isolated cwd (never the live checkout)', () => {
    expect(() => createAcpCausalProvider({ cwd: '' })).toThrow()
  })

  // T023 (US2 / research R3) — Alg-3 consolidation must judge ALL candidates without the wall-blowing
  // single all-candidates spawn: chunk into ≤batchSize-pair batches (one bounded deny-all session each),
  // unioning the results. This is what makes un-capping the ingest (dropping the harness cap-20) safe.
  it('judges ALL candidates in ≤batchSize-pair chunks (no single wall-blowing spawn), unioning edges', async () => {
    const candidates = Array.from({ length: 45 }, (_, i) => ({
      causeKey: `cause${i}`,
      effectKey: `effect${i}`,
      causeContent: `cause text ${i}`,
      effectContent: `effect text ${i}`,
      entity: 'broker',
      causeFilePath: 'weekly/a.md',
      effectFilePath: 'weekly/b.md',
    }))
    const batchSizes: number[] = []
    let spawns = 0
    const makeClient = () => {
      spawns++
      return {
        async initialize() {},
        async createSession() {
          return 'session-1'
        },
        async sendPrompt(_sessionId: string, prompt: string) {
          // Echo a causal edge for every (causeKey,effectKey) pair listed in THIS batch's prompt.
          const causeKeys = [...prompt.matchAll(/- causeKey: (\S+)/g)].map((m) => m[1])
          const effectKeys = [...prompt.matchAll(/\n {2}effectKey: (\S+)/g)].map((m) => m[1])
          batchSizes.push(causeKeys.length)
          const arr = causeKeys.map((ck, i) => ({
            causeKey: ck,
            effectKey: effectKeys[i],
            confidence: 0.9,
          }))
          return { output: JSON.stringify(arr) }
        },
        async close() {},
      }
    }
    const provider = createAcpCausalProvider({
      cwd: '/tmp/scns-causal-test-isolated',
      createClient: () => makeClient() as never,
      batchSize: 20,
    })
    const edges = await provider.infer({ candidates })
    expect(edges).toHaveLength(45) // every candidate judged — no cap silently drops pairs
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(20) // ≤20-pair chunks (wall-safe)
    expect(spawns).toBe(3) // 45 candidates → 20 + 20 + 5, one bounded session per batch
  })
})
