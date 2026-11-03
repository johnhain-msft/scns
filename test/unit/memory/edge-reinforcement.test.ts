import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import {
  reinforceEdgesForPath,
  decayEdgeWeightsTowardNeutral,
  applyExperienceReinforcement,
  DEFAULT_REINFORCE_ETA,
  DEFAULT_WEIGHT_MIN,
  DEFAULT_WEIGHT_MAX,
} from '../../../src/memory/edge-reinforcement.js'
import {
  openExperienceStore,
  logRetrievalExperience,
  settleHumanOutcome,
} from '../../../src/memory/experience-store.js'
import type Database from 'better-sqlite3'

// ── Phase D — path-conditioned edge reinforcement (plan §9: "up/down-weight memories on the graph by
// path + context"). Bounded multiplicative updates on memory_edges.weight along the RETRIEVED path,
// from the settled human accept-vs-waste gradient; decay toward the neutral 1.0 fights the
// degenerate-feedback-loop failure (Jiang arXiv:1902.10730 / Chaney arXiv:1710.11214). Weights change
// retrieval ONLY through the default-OFF `useEdgeWeights` beam lever — certification-gated.

let seq = 0
function addChunk(db: Database.Database, content: string): number {
  const path = `f${seq}.md`
  db.prepare('INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)').run(
    path,
    1000 + seq++,
    content.length,
  )
  return db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count) VALUES (?, 0, ?, 0, ?, 1)`,
    )
    .run(path, content, content.length).lastInsertRowid as number
}
function link(db: Database.Database, src: number, dst: number, type = 'semantic'): number {
  return db
    .prepare(
      `INSERT INTO memory_edges (src_chunk, edge_type, dst_chunk, source) VALUES (?, ?, ?, 'test')`,
    )
    .run(src, type, dst).lastInsertRowid as number
}
function linkEntity(db: Database.Database, chunk: number, entity: number): number {
  return db
    .prepare(
      `INSERT INTO memory_edges (src_chunk, edge_type, dst_entity, source) VALUES (?, 'entity', ?, 'test')`,
    )
    .run(chunk, entity).lastInsertRowid as number
}
const weightOf = (db: Database.Database, edgeId: number): number =>
  (db.prepare(`SELECT weight FROM memory_edges WHERE id = ?`).get(edgeId) as { weight: number })
    .weight

describe('reinforceEdgesForPath — bounded multiplicative path updates', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    seq = 0
  })
  afterEach(() => closeMemoryDb(db))

  it('outcome 1.0 strengthens (×(1+η)) and 0.0 weakens (×(1−η)) chunk→chunk edges INSIDE the path only', () => {
    const a = addChunk(db, 'a')
    const b = addChunk(db, 'b')
    const c = addChunk(db, 'c') // outside the path
    const inPath = link(db, a, b)
    const outside = link(db, a, c)
    const up = reinforceEdgesForPath(db, { chunkIds: [a, b], outcome: 1.0 })
    expect(up.edgesTouched).toBe(1)
    expect(weightOf(db, inPath)).toBeCloseTo(1 + DEFAULT_REINFORCE_ETA, 10)
    expect(weightOf(db, outside)).toBe(1)
    reinforceEdgesForPath(db, { chunkIds: [a, b], outcome: 0.0 })
    expect(weightOf(db, inPath)).toBeCloseTo(
      (1 + DEFAULT_REINFORCE_ETA) * (1 - DEFAULT_REINFORCE_ETA),
      10,
    )
  })

  it('a neutral outcome (0.5) changes nothing; weights clamp to [min, max]', () => {
    const a = addChunk(db, 'a')
    const b = addChunk(db, 'b')
    const e = link(db, a, b)
    const neutral = reinforceEdgesForPath(db, { chunkIds: [a, b], outcome: 0.5 })
    expect(neutral.edgesTouched).toBe(0)
    expect(weightOf(db, e)).toBe(1)
    for (let i = 0; i < 40; i++) reinforceEdgesForPath(db, { chunkIds: [a, b], outcome: 1.0 })
    expect(weightOf(db, e)).toBeCloseTo(DEFAULT_WEIGHT_MAX, 10)
    for (let i = 0; i < 80; i++) reinforceEdgesForPath(db, { chunkIds: [a, b], outcome: 0.0 })
    expect(weightOf(db, e)).toBeCloseTo(DEFAULT_WEIGHT_MIN, 10)
  })

  it('reinforces entity edges ONLY for entities bridging ≥2 path chunks (the edge the beam walked)', () => {
    const a = addChunk(db, 'a')
    const b = addChunk(db, 'b')
    const shared = db
      .prepare(`INSERT INTO memory_entities (name, kind) VALUES ('shared', 'concept')`)
      .run().lastInsertRowid as number
    const lone = db
      .prepare(`INSERT INTO memory_entities (name, kind) VALUES ('lone', 'concept')`)
      .run().lastInsertRowid as number
    const ea = linkEntity(db, a, shared)
    const eb = linkEntity(db, b, shared)
    const el = linkEntity(db, a, lone)
    reinforceEdgesForPath(db, { chunkIds: [a, b], outcome: 1.0 })
    expect(weightOf(db, ea)).toBeCloseTo(1.2, 10)
    expect(weightOf(db, eb)).toBeCloseTo(1.2, 10)
    expect(weightOf(db, el)).toBe(1) // its entity does not bridge the path
  })

  it('rejects invalid outcomes / empty paths (returns 0, writes nothing)', () => {
    const a = addChunk(db, 'a')
    const b = addChunk(db, 'b')
    link(db, a, b)
    expect(reinforceEdgesForPath(db, { chunkIds: [], outcome: 1.0 }).edgesTouched).toBe(0)
    expect(reinforceEdgesForPath(db, { chunkIds: [a, b], outcome: 1.5 }).edgesTouched).toBe(0)
    expect(reinforceEdgesForPath(db, { chunkIds: [a, b], outcome: NaN }).edgesTouched).toBe(0)
  })
})

describe('decayEdgeWeightsTowardNeutral — anti-ossification freshness decay', () => {
  it('moves every non-neutral weight toward 1.0 by rate and leaves neutral edges untouched', () => {
    const db = openMemoryDb(':memory:')
    seq = 0
    const a = addChunk(db, 'a')
    const b = addChunk(db, 'b')
    const hot = link(db, a, b)
    db.prepare(`UPDATE memory_edges SET weight = 3.0 WHERE id = ?`).run(hot)
    const cold = link(db, b, a)
    const r = decayEdgeWeightsTowardNeutral(db, { rate: 0.1 })
    expect(r.edgesTouched).toBe(1) // only the non-neutral edge moves
    expect(weightOf(db, hot)).toBeCloseTo(3.0 + 0.1 * (1.0 - 3.0), 10) // 2.8
    expect(weightOf(db, cold)).toBe(1)
    closeMemoryDb(db)
  })
})

describe('applyExperienceReinforcement — settled magma rows → path updates, idempotent via the vault log', () => {
  it('applies each settled magma row ONCE (re-runs are no-ops) and skips hybrid/unsettled rows', () => {
    const db = openMemoryDb(':memory:')
    seq = 0
    const a = addChunk(db, 'a')
    const b = addChunk(db, 'b')
    const e = link(db, a, b)
    const store = openExperienceStore(':memory:')
    const magma = logRetrievalExperience(store, {
      queryText: 'q',
      levers: { traverse: true },
      retrievedChunkIds: [a, b],
    })
    const hybrid = logRetrievalExperience(store, {
      queryText: 'q2',
      levers: {},
      retrievedChunkIds: [a, b],
    })
    logRetrievalExperience(store, {
      queryText: 'unsettled',
      levers: { traverse: true },
      retrievedChunkIds: [a, b],
    })
    settleHumanOutcome(store, magma, 1.0)
    settleHumanOutcome(store, hybrid, 1.0)

    const first = applyExperienceReinforcement(db, store)
    expect(first.rowsApplied).toBe(1) // only the settled MAGMA row (hybrid has no path; unsettled skipped)
    expect(weightOf(db, e)).toBeCloseTo(1.2, 10)
    const second = applyExperienceReinforcement(db, store)
    expect(second.rowsApplied).toBe(0) // idempotent — logged in the vault
    expect(weightOf(db, e)).toBeCloseTo(1.2, 10)
    store.close()
    closeMemoryDb(db)
  })
})

// ── T039 [US4] FR-017 — the reinforcement loop can NEVER touch a guardrail (structural locks) ────
import { readFileSync } from 'node:fs'
import { join as joinPath, dirname as dirnameOf } from 'node:path'
import { fileURLToPath } from 'node:url'

describe('T039 — reinforcement writes ONLY memory_edges.weight + edge_reinforcement_log (FR-017)', () => {
  const root = joinPath(dirnameOf(fileURLToPath(import.meta.url)), '../../..')
  const src = readFileSync(joinPath(root, 'src/memory/edge-reinforcement.ts'), 'utf8')
  const runner = readFileSync(joinPath(root, 'scripts/reinforce-edges.ts'), 'utf8')

  it('edge-reinforcement.ts has NO filesystem access and no import path to kernel/guardrail modules', () => {
    expect(src).not.toMatch(/from 'node:fs'|require\(['"]fs/)
    expect(src).not.toMatch(/writeFileSync|appendFileSync|createWriteStream/)
    expect(src).not.toMatch(/safety-kernel|safety-allowlist|kernel-policy/)
  })

  it('every INSERT/UPDATE in edge-reinforcement.ts targets only memory_edges or edge_reinforcement_log', () => {
    const writes = src.match(/(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE)\s+([a-z_]+)/g) ?? []
    expect(writes.length).toBeGreaterThan(0) // the lock must be exercised, not vacuous
    for (const w of writes) {
      expect(w).toMatch(/memory_edges|edge_reinforcement_log/)
    }
  })

  it('the runner REFUSES the live vault by resolved path (reinforce a COPY, never the live substrate)', () => {
    expect(runner).toMatch(/realpathSync/)
    expect(runner).toMatch(/REFUSED.*LIVE vault|LIVE vault.*REFUSED/i)
  })
})
