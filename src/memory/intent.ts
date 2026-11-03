/**
 * M1.2 — deterministic query intent classifier (design-m1.md §5). Maps a query to one of MAGMA's
 * retrieval intents `Tq ∈ {WHY, WHEN, ENTITY, DEFAULT}` so the search adapter can route over the
 * M1.1 entity/temporal substrate (MAGMA's #1 retrieval lever, Table 4) — with NO LLM in the path.
 *
 * Keyword/pattern MVP, precedence WHY → WHEN → ENTITY → DEFAULT:
 *   - WHY   : causal markers (why / because / caused / due to / root cause / reason …)
 *   - WHEN  : temporal markers (when / before / after / last / recently / history …)
 *   - ENTITY: a gazetteer entity is mentioned (and no WHY/WHEN marker present)
 *   - DEFAULT: everything else ⇒ today's hybrid search, unchanged.
 *
 * Markers match on `[\w-]` token boundaries (case-insensitive, whitespace-tolerant) so a term is
 * never read inside a larger word ("last" must not fire inside "lastly").
 */

import { matchEntities, SCNS_GAZETTEER, type GazetteerEntry } from './entities/gazetteer.js'

export type QueryIntent = 'WHY' | 'WHEN' | 'ENTITY' | 'DEFAULT'

/** Causal-question surface markers (the MAGMA "WHY"). */
const WHY_TERMS: readonly string[] = [
  'why',
  'because',
  'because of',
  'caused',
  'cause',
  'causes',
  'causing',
  'due to',
  'led to',
  'lead to',
  'leads to',
  'result of',
  'resulted in',
  'root cause',
  'reason',
  'reasons',
  'responsible for',
]

/** Temporal-question surface markers (the MAGMA "WHEN"). */
const WHEN_TERMS: readonly string[] = [
  'when',
  'before',
  'after',
  'last',
  'latest',
  'earliest',
  'recently',
  'recent',
  'previously',
  'prior',
  'history',
  'timeline',
  'chronological',
  'chronology',
  'ago',
  'during',
  'since',
  'until',
  'over time',
  'what happened',
  'sequence',
]

/** Escape regex metacharacters in a literal marker. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
}

/**
 * Build one case-insensitive, boundary-aware regex that matches ANY of the given markers. Internal
 * whitespace becomes `\s+` so multi-word markers tolerate arbitrary spacing; `[\w-]` look-arounds
 * prevent in-word matches.
 */
function buildMarkerRegex(terms: readonly string[]): RegExp {
  const alternation = terms
    .map((t) => escapeRegex(t.trim()).replace(/\s+/g, '\\s+'))
    .join('|')
  return new RegExp(`(?<![\\w-])(?:${alternation})(?![\\w-])`, 'i')
}

const WHY_RE = buildMarkerRegex(WHY_TERMS)
const WHEN_RE = buildMarkerRegex(WHEN_TERMS)

/**
 * Classify a query's retrieval intent deterministically. Precedence WHY → WHEN → ENTITY → DEFAULT;
 * an empty/whitespace query is DEFAULT. `gazetteer` (defaults to the curated SCNS gazetteer) drives
 * ENTITY detection. When `options.hasLearnedEntity` is supplied (A-div2 query-side; injected so this
 * stays DB-free/deterministic), a query naming a LEARNED (non-gazetteer) entity ALSO classifies as
 * ENTITY — so the intent router reaches the entity-anchored route for learned names. Absent ⇒
 * gazetteer-only, byte-identical to today.
 */
export function classifyIntent(
  query: string,
  gazetteer: readonly GazetteerEntry[] = SCNS_GAZETTEER,
  options: { readonly hasLearnedEntity?: (query: string) => boolean } = {},
): QueryIntent {
  if (!query || !query.trim()) return 'DEFAULT'
  if (WHY_RE.test(query)) return 'WHY'
  if (WHEN_RE.test(query)) return 'WHEN'
  if (matchEntities(query, gazetteer).length > 0) return 'ENTITY'
  if (options.hasLearnedEntity?.(query)) return 'ENTITY'
  return 'DEFAULT'
}
