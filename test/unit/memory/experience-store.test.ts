/**
 * Phase B — Shared Retrieval-Experience Store unit tests (B-CORE).
 *
 * Embedding-free + fully hermetic: every store is `:memory:` or an injected tmpdir file, so the suite
 * never spawns the fastembed worker and NEVER touches the live vault (`~/.scns/memory/vault.db`). These
 * are B-core tests 1-10; the ε-policy + entity-query-default tests (11-12) ship WITH B-EXPLORE, which is
 * a separate, later, John-gated step.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIsolatedRoot, snapshotVault, assertVaultUnchanged } from '../../helpers/isolation.js'
import Database from 'better-sqlite3'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { deserializeEmbedding } from '../../../src/memory/embeddings.js'
import { NULL_JUDGE_SCORE } from '../../../src/memory/judge-provider.js'
import { retrieveContext } from '../../../src/memory/retrieval-context.js'
import { classifyIntent } from '../../../src/memory/intent.js'
import type { SearchResult } from '../../../src/memory/search.js'
import type { BaseSearch } from '../../../src/memory/intent-search.js'
import {
  openExperienceStore,
  logRetrievalExperience,
  settleRetrievalExperience,
  settleHumanOutcome,
  logFullContextBaseline,
  projectToArmFrontierRow,
  retrieverFamilyOf,
  countExplorations24h,
  countServedByArm,
  countSettledByArm,
  readServedByArm,
  readSettledByArm,
  recordFollowupRefusal,
  isFollowupDeferred,
  clearFollowupRefusal,
  FOLLOWUP_REFUSAL_BACKOFF_BASE_MS,
  FOLLOWUP_REFUSAL_BACKOFF_CAP_MS,
  type ExperienceStore,
  type RetrievalExperienceInput,
} from '../../../src/memory/experience-store.js'

// ── helpers ──────────────────────────────────────────────────────────────────
function addChunk(db: Database.Database, path: string, mtimeMs: number, content: string): number {
  db.prepare('INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)').run(
    path,
    mtimeMs,
    content.length,
  )
  return db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, 0, ?, 0, ?, 1)`,
    )
    .run(path, content, content.length).lastInsertRowid as number
}

/** A base search returning a fixed set of sentinel chunk ids (proves retrieved_chunk_ids capture). */
function fixedBase(ids: readonly number[]): BaseSearch {
  return async (): Promise<readonly SearchResult[]> =>
    ids.map((chunkId) => ({
      chunkId,
      filePath: `f${chunkId}.md`,
      content: `content ${chunkId}`,
      score: 1,
      vectorScore: 0,
      keywordScore: 1,
      chunkIndex: 0,
    }))
}

interface RawRow {
  readonly id: number
  readonly conversation_id: string | null
  readonly turn: number | null
  readonly query_text: string
  readonly query_embedding: Buffer | null
  readonly retriever: string
  readonly magma_path: string | null
  readonly retrieved_chunk_ids: string | null
  readonly gen_answer: string | null
  readonly judge_score: number | null
  readonly dropped: number
  readonly tokens: number | null
  readonly latency_ms: number | null
  readonly human_outcome: number | null
  readonly category: number | null
  readonly intent: string | null
  readonly explore_arm: string | null
  readonly flag_state: string | null
}
const rows = (s: ExperienceStore): RawRow[] =>
  s.db.prepare('SELECT * FROM retrieval_experience ORDER BY id').all() as RawRow[]
const count = (s: ExperienceStore): number =>
  (s.db.prepare('SELECT COUNT(*) AS n FROM retrieval_experience').get() as { n: number }).n

// ── (1) openExperienceStore ────────────────────────────────────────────────────
describe('openExperienceStore', () => {
  it('creates the table idempotently on :memory: and is re-openable non-destructively on a temp file', () => {
    const mem = openExperienceStore(':memory:')
    expect(count(mem)).toBe(0)
    // Re-running the DDL (idempotent) must not throw or wipe data.
    mem.db.exec('CREATE TABLE IF NOT EXISTS retrieval_experience (id INTEGER PRIMARY KEY)') // no-op guard
    logRetrievalExperience(mem, { queryText: 'q', levers: {}, retrievedChunkIds: [1] })
    expect(count(mem)).toBe(1)
    mem.close()

    const dir = mkdtempSync(join(tmpdir(), 'scns-exp-'))
    const path = join(dir, 'experience.db')
    const s1 = openExperienceStore(path)
    expect(s1.db.pragma('journal_mode', { simple: true })).toBe('wal')
    logRetrievalExperience(s1, { queryText: 'persisted', levers: {}, retrievedChunkIds: [7] })
    s1.close()
    const s2 = openExperienceStore(path) // re-open: data survives, DDL is a no-op
    expect(count(s2)).toBe(1)
    expect(rows(s2)[0]!.query_text).toBe('persisted')
    s2.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

// ── (2) logRetrievalExperience ─────────────────────────────────────────────────
describe('logRetrievalExperience', () => {
  let store: ExperienceStore
  beforeEach(() => (store = openExperienceStore(':memory:')))
  afterEach(() => store.close())

  it('inserts exactly one row, returns its id, and round-trips all fields', () => {
    const id = logRetrievalExperience(store, {
      queryText: 'why did the broker crash',
      levers: {
        intentRouting: true,
        learnedEntityQuery: true,
        traversalOptions: { maxDepth: 5, budget: 200 },
      },
      retrievedChunkIds: [3, 1, 2],
      intent: 'WHY',
      category: 4,
      conversationId: 'conv-26',
      turn: 2,
      latencyMs: 12,
    })
    expect(id).toBeGreaterThan(0)
    expect(count(store)).toBe(1)
    const r = rows(store)[0]!
    expect(r.query_text).toBe('why did the broker crash')
    expect(r.retriever).toBe('magma') // intentRouting ⇒ magma
    expect(JSON.parse(r.retrieved_chunk_ids!)).toEqual([3, 1, 2])
    expect(JSON.parse(r.magma_path!)).toEqual([3, 1, 2]) // ranked node-id path for a magma arm
    expect(r.intent).toBe('WHY')
    expect(r.category).toBe(4)
    expect(r.conversation_id).toBe('conv-26')
    expect(r.turn).toBe(2)
    expect(r.latency_ms).toBe(12)
    expect(JSON.parse(r.flag_state!)).toMatchObject({
      intentRouting: true,
      learnedEntityQuery: true,
    })
    // Un-wired / unsettled at insert:
    expect(r.human_outcome).toBeNull()
    expect(r.judge_score).toBeNull()
    expect(r.gen_answer).toBeNull()
    expect(r.tokens).toBeNull()
    expect(r.dropped).toBe(0)
  })

  it("classifies a hybrid arm as 'hybrid' with a NULL magma_path", () => {
    logRetrievalExperience(store, { queryText: 'q', levers: {}, retrievedChunkIds: [9] })
    const r = rows(store)[0]!
    expect(r.retriever).toBe('hybrid')
    expect(r.magma_path).toBeNull()
    expect(JSON.parse(r.retrieved_chunk_ids!)).toEqual([9])
  })

  it('rejects a bad retriever enum at the DDL layer (CHECK constraint holds)', () => {
    expect(() =>
      store.db
        .prepare("INSERT INTO retrieval_experience (query_text, retriever) VALUES ('x','bogus')")
        .run(),
    ).toThrow(/CHECK/i)
  })

  it('round-trips a query_embedding BLOB as float32[384] byte-for-byte', () => {
    const vec = new Float32Array(384)
    for (let i = 0; i < 384; i++) vec[i] = (i - 192) / 384
    logRetrievalExperience(store, {
      queryText: 'q',
      levers: {},
      retrievedChunkIds: [1],
      queryEmbedding: vec,
    })
    const blob = rows(store)[0]!.query_embedding!
    expect(blob).toBeInstanceOf(Buffer)
    const back = deserializeEmbedding(blob)
    expect(back.length).toBe(384)
    expect(Array.from(back)).toEqual(Array.from(vec))
  })

  it('is fail-safe: a closed store returns -1 and never throws', () => {
    const s = openExperienceStore(':memory:')
    s.close()
    expect(logRetrievalExperience(s, { queryText: 'q', levers: {}, retrievedChunkIds: [1] })).toBe(
      -1,
    )
  })
})

// ── (3) settleRetrievalExperience ──────────────────────────────────────────────
describe('settleRetrievalExperience', () => {
  let store: ExperienceStore
  beforeEach(() => (store = openExperienceStore(':memory:')))
  afterEach(() => store.close())

  it('updates only the settle fields and leaves the insert fields intact', () => {
    const id = logRetrievalExperience(store, {
      queryText: 'q',
      levers: { traverse: true },
      retrievedChunkIds: [1, 2],
      intent: 'WHY',
      category: 1,
    })
    settleRetrievalExperience(store, id, {
      genAnswer: 'the answer',
      judgeScore: 0.8,
      tokens: 184,
      latencyMs: 900,
    })
    const r = rows(store)[0]!
    expect(r.gen_answer).toBe('the answer')
    expect(r.judge_score).toBe(0.8)
    expect(r.dropped).toBe(0)
    expect(r.tokens).toBe(184)
    expect(r.latency_ms).toBe(900)
    // insert fields untouched:
    expect(r.query_text).toBe('q')
    expect(r.retriever).toBe('magma')
    expect(JSON.parse(r.retrieved_chunk_ids!)).toEqual([1, 2])
    expect(r.category).toBe(1)
  })

  it('stores a dropped judge as NULL score + dropped=1 (NOT the -1 sentinel)', () => {
    const id = logRetrievalExperience(store, { queryText: 'q', levers: {}, retrievedChunkIds: [1] })
    settleRetrievalExperience(store, id, { judgeScore: null, dropped: true, tokens: 50 })
    const r = rows(store)[0]!
    expect(r.judge_score).toBeNull()
    expect(r.dropped).toBe(1)
    expect(r.tokens).toBe(50)
  })

  it('is a no-op on a negative (failed-log) handle and never throws', () => {
    logRetrievalExperience(store, { queryText: 'q', levers: {}, retrievedChunkIds: [1] })
    expect(() => settleRetrievalExperience(store, -1, { judgeScore: 1 })).not.toThrow()
    expect(rows(store)[0]!.judge_score).toBeNull() // untouched
  })
})

// ── (4) BYTE-IDENTICAL: retrieveContext with/without the experienceLog dep ──────
describe('retrieveContext — additive experienceLog (byte-identical when off; one row when on)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    addChunk(db, 'a.md', 1000, 'the broker booted')
  })
  afterEach(() => closeMemoryDb(db))

  it('OFF: no experienceLog ⇒ identical result shape and NO experienceId key', async () => {
    const r = await retrieveContext(
      db,
      'broker',
      { intentRouting: false },
      { baseSearch: fixedBase([1]) },
    )
    expect(r).toEqual({ text: r.text, intent: r.intent, chunkIds: [1], nResults: 1 })
    expect('experienceId' in r).toBe(false)
  })

  it('ON: text/intent/chunkIds/nResults IDENTICAL to OFF, plus exactly one row + experienceId', async () => {
    const off = await retrieveContext(
      db,
      'broker',
      { intentRouting: false },
      { baseSearch: fixedBase([1]) },
    )
    const store = openExperienceStore(':memory:')
    const on = await retrieveContext(
      db,
      'broker',
      { intentRouting: false },
      {
        baseSearch: fixedBase([1]),
        experienceLog: { store, episode: { conversationId: 'c', category: 2 } },
      },
    )
    expect(on.text).toBe(off.text)
    expect(on.intent).toBe(off.intent)
    expect(on.chunkIds).toEqual(off.chunkIds)
    expect(on.nResults).toBe(off.nResults)
    expect(count(store)).toBe(1)
    const r = rows(store)[0]!
    expect((on as { experienceId?: number }).experienceId).toBe(r.id)
    expect(r.query_text).toBe('broker')
    expect(JSON.parse(r.retrieved_chunk_ids!)).toEqual([1])
    expect(r.conversation_id).toBe('c')
    expect(r.category).toBe(2)
    store.close()
  })
})

// ── (5) retrieveContext ON derives the retriever per arm ────────────────────────
describe('retrieveContext — one row per call, retriever + magma_path derived from the arm config', () => {
  let db: Database.Database
  let store: ExperienceStore
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    addChunk(db, 'a.md', 1000, 'the broker booted')
    store = openExperienceStore(':memory:')
  })
  afterEach(() => {
    store.close()
    closeMemoryDb(db)
  })

  it("hybrid arm ⇒ retriever='hybrid', magma_path NULL", async () => {
    await retrieveContext(
      db,
      'broker',
      { intentRouting: false },
      { baseSearch: fixedBase([5]), experienceLog: { store, episode: {} } },
    )
    const r = rows(store)[0]!
    expect(r.retriever).toBe('hybrid')
    expect(r.magma_path).toBeNull()
    expect(JSON.parse(r.retrieved_chunk_ids!)).toEqual([5])
  })

  it("entity (intentRouting) arm ⇒ retriever='magma', magma_path == retrieved ids", async () => {
    await retrieveContext(
      db,
      'broker',
      { intentRouting: true },
      { baseSearch: fixedBase([5, 6]), experienceLog: { store, episode: {} } },
    )
    const r = rows(store)[0]!
    expect(r.retriever).toBe('magma')
    expect(JSON.parse(r.magma_path!)).toEqual(JSON.parse(r.retrieved_chunk_ids!))
  })
})

// ── (6) shared-logger single-source ─────────────────────────────────────────────
describe('logRetrievalExperience — one shared logger, identical rows from either call-site', () => {
  it('a direct call (simulating the cli.ts live closure) and the retrieveContext seam produce structurally identical rows for the same input', async () => {
    const input: RetrievalExperienceInput = {
      queryText: 'broker',
      levers: { intentRouting: false },
      retrievedChunkIds: [5],
      // Both prod seams classify intent the SAME way (classifyIntent(query), default SCNS_GAZETTEER):
      // the live cli.ts closure via classifyIntent(query); retrieveContext via classifyIntent(query, gaz).
      intent: classifyIntent('broker'),
    }
    // Path B (live): call the shared logger directly, as the cli.ts closure will.
    const live = openExperienceStore(':memory:')
    logRetrievalExperience(live, input)
    // Path A (offline seam): drive it through retrieveContext.
    const db = openMemoryDb(':memory:')
    addChunk(db, 'a.md', 1000, 'the broker booted')
    const off = openExperienceStore(':memory:')
    await retrieveContext(
      db,
      'broker',
      { intentRouting: false },
      { baseSearch: fixedBase([5]), experienceLog: { store: off, episode: {} } },
    )

    const norm = (r: RawRow) => ({
      retriever: r.retriever,
      query_text: r.query_text,
      magma_path: r.magma_path,
      retrieved_chunk_ids: r.retrieved_chunk_ids,
      intent: r.intent,
    })
    expect(norm(rows(live)[0]!)).toEqual(norm(rows(off)[0]!))
    live.close()
    off.close()
    closeMemoryDb(db)
  })
})

// ── (7) full-context baseline row ───────────────────────────────────────────────
describe('logFullContextBaseline', () => {
  it("writes retriever='full' with tokens set and retrieved_chunk_ids/gen_answer/magma_path NULL", () => {
    const store = openExperienceStore(':memory:')
    const id = logFullContextBaseline(store, {
      queryText: 'q',
      tokens: 101_000,
      category: 4,
      conversationId: 'conv-26',
    })
    expect(id).toBeGreaterThan(0)
    const r = rows(store)[0]!
    expect(r.retriever).toBe('full')
    expect(r.tokens).toBe(101_000)
    expect(r.retrieved_chunk_ids).toBeNull()
    expect(r.gen_answer).toBeNull()
    expect(r.magma_path).toBeNull()
    expect(r.category).toBe(4)
    expect(r.conversation_id).toBe('conv-26')
    store.close()
  })
})

// ── (8) evaluator projection ────────────────────────────────────────────────────
describe('projectToArmFrontierRow — store row → ArmFrontierRow, frontier-compatible', () => {
  it('maps judge_score→score (NULL/dropped→NULL_JUDGE_SCORE), tokens→contextTokens, category passthrough', () => {
    expect(
      projectToArmFrontierRow({ category: 4, judge_score: 0.8, dropped: 0, tokens: 184 }),
    ).toEqual({
      category: 4,
      score: 0.8,
      contextTokens: 184,
    })
    expect(
      projectToArmFrontierRow({ category: 1, judge_score: null, dropped: 0, tokens: 50 }),
    ).toEqual({
      category: 1,
      score: NULL_JUDGE_SCORE,
      contextTokens: 50,
    })
    expect(
      projectToArmFrontierRow({ category: 2, judge_score: 0.6, dropped: 1, tokens: 60 }).score,
    ).toBe(NULL_JUDGE_SCORE)
    expect(
      projectToArmFrontierRow({ category: null, judge_score: null, dropped: 0, tokens: null }),
    ).toEqual({
      category: -1,
      score: NULL_JUDGE_SCORE,
      contextTokens: 0,
    })
  })

  it('a projected set yields the SAME λ-frontier value as the raw judged rows (drops handled identically)', () => {
    // Raw judged rows (JudgeEvalRow-shaped: score>=0 graded, -1 == dropped) and their store equivalents.
    const raw = [
      { score: 1.0, contextTokens: 100 },
      { score: NULL_JUDGE_SCORE, contextTokens: 999 }, // dropped
      { score: 0.6, contextTokens: 200 },
    ]
    const stored = [
      { category: 0, judge_score: 1.0, dropped: 0, tokens: 100 },
      { category: 0, judge_score: null, dropped: 1, tokens: 999 },
      { category: 0, judge_score: 0.6, dropped: 0, tokens: 200 },
    ].map(projectToArmFrontierRow)
    // Frontier value formula (locomo-judge-lib frontierValue): vᵢ = accᵢ − λ·(tokᵢ/1000), dropping score<0.
    const frontier = (r: readonly { score: number; contextTokens: number }[], lambda: number) =>
      r.filter((x) => x.score >= 0).map((x) => x.score - lambda * (x.contextTokens / 1000))
    for (const lambda of [0, 0.25, 1.0]) {
      expect(frontier(stored, lambda)).toEqual(frontier(raw, lambda))
    }
  })
})

// ── (9) five-traps: fine episode key + lever attribution ────────────────────────
describe('five-traps attribution', () => {
  it('the same anchor with different intent/path yields DISTINCT episodes (query_text+intent+magma_path)', () => {
    const store = openExperienceStore(':memory:')
    // Trap #2: "Gina" asked two ways ⇒ two rows keyed finer than the anchor.
    logRetrievalExperience(store, {
      queryText: 'what does Gina play',
      levers: { intentRouting: true },
      retrievedChunkIds: [10, 11],
      intent: 'ENTITY',
    })
    logRetrievalExperience(store, {
      queryText: 'why did Gina leave',
      levers: { traverse: true },
      retrievedChunkIds: [22, 33],
      intent: 'WHY',
    })
    const [a, b] = rows(store)
    expect(a!.query_text).not.toBe(b!.query_text)
    expect(a!.intent).not.toBe(b!.intent)
    expect(a!.magma_path).not.toBe(b!.magma_path)
    store.close()
  })

  it('flag_state captures the levers for attribution incl. learnedEntityQuery + exploreArm + propensity', () => {
    const store = openExperienceStore(':memory:')
    logRetrievalExperience(store, {
      queryText: 'q',
      levers: {
        traverse: true,
        learnedEntityQuery: true,
        exploreArm: 'causal-beam',
        epsilon: 0.1,
        propensity: 0.0333,
      },
      retrievedChunkIds: [1],
    })
    const r = rows(store)[0]!
    expect(JSON.parse(r.flag_state!)).toMatchObject({
      traverse: true,
      learnedEntityQuery: true,
      exploreArm: 'causal-beam',
      epsilon: 0.1,
      propensity: 0.0333,
    })
    expect(r.explore_arm).toBe('causal-beam')
    store.close()
  })
})

// ── (B-EXPLORE bound) countExplorations24h ──────────────────────────────────────
describe('countExplorations24h — the 24h half of the ε-router bound', () => {
  it('counts only explored rows (explore_arm NOT NULL), ignoring exploit rows', () => {
    const store = openExperienceStore(':memory:')
    logRetrievalExperience(store, { queryText: 'q1', levers: {}, retrievedChunkIds: [1] }) // exploit hybrid
    logRetrievalExperience(store, {
      queryText: 'q2',
      levers: { intentRouting: true },
      retrievedChunkIds: [2],
    }) // magma, but NOT an ε-explore
    expect(countExplorations24h(store)).toBe(0)
    // ε-explored rows carry explore_arm (+ propensity) ⇒ they count toward the bound.
    logRetrievalExperience(store, {
      queryText: 'q3',
      levers: { intentRouting: true, exploreArm: 'entity', propensity: 0.1 / 3 },
      retrievedChunkIds: [3],
    })
    logRetrievalExperience(store, {
      queryText: 'q4',
      levers: { traverse: true, exploreArm: 'causal-beam', propensity: 0.1 / 3 },
      retrievedChunkIds: [4],
    })
    expect(countExplorations24h(store)).toBe(2)
    store.close()
  })
})

// ── (10) isolation: injected path only; retrieverFamilyOf classification ────────
describe('store isolation + classification', () => {
  it('opens ONLY at the injected path (a tmpdir file), never a homedir/vault path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scns-exp-iso-'))
    const path = join(dir, 'experience.db')
    const store = openExperienceStore(path)
    logRetrievalExperience(store, { queryText: 'q', levers: {}, retrievedChunkIds: [1] })
    settleRetrievalExperience(store, 1, { judgeScore: 1 })
    expect(store.db.name).toBe(path) // better-sqlite3 exposes the opened path
    expect(existsSync(path)).toBe(true)
    expect(path.includes('/.scns/')).toBe(false)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('retrieverFamilyOf: magma iff any MAGMA mechanism ran, else hybrid', () => {
    expect(retrieverFamilyOf({})).toBe('hybrid')
    expect(retrieverFamilyOf({ semantic: true, timeline: true, entityRelevanceRank: true })).toBe(
      'hybrid',
    )
    expect(retrieverFamilyOf({ intentRouting: true })).toBe('magma')
    expect(retrieverFamilyOf({ fusion: true })).toBe('magma')
    expect(retrieverFamilyOf({ traverse: true })).toBe('magma')
    expect(retrieverFamilyOf({ synthesize: true })).toBe('magma')
    expect(retrieverFamilyOf({ multiHop: true })).toBe('magma') // C2 — graph-based deep retrieval
  })
})

describe('settleHumanOutcome — Phase D: the human accept-vs-waste write (6-pt gradient column)', () => {
  it('writes a valid [0,1] outcome onto an existing row and returns true', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, { queryText: 'q', levers: {}, retrievedChunkIds: [1] })
    expect(settleHumanOutcome(store, id, 0.8)).toBe(true)
    const r = store.db
      .prepare(`SELECT human_outcome FROM retrieval_experience WHERE id = ?`)
      .get(id) as {
      human_outcome: number | null
    }
    expect(r.human_outcome).toBe(0.8)
    store.close()
  })
  it('rejects out-of-range / non-finite values (returns false, row untouched)', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, { queryText: 'q', levers: {}, retrievedChunkIds: [] })
    for (const bad of [-0.1, 1.1, NaN, Infinity])
      expect(settleHumanOutcome(store, id, bad)).toBe(false)
    const r = store.db
      .prepare(`SELECT human_outcome FROM retrieval_experience WHERE id = ?`)
      .get(id) as {
      human_outcome: number | null
    }
    expect(r.human_outcome).toBeNull()
    store.close()
  })
  it('is fail-safe: id<0 or a missing row returns false, never throws', () => {
    const store = openExperienceStore(':memory:')
    expect(settleHumanOutcome(store, -1, 0.5)).toBe(false)
    expect(settleHumanOutcome(store, 99999, 0.5)).toBe(false)
    store.close()
  })
})

// ── T005 (Foundational, specs/001-learning-memory-loop) — schema deltas ──────────────────────────

describe('T005 — first-class propensity + target columns and the (intent,target) index', () => {
  it('retrieval_experience has a propensity REAL column and a target TEXT column', () => {
    const store = openExperienceStore(':memory:')
    const cols = store.db.prepare('PRAGMA table_info(retrieval_experience)').all() as {
      name: string
      type: string
    }[]
    const byName = new Map(cols.map((c) => [c.name, c.type]))
    expect(byName.get('propensity')).toBe('REAL')
    expect(byName.get('target')).toBe('TEXT')
    store.close()
  })

  it('an (intent, target) composite index exists — the US4 reuse-lookup key', () => {
    const store = openExperienceStore(':memory:')
    const idx = store.db.prepare('PRAGMA index_list(retrieval_experience)').all() as {
      name: string
    }[]
    expect(idx.map((i) => i.name)).toContain('idx_rexp_intent_target')
    const info = store.db.prepare('PRAGMA index_info(idx_rexp_intent_target)').all() as {
      name: string
    }[]
    expect(info.map((c) => c.name)).toEqual(['intent', 'target'])
    store.close()
  })

  it('ADDITIVE migration: a pre-feature experience.db gains both columns on reopen and keeps its rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scns-exp-migrate-'))
    const dbPath = join(dir, 'experience.db')
    try {
      // Simulate the live pre-feature DB: the 19-column schema WITHOUT propensity/target.
      const legacy = new Database(dbPath)
      legacy.exec(`
        CREATE TABLE retrieval_experience (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id     TEXT,
          turn                INTEGER,
          query_text          TEXT NOT NULL,
          query_embedding     BLOB,
          retriever           TEXT NOT NULL CHECK (retriever IN ('hybrid','magma','full')),
          magma_path          TEXT,
          retrieved_chunk_ids TEXT,
          gen_answer          TEXT,
          judge_score         REAL,
          dropped             INTEGER NOT NULL DEFAULT 0,
          tokens              INTEGER,
          latency_ms          INTEGER,
          human_outcome       REAL CHECK (human_outcome IS NULL OR (human_outcome >= 0 AND human_outcome <= 1)),
          category            INTEGER,
          intent              TEXT,
          explore_arm         TEXT,
          flag_state          TEXT,
          created_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );`)
      legacy
        .prepare(
          `INSERT INTO retrieval_experience (query_text, retriever, intent) VALUES (?, 'hybrid', 'lookup')`,
        )
        .run('legacy row')
      // Negative control: the legacy DB really lacks the columns (else this migration test is vacuous).
      const legacyCols = (
        legacy.prepare('PRAGMA table_info(retrieval_experience)').all() as { name: string }[]
      ).map((c) => c.name)
      expect(legacyCols).not.toContain('propensity')
      expect(legacyCols).not.toContain('target')
      legacy.close()

      // Reopen through the store: columns appear, the legacy row survives with NULLs.
      const store = openExperienceStore(dbPath)
      const cols = (
        store.db.prepare('PRAGMA table_info(retrieval_experience)').all() as { name: string }[]
      ).map((c) => c.name)
      expect(cols).toContain('propensity')
      expect(cols).toContain('target')
      const row = store.db
        .prepare(
          `SELECT query_text, propensity, target FROM retrieval_experience WHERE query_text = ?`,
        )
        .get('legacy row') as {
        query_text: string
        propensity: number | null
        target: string | null
      }
      expect(row.query_text).toBe('legacy row')
      expect(row.propensity).toBeNull()
      expect(row.target).toBeNull()
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a logged propensity + target round-trip as first-class columns', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, {
      queryText: 'route me',
      levers: {},
      retrievedChunkIds: [],
      intent: 'why',
      propensity: 0.25,
      target: 'broker-port-decision',
    })
    expect(id).toBeGreaterThan(0)
    const row = store.db
      .prepare(`SELECT propensity, target FROM retrieval_experience WHERE id = ?`)
      .get(id) as { propensity: number | null; target: string | null }
    expect(row.propensity).toBe(0.25)
    expect(row.target).toBe('broker-port-decision')
    store.close()
  })
})

// ── T021 [US2] (specs/001-learning-memory-loop) — the complete seven-field attempt record ────────

describe('T021 — one attempt id carries all seven spec fields; writes are fail-safe', () => {
  it('POSITIVE: log → settle → human-verdict yields all seven fields under ONE id', () => {
    const store = openExperienceStore(':memory:')
    const id = logRetrievalExperience(store, {
      queryText: 'what did I decide about the broker port',
      levers: { intentRouting: true, exploreArm: 'magma', propensity: 0.1 },
      retrievedChunkIds: [4, 2],
      intent: 'ENTITY',
      target: 'broker-port-decision',
    })
    settleRetrievalExperience(store, id, {
      genAnswer: 'You pinned the broker to :3456.',
      judgeScore: 0.8,
      tokens: 512,
    })
    expect(settleHumanOutcome(store, id, 1.0)).toBe(true)

    const r = store.db.prepare('SELECT * FROM retrieval_experience WHERE id = ?').get(id) as {
      query_text: string
      retriever: string
      flag_state: string
      explore_arm: string | null
      retrieved_chunk_ids: string
      magma_path: string | null
      gen_answer: string | null
      judge_score: number | null
      tokens: number | null
      human_outcome: number | null
      propensity: number | null
      target: string | null
    }
    // 1 query, 2 strategy (retriever+flag_state+explore_arm), 3 briefing (chunk ids+magma_path),
    // 4 answer, 5 judge quality, 6 tokens, 7 human verdict — all present, one id.
    expect(r.query_text).toBe('what did I decide about the broker port')
    expect(r.retriever).toBe('magma')
    expect(JSON.parse(r.flag_state)).toMatchObject({ intentRouting: true, exploreArm: 'magma' })
    expect(r.explore_arm).toBe('magma')
    expect(JSON.parse(r.retrieved_chunk_ids)).toEqual([4, 2])
    expect(r.magma_path).not.toBeNull()
    expect(r.gen_answer).toBe('You pinned the broker to :3456.')
    expect(r.judge_score).toBe(0.8)
    expect(r.tokens).toBe(512)
    expect(r.human_outcome).toBe(1.0)
    expect(r.propensity).toBe(0.1)
    expect(r.target).toBe('broker-port-decision')
    store.close()
  })

  it('NEGATIVE (fail-safe): a forced write failure returns -1 and the vault snapshot is untouched', () => {
    const root = createIsolatedRoot()
    try {
      writeFileSync(root.vaultDbPath, 'fake-vault-bytes')
      const before = snapshotVault(root.vaultDbPath)
      const store = openExperienceStore(root.experienceDbPath)
      store.close() // force every subsequent write to fail
      const id = logRetrievalExperience(store, {
        queryText: 'q',
        levers: {},
        retrievedChunkIds: [],
      })
      expect(id).toBe(-1)
      expect(settleHumanOutcome(store, 1, 0.5)).toBe(false)
      const after = assertVaultUnchanged(before) // throws if the vault moved
      expect(after.size).toBe(before.size)
    } finally {
      root.cleanup()
    }
  })
})

/**
 * Prompt-origin labelling. John's decision (2026-07-31): machine-originated retrievals are KEPT — they
 * are useful data for optimizing the harness later — but they must be MARKED at capture time so agent
 * traffic is never mistaken for a human signal at label time. Previously nothing recorded the origin,
 * so a sub-agent prompt ("Run these two bash commands and report...") was indistinguishable from John.
 */
describe('prompt origin is recorded at capture time', () => {
  let store: ExperienceStore
  beforeEach(() => (store = openExperienceStore(':memory:')))
  afterEach(() => store.close())

  const originOf = (id: number) =>
    store.db
      .prepare(
        'SELECT prompt_origin AS o, prompt_origin_rule AS r FROM retrieval_experience WHERE id=?',
      )
      .get(id) as { o: string | null; r: string | null }

  it('labels a human-authored prompt as human', () => {
    const id = logRetrievalExperience(store, {
      queryText: "you're only looking surface level and looking for shortcuts",
      levers: { traverse: true },
      retrievedChunkIds: [1],
    })
    expect(originOf(id).o).toBe('human')
  })

  it('labels a machine-authored prompt as machine and records the rule that matched', () => {
    const id = logRetrievalExperience(store, {
      queryText: 'You are a strict news-desk fact-checker for a DAILY dev newsletter.',
      levers: { traverse: true },
      retrievedChunkIds: [1],
    })
    const row = originOf(id)
    expect(row.o).toBe('machine')
    expect(row.r).toBeTruthy()
  })

  it('labels the full-context baseline path too', () => {
    const id = logFullContextBaseline(store, {
      queryText: 'You are picking up Lane B (agent harness / ops).',
      tokens: 10,
    })
    expect(originOf(id).o).toBe('machine')
  })

  it('keeps machine rows — they are marked, never dropped', () => {
    logRetrievalExperience(store, {
      queryText: 'You are a strict news-desk fact-checker for a DAILY dev newsletter.',
      levers: { traverse: true },
      retrievedChunkIds: [1],
    })
    const n = store.db.prepare('SELECT COUNT(*) c FROM retrieval_experience').get() as { c: number }
    expect(n.c).toBe(1)
  })
})

/**
 * The settle choke point refuses machine-origin rows. Marking the origin (above) is only half the fix:
 * without this, agent traffic could still be settled as if it were John's accept-or-waste signal — the
 * exact contamination class that produced fabricated ACCEPTs. One guard here covers EVERY producer.
 */
describe('settleHumanOutcome refuses machine-origin rows', () => {
  let store: ExperienceStore
  beforeEach(() => (store = openExperienceStore(':memory:')))
  afterEach(() => store.close())

  it('settles a human-origin row', () => {
    const id = logRetrievalExperience(store, {
      queryText: 'did we address these bugs or at least create issues',
      levers: { traverse: true },
      retrievedChunkIds: [1],
    })
    expect(settleHumanOutcome(store, id, 0.2)).toBe(true)
  })

  it('refuses a machine-origin row and leaves human_outcome NULL', () => {
    const id = logRetrievalExperience(store, {
      queryText: 'You are a strict news-desk fact-checker for a DAILY dev newsletter.',
      levers: { traverse: true },
      retrievedChunkIds: [1],
    })
    expect(settleHumanOutcome(store, id, 1.0)).toBe(false)
    const row = store.db
      .prepare('SELECT human_outcome AS h FROM retrieval_experience WHERE id=?')
      .get(id) as { h: number | null }
    expect(row.h).toBeNull()
  })

  it('still settles legacy rows captured before prompt_origin existed', () => {
    const id = logRetrievalExperience(store, {
      queryText: 'legacy row',
      levers: { traverse: true },
      retrievedChunkIds: [1],
    })
    store.db.prepare('UPDATE retrieval_experience SET prompt_origin = NULL WHERE id=?').run(id)
    expect(settleHumanOutcome(store, id, 0.8)).toBe(true)
  })
})

describe('prompt_origin backfill annotates the existing corpus', () => {
  it('labels legacy rows without touching an already-settled verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backfill-'))
    const path = join(dir, 'exp.db')
    let s = openExperienceStore(path)
    const humanId = logRetrievalExperience(s, {
      queryText: 'lets fix that & test it to make sure that it works',
      levers: { traverse: true },
      retrievedChunkIds: [1],
    })
    const machineId = logRetrievalExperience(s, {
      queryText: 'You are a strict news-desk fact-checker for a DAILY dev newsletter.',
      levers: { traverse: true },
      retrievedChunkIds: [1],
    })
    // simulate a pre-feature corpus: origin unknown, and one row already settled
    s.db
      .prepare('UPDATE retrieval_experience SET prompt_origin=NULL, prompt_origin_rule=NULL')
      .run()
    s.db.prepare('UPDATE retrieval_experience SET human_outcome=1.0 WHERE id=?').run(machineId)
    s.close()

    s = openExperienceStore(path)
    const get = (id: number) =>
      s.db
        .prepare(
          'SELECT prompt_origin AS o, human_outcome AS h FROM retrieval_experience WHERE id=?',
        )
        .get(id) as { o: string | null; h: number | null }
    expect(get(humanId).o).toBe('human')
    expect(get(machineId).o).toBe('machine')
    expect(get(machineId).h).toBe(1.0) // annotate-only: an existing verdict is preserved
    s.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * T018–T020 [US1] — #20: unknown ≠ absent ≠ empty (FR-024–FR-026).
 *
 * RED FIRST. `readServedByArm` / `readSettledByArm` and the `EvidenceRead` discriminated union do
 * not exist yet; `countServedByArm`/`countSettledByArm` both end in `catch { return out }`
 * (`experience-store.ts:592,650`), which returns an EMPTY MAP on any read failure. That swallow is
 * what makes the review's existing "Evidence base UNKNOWN" branch (`weekly-report.ts:221`)
 * unreachable — a failed read is currently indistinguishable from a starved learner, so the review
 * would print `arm: 0` as fact.
 *
 * Contract: `specs/003-label-integrity-defects/contracts/evidence-counts.md`.
 */
describe('T018 [US1] RED — the evidence read discriminates three states (FR-026)', () => {
  it('returns { status: "ok", counts } for a readable corpus', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evread-ok-'))
    const path = join(dir, 'experience.db')
    const s = openExperienceStore(path)
    s.db
      .prepare(
        `INSERT INTO retrieval_experience (query_text, retriever, explore_arm, human_outcome, prompt_origin)
         VALUES ('q', 'magma', 'magma', 1.0, 'human')`,
      )
      .run()
    s.close()

    const served = readServedByArm(path)
    const settled = readSettledByArm(path)
    expect(served.status).toBe('ok')
    expect(settled.status).toBe('ok')
    if (served.status !== 'ok' || settled.status !== 'ok') throw new Error('narrowing')
    expect(served.counts.get('magma')).toBe(1)
    expect(settled.counts.get('magma')).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns { status: "absent", path } when the store file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evread-absent-'))
    const path = join(dir, 'nope.db')
    expect(existsSync(path)).toBe(false)

    const read = readSettledByArm(path)
    expect(read.status).toBe('absent')
    if (read.status !== 'absent') throw new Error('narrowing')
    expect(read.path).toBe(path)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns { status: "failed", error } when open or query throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evread-failed-'))
    const path = join(dir, 'corrupt.db')
    // A real file that exists but is not a SQLite database — `absent` must not absorb this.
    writeFileSync(path, 'this is not a sqlite database')

    const read = readSettledByArm(path)
    expect(read.status).toBe('failed')
    if (read.status !== 'failed') throw new Error('narrowing')
    expect(read.error.length).toBeGreaterThan(0)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('T019 [US1] RED — NEGATIVE CONTROL: a genuinely EMPTY corpus is `ok`, never `failed`', () => {
  it('an empty corpus returns status "ok" with zero entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evread-empty-'))
    const path = join(dir, 'experience.db')
    openExperienceStore(path).close() // schema, no rows

    const served = readServedByArm(path)
    const settled = readSettledByArm(path)
    expect(served.status).toBe('ok')
    expect(settled.status).toBe('ok')
    if (served.status !== 'ok' || settled.status !== 'ok') throw new Error('narrowing')
    expect(served.counts.size).toBe(0)
    expect(settled.counts.size).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not collapse in the other direction either — a FAILED read is never reported as `ok` with zero entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evread-nocollapse-'))
    const path = join(dir, 'corrupt.db')
    writeFileSync(path, 'not sqlite')

    const read = readSettledByArm(path)
    expect(read.status).not.toBe('ok')
    expect(read.status).toBe('failed')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('T020 [US1] RED — NEGATIVE CONTROL: the fail-safe adapter must never throw (FR-025)', () => {
  it('countSettledByArm returns an empty Map on an injected read failure and does not throw', () => {
    const store = openExperienceStore(':memory:')
    const broken = {
      ...store,
      db: {
        prepare() {
          throw new Error('injected read failure')
        },
      },
    } as unknown as ExperienceStore

    let result: Map<string, number> | undefined
    expect(() => {
      result = countSettledByArm(broken)
    }).not.toThrow()
    expect(result).toBeInstanceOf(Map)
    expect(result?.size).toBe(0)
    store.close()
  })

  it('countServedByArm has the same never-throw contract', () => {
    const store = openExperienceStore(':memory:')
    const broken = {
      ...store,
      db: {
        prepare() {
          throw new Error('injected read failure')
        },
      },
    } as unknown as ExperienceStore

    expect(() => countServedByArm(broken)).not.toThrow()
    expect(countServedByArm(broken).size).toBe(0)
    store.close()
  })

  it('the STRICT read surfaces the same failure the adapter swallows — the two must not be the same function', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evread-split-'))
    const path = join(dir, 'corrupt.db')
    writeFileSync(path, 'not sqlite')

    // Strict form reports it...
    expect(readSettledByArm(path).status).toBe('failed')
    // ...while the routing path still gets a usable, empty answer without throwing.
    const store = openExperienceStore(':memory:')
    const broken = {
      ...store,
      db: {
        prepare() {
          throw new Error('injected read failure')
        },
      },
    } as unknown as ExperienceStore
    expect(countSettledByArm(broken).size).toBe(0)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * PR #24 finding A [US1] — `existsSync` is not an ENOENT test (FR-026).
 *
 * RED FIRST. `readByArm` gated `absent` on `existsSync(path)`, which returns `false` for ANY stat
 * error — EACCES included. A store that is PRESENT but unreadable therefore rendered as:
 *
 *   "There is no experience store at <path> — the broker creates it on first retrieval. … This is
 *    the expected state on a fresh install, not a failure … the cause is known and self-resolving."
 *
 * which is false, and a direct FR-026 violation: the two states are separated PRECISELY because
 * `absent` has a known self-resolving cause and `failed` does not. Verified against `dist/` on
 * 2026-08-02 — a store inside a `chmod 000` directory reported `status = absent`.
 */
describe('PR#24-A [US1] RED — a PRESENT-but-unreadable store is `failed`, never `absent`', () => {
  // chmod 000 cannot make a path unreadable on NTFS, so the permission-denied
  // state these two tests construct does not exist on a win32 host.
  it.skipIf(process.platform === 'win32')(
    'classifies a permissions failure as failed, not absent',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'evread-perm-'))
      const inner = join(dir, 'inner')
      mkdirSync(inner)
      const path = join(inner, 'experience.db')
      openExperienceStore(path).close() // a REAL, well-formed store — only the access is denied
      chmodSync(inner, 0o000)

      try {
        // The premise of the whole test: this is exactly the lie `existsSync` told.
        expect(existsSync(path)).toBe(false)

        const settled = readSettledByArm(path)
        const served = readServedByArm(path)
        expect(settled.status).toBe('failed')
        expect(served.status).toBe('failed')
        if (settled.status !== 'failed') throw new Error('narrowing')
        expect(settled.error.length).toBeGreaterThan(0)
        // The renderer keys the "fresh install, self-resolving" wording off `absent`, so the reason
        // must not be silently reworded into that branch.
        expect(settled.error).not.toMatch(/fresh install/i)
      } finally {
        chmodSync(inner, 0o700)
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it('still reports a genuinely missing file as absent (POSITIVE CONTROL — the fix must not over-correct)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evread-perm-ctl-'))
    const path = join(dir, 'never-created.db')
    const read = readSettledByArm(path)
    expect(read.status).toBe('absent')
    if (read.status !== 'absent') throw new Error('narrowing')
    expect(read.path).toBe(path)
    rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'an unreadable PARENT DIRECTORY is failed too — the store may well exist behind it',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'evread-perm-dir-'))
      const inner = join(dir, 'locked')
      mkdirSync(inner, { mode: 0o000 })
      try {
        const read = readSettledByArm(join(inner, 'memory', 'experience.db'))
        expect(read.status).toBe('failed')
      } finally {
        chmodSync(inner, 0o700)
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})

// ── T068/T069 [US4] — the `followup_refusal` table and its back-off policy (#17) ──────────────────
// Durable memory that a pair was offered to the expensive ACP reader and declined. Before this table
// the refusal record was an in-memory Set constructed inside a single sweep run, so the same
// permanently-refused pairs were re-offered every hour until the 12-read budget was exhausted.
// Contract: specs/003-label-integrity-defects/contracts/refusal-backoff.md (FR-006..FR-011).

describe('T068 [US4] — followup_refusal schema', () => {
  it('the table exists with the data-model.md columns', () => {
    const store = openExperienceStore(':memory:')
    const cols = store.db.prepare('PRAGMA table_info(followup_refusal)').all() as {
      name: string
      type: string
      notnull: number
      pk: number
      dflt_value: string | null
    }[]
    const byName = new Map(cols.map((c) => [c.name, c]))
    expect(byName.get('experience_id')?.type).toBe('INTEGER')
    expect(byName.get('experience_id')?.pk).toBe(1)
    expect(byName.get('conversation_id')?.type).toBe('TEXT')
    expect(byName.get('conversation_id')?.notnull).toBe(1)
    expect(byName.get('first_refused_at')?.type).toBe('TEXT')
    expect(byName.get('first_refused_at')?.notnull).toBe(1)
    expect(byName.get('last_refused_at')?.type).toBe('TEXT')
    expect(byName.get('last_refused_at')?.notnull).toBe(1)
    expect(byName.get('attempts')?.type).toBe('INTEGER')
    expect(byName.get('attempts')?.dflt_value).toBe('1')
    expect(byName.get('turns_at_refusal')?.type).toBe('INTEGER')
    store.close()
  })

  it('ADDITIVE: opening a pre-feature experience.db creates the table without touching existing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scns-refusal-migrate-'))
    const dbPath = join(dir, 'experience.db')
    try {
      const legacy = new Database(dbPath)
      // The live pre-feature shape (as in the T005 migration test): base columns, no refusal table.
      legacy.exec(
        `CREATE TABLE retrieval_experience (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           conversation_id TEXT,
           turn INTEGER,
           query_text TEXT NOT NULL,
           query_embedding BLOB,
           retriever TEXT NOT NULL CHECK (retriever IN ('hybrid','magma','full')),
           magma_path TEXT,
           retrieved_chunk_ids TEXT,
           gen_answer TEXT,
           judge_score REAL,
           dropped INTEGER NOT NULL DEFAULT 0,
           tokens INTEGER,
           latency_ms INTEGER,
           human_outcome REAL CHECK (human_outcome IS NULL OR (human_outcome >= 0 AND human_outcome <= 1)),
           category INTEGER,
           intent TEXT,
           explore_arm TEXT,
           flag_state TEXT,
           created_at TEXT NOT NULL DEFAULT (datetime('now'))
         );`,
      )
      legacy
        .prepare(`INSERT INTO retrieval_experience (query_text, retriever) VALUES (?, 'hybrid')`)
        .run('legacy row')
      expect(
        legacy
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'followup_refusal'`,
          )
          .get(),
      ).toBeUndefined()
      legacy.close()

      const store = openExperienceStore(dbPath)
      expect(
        store.db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'followup_refusal'`,
          )
          .get(),
      ).toBeDefined()
      expect(store.db.prepare(`SELECT COUNT(*) AS n FROM retrieval_experience`).get()).toEqual({
        n: 1,
      })
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('T069 [US4] — recordFollowupRefusal / isFollowupDeferred / clearFollowupRefusal', () => {
  const mkRow = (store: ExperienceStore, conversationId: string): number =>
    logRetrievalExperience(store, {
      queryText: 'how do i restart the scns broker safely',
      levers: { traverse: true, synthesize: true },
      retrievedChunkIds: [1, 2],
      conversationId,
      latencyMs: 200,
    })

  const refusalRow = (store: ExperienceStore, id: number) =>
    store.db
      .prepare(
        `SELECT conversation_id, first_refused_at, last_refused_at, attempts, turns_at_refusal
           FROM followup_refusal WHERE experience_id = ?`,
      )
      .get(id) as
      | {
          conversation_id: string
          first_refused_at: string
          last_refused_at: string
          attempts: number
          turns_at_refusal: number | null
        }
      | undefined

  it('a pair with no refusal row is never deferred', () => {
    const store = openExperienceStore(':memory:')
    const id = mkRow(store, 'conv-1')
    expect(isFollowupDeferred(store, { experienceId: id, currentTurnCount: 2 })).toBe(false)
    store.close()
  })

  it('recording a refusal stamps the row; a repeat refusal accumulates attempts and advances last_refused_at only', () => {
    const store = openExperienceStore(':memory:')
    const id = mkRow(store, 'conv-1')
    const t1 = new Date('2026-08-14T12:00:00.000Z')
    const t2 = new Date('2026-08-14T16:30:00.000Z')

    recordFollowupRefusal(store, {
      experienceId: id,
      conversationId: 'conv-1',
      turnsAtRefusal: 2,
      refusedAt: t1,
    })
    let row = refusalRow(store, id)
    expect(row).toEqual({
      conversation_id: 'conv-1',
      first_refused_at: t1.toISOString(),
      last_refused_at: t1.toISOString(),
      attempts: 1,
      turns_at_refusal: 2,
    })

    recordFollowupRefusal(store, {
      experienceId: id,
      conversationId: 'conv-1',
      turnsAtRefusal: 3,
      refusedAt: t2,
    })
    row = refusalRow(store, id)
    expect(row?.attempts).toBe(2)
    expect(row?.first_refused_at).toBe(t1.toISOString()) // the audit anchor never moves
    expect(row?.last_refused_at).toBe(t2.toISOString())
    expect(row?.turns_at_refusal).toBe(3)
    store.close()
  })

  it('RR1/FR-007: a fresh refusal defers the pair for the whole base window', () => {
    const store = openExperienceStore(':memory:')
    const id = mkRow(store, 'conv-1')
    const t = new Date('2026-08-14T12:00:00.000Z')
    recordFollowupRefusal(store, {
      experienceId: id,
      conversationId: 'conv-1',
      turnsAtRefusal: 2,
      refusedAt: t,
    })

    const oneHourLater = new Date(t.getTime() + 60 * 60 * 1000)
    expect(
      isFollowupDeferred(store, { experienceId: id, currentTurnCount: 2, now: oneHourLater }),
    ).toBe(true)
    const afterBase = new Date(t.getTime() + FOLLOWUP_REFUSAL_BACKOFF_BASE_MS)
    expect(
      isFollowupDeferred(store, { experienceId: id, currentTurnCount: 2, now: afterBase }),
    ).toBe(false)
    store.close()
  })

  it('RR2/FR-008: the window DOUBLES per attempt and is CAPPED — bounded retries, never a seal', () => {
    const store = openExperienceStore(':memory:')
    const id = mkRow(store, 'conv-1')
    const t = new Date('2026-08-14T12:00:00.000Z')
    for (let i = 0; i < 2; i++) {
      recordFollowupRefusal(store, {
        experienceId: id,
        conversationId: 'conv-1',
        turnsAtRefusal: 2,
        refusedAt: t,
      })
    }

    // attempts = 2 ⇒ window = 2×base.
    const afterOneBase = new Date(t.getTime() + FOLLOWUP_REFUSAL_BACKOFF_BASE_MS)
    expect(
      isFollowupDeferred(store, { experienceId: id, currentTurnCount: 2, now: afterOneBase }),
    ).toBe(true)
    const afterTwoBase = new Date(t.getTime() + 2 * FOLLOWUP_REFUSAL_BACKOFF_BASE_MS)
    expect(
      isFollowupDeferred(store, { experienceId: id, currentTurnCount: 2, now: afterTwoBase }),
    ).toBe(false)

    // A pathological attempt count still frees the pair at the cap.
    store.db.prepare(`UPDATE followup_refusal SET attempts = 50 WHERE experience_id = ?`).run(id)
    const justUnderCap = new Date(t.getTime() + FOLLOWUP_REFUSAL_BACKOFF_CAP_MS - 1)
    expect(
      isFollowupDeferred(store, { experienceId: id, currentTurnCount: 2, now: justUnderCap }),
    ).toBe(true)
    const atCap = new Date(t.getTime() + FOLLOWUP_REFUSAL_BACKOFF_CAP_MS)
    expect(isFollowupDeferred(store, { experienceId: id, currentTurnCount: 2, now: atCap })).toBe(
      false,
    )
    store.close()
  })

  it('RR2/FR-008: NEW EVIDENCE recovers the pair immediately — turn count above turns_at_refusal', () => {
    const store = openExperienceStore(':memory:')
    const id = mkRow(store, 'conv-1')
    recordFollowupRefusal(store, { experienceId: id, conversationId: 'conv-1', turnsAtRefusal: 2 })
    expect(isFollowupDeferred(store, { experienceId: id, currentTurnCount: 2 })).toBe(true)
    expect(isFollowupDeferred(store, { experienceId: id, currentTurnCount: 3 })).toBe(false)
    store.close()
  })

  it('clearFollowupRefusal removes the record entirely', () => {
    const store = openExperienceStore(':memory:')
    const id = mkRow(store, 'conv-1')
    recordFollowupRefusal(store, { experienceId: id, conversationId: 'conv-1', turnsAtRefusal: 2 })
    clearFollowupRefusal(store, id)
    expect(refusalRow(store, id)).toBeUndefined()
    expect(isFollowupDeferred(store, { experienceId: id, currentTurnCount: 2 })).toBe(false)
    store.close()
  })

  it('RR5 (T072): settling the record clears its refusal row — table growth stays bounded by the frontier', () => {
    const store = openExperienceStore(':memory:')
    const id = mkRow(store, 'conv-1')
    recordFollowupRefusal(store, { experienceId: id, conversationId: 'conv-1', turnsAtRefusal: 2 })
    expect(refusalRow(store, id)).toBeDefined()

    expect(settleHumanOutcome(store, id, 0.2, 'followup:repeat-need:turn-1:conf-0.90')).toBe(true)

    expect(refusalRow(store, id)).toBeUndefined()
    store.close()
  })

  it('a REFUSED settle does not clear the record — only a real label removes the work item', () => {
    const store = openExperienceStore(':memory:')
    const id = mkRow(store, 'conv-1')
    settleHumanOutcome(store, id, 1.0) // first signal wins the row…
    recordFollowupRefusal(store, { experienceId: id, conversationId: 'conv-1', turnsAtRefusal: 2 })
    expect(settleHumanOutcome(store, id, 0.2)).toBe(false) // …so the second is refused
    expect(refusalRow(store, id)).toBeDefined()
    store.close()
  })

  it('T065/FR-009: the refusal survives close-and-reopen — a genuinely fresh handle on the same file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scns-refusal-durable-'))
    const dbPath = join(dir, 'experience.db')
    try {
      const store = openExperienceStore(dbPath)
      const id = logRetrievalExperience(store, {
        queryText: 'how do i restart the scns broker safely',
        levers: { traverse: true, synthesize: true },
        retrievedChunkIds: [1],
        conversationId: 'conv-1',
        latencyMs: 200,
      })
      recordFollowupRefusal(store, {
        experienceId: id,
        conversationId: 'conv-1',
        turnsAtRefusal: 2,
      })
      store.close()

      // Not a shared in-process handle: the store is reopened from disk, as after a broker restart.
      const reopened = openExperienceStore(dbPath)
      expect(isFollowupDeferred(reopened, { experienceId: id, currentTurnCount: 2 })).toBe(true)
      const row = reopened.db
        .prepare(`SELECT attempts FROM followup_refusal WHERE experience_id = ?`)
        .get(id) as { attempts: number }
      expect(row.attempts).toBe(1)
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('FAIL-SAFE, fail-open: on a broken store nothing throws and nothing is deferred — the worst failure is the old waste, never a new silence', () => {
    const store = openExperienceStore(':memory:')
    const id = mkRow(store, 'conv-1')
    store.close()
    expect(() =>
      recordFollowupRefusal(store, {
        experienceId: id,
        conversationId: 'conv-1',
        turnsAtRefusal: 2,
      }),
    ).not.toThrow()
    expect(isFollowupDeferred(store, { experienceId: id, currentTurnCount: 2 })).toBe(false)
    expect(() => clearFollowupRefusal(store, id)).not.toThrow()
  })
})
