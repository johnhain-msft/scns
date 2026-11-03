/**
 * Derived memory edges — DETERMINISTIC entity + temporal layer (M1.1, design-m1.md §4-5).
 *
 * Edges are a pure function of current chunk content, so they are RECOMPUTED on every
 * content-changing index pass rather than persisted incrementally: `chunks.id` is AUTOINCREMENT
 * and chunks are deleted+reinserted (NEW id) when a file changes (design-m1.md §3), which would
 * orphan any id-keyed edge. A full rebuild keyed on `chunks(id) ON DELETE CASCADE` is cheap
 * (closed gazetteer × vault chunks) and inherently idempotent + correct across cross-file
 * temporal links.
 *
 * - Entity edge:   chunk --[entity]--> memory_entities.id  (source 'gazetteer' for closed-vocabulary
 *   content matches; source 'extracted' for LEARNED App-C.1 entities carried on event nodes — the
 *   primary vocabulary is now DATA-DRIVEN, MAGMA Eq (3) Aᵢ / E_ent §3.2, not just the gazetteer).
 * - Temporal edge: chunk_pred --[temporal]--> chunk_succ, scoped to the entity whose timeline it
 *   belongs to via dst_entity (source 'timestamp'). Per-entity predecessor chain ordered by the
 *   first-class per-node event-time τ (MAGMA Eq (3) node = ⟨cᵢ,τᵢ,vᵢ,Aᵢ⟩; the Temporal Graph E_temp
 *   §3.2 is "strictly ordered pairs (nᵢ,nⱼ) where τᵢ<τⱼ"), read from the `event_nodes` sidecar. Genuine
 *   non-event chunks have no conversational τ and fall back to vault_files.mtime_ms; both then tiebreak
 *   on chunk_index, then id (design-m1.md §8: per-entity timeline).
 */

import type Database from 'better-sqlite3'
import { SCNS_GAZETTEER, matchEntities, type GazetteerEntry } from './gazetteer.js'

export interface EdgeRebuildStats {
  /** Entities in the catalog after upsert (full gazetteer size + any LEARNED entities encountered). */
  readonly entities: number
  readonly entityEdges: number
  readonly temporalEdges: number
  /** Distinct LEARNED (non-gazetteer, App-C.1) entities promoted into the vocabulary this rebuild. */
  readonly learnedEntities: number
  /** Entity edges created from LEARNED entities (source 'extracted'), separate from gazetteer edges. */
  readonly learnedEntityEdges: number
}

interface ChunkRow {
  id: number
  content: string
  chunk_index: number
  mtime_ms: number
  /** Per-node event-time τ (ISO-8601) from the event_nodes sidecar; NULL for non-event chunks. */
  tau: string | null
  /** JSON array of App-C.1 LEARNED entity canonicals on this node (event nodes only); NULL otherwise. */
  entities: string | null
}

interface TimelineNode {
  id: number
  /** Effective ordering key in epoch ms: event-τ if present, else the file mtime (fallback). */
  sortMs: number
  chunkIndex: number
}

/**
 * Recompute the deterministic entity + temporal edge set from the current `chunks` table.
 * Idempotent: clears `memory_edges` and rebuilds. Does NOT open its own transaction, so it is
 * safe to call inside the indexer's mutation transaction (better-sqlite3 forbids nested txns).
 */
export function rebuildMemoryEdges(
  db: Database.Database,
  gazetteer: readonly GazetteerEntry[] = SCNS_GAZETTEER,
): EdgeRebuildStats {
  // 1. Upsert the durable entity catalog; capture canonical → entity id.
  const upsertEntity = db.prepare(
    `INSERT INTO memory_entities (name, kind, aliases) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, aliases = excluded.aliases`,
  )
  const getEntityId = db.prepare('SELECT id FROM memory_entities WHERE name = ?')
  const entityIdByName = new Map<string, number>()
  for (const entry of gazetteer) {
    upsertEntity.run(entry.canonical, entry.kind, JSON.stringify(entry.aliases))
    entityIdByName.set(
      entry.canonical,
      (getEntityId.get(entry.canonical) as { id: number }).id,
    )
  }
  // Gazetteer ids seeded above — used to tell a LEARNED entity apart from a gazetteer one so an
  // extracted surface that canonicalizes onto a gazetteer entry is not miscounted as learned.
  const gazetteerEntityIds = new Set(entityIdByName.values())
  const learnedEntityIds = new Set<number>()
  // Lazily promote a LEARNED (App-C.1) entity into the durable vocabulary; returns its id. Idempotent
  // via memory_entities.name UNIQUE ⇒ the same name across sessions is ONE entity (object permanence).
  const learnedEntityId = (name: string): number => {
    const cached = entityIdByName.get(name)
    if (cached !== undefined) return cached // gazetteer collision ⇒ reuse, never overwrite its kind
    upsertEntity.run(name, 'entity', JSON.stringify([name]))
    const id = (getEntityId.get(name) as { id: number }).id
    entityIdByName.set(name, id)
    if (!gazetteerEntityIds.has(id)) learnedEntityIds.add(id)
    return id
  }

  // 2. Rebuild the deterministic ENTITY + TEMPORAL edges. SCOPED delete (not an unscoped
  //    wipe): the independently-built SEMANTIC tier (semantic-edges.ts) shares this table, so
  //    it must survive an entity rebuild regardless of pass ordering.
  db.prepare("DELETE FROM memory_edges WHERE edge_type IN ('entity', 'temporal')").run()

  // 3. Scan all chunks with their per-node event-time τ. Event nodes persist their real, first-class
  //    τ in the `event_nodes` sidecar (event_nodes.tau, ISO-8601); LEFT-JOIN it so the temporal
  //    backbone can order by τ (MAGMA Eq (3) / E_temp §3.2) rather than the file's mtime — event-node
  //    chunks share ONE synthetic file whose per-file mtime cannot represent per-node τ. The sidecar
  //    is always created by openMemoryDb, but guard its presence so a minimal/partial DB still works
  //    (⇒ τ NULL ⇒ pure mtime fallback, byte-identical to the pre-τ behaviour).
  const hasEventNodes =
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_nodes'").get() !==
    undefined
  // Defensive: a pre-App-C.1 on-disk DB may have `event_nodes` WITHOUT the `entities` column. Only
  // read it when present, else fall back to NULL (⇒ no learned entities ⇒ byte-identical to before).
  const hasEntitiesCol =
    hasEventNodes &&
    (db.prepare("PRAGMA table_info('event_nodes')").all() as Array<{ name: string }>).some(
      (c) => c.name === 'entities',
    )
  const chunks = db
    .prepare(
      hasEventNodes
        ? `SELECT c.id, c.content, c.chunk_index, vf.mtime_ms AS mtime_ms, en.tau AS tau,
                  ${hasEntitiesCol ? 'en.entities AS entities' : 'NULL AS entities'}
           FROM chunks c
           JOIN vault_files vf ON vf.path = c.file_path
           LEFT JOIN event_nodes en ON en.chunk_id = c.id`
        : `SELECT c.id, c.content, c.chunk_index, vf.mtime_ms AS mtime_ms, NULL AS tau,
                  NULL AS entities
           FROM chunks c JOIN vault_files vf ON vf.path = c.file_path`,
    )
    .all() as ChunkRow[]

  const insertEntityEdge = db.prepare(
    `INSERT INTO memory_edges (src_chunk, edge_type, dst_entity, source) VALUES (?, 'entity', ?, 'gazetteer')`,
  )
  const insertLearnedEntityEdge = db.prepare(
    `INSERT INTO memory_edges (src_chunk, edge_type, dst_entity, source) VALUES (?, 'entity', ?, 'extracted')`,
  )
  const insertTemporalEdge = db.prepare(
    `INSERT INTO memory_edges (src_chunk, edge_type, dst_chunk, dst_entity, source) VALUES (?, 'temporal', ?, ?, 'timestamp')`,
  )

  const timelines = new Map<string, TimelineNode[]>()
  let entityEdges = 0
  let learnedEntityEdges = 0

  // Push a node onto an entity's timeline: per-node event-τ (MAGMA Eq (3) / E_temp §3.2), else the
  // file mtime fallback for non-event chunks (A-div1). Both gazetteer + learned entities use it.
  const pushTimeline = (canonical: string, chunk: ChunkRow): void => {
    let timeline = timelines.get(canonical)
    if (!timeline) {
      timeline = []
      timelines.set(canonical, timeline)
    }
    const parsedTau = chunk.tau !== null ? Date.parse(chunk.tau) : Number.NaN
    const sortMs = Number.isFinite(parsedTau) ? parsedTau : chunk.mtime_ms
    timeline.push({ id: chunk.id, sortMs, chunkIndex: chunk.chunk_index })
  }

  for (const chunk of chunks) {
    // Dedup a chunk↔entity edge across the gazetteer + learned passes (a surface that canonicalizes
    // onto a gazetteer entity must not create two edges to the same entity for the same chunk).
    const linked = new Set<number>()

    // (a) GAZETTEER pass — deterministic closed-vocabulary matches over content (source 'gazetteer').
    for (const match of matchEntities(chunk.content, gazetteer)) {
      const entityId = entityIdByName.get(match.canonical)
      if (entityId === undefined || linked.has(entityId)) continue
      linked.add(entityId)
      insertEntityEdge.run(chunk.id, entityId)
      entityEdges++
      pushTimeline(match.canonical, chunk)
    }

    // (b) LEARNED pass — App-C.1 extracted entities on event nodes (source 'extracted'). This makes
    //     the PRIMARY vocabulary data-driven (MAGMA Eq (3) Aᵢ / E_ent object permanence) rather than a
    //     fixed gazetteer; a learned name recurring across sessions ⇒ ONE entity ⇒ the cross-session
    //     temporal backbone built below.
    for (const name of parseLearnedEntities(chunk.entities)) {
      const entityId = learnedEntityId(name)
      if (linked.has(entityId)) continue
      linked.add(entityId)
      insertLearnedEntityEdge.run(chunk.id, entityId)
      learnedEntityEdges++
      pushTimeline(name, chunk)
    }
  }

  // 4. Per-entity temporal predecessor chain (event-τ, then chunk_index, then id).
  let temporalEdges = 0
  for (const [name, timeline] of timelines) {
    if (timeline.length < 2) continue
    timeline.sort(
      (a, b) => a.sortMs - b.sortMs || a.chunkIndex - b.chunkIndex || a.id - b.id,
    )
    const entityId = entityIdByName.get(name)!
    for (let i = 1; i < timeline.length; i++) {
      insertTemporalEdge.run(timeline[i - 1]!.id, timeline[i]!.id, entityId)
      temporalEdges++
    }
  }

  return {
    entities: entityIdByName.size,
    entityEdges,
    temporalEdges,
    learnedEntities: learnedEntityIds.size,
    learnedEntityEdges,
  }
}

/** Parse the `event_nodes.entities` JSON column into a clean canonical list (defensive: never throws). */
function parseLearnedEntities(json: string | null): string[] {
  if (!json) return []
  try {
    const v: unknown = JSON.parse(json)
    if (!Array.isArray(v)) return []
    const out: string[] = []
    for (const x of v) if (typeof x === 'string' && x.trim() !== '') out.push(x)
    return out
  } catch {
    return []
  }
}
