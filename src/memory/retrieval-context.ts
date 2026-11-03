/**
 * THE BRIDGE — retrieved-memory context for the behavioral gate (design-m1.md §5).
 *
 * Runs the REAL production retrieval path (`intentAwareSearch` → `hybridSearch` /
 * entity-temporal neighborhood) for a query and formats the top-K chunks into ONE
 * bounded text block suitable for injection as the agent's `# Guidance` context.
 *
 * Why this exists: the QG behavioral gate's asymmetry channel was a STATIC guidance
 * file (HEAD vs post-diff `.github/copilot-instructions.md`). That measures a
 * guardrails change but is INERT for a memory/retrieval change (identical file ⇒
 * delta 0). This module makes the injected context the OUTPUT of retrieval, so the
 * baseline (HEAD retrieval config) and candidate (the candidate's retrieval config)
 * inject genuinely different memory over the SAME vault — and a retrieval-sensitive
 * val task scores the candidate higher exactly when its retrieval is better. The
 * gate then MEASURES MAGMA memory quality (the `intentRouting` lever is MAGMA's #1
 * retrieval lever, Table 4) instead of just guarding a guidance file.
 *
 * Pure read path: opens nothing, writes nothing, mutates no env. The DB handle and
 * the base search are injected; the default base is keyword-only (FTS5, embedding-
 * free) so this is deterministic and CI-safe, while the gate/proof inject the real
 * hybrid base ({@link makeHybridBaseSearch}) for production fidelity.
 */
import type Database from 'better-sqlite3'
import { hybridSearch, keywordOnlySearch, type SearchResult } from './search.js'
import { intentAwareSearch, type BaseSearch } from './intent-search.js'
import { classifyIntent, type QueryIntent } from './intent.js'
import { SCNS_GAZETTEER, type GazetteerEntry } from './entities/gazetteer.js'
import type { SemanticRelevanceScorer } from './semantic-relevance.js'
import { DEFAULT_BUDGET, type TraversalOptions } from './adaptive-traversal.js'
import { estimateTokens } from './chunker.js'
import type { MultiHopOptions } from './multihop-iterative.js'
import { topologicalOrderCausalChains, type CausalChain } from './causal-neighborhood.js'
import { buildCausalKeyToChunk } from './causal-edges.js'
import {
  logRetrievalExperience,
  type ExperienceStore,
  type EpisodeContext,
} from './experience-store.js'

/** Default number of chunks folded into the injected context. */
export const DEFAULT_RETRIEVAL_TOPK = 5
/** Hard cap on injected context chars so a pathological neighborhood can't bloat the prompt. */
export const DEFAULT_RETRIEVAL_MAX_CHARS = 4000
/** Header prefixing the injected block (mirrors `/api/extension/context`). */
export const RETRIEVED_CONTEXT_HEADER = 'Relevant SCNS memories:'

export interface RetrievalContextConfig {
  /**
   * MAGMA intent routing (entity/temporal neighborhood). `false` = today's base
   * hybrid/keyword search only (the production default; opt in with `SCNS_INTENT_ROUTING=1`).
   * This is the asymmetry lever: baseline carries HEAD's value, candidate carries
   * the candidate's.
   */
  readonly intentRouting: boolean
  /**
   * MAGMA semantic tier: enrich the base/DEFAULT path with 2-hop embedding-similarity
   * associations (neighbor-of-neighbor the hybrid top-K can't reach). Default OFF ⇒
   * unchanged from today. A SECOND asymmetry lever — flip it on the candidate side to
   * measure whether the semantic tier improves answers.
   */
  readonly semantic?: boolean
  /**
   * MAGMA Algorithm 1 fusion: fuse hybrid ⊕ entity ⊕ semantic ⊕ temporal via weighted RRF
   * into one relevance-ranked result (supersedes the binary intent switch). Default OFF ⇒
   * unchanged. A THIRD asymmetry lever — flip it on the candidate side to measure whether
   * fused retrieval beats the coarse binary router.
   */
  readonly fusion?: boolean
  /**
   * MAGMA temporal tier: for a WHEN query with no entity anchor, return a chronological timeline
   * of the most-recent query-relevant chunks instead of relevance-ranked hybrid search. Default
   * OFF ⇒ unchanged. Only affects the intent-routing WHEN path.
   */
  readonly timeline?: boolean
  /**
   * MAGMA Algorithm 1 (Heuristic Beam Search, §3.3 Stage 3) adaptive traversal: seed on the hybrid
   * RRF anchors (Eq. 4) then beam-expand typed-edge neighbors scored by intent-adaptive edge weight
   * φ (Eq. 6 / Table 6, e.g. WHY→causal) × per-node query similarity sim(n,q) (Eq. 5) with per-hop
   * decay γ. Reaches buried multi-hop nodes flat retrieval cannot (Table 4: the single biggest
   * ablation — w/o Adaptive Policy 0.700→0.637). SUPERSEDES fusion/binary routing when ON. Default
   * OFF ⇒ prod byte-identical. Measurement-only lever (the WHY-eval harness's faithful Arm B).
   */
  readonly traverse?: boolean
  /** Beam tuning forwarded to the adaptive-traversal beam when {@link traverse} is ON (e.g. maxDepth/budget → paper 5/200). */
  readonly traversalOptions?: TraversalOptions
  /**
   * C2 — the multi-hop ITERATIVE arm (beyond MAGMA; IRCoT/FLARE family). Iterative retrieval whose
   * follow-up queries derive from what was just retrieved (graph-native bridge entities by default; an
   * LLM proposer injectable via {@link multiHopOptions}), stopping on zero information gain. Targets the
   * category the paper CONCEDES (Table 1 Multi-Hop 0.528 < Nemori 0.569). Default OFF ⇒ prod
   * byte-identical; supersedes {@link traverse} when both are ON.
   */
  readonly multiHop?: boolean
  /** Tuning forwarded to the iterative arm when {@link multiHop} is ON. */
  readonly multiHopOptions?: MultiHopOptions
  /**
   * MAGMA Stage 4 — Narrative Synthesis via Graph Linearization (Eq. 7 / §S4). When ON, the retrieved
   * subgraph is serialized as `⊕ [<t:τ> content <ref:id>]` — (1) topologically/temporally ordered
   * (WHY→causal cause-before-effect, WHEN→τ ascending), (2) provenance-scaffolded, (3) salience-token-
   * budgeted (low-salience tail → brevity codes). This is MAGMA's context-management + efficiency
   * mechanism (Table 3, ~3.37k tok/query). Default OFF ⇒ output byte-identical to today's plain join.
   * When this config is silent, `SCNS_NARRATIVE_SYNTHESIS=1` turns the lever on (T013 [US1]); an
   * explicit `false` always wins over the env.
   */
  readonly synthesize?: boolean
  /** Number of chunks to inject. Default {@link DEFAULT_RETRIEVAL_TOPK}. */
  readonly topK?: number
  /** Char cap on the injected block. Default {@link DEFAULT_RETRIEVAL_MAX_CHARS}. */
  readonly maxChars?: number
  /**
   * Force the adaptive traversal to serialize up to this many Visited nodes (Alg 1 L22-23) REGARDLESS of
   * synthesize/maxTokens. Used by the Increment-2 full-context ordering-control arm to inject the SAME
   * retrieved subgraph as magma but as plain unordered context (no Eq-7), isolating Stage-4's contribution.
   * Unset ⇒ the magma path derives it from the beam budget (synthesize+maxTokens) and legacy stays topK.
   */
  readonly returnBudget?: number
  /**
   * MAGMA Eq. 7 / Table-3 TOKEN budget for the injected block (~3.37k tok/query). When set AND
   * {@link synthesize} is on, Stage-4 salience-budgets by estimated tokens instead of {@link maxChars}, and
   * — for the {@link traverse}/{@link multiHop} arms — the traversal SERIALIZES ALL of Visited (Alg 1
   * L22-23) so the graph AUGMENTS the anchors instead of the topK-forced 1-for-1 swap. Anchors are always
   * retained (AnchorRetention = 1.0). Unset ⇒ today's topK/maxChars behavior, byte-identical.
   */
  readonly maxTokens?: number
}

export interface RetrievalContextDeps {
  /**
   * Base search the intent router falls back to (DEFAULT/WHY and empty
   * neighborhoods). Default keyword-only over `db` (embedding-free, deterministic).
   * Inject {@link makeHybridBaseSearch} for the production hybrid path.
   */
  readonly baseSearch?: BaseSearch
  /** Override the gazetteer used for intent + entity routing. Default the SCNS gazetteer. */
  readonly gazetteer?: readonly GazetteerEntry[]
  /**
   * Optional factory for a query-bound semantic-relevance scorer (cosine over stored embeddings).
   * When supplied AND `config.fusion`/`config.semantic` is on, fusion's semantic source and the
   * 2-hop augmentation are ranked by QUERY relevance instead of edge weight — making this path
   * faithful to the production CLI (which injects the same scorer). Absent ⇒ graph/edge-weight
   * order (unchanged, embedding-free), so default/keyword-only callers stay deterministic.
   */
  readonly makeSemanticRelevanceScorer?: (query: string) => SemanticRelevanceScorer
  /**
   * Phase B — OPTIONAL shared retrieval-experience logging. When supplied, {@link retrieveContext}
   * writes ONE row (via the shared {@link logRetrievalExperience}) AFTER retrieval and surfaces its id
   * on {@link RetrievedContext.experienceId}. ABSENT ⇒ zero store writes and a byte-identical result —
   * existing callers, the token-axis harness sub-modes, and `qg-behavioral-backend` all opt out.
   */
  readonly experienceLog?: { readonly store: ExperienceStore; readonly episode: EpisodeContext }
}

export interface RetrievedContext {
  /** The bounded, formatted context block to inject. `''` when retrieval returned nothing. */
  readonly text: string
  /** The routed intent for this query (provenance). */
  readonly intent: QueryIntent
  /** Chunk ids that made it into the block (provenance / debugging). */
  readonly chunkIds: readonly number[]
  /** Number of chunks retrieved (before the char cap). */
  readonly nResults: number
  /**
   * Phase B — the id of the retrieval-experience row this call logged, IFF `deps.experienceLog` was
   * supplied (the offline settle handle). Absent otherwise ⇒ the result is byte-identical to pre-B.
   */
  readonly experienceId?: number
}

/**
 * Format retrieved chunks into ONE bounded block. Mirrors `/api/extension/context`:
 * the chunk contents joined under {@link RETRIEVED_CONTEXT_HEADER}, capped at
 * `maxChars`. Returns `''` for an empty result set (so the merge becomes a no-op).
 */
export function formatRetrievedContext(
  results: readonly SearchResult[],
  maxChars: number = DEFAULT_RETRIEVAL_MAX_CHARS,
): string {
  const contents = results.map((r) => r.content.trim()).filter((c) => c !== '')
  if (contents.length === 0) return ''
  const block = `${RETRIEVED_CONTEXT_HEADER}\n${contents.join('\n\n')}`
  return maxChars > 0 ? block.slice(0, maxChars) : block
}

// ── MAGMA Stage 4: Narrative Synthesis via Graph Linearization (Eq. 7 / §S4) ──────────────────────
// Cprompt = ⊕_{ni∈Sort(Gsub)} [<t:τi> ni.content <ref:ni.id>]. Three phases: (1) Topological Ordering
// (WHEN→sort by τ; WHY→causal topo-sort so causes precede effects, via topologicalOrderCausalChains);
// (2) Provenance Scaffold [<t:τ> content <ref:id>]; (3) Salience-Based Token Budgeting — high-salience
// nodes kept full, the low-salience tail that overflows the budget collapses into a brevity code. This
// is the paper's context-management + token-efficiency win (Table 3), ABSENT from the plain join above.

/** A retrieved node prepared for linearization: id + trimmed content + Eq-5 salience + resolved τ. */
interface SynthNode {
  readonly id: number
  readonly content: string
  readonly salience: number
  readonly tau: string
}

export interface SynthesizeOptions {
  /** Routed intent — selects the Eq-7 ordering (WHY→causal topo, WHEN→τ, else salience). */
  readonly intent: QueryIntent
  /** Token/char budget for the injected block. Default {@link DEFAULT_RETRIEVAL_MAX_CHARS}. */
  readonly maxChars?: number
  /**
   * MAGMA Eq. 7 / Table-3 (~3.37k tok/query) TOKEN budget. When set, the salience budgeting keeps nodes
   * while the estimated token cost stays ≤ maxTokens (instead of the char cap) — the paper-faithful
   * denomination. Anchors (see {@link SynthesizeOptions.protectedIds}) are always kept regardless of budget.
   */
  readonly maxTokens?: number
  /**
   * Stage-1 anchor ids to PROTECT from the salience-token budget (AnchorRetention = 1.0). An anchor's
   * cumulative beam score is far below a φ-lifted reached node's, so a pure salience budget would elide
   * anchors first; keeping them unconditionally preserves the hybrid entry points while the graph augments.
   */
  readonly protectedIds?: readonly number[]
  /** Block header. Default {@link RETRIEVED_CONTEXT_HEADER}. */
  readonly header?: string
}

/** Serialize one node into the Eq-7 provenance block `[<t:τ> content <ref:id>]`. */
function serializeSynthNode(n: SynthNode): string {
  return `[<t:${n.tau}> ${n.content} <ref:${n.id}>]`
}

/** Stable marker substring emitted inside every {@link brevityCode} — its presence in a synthesized
 *  block means Stage-4 salience budgeting actually COMPRESSED (elided a low-salience tail), as opposed to
 *  merely adding provenance scaffold. Single source of truth for {@link brevityCode} + {@link hasBrevityCode}. */
export const BREVITY_CODE_MARKER = ' elided <ref:'

/** Brevity code for a contiguous run of budget-elided low-salience nodes (content dropped, ids kept). */
function brevityCode(ids: readonly number[]): string {
  return `[… ${ids.length} intermediate event${ids.length === 1 ? '' : 's'}${BREVITY_CODE_MARKER}${ids.join(',')}> …]`
}

/** True iff `text` contains at least one Eq-7 brevity code — i.e. Stage-4 compression actually fired
 *  (a low-salience tail was elided because the retrieved block overflowed the salience token budget). */
export function hasBrevityCode(text: string): boolean {
  return text.includes(BREVITY_CODE_MARKER)
}

/**
 * Resolve each chunk's event-time τ: the first-class `event_nodes.tau` (ISO-8601) when the chunk is an
 * event node, else the file `mtime_ms` rendered ISO (the temporal fallback for size-window chunks).
 */
function resolveTaus(db: Database.Database, ids: readonly number[]): Map<number, string> {
  const out = new Map<number, string>()
  const q = db.prepare(
    `SELECT en.tau AS eventTau, vf.mtime_ms AS mtimeMs
       FROM chunks c
       LEFT JOIN event_nodes en ON en.chunk_id = c.id
       LEFT JOIN vault_files vf ON vf.path = c.file_path
      WHERE c.id = ?`,
  )
  for (const id of ids) {
    const row = q.get(id) as { eventTau: string | null; mtimeMs: number | null } | undefined
    const tau =
      row?.eventTau ??
      (row?.mtimeMs != null ? new Date(row.mtimeMs).toISOString() : new Date(0).toISOString())
    out.set(id, tau)
  }
  return out
}

/**
 * WHY topological order: read the DIRECTED (cause→effect) edges from `memory_causal` (NOT the symmetric
 * `memory_edges(causal)`, which loses direction), keep those whose BOTH endpoints are in the node set,
 * and cause-order them via {@link topologicalOrderCausalChains}. Returns the node-id sequence (causes
 * first), or null when no causal edge connects the nodes (caller falls back to salience order).
 */
function causalTopoOrderIds(db: Database.Database, nodes: readonly SynthNode[]): number[] | null {
  const idSet = new Set(nodes.map((n) => n.id))
  const keyToChunk = buildCausalKeyToChunk(db)
  const rows = db
    .prepare(`SELECT cause_key AS ck, effect_key AS ek, confidence FROM memory_causal`)
    .all() as Array<{
    ck: string
    ek: string
    confidence: number
  }>
  const chains: CausalChain[] = []
  for (const r of rows) {
    const cause = keyToChunk.get(r.ck)
    const effect = keyToChunk.get(r.ek)
    if (
      !cause ||
      !effect ||
      !idSet.has(cause.id) ||
      !idSet.has(effect.id) ||
      cause.id === effect.id
    )
      continue
    chains.push({
      causeKey: r.ck,
      effectKey: r.ek,
      entity: null,
      rationale: null,
      confidence: r.confidence,
      causeContent: '',
      effectContent: '',
      causeChunkId: cause.id,
      effectChunkId: effect.id,
    })
  }
  if (chains.length === 0) return null
  const seq: number[] = []
  const seen = new Set<number>()
  for (const c of topologicalOrderCausalChains(chains)) {
    for (const id of [c.causeChunkId, c.effectChunkId]) {
      if (id != null && idSet.has(id) && !seen.has(id)) {
        seen.add(id)
        seq.push(id)
      }
    }
  }
  return seq.length > 0 ? seq : null
}

/** Phase 1: topological/temporal ordering of the retrieved nodes (Eq. 7). */
function orderSynthNodes(
  db: Database.Database,
  nodes: readonly SynthNode[],
  intent: QueryIntent,
): SynthNode[] {
  if (intent === 'WHEN') {
    return [...nodes].sort((a, b) =>
      a.tau < b.tau ? -1 : a.tau > b.tau ? 1 : b.salience - a.salience,
    )
  }
  if (intent === 'WHY') {
    const order = causalTopoOrderIds(db, nodes)
    if (order) {
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const covered = new Set(order)
      const head = order.map((id) => byId.get(id)!).filter(Boolean)
      const rest = nodes.filter((n) => !covered.has(n.id)).sort((a, b) => b.salience - a.salience)
      return [...head, ...rest]
    }
  }
  return [...nodes].sort((a, b) => b.salience - a.salience)
}

/**
 * Phase 3: salience-based budgeting. ANCHORS (protectedIds) are kept unconditionally — a Stage-1 hybrid
 * entry point's cumulative beam score is far below a φ-lifted reached node's, so a pure salience budget would
 * elide anchors first; protecting them preserves AnchorRetention = 1.0 while the graph augments. The
 * remaining budget is filled by the highest-salience NON-anchor nodes while the running serialized size fits
 * (by estimated TOKENS when {@link KeepBudget.maxTokens} is set — the Eq. 7 / Table-3 denomination — else by
 * chars). The top-salience node is always admitted (never an empty block); the complement is compressed into
 * brevity codes at serialization.
 */
interface KeepBudget {
  readonly maxChars: number
  readonly maxTokens?: number
  readonly protectedIds?: ReadonlySet<number>
}

function chooseKeepSet(nodes: readonly SynthNode[], budget: KeepBudget, header: string): Set<number> {
  const useTokens = budget.maxTokens != null
  const limit = useTokens ? budget.maxTokens! : budget.maxChars
  const cost = (s: string): number => (useTokens ? estimateTokens(s) : s.length + 1) // +1 = '\n' separator
  const protectedSet = budget.protectedIds ?? new Set<number>()
  const keep = new Set<number>()
  let used = useTokens ? estimateTokens(header) : header.length + 1 // header + '\n'
  // 1) Anchors are ALWAYS kept (retention 1.0), regardless of the budget.
  for (const n of nodes) {
    if (protectedSet.has(n.id)) {
      keep.add(n.id)
      used += cost(serializeSynthNode(n))
    }
  }
  // 2) Fill the remaining budget with the highest-salience NON-anchor nodes; the low-salience tail overflows
  //    into a brevity code. The single top-salience node is admitted even if it alone overflows an empty set.
  const bySalience = nodes
    .filter((n) => !protectedSet.has(n.id))
    .sort((a, b) => b.salience - a.salience)
  for (let i = 0; i < bySalience.length; i++) {
    const n = bySalience[i]!
    const c = cost(serializeSynthNode(n))
    if ((keep.size === 0 && i === 0) || used + c <= limit) {
      keep.add(n.id)
      used += c
    }
  }
  return keep
}

/**
 * MAGMA Stage 4 linearizer (Eq. 7 / §S4): order the retrieved subgraph (WHY→causal topo, WHEN→τ, else
 * salience), serialize each budget-kept node as `[<t:τ> content <ref:id>]`, and collapse each contiguous
 * run of low-salience budget-elided nodes into a single brevity code. Returns '' for an empty set. Pure
 * read path (resolves τ + causal direction from `db`; writes nothing).
 */
/**
 * Wrap a {@link SemanticRelevanceScorer} so its wall-clock cost and call count accumulate into `acc`.
 * Semantic scoring embeds candidate chunks, which makes it the prime suspect for the slow tail — but
 * that was previously unmeasurable, so it could only be guessed at. Records the call even when the
 * scorer throws, and re-throws untouched: instrumentation must never change retrieval behaviour.
 */
export function makeTimedScorer(
  inner: SemanticRelevanceScorer,
  acc: { ms: number; calls: number },
): SemanticRelevanceScorer {
  return async (candidateChunkIds: readonly number[]) => {
    const started = Date.now()
    acc.calls += 1
    try {
      return await inner(candidateChunkIds)
    } finally {
      acc.ms += Date.now() - started
    }
  }
}

export function synthesizeNarrativeContext(
  db: Database.Database,
  results: readonly SearchResult[],
  options: SynthesizeOptions,
): string {
  const maxChars = options.maxChars ?? DEFAULT_RETRIEVAL_MAX_CHARS
  const header = options.header ?? RETRIEVED_CONTEXT_HEADER
  const nonEmpty = results
    .map((r) => ({ id: r.chunkId, content: r.content.trim(), salience: r.score }))
    .filter((r) => r.content !== '')
  if (nonEmpty.length === 0) return ''

  // Anchor protection is part of the token-budget AUGMENT: derive the protected (anchor) set from isAnchor
  // ONLY when the Eq-7 token budget is active (or when the caller passes protectedIds explicitly). Under the
  // legacy char budget (no maxTokens) the keep-set stays pure salience ⇒ byte-identical to pre-T027 on every
  // non-token path (incl. a bare traverse+synthesize char-budget call).
  const protectedIds = new Set<number>(
    options.protectedIds ??
      (options.maxTokens != null
        ? results.filter((r) => r.isAnchor === true).map((r) => r.chunkId)
        : []),
  )

  const taus = resolveTaus(
    db,
    nonEmpty.map((r) => r.id),
  )
  const nodes: SynthNode[] = nonEmpty.map((r) => ({
    id: r.id,
    content: r.content,
    salience: r.salience,
    tau: taus.get(r.id) ?? new Date(0).toISOString(),
  }))

  const ordered = orderSynthNodes(db, nodes, options.intent)
  const keep = chooseKeepSet(
    ordered,
    {
      maxChars,
      protectedIds,
      ...(options.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
    },
    header,
  )

  const blocks: string[] = []
  let run: number[] = []
  const flushRun = (): void => {
    if (run.length > 0) {
      blocks.push(brevityCode(run))
      run = []
    }
  }
  for (const n of ordered) {
    if (keep.has(n.id)) {
      flushRun()
      blocks.push(serializeSynthNode(n))
    } else {
      run.push(n.id)
    }
  }
  flushRun()
  return `${header}\n${blocks.join('\n')}`
}

/**
 * Build a base search over `db` using the production HYBRID path (vector + FTS5),
 * falling back to keyword-only on any failure (cold embedding worker, missing
 * model) — the same resilience the live `memorySearch` adapter uses. Pass this as
 * `deps.baseSearch` to {@link retrieveContext} to measure retrieval over the real
 * production base; omit it to use the embedding-free keyword-only default.
 */
export function makeHybridBaseSearch(
  db: Database.Database,
  opts: { readonly fallbackKeywordOnly?: boolean } = {},
): BaseSearch {
  const fallback = opts.fallbackKeywordOnly ?? true
  return async (query: string, topK: number): Promise<readonly SearchResult[]> => {
    try {
      return await hybridSearch(db, query, { limit: topK })
    } catch (err) {
      if (!fallback) throw err
      return keywordOnlySearch(db, query, topK)
    }
  }
}

/**
 * Retrieve memory context for `query` via the REAL intent-aware retrieval path and
 * format it for injection. `config.intentRouting` selects the MAGMA entity/temporal
 * router (`true`) vs the base hybrid/keyword path (`false`) — the asymmetry lever.
 */
export async function retrieveContext(
  db: Database.Database,
  query: string,
  config: RetrievalContextConfig,
  deps: RetrievalContextDeps = {},
): Promise<RetrievedContext> {
  const topK = config.topK ?? DEFAULT_RETRIEVAL_TOPK
  const maxChars = config.maxChars ?? DEFAULT_RETRIEVAL_MAX_CHARS
  // T013 [US1] — Stage-4 lever follows the option-flag + SCNS_* env convention: an explicit config
  // value ALWAYS wins; the env turns it on only when the config is silent. Unset ⇒ byte-identical OFF.
  const synthesize = config.synthesize ?? process.env.SCNS_NARRATIVE_SYNTHESIS === '1'
  const gazetteer = deps.gazetteer ?? SCNS_GAZETTEER
  const baseSearch: BaseSearch =
    deps.baseSearch ?? ((q: string, k: number) => Promise.resolve(keywordOnlySearch(db, q, k)))

  const intent = classifyIntent(query, gazetteer)
  const wantsSemanticRanking =
    (config.fusion ?? false) ||
    (config.semantic ?? false) ||
    (config.traverse ?? false) ||
    (config.multiHop ?? false)
  // MAGMA Alg 1 L22-23 — when Stage-4 will salience-token-budget (synthesize + maxTokens) a graph arm, the
  // traversal SERIALIZES ALL of Visited (returnBudget = the beam's node budget) so the whole subgraph flows
  // to Stage-4 and the graph AUGMENTS the anchors, instead of the topK-forced 1-for-1 swap. An explicit
  // config.returnBudget forces the same serialize-all-visited even without synthesize (the full-context
  // ordering-control arm). Otherwise the traversal keeps its topK-bounded return (byte-identical legacy).
  const serializeAllVisited =
    synthesize && config.maxTokens != null && ((config.traverse ?? false) || (config.multiHop ?? false))
  const returnBudget =
    config.returnBudget ??
    (serializeAllVisited ? (config.traversalOptions?.budget ?? DEFAULT_BUDGET) : undefined)
  const effectiveTraversalOptions: TraversalOptions | undefined =
    returnBudget != null
      ? { ...config.traversalOptions, returnBudget }
      : config.traversalOptions
  const t0 = Date.now()
  const semanticAcc = { ms: 0, calls: 0 }
  const baseScorer =
    wantsSemanticRanking && deps.makeSemanticRelevanceScorer
      ? deps.makeSemanticRelevanceScorer(query)
      : undefined
  const results = await intentAwareSearch(db, query, topK, baseSearch, {
    enabled: config.intentRouting,
    semantic: config.semantic ?? false,
    fusion: config.fusion ?? false,
    timeline: config.timeline ?? false,
    traverse: config.traverse ?? false,
    multiHop: config.multiHop ?? false,
    ...(effectiveTraversalOptions ? { traversalOptions: effectiveTraversalOptions } : {}),
    ...(config.multiHopOptions ? { multiHopOptions: config.multiHopOptions } : {}),
    gazetteer,
    ...(baseScorer ? { semanticRelevance: makeTimedScorer(baseScorer, semanticAcc) } : {}),
  })
  const searchMs = Date.now() - t0
  const chunkIds = results.map((r) => r.chunkId)

  // Synthesis runs BEFORE logging so the recorded total reflects what the human actually waited for.
  // It used to run after the log, which silently excluded it from every measurement.
  const tSynth = Date.now()
  const text = synthesize
    ? synthesizeNarrativeContext(db, results, {
        intent,
        maxChars,
        ...(config.maxTokens != null ? { maxTokens: config.maxTokens } : {}),
      })
    : formatRetrievedContext(results, maxChars)
  const synthMs = Date.now() - tSynth

  // Phase B — ADDITIVE + FAIL-SAFE experience logging. Runs AFTER retrieval and only when opted in via
  // deps.experienceLog, so retrieved chunks/text are byte-identical whether logging is on or off.
  let experienceId: number | undefined
  if (deps.experienceLog) {
    const { store, episode } = deps.experienceLog
    experienceId = logRetrievalExperience(store, {
      queryText: query,
      levers: {
        intentRouting: config.intentRouting,
        fusion: config.fusion,
        traverse: config.traverse,
        semantic: config.semantic,
        timeline: config.timeline,
        synthesize, // the EFFECTIVE lever (config ?? env) — trap-#1 attribution must match the output
        multiHop: config.multiHop,
        traversalOptions: config.traversalOptions,
        exploreArm: episode.exploreArm,
        epsilon: episode.epsilon,
        propensity: episode.propensity,
      },
      retrievedChunkIds: chunkIds,
      intent,
      category: episode.category,
      conversationId: episode.conversationId,
      turn: episode.turn,
      latencyMs: searchMs,
      clientTimeoutMs: episode.clientTimeoutMs,
      stageTimings: JSON.stringify({
        searchMs,
        semanticMs: semanticAcc.ms,
        semanticCalls: semanticAcc.calls,
        synthMs,
        totalMs: Date.now() - t0,
      }),
    })
  }

  return {
    text,
    intent,
    chunkIds,
    nResults: results.length,
    ...(experienceId !== undefined ? { experienceId } : {}),
  }
}
