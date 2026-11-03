/**
 * SCNS entity gazetteer — a small, mostly-closed, curated vocabulary of recurring
 * SCNS system entities used for DETERMINISTIC entity extraction at index time (NO LLM).
 *
 * SCNS entities ("auto-merger", "dream daemon", "broker", "quality-gate", …) are a
 * well-known system vocabulary, so a hand-curated gazetteer of {canonical, kind, aliases}
 * extracts them reliably without an LLM — flipping entity extraction from MAGMA's generic
 * "expensive + low value" to SCNS's "cheap + high D2a value" (design-m1.md §2, §5/M1.1).
 *
 * Matching is case-insensitive on `[\w-]` token boundaries so a term never matches inside a
 * larger word ("search" must not match inside "researcher"). Multi-word surfaces tolerate
 * arbitrary internal whitespace.
 */

// 'entity' = a generic LEARNED proper noun auto-extracted from content (MAGMA App-C.1: "People,
// Locations, Organizations"). The paper does not sub-type proper nouns, so we don't invent
// person/location/org kinds — extracted entities are the single generic 'entity' kind.
export type EntityKind = 'component' | 'agent' | 'artifact' | 'concept' | 'entity'

export interface GazetteerEntry {
  /** Canonical, lowercase identifier, e.g. 'auto-merger'. Unique across the gazetteer. */
  readonly canonical: string
  readonly kind: EntityKind
  /** Additional surface forms (besides the canonical) that resolve to this entity. */
  readonly aliases: readonly string[]
}

export interface EntityMatch {
  readonly canonical: string
  readonly kind: EntityKind
}

/**
 * Curated SCNS entities + a `kind:'concept'` catch-all set. Hand-seeded, reviewed periodically
 * (design-m1.md §8). NOT auto-extracted — deterministic closed vocabulary keeps the common path
 * LLM-free and noise-free.
 */
export const SCNS_GAZETTEER: readonly GazetteerEntry[] = [
  // ── Components / subsystems ──
  { canonical: 'auto-merger', kind: 'component', aliases: ['automerger', 'auto merger'] },
  {
    canonical: 'dream-daemon',
    kind: 'component',
    aliases: ['dream daemon', 'dream cycle', 'dream consolidation', 'dream'],
  },
  { canonical: 'broker', kind: 'component', aliases: ['broker daemon'] },
  { canonical: 'indexer', kind: 'component', aliases: ['index pass', 'indexvault', 'reindex'] },
  {
    canonical: 'quality-gate',
    kind: 'component',
    aliases: ['quality gate', 'quality-gate-arbiter', 'qg arbiter'],
  },
  {
    canonical: 'behavioral-gate',
    kind: 'component',
    aliases: ['behavioral gate', 'behavioral-improvement gate', 'behavioural gate'],
  },
  {
    canonical: 'memory-search',
    kind: 'component',
    aliases: ['hybrid search', 'hybridsearch', 'memory search', 'memorysearch'],
  },
  { canonical: 'ideation', kind: 'component', aliases: ['idea generation', 'suggestion generator'] },
  {
    canonical: 'negative-memory-applicator',
    kind: 'component',
    aliases: ['negative-memory applicator', 'neg-mem applicator'],
  },
  // ── Agents ──
  { canonical: 'brain', kind: 'agent', aliases: ['scns-brain', 'brain daemon', 'brain agent'] },
  // ── Artifacts ──
  { canonical: 'vault', kind: 'artifact', aliases: ['vault.db', 'memory vault'] },
  {
    canonical: 'copilot-instructions',
    kind: 'artifact',
    aliases: ['copilot-instructions.md', 'guardrails file', 'guardrails'],
  },
  // ── Concepts (the catch-all subspace) ──
  { canonical: 'memory-graph', kind: 'concept', aliases: ['memory graph', 'magma-lite', 'relational memory'] },
  {
    canonical: 'negative-memory',
    kind: 'concept',
    aliases: ['negative memory', 'negative memories', "don't rule", 'dont rule', 'prohibition memory'],
  },
  { canonical: 'self-improvement', kind: 'concept', aliases: ['self improvement', 'self-improving'] },
  { canonical: 'autonomy', kind: 'concept', aliases: ['autonomous', 'self-driving'] },
  { canonical: 'gazetteer', kind: 'concept', aliases: [] },
  { canonical: 'temporal-edge', kind: 'concept', aliases: ['temporal edge', 'temporal backbone', 'temporal edges'] },
  { canonical: 'causal-edge', kind: 'concept', aliases: ['causal edge', 'causal edges', 'causal link'] },
  { canonical: 'entity-edge', kind: 'concept', aliases: ['entity edge', 'entity node', 'entity edges', 'entity nodes'] },
  { canonical: 'magma', kind: 'concept', aliases: [] },
  { canonical: 'embeddings', kind: 'concept', aliases: ['embedding', 'vector index', 'vec0'] },
  { canonical: 'go-live', kind: 'concept', aliases: ['go live', 'go-live ladder'] },
  { canonical: 'worktree', kind: 'concept', aliases: ['git worktree', 'worktrees'] },
]

/** Escape regex metacharacters in a literal surface form. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
}

/**
 * Build the boundary-aware matcher for one surface form. Whitespace in the surface becomes `\s+`
 * so multi-word entities tolerate any internal spacing. `[\w-]` boundaries prevent in-word hits.
 */
function surfaceToPattern(surface: string): string {
  const escaped = escapeRegex(surface.trim()).replace(/\s+/g, '\\s+')
  return `(?<![\\w-])${escaped}(?![\\w-])`
}

interface CompiledEntry {
  readonly entry: GazetteerEntry
  readonly regex: RegExp
}

/** Per-gazetteer compiled-regex cache (keyed by gazetteer array identity). */
const compiledCache = new WeakMap<readonly GazetteerEntry[], CompiledEntry[]>()

function compile(gazetteer: readonly GazetteerEntry[]): CompiledEntry[] {
  const cached = compiledCache.get(gazetteer)
  if (cached) return cached
  const compiled = gazetteer.map((entry) => {
    const surfaces = [entry.canonical, ...entry.aliases]
    const pattern = surfaces.map(surfaceToPattern).join('|')
    return { entry, regex: new RegExp(pattern, 'i') }
  })
  compiledCache.set(gazetteer, compiled)
  return compiled
}

/** Per-gazetteer alias→canonical lookup cache (lowercased surface → canonical). */
const aliasCache = new WeakMap<readonly GazetteerEntry[], Map<string, string>>()

function aliasMap(gazetteer: readonly GazetteerEntry[]): Map<string, string> {
  const cached = aliasCache.get(gazetteer)
  if (cached) return cached
  const map = new Map<string, string>()
  for (const entry of gazetteer) {
    for (const surface of [entry.canonical, ...entry.aliases]) {
      map.set(surface.trim().toLowerCase().replace(/\s+/g, ' '), entry.canonical)
    }
  }
  aliasCache.set(gazetteer, map)
  return map
}

/**
 * Resolve a surface form to its canonical entity name (case-insensitive, whitespace-normalised).
 * Returns undefined when the surface is not a known entity or alias.
 */
export function canonicalize(
  surface: string,
  gazetteer: readonly GazetteerEntry[] = SCNS_GAZETTEER,
): string | undefined {
  const key = surface.trim().toLowerCase().replace(/\s+/g, ' ')
  return aliasMap(gazetteer).get(key)
}

/**
 * Deterministically extract the set of gazetteer entities mentioned in `text`. Each canonical
 * entity is returned at most once, in gazetteer declaration order (stable/deterministic).
 */
export function matchEntities(
  text: string,
  gazetteer: readonly GazetteerEntry[] = SCNS_GAZETTEER,
): EntityMatch[] {
  if (!text) return []
  const out: EntityMatch[] = []
  for (const { entry, regex } of compile(gazetteer)) {
    if (regex.test(text)) {
      out.push({ canonical: entry.canonical, kind: entry.kind })
    }
  }
  return out
}
