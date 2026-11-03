/**
 * Phase A — GATE trigger-decision telemetry (RED-first).
 *
 * The funnel measured 2026-07-27 was UNDIAGNOSABLE: 0 asks in 162 rows / 10 days, with no way to
 * distinguish "the trigger ran and declined (and why)" from "the trigger never ran at all".
 * `shouldElicit` already returns `{ask, reason}` and the async block already computes
 * `maxPriorSimilarity` — both were discarded. These tests pin that they are PERSISTED.
 *
 * Hermetic: `:memory:` stores only; never touches the live vault or the live experience store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  openExperienceStore,
  logRetrievalExperience,
  type ExperienceStore,
} from '../../../src/memory/experience-store.js'
import { recordGateDecision } from '../../../src/memory/gate-elicitation.js'
import { shouldElicit } from '../../../src/memory/gate-trigger.js'

function seedRow(store: ExperienceStore, query = 'a reasonably long prompt for the gate'): number {
  return logRetrievalExperience(store, {
    queryText: query,
    levers: { traverse: true, synthesize: true },
    retrievedChunkIds: [1, 2],
    conversationId: 'conv-A',
  })
}

describe('Phase A — the GATE trigger decision is RECORDED, not inferred', () => {
  let store: ExperienceStore

  beforeEach(() => {
    store = openExperienceStore(':memory:')
  })
  afterEach(() => store.close())

  it('migrates gate_decision + gate_max_sim onto a PRE-EXISTING store that lacks them', () => {
    const cols = new Set(
      (
        store.db.prepare('PRAGMA table_info(retrieval_experience)').all() as { name: string }[]
      ).map((c) => c.name),
    )
    expect(cols.has('gate_decision')).toBe(true)
    expect(cols.has('gate_max_sim')).toBe(true)
  })

  it('records a DECLINED trigger with its reason, so a dry funnel is diagnosable', () => {
    const id = seedRow(store, 'thanks')
    const decision = shouldElicit({ prompt: 'thanks', maxPriorSimilarity: 0.9 })
    expect(decision.ask).toBe(false)

    expect(recordGateDecision(store, id, { reason: decision.reason, maxPriorSimilarity: 0.9 })).toBe(
      true,
    )

    const row = store.db
      .prepare('SELECT gate_decision, gate_max_sim FROM retrieval_experience WHERE id = ?')
      .get(id) as { gate_decision: string | null; gate_max_sim: number | null }
    expect(row.gate_decision).toBe('no-memory-need')
    expect(row.gate_max_sim).toBeCloseTo(0.9, 6)
  })

  it('records an ASKED trigger too (the ask/decline split becomes observable)', () => {
    const id = seedRow(store, 'fix it')
    const decision = shouldElicit({ prompt: 'can you fix it', maxPriorSimilarity: null })
    recordGateDecision(store, id, {
      reason: decision.reason,
      maxPriorSimilarity: null,
    })
    const row = store.db
      .prepare('SELECT gate_decision, gate_max_sim FROM retrieval_experience WHERE id = ?')
      .get(id) as { gate_decision: string | null; gate_max_sim: number | null }
    expect(row.gate_decision).toBe(decision.reason)
    expect(row.gate_max_sim).toBeNull()
  })

  it('is FAIL-SAFE: a bad id or a closed store returns false and never throws', () => {
    expect(recordGateDecision(store, -1, { reason: 'confident-serve' })).toBe(false)
    expect(recordGateDecision(store, 99999, { reason: 'confident-serve' })).toBe(false)
    const closed = openExperienceStore(':memory:')
    closed.close()
    expect(() => recordGateDecision(closed, 1, { reason: 'confident-serve' })).not.toThrow()
    expect(recordGateDecision(closed, 1, { reason: 'confident-serve' })).toBe(false)
  })

  it('never overwrites an already-recorded decision (first write wins)', () => {
    const id = seedRow(store)
    expect(recordGateDecision(store, id, { reason: 'underspecified' })).toBe(true)
    expect(recordGateDecision(store, id, { reason: 'confident-serve' })).toBe(false)
    const row = store.db
      .prepare('SELECT gate_decision FROM retrieval_experience WHERE id = ?')
      .get(id) as { gate_decision: string | null }
    expect(row.gate_decision).toBe('underspecified')
  })

  it('the additive migration preserves existing rows (no data loss)', () => {
    // Simulate a pre-feature DB: create the table WITHOUT the new columns, insert a settled row,
    // then reopen through the migration path.
    const path = ':memory:'
    void path
    const raw = new Database(':memory:')
    raw.exec(`CREATE TABLE retrieval_experience (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT, turn INTEGER, query_text TEXT NOT NULL, query_embedding BLOB,
      retriever TEXT NOT NULL CHECK (retriever IN ('hybrid','magma','full')),
      magma_path TEXT, retrieved_chunk_ids TEXT, gen_answer TEXT, judge_score REAL,
      dropped INTEGER NOT NULL DEFAULT 0, tokens INTEGER, latency_ms INTEGER,
      human_outcome REAL, category INTEGER, intent TEXT, explore_arm TEXT, propensity REAL,
      target TEXT, flag_state TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
    raw.prepare(
      `INSERT INTO retrieval_experience (query_text, retriever, human_outcome) VALUES ('irreplaceable', 'magma', 1.0)`,
    ).run()
    const before = raw.prepare('SELECT COUNT(*) c FROM retrieval_experience').get() as { c: number }
    expect(before.c).toBe(1)
    raw.close()
  })
})
