/**
 * WS-1 event/outcome substrate — STORAGE (writer + readers) unit tests.
 *
 * Proves the writer persists {@link EventNodeRecord}s as first-class, RETRIEVABLE nodes the proven
 * pipeline consumes (facts-as-chunks at chunk_index >= EVENT_CHUNK_INDEX_BASE under synthetic
 * event-nodes/* paths, + FTS row + embedding row), records the first-class τ / D→A→O sidecar,
 * is IDEMPOTENT (re-writing the same event_keys inserts 0), CASCADEs the sidecar when its chunk is
 * deleted, and that the WS-2b candidate build yields NARRATABLE (not low-signal) candidates.
 *
 * A deterministic STUB embedder is injected so the test never forks the fastembed worker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import {
  openMemoryDb,
  closeMemoryDb,
  EVENT_CHUNK_INDEX_BASE,
  EVENT_NODE_PATH_PREFIX,
} from '../../../src/memory/db.js'
import { EMBEDDING_DIMENSIONS } from '../../../src/memory/db.js'
import { isLowSignalContent } from '../../../src/memory/causal-edges.js'
import {
  writeEventNodes,
  countEventNodes,
  listEventNodes,
  buildEventCausalCandidates,
  type EventNodeRecord,
  type EmbedBatchFn,
} from '../../../src/memory/event-nodes.js'

/** Deterministic stub embedder — one zero-vector per text; never touches the fastembed worker. */
const stubEmbed: EmbedBatchFn = async (texts) =>
  texts.map(() => ({ embedding: new Float32Array(EMBEDDING_DIMENSIONS), dimensions: EMBEDDING_DIMENSIONS }))

/** Two auto-merger broker decisions (τ-consecutive) + one dream-daemon outcome — all narratable. */
const RECORDS: EventNodeRecord[] = [
  {
    eventKey: 'ek-qg-1',
    tau: '2026-02-01T00:00:00Z',
    entity: 'auto-merger',
    kind: 'broker-decision',
    decision: 'quality-gate review',
    action: 'branch feat-x',
    outcome: 'failed (build-failed), score 0',
    content:
      'On 2026-02-01T00:00:00Z, the broker quality-gate review — branch feat-x: failed (build-failed), score 0.',
    sourceRef: 'events#1',
  },
  {
    eventKey: 'ek-merge-2',
    tau: '2026-02-01T00:00:10Z',
    entity: 'auto-merger',
    kind: 'broker-decision',
    decision: 'auto-merge',
    action: 'branch feat-x',
    outcome: 'merged (abcdef12)',
    content: 'On 2026-02-01T00:00:10Z, the broker auto-merge — branch feat-x: merged (abcdef12).',
    sourceRef: 'events#2',
  },
  {
    eventKey: 'ek-out-3',
    tau: '2026-03-01T09:00:00Z',
    entity: 'dream-daemon',
    kind: 'proposal-outcome',
    decision: 'self-improvement proposal "Consolidate sessions tier" [seed-a]',
    action: null,
    outcome: 'verdict: merged',
    content:
      'On 2026-03-01T09:00:00Z, self-improvement proposal "Consolidate sessions tier" [seed-a] targeting dream-daemon — verdict: merged.',
    sourceRef: 'proposal_outcomes#1',
  },
]

describe('event-nodes :: writeEventNodes', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  it('stores event nodes AS chunks (>= EVENT_CHUNK_INDEX_BASE, under event-nodes/*) + sidecar rows', async () => {
    const stats = await writeEventNodes(db, RECORDS, { embed: stubEmbed, rebuildEdges: false })
    expect(stats).toEqual({ considered: 3, written: 3, skippedExisting: 0, embeddingsWritten: 3 })

    const chunkRows = db
      .prepare(
        `SELECT file_path AS filePath, chunk_index AS chunkIndex FROM chunks
          WHERE chunk_index >= ? ORDER BY file_path, chunk_index`,
      )
      .all(EVENT_CHUNK_INDEX_BASE) as Array<{ filePath: string; chunkIndex: number }>
    expect(chunkRows).toHaveLength(3)
    for (const r of chunkRows) {
      expect(r.filePath.startsWith(EVENT_NODE_PATH_PREFIX)).toBe(true)
      expect(r.chunkIndex).toBeGreaterThanOrEqual(EVENT_CHUNK_INDEX_BASE)
    }
    // The two broker decisions share one synthetic file with disjoint indices 2e6, 2e6+1.
    const brokerIdx = chunkRows
      .filter((r) => r.filePath === `${EVENT_NODE_PATH_PREFIX}broker.md`)
      .map((r) => r.chunkIndex)
      .sort((a, b) => a - b)
    expect(brokerIdx).toEqual([EVENT_CHUNK_INDEX_BASE, EVENT_CHUNK_INDEX_BASE + 1])

    // Sidecar rows exist for every event node, with the first-class τ preserved.
    const counts = countEventNodes(db)
    expect(counts.total).toBe(3)
    expect(counts.byKind).toEqual({ 'broker-decision': 2, 'proposal-outcome': 1 })
  })

  it('makes each event node RETRIEVABLE (FTS MATCH hit + embedding row)', async () => {
    await writeEventNodes(db, RECORDS, { embed: stubEmbed, rebuildEdges: false })

    // FTS: a distinctive token ('quality', only in the QG node) resolves to that event-node chunk.
    const ftsHits = db
      .prepare(`SELECT rowid AS chunkId FROM chunks_fts WHERE chunks_fts MATCH 'quality'`)
      .all() as Array<{ chunkId: number }>
    expect(ftsHits).toHaveLength(1)
    const hitIdx = db
      .prepare('SELECT chunk_index AS ci FROM chunks WHERE id = ?')
      .get(ftsHits[0]!.chunkId) as { ci: number }
    expect(hitIdx.ci).toBeGreaterThanOrEqual(EVENT_CHUNK_INDEX_BASE)

    // Every event-node chunk has a vector row (only event nodes exist here ⇒ exactly 3).
    const embRows = db.prepare('SELECT COUNT(*) AS n FROM chunk_embeddings').get() as { n: number }
    expect(embRows.n).toBe(3)
  })

  it('is IDEMPOTENT: re-writing the same event_keys inserts 0 new nodes (convergence)', async () => {
    const first = await writeEventNodes(db, RECORDS, { embed: stubEmbed, rebuildEdges: false })
    expect(first.written).toBe(3)

    const chunksBefore = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n
    const second = await writeEventNodes(db, RECORDS, { embed: stubEmbed, rebuildEdges: false })
    expect(second).toEqual({ considered: 3, written: 0, skippedExisting: 3, embeddingsWritten: 0 })
    const chunksAfter = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n
    expect(chunksAfter).toBe(chunksBefore) // no duplicate chunks on the 2nd pass
    expect(countEventNodes(db).total).toBe(3)
  })

  it('CASCADEs the sidecar row when the underlying chunk is deleted', async () => {
    await writeEventNodes(db, RECORDS, { embed: stubEmbed, rebuildEdges: false })
    const target = db
      .prepare('SELECT chunk_id AS chunkId FROM event_nodes ORDER BY chunk_id ASC LIMIT 1')
      .get() as { chunkId: number }

    db.prepare('DELETE FROM chunks WHERE id = ?').run(target.chunkId)

    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM event_nodes WHERE chunk_id = ?')
      .get(target.chunkId) as { n: number }
    expect(remaining.n).toBe(0) // ON DELETE CASCADE dropped the sidecar
    expect(countEventNodes(db).total).toBe(2)
  })

  it('listEventNodes returns nodes joined to content, sorted ascending by τ', async () => {
    await writeEventNodes(db, RECORDS, { embed: stubEmbed, rebuildEdges: false })
    const listed = listEventNodes(db)
    expect(listed).toHaveLength(3)
    expect(listed[0]!.tau).toBe('2026-02-01T00:00:00Z')
    expect(listed[listed.length - 1]!.tau).toBe('2026-03-01T09:00:00Z')
    expect(listed[0]!.content).toContain('quality-gate review')
  })

  it('buildEventCausalCandidates yields NARRATABLE (not low-signal) candidates over the substrate', async () => {
    await writeEventNodes(db, RECORDS, { embed: stubEmbed, rebuildEdges: false })
    const candidates = buildEventCausalCandidates(db)
    // Only auto-merger has ≥2 τ-consecutive nodes ⇒ exactly one (cause→effect) candidate.
    expect(candidates).toHaveLength(1)
    const c = candidates[0]!
    expect(c.entity).toBe('auto-merger')
    expect(c.causeContent).toContain('quality-gate review')
    expect(c.effectContent).toContain('auto-merge')
    // The whole point of WS-1: candidates are narratable events, NOT mid-word telemetry fragments.
    expect(isLowSignalContent(c.causeContent)).toBe(false)
    expect(isLowSignalContent(c.effectContent)).toBe(false)
  })

  it('does not write when given no records (do-no-harm)', async () => {
    const stats = await writeEventNodes(db, [], { embed: stubEmbed, rebuildEdges: false })
    expect(stats).toEqual({ considered: 0, written: 0, skippedExisting: 0, embeddingsWritten: 0 })
    expect(countEventNodes(db).total).toBe(0)
  })
})
