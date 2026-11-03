/**
 * A-div2 QUERY-SIDE — resolve a query against the LEARNED (App-C.1) entity vocabulary.
 *
 * A-div2 build-side made conversation-extracted entities the PRIMARY, data-driven `memory_entities`
 * vocabulary (edges.ts: `source='extracted'` edges, MAGMA Eq (3) Aᵢ / E_ent §3.2). But query→entity
 * anchoring (MAGMA Algorithm 1) still resolved names GAZETTEER-ONLY — a learned name like 'melanie'
 * was built + structurally traversable yet NOT name-queryable, because both `entityNeighborhood`
 * and the intent router gate on `canonicalize`/`matchEntities` over the closed gazetteer.
 *
 * This module closes that query-side gap ADDITIVELY: it builds a gazetteer-SHAPED view of the
 * learned vocabulary so the SAME boundary-aware `matchEntities` machinery (case-insensitive,
 * in-word-safe, dedup-ordered) resolves learned names — no new match semantics. Query-side resolution
 * is DEFAULT-ON (B-EXPLORE §7a; `SCNS_LEARNED_ENTITY_QUERY`, disable with '0'); with `learned` false,
 * resolution is exactly `matchEntities(query, gazetteer)` — byte-identical to the pre-flip behavior.
 */

import type Database from 'better-sqlite3'
import {
  matchEntities,
  SCNS_GAZETTEER,
  type EntityKind,
  type EntityMatch,
  type GazetteerEntry,
} from './gazetteer.js'

/**
 * Build a gazetteer-shaped VIEW of the LEARNED vocabulary: every `memory_entities` row whose
 * canonical is NOT already a gazetteer entry, as `{canonical, kind, aliases:[]}`. Gazetteer
 * canonicals are excluded because the real gazetteer (with its aliases) already matches them; the
 * learned view carries only the data-driven extracted names. Reusing {@link GazetteerEntry} lets
 * {@link matchEntities} run identically over learned names.
 */
export function learnedEntityView(
  db: Database.Database,
  gazetteer: readonly GazetteerEntry[] = SCNS_GAZETTEER,
): GazetteerEntry[] {
  const gazNames = new Set(gazetteer.map((g) => g.canonical))
  const rows = db.prepare('SELECT name, kind FROM memory_entities').all() as Array<{
    name: string
    kind: string
  }>
  const view: GazetteerEntry[] = []
  for (const r of rows) {
    if (gazNames.has(r.name)) continue
    view.push({ canonical: r.name, kind: r.kind as EntityKind, aliases: [] })
  }
  return view
}

/**
 * Resolve the entities NAMED in `query` (MAGMA Algorithm 1 query→entity anchoring). Gazetteer
 * matches first (canonicalization + aliases preserved), then — when `learned` — the learned
 * `memory_entities` vocabulary, deduped by canonical in first-seen order. With `learned` false this
 * is exactly `matchEntities(query, gazetteer)`.
 */
export function resolveQueryEntities(
  db: Database.Database,
  query: string,
  gazetteer: readonly GazetteerEntry[] = SCNS_GAZETTEER,
  learned = false,
): EntityMatch[] {
  const gaz = matchEntities(query, gazetteer)
  if (!learned) return gaz
  const seen = new Set(gaz.map((m) => m.canonical))
  const out: EntityMatch[] = [...gaz]
  for (const m of matchEntities(query, learnedEntityView(db, gazetteer))) {
    if (seen.has(m.canonical)) continue
    seen.add(m.canonical)
    out.push(m)
  }
  return out
}

/**
 * True when `query` names a LEARNED (non-gazetteer) entity. Used to make `classifyIntent`
 * learned-aware without giving it a DB handle (the matcher is injected). Gazetteer entities are
 * intentionally excluded — the caller already tests those via the gazetteer path.
 */
export function queryNamesLearnedEntity(
  db: Database.Database,
  query: string,
  gazetteer: readonly GazetteerEntry[] = SCNS_GAZETTEER,
): boolean {
  return matchEntities(query, learnedEntityView(db, gazetteer)).length > 0
}

/** DEFAULT-ON→OFF flip env (B-EXPLORE §7a). */
export const LEARNED_ENTITY_QUERY_ENV = 'SCNS_LEARNED_ENTITY_QUERY'

/**
 * Whether query-side LEARNED-entity resolution is enabled (B-EXPLORE §7a — now DEFAULT-ON, permitted once
 * the B-core experience logger went live). Resolving a query naming a data-driven (non-gazetteer) entity
 * against `memory_entities` anchors it on that entity's neighborhood (MAGMA Algorithm 1 query→entity
 * anchoring), additive to the gazetteer and inside the default hybrid flow (NOT a switch to a non-hybrid
 * arm). Reversible + BYTE-IDENTICAL to the pre-flip behavior when explicitly set to '0'.
 */
export function isLearnedEntityQueryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LEARNED_ENTITY_QUERY_ENV] !== '0'
}
