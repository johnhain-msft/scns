/**
 * WS-2 Phase R — PURE, UNIT-TESTED core of the LLM-as-a-Judge QA-accuracy ruler (LoCoMo).
 *
 * Dependency-injected (no `src/**` I/O of its own; retrieve/generator/judge are injected) so the ruler's
 * OWN correctness — gold selection, token accounting, accuracy aggregation, the retrieve→generate→judge
 * wiring, and the R3 variance math — is unit-tested with hand-checked fixtures BEFORE any real judge
 * number is trusted (anti-mistesting; mirrors `locomo-scoring.ts`). The harness
 * (`locomo-judge-harness.ts`) supplies the REAL retrieve (prod `retrieveContext`) + the REAL ephemeral
 * deny-all ACP generator/judge.
 *
 * Metric = MAGMA App C.3 answer accuracy + token efficiency (NEVER retrieval recall). The judge is BLIND
 * (App C.3): it grades {question, gold, candidate} only — this module never passes it the retrieved
 * context (R2 anti-self-grading).
 */

import type { QueryIntent } from '../src/memory/intent.js'
import type { QaGenerator } from '../src/memory/qa-generator.js'
import { QA_NOT_FOUND } from '../src/memory/qa-generator.js'
import type { JudgeProvider } from '../src/memory/judge-provider.js'
import { NULL_JUDGE_SCORE } from '../src/memory/judge-provider.js'
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base'

/**
 * Gold reference for a LoCoMo QA. Categories 1–4 (multi-hop/temporal/open-domain/single-hop) use the
 * `answer` field; category 5 (adversarial) uses the MAGMA abstain convention {@link LOCOMO_UNANSWERABLE}
 * — App C.3 "Adversarial Handling" (gold "Unanswerable" ⇒ the candidate MUST state lack of information)
 * + OSS `answer_formatter.py:611-624` (cat-5 → "Information not found" on entity mismatch).
 *
 * NOTE (build-time verification, flagged for Phase-R validation): the cat-5 gold convention is settled
 * EMPIRICALLY by the R2 human-calibration slice (which includes adversarial items) — if John's human
 * grades disagree with the "Unanswerable" mapping, revisit here. Do not trust the adversarial score
 * until the calibration confirms it.
 */
export const LOCOMO_UNANSWERABLE = 'Unanswerable'

// ── LoCoMo categories + the PAPER control axis (MAGMA Table 1) ───────────────────────────────────
// Table 1 (LLM-as-a-Judge, the ONLY verdict axis): MAGMA Multi-Hop 0.528 — a LOSS (< Nemori 0.569 /
// MemoryOS 0.552); Temporal 0.650, Single-Hop 0.776, Adversarial 0.742, Overall 0.700 — the WINS;
// Open-Domain 0.517 — a narrow best, treated NEUTRAL. The control sets below are derived from those
// rows and unit-tested against them, so the twice-made inversion (multi-hop as a positive control)
// can never silently return: a POSITIVE control is a category where the paper says the deep arm
// SHOULD win (sanity, non-gating); the NEGATIVE control is the paper's own concession — a category
// the deep arm is NOT expected to win and must NOT regress (Δacc ≥ −σ gates the verdict).

/** LoCoMo category ids (single source of truth for lib + harness). */
export const LOCOMO_CAT = {
  multihop: 1,
  temporal: 2,
  openDomain: 3,
  singleHop: 4,
  adversarial: 5,
} as const

/** POSITIVE controls = MAGMA's real Table-1 wins {Temporal 0.650, Single-Hop 0.776, Adversarial 0.742}. */
export const POS_CONTROL_CATS: ReadonlySet<number> = new Set([
  LOCOMO_CAT.temporal,
  LOCOMO_CAT.singleHop,
  LOCOMO_CAT.adversarial,
])

/** NEGATIVE control = the paper's concession {Multi-Hop 0.528 < Nemori/MemoryOS} — must-not-regress, never expected to win. */
export const NEG_CONTROL_CATS: ReadonlySet<number> = new Set([LOCOMO_CAT.multihop])

/** Neutral = {Open-Domain 0.517} — a narrow Table-1 best: measured + reported, gates nothing. */
export const NEUTRAL_CATS: ReadonlySet<number> = new Set([LOCOMO_CAT.openDomain])

export type ControlClass = 'positive' | 'negative' | 'neutral'

/** Control class of a LoCoMo category per the Table-1 axis above. Throws on an unknown category (fail fast). */
export function controlClassOf(category: number): ControlClass {
  if (POS_CONTROL_CATS.has(category)) return 'positive'
  if (NEG_CONTROL_CATS.has(category)) return 'negative'
  if (NEUTRAL_CATS.has(category)) return 'neutral'
  throw new Error(`controlClassOf: unknown LoCoMo category ${category} (want 1–5)`)
}

export interface LocomoQaLike {
  readonly question: string
  readonly category: number
  readonly answer?: unknown
  readonly adversarial_answer?: unknown
}

export function goldFor(qa: LocomoQaLike): string {
  if (qa.category === 5) return LOCOMO_UNANSWERABLE
  return qa.answer === undefined || qa.answer === null ? '' : String(qa.answer)
}

/**
 * REAL token count of a context string via the o200k_base BPE (gpt-tokenizer, offline, deterministic) —
 * the retrieved-context INPUT-efficiency axis (MAGMA Table-3 is an input-context token claim). Replaces
 * the old chars/4 proxy: chars/4 UNDER-counts the Eq-7 provenance scaffold (`[<t:τ> … <ref:id>]`), whose
 * punctuation BPE-splits into more tokens than length/4 implies, so an honest S4-OFF vs S4-ON Δ needs a
 * real tokenizer. o200k is a modern standard BPE; the S4-OFF/S4-ON Δ is invariant to the encoder family
 * (same encoder both arms). The gate generator/judge is Claude (proprietary tokenizer, no exact offline
 * lib) ⇒ absolute calibration is supplied by the telemetry cross-check (events.usage_input_tokens).
 */
export function countTokens(s: string): number {
  if (s.length === 0) return 0
  return encodeO200k(s).length
}

/** Sample standard deviation (n−1). Returns 0 for <2 samples (undefined-variance floor). */
export function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const varSum = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0)
  const sd = Math.sqrt(varSum / (xs.length - 1))
  return sd < 1e-9 ? 0 : sd // snap float noise from identical inputs to exact 0
}

/**
 * Samples PER ARM to resolve a mean difference `delta` at judge test-retest `sigma`, two-sample:
 * SE(diff) = σ·√(2/N); resolving `delta` at confidence `z` ⇒ N = 2·(z·σ/δ)². Returns:
 *   - `0` when σ = 0 (a deterministic judge resolves any non-zero delta trivially),
 *   - `Infinity` when δ = 0 with σ > 0 (a zero delta is never resolvable),
 * else the ceiling of the formula. This is the R3 "can LoCoMo's N resolve a 4-pt delta?" computation.
 */
export function nToResolveDelta(delta: number, sigma: number, z = 1.96): number {
  if (sigma === 0) return 0
  if (delta === 0) return Infinity
  return Math.ceil(2 * Math.pow((z * sigma) / delta, 2))
}

// ── R3/R4 reporting stats + R1 deterministic sampling + R2 control construction ─────────────────

function avg(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

export interface MeanCI {
  readonly mean: number
  readonly sigma: number
  readonly n: number
  /** Half-width of the 95% CI of the MEAN: `z·σ/√n` (0 for <2 samples). */
  readonly ci: number
}

/**
 * Mean + the half-width of the (default 95%) confidence interval of the mean, `ci = z·σ/√n`. The
 * Copilot ACP judge exposes no temperature control, so a frozen {q,gold,candidate} is judged with
 * NOISE; R3/R4 therefore report mean±ci rather than a bare point estimate.
 */
export function meanCI(xs: readonly number[], z = 1.96): MeanCI {
  const n = xs.length
  const mean = avg(xs)
  const sigma = stddev(xs)
  const ci = n > 1 ? (z * sigma) / Math.sqrt(n) : 0
  return { mean, sigma, n, ci }
}

/**
 * Pooled standard deviation across `groups`, where each group is the k replicate judge scores of ONE
 * frozen item (R3 test-retest). Pooled variance = Σ(n_i−1)·s_i² / Σ(n_i−1); singleton/empty groups
 * contribute no degrees of freedom. Returns 0 when no group has ≥2 samples. This is the σ fed to
 * {@link nToResolveDelta} to answer "can LoCoMo's N resolve a 4-pt delta?".
 */
export function pooledStddev(groups: readonly (readonly number[])[]): number {
  let num = 0
  let den = 0
  for (const g of groups) {
    if (g.length < 2) continue
    const s = stddev(g)
    num += (g.length - 1) * s * s
    den += g.length - 1
  }
  if (den === 0) return 0
  const pooledVar = num / den
  return pooledVar < 1e-18 ? 0 : Math.sqrt(pooledVar)
}

/**
 * Take the first `perCat` items of each category by a STABLE ascending `keyOf` (e.g. dia_id then
 * question) — a deterministic, reproducible dev-slice sampler (R1: no train-on-test drift between
 * runs). Category encounter order is preserved; within a category items are sorted by `keyOf`.
 *
 * `perCat` may be a NUMBER (uniform cap) or a FUNCTION `(category) => cap` (per-category cap — the M2
 * paired mode oversamples the WHY-relevant multi-hop/temporal categories where causal edges should
 * help, keeping sparse categories honest). Both forms are pure and deterministic.
 */
export function pickPerCategory<T>(
  items: readonly T[],
  perCat: number | ((category: number) => number),
  catOf: (t: T) => number,
  keyOf: (t: T) => string,
): T[] {
  const capOf = typeof perCat === 'function' ? perCat : (): number => perCat
  const byCat = new Map<number, T[]>()
  const order: number[] = []
  for (const it of items) {
    const c = catOf(it)
    if (!byCat.has(c)) {
      byCat.set(c, [])
      order.push(c)
    }
    byCat.get(c)!.push(it)
  }
  const out: T[] = []
  for (const c of order) {
    const group = byCat
      .get(c)!
      .slice()
      .sort((a, b) => {
        const ka = keyOf(a)
        const kb = keyOf(b)
        return ka < kb ? -1 : ka > kb ? 1 : 0
      })
    for (const it of group.slice(0, capOf(c))) out.push(it)
  }
  return out
}

export interface ControlItem {
  readonly question: string
  readonly gold: string
  readonly category: number
}
export interface ControlCase {
  readonly question: string
  readonly gold: string
  readonly candidate: string
  readonly category: number
}

/**
 * Build the R2 anti-self-grading controls over a frozen item set: for each item a POSITIVE case
 * (candidate = its own gold ⇒ the judge MUST score high) and a NEGATIVE case (candidate = a DIFFERENT
 * item's gold ⇒ a real-but-mismatched answer the judge MUST score low). Deterministic (neg picks the
 * next item whose gold differs). A working judge shows pos ≫ neg (see {@link controlsVerdict}).
 */
export function buildControlPairs(items: readonly ControlItem[]): {
  pos: ControlCase[]
  neg: ControlCase[]
} {
  const n = items.length
  const pos: ControlCase[] = items.map((it) => ({
    question: it.question,
    gold: it.gold,
    candidate: it.gold,
    category: it.category,
  }))
  const neg: ControlCase[] = items.map((it, i) => {
    let j = n > 1 ? (i + 1) % n : i
    let guard = 0
    while (guard < n && items[j]!.gold === it.gold) {
      j = (j + 1) % n
      guard++
    }
    return {
      question: it.question,
      gold: it.gold,
      candidate: items[j]!.gold,
      category: it.category,
    }
  })
  return { pos, neg }
}

export interface ControlsVerdict {
  readonly posMean: number
  readonly negMean: number
  readonly separation: number
  readonly pass: boolean
}

/**
 * R2 verdict: the pos-control mean must clear the neg-control mean by at least `minSeparation`. A judge
 * that cannot separate a correct answer from a mismatched one is not a usable ruler (fail).
 */
export function controlsVerdict(
  pos: readonly number[],
  neg: readonly number[],
  minSeparation = 0.3,
): ControlsVerdict {
  const posMean = avg(pos)
  const negMean = avg(neg)
  const separation = posMean - negMean
  return { posMean, negMean, separation, pass: separation >= minSeparation }
}

export type HumanSliceKind = 'correct' | 'wrong' | 'partial' | 'abstain'
export interface HumanSliceEntry {
  readonly question: string
  readonly gold: string
  readonly candidate: string
  readonly category: number
  readonly kind: HumanSliceKind
  /** Left `null` for John to fill in — judge↔human agreement is computed on return (R2 calibration). */
  readonly human_score: number | null
}

/** Degrade a gold reference to a plausibly-PARTIAL candidate (first ~60% of words, or half the chars). */
function degradePartial(gold: string): string {
  const words = gold
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '')
  if (words.length >= 2) return words.slice(0, Math.max(1, Math.ceil(words.length * 0.6))).join(' ')
  return gold.slice(0, Math.max(1, Math.ceil(gold.length * 0.5)))
}

/**
 * Build the R2 human-calibration slice: up to `target` {question, gold, candidate, category, kind}
 * triples spanning ALL categories (incl. adversarial) and a MIX of candidate qualities
 * (correct/wrong/partial/abstain), each with `human_score:null` for John to grade. Deterministic
 * (category-major, question-tiebroken). On return the harness judges the same triples and computes
 * judge↔human agreement — the residual same-model-bias control.
 */
export function buildHumanSlice(pool: readonly ControlItem[], target = 15): HumanSliceEntry[] {
  // Group by category (deterministic within-category order) then ROUND-ROBIN across categories so
  // every category is represented even when one dominates the pool (a plain category-major slice
  // would emit only the first category once it has ≥ target items).
  const byCat = new Map<number, ControlItem[]>()
  for (const it of pool) {
    if (!byCat.has(it.category)) byCat.set(it.category, [])
    byCat.get(it.category)!.push(it)
  }
  const cats = [...byCat.keys()].sort((a, b) => a - b)
  for (const c of cats) {
    byCat.get(c)!.sort((a, b) => (a.question < b.question ? -1 : a.question > b.question ? 1 : 0))
  }
  const selected: ControlItem[] = []
  const cursor = new Map<number, number>(cats.map((c) => [c, 0]))
  let progressed = true
  while (selected.length < target && progressed) {
    progressed = false
    for (const c of cats) {
      if (selected.length >= target) break
      const i = cursor.get(c)!
      const group = byCat.get(c)!
      if (i < group.length) {
        selected.push(group[i]!)
        cursor.set(c, i + 1)
        progressed = true
      }
    }
  }

  const n = selected.length
  if (n === 0) return []
  const KINDS: HumanSliceKind[] = ['correct', 'wrong', 'partial', 'abstain']
  const out: HumanSliceEntry[] = []
  for (let i = 0; i < n; i++) {
    const it = selected[i]!
    const kind = KINDS[i % KINDS.length]!
    let candidate: string
    if (kind === 'correct') candidate = it.gold
    else if (kind === 'abstain') candidate = QA_NOT_FOUND
    else if (kind === 'partial') candidate = degradePartial(it.gold)
    else {
      let j = n > 1 ? (i + 1) % n : i
      let guard = 0
      while (guard < n && selected[j]!.gold === it.gold) {
        j = (j + 1) % n
        guard++
      }
      candidate = selected[j]!.gold
    }
    out.push({
      question: it.question,
      gold: it.gold,
      candidate,
      category: it.category,
      kind,
      human_score: null,
    })
  }
  return out
}

// ── evaluate one item (retrieve → generate → judge), fully injected ──────────────────────────────

export interface JudgeEvalItem {
  readonly question: string
  readonly gold: string
  readonly category: number
}

export interface JudgeEvalDeps {
  /** Prod retrieval (real harness: `retrieveContext` over the isolated LoCoMo vault). */
  readonly retrieve: (question: string) => Promise<{ text: string; chunkIds: readonly number[] }>
  /** SCNS intent classifier (`classifyIntent`) — selects the C.2 dynamic instruction (NOT the gold label). */
  readonly intentOf: (question: string) => QueryIntent
  readonly generator: QaGenerator
  readonly judge: JudgeProvider
}

export interface JudgeEvalRow {
  readonly question: string
  readonly category: number
  readonly contextTokens: number
  readonly answer: string
  readonly notFound: boolean
  readonly genError: boolean
  /** Judge score in [0,1], or {@link NULL_JUDGE_SCORE} when the row is DROPPED (gen error / judge null). */
  readonly score: number
  readonly judgeNull: boolean
  readonly latencyMs: number
}

/**
 * Evaluate ONE item end-to-end with injected deps: retrieve context → generate an answer (App C.2) →
 * judge it BLIND against gold (App C.3). A genuine abstain ("Information not found") IS judged (it is a
 * real candidate — correct for adversarial). A generator SPAWN FAILURE (`error`) is DROPPED (judge never
 * called), exactly as a judge-null is dropped, so a flaky spawn never counts as a real 0.0.
 */
export async function evaluateItem(
  item: JudgeEvalItem,
  deps: JudgeEvalDeps,
): Promise<JudgeEvalRow> {
  const t0 = Date.now()
  const ctx = await deps.retrieve(item.question)
  const contextTokens = countTokens(ctx.text)
  const intent = deps.intentOf(item.question)
  const gen = await deps.generator.generate({ question: item.question, context: ctx.text, intent })

  if (gen.error) {
    return {
      question: item.question,
      category: item.category,
      contextTokens,
      answer: '',
      notFound: gen.notFound,
      genError: true,
      score: NULL_JUDGE_SCORE,
      judgeNull: true,
      latencyMs: Date.now() - t0,
    }
  }

  // A genuine abstain still gets graded: surface the abstain sentinel as the candidate the judge sees.
  const candidate = gen.notFound && gen.answer.trim() === '' ? QA_NOT_FOUND : gen.answer
  const verdict = await deps.judge.judge({
    question: item.question,
    gold: item.gold,
    candidate,
    category: item.category,
  })
  const judgeNull = verdict.score < 0
  return {
    question: item.question,
    category: item.category,
    contextTokens,
    answer: gen.answer,
    notFound: gen.notFound,
    genError: false,
    score: verdict.score,
    judgeNull,
    latencyMs: Date.now() - t0,
  }
}

// ── aggregation ──────────────────────────────────────────────────────────────────────────────────

export interface AccuracyRowLike {
  readonly category: number
  readonly score: number
  readonly contextTokens: number
  readonly judgeNull: boolean
  readonly genError: boolean
}

export interface CategoryAccuracy {
  readonly nScored: number
  readonly meanScore: number
}

export interface AccuracyAggregate {
  readonly nScored: number
  readonly nDropped: number
  readonly meanScore: number
  readonly meanContextTokens: number
  readonly byCategory: Record<number, CategoryAccuracy>
}

/**
 * Aggregate accuracy over evaluated rows. A row is SCORED iff `score >= 0` (a real [0,1] grade); rows
 * with a negative null sentinel (judge null OR generator error) are DROPPED from the accuracy mean but
 * their retrieved-context tokens ARE counted (the efficiency axis measures what retrieval fed the
 * generator regardless of the downstream grade). Reports overall + per-category means.
 */
export function aggregateAccuracy(rows: readonly AccuracyRowLike[]): AccuracyAggregate {
  const scored = rows.filter((r) => r.score >= 0)
  const dropped = rows.length - scored.length
  const meanScore = scored.length ? scored.reduce((a, r) => a + r.score, 0) / scored.length : 0
  const meanContextTokens = rows.length
    ? rows.reduce((a, r) => a + r.contextTokens, 0) / rows.length
    : 0
  const byCategory: Record<number, CategoryAccuracy> = {}
  const cats = new Set(scored.map((r) => r.category))
  for (const c of cats) {
    const cr = scored.filter((r) => r.category === c)
    byCategory[c] = {
      nScored: cr.length,
      meanScore: cr.reduce((a, r) => a + r.score, 0) / cr.length,
    }
  }
  return { nScored: scored.length, nDropped: dropped, meanScore, meanContextTokens, byCategory }
}

/** T030 reproduction floor: MAGMA paper-band reproduction is inclusive at 0.60 overall accuracy. */
export function reproductionBand(overall: number): boolean {
  return overall >= 0.6
}

/**
 * MAGMA App C.3 / Table-1 per-category answer-accuracy TARGETS — the Fidelity-Reproduction Floor bar
 * (AGENTS.md #11: reproduce the paper's own number + per-category WINS within tolerance). Each GATING
 * category must MEET its target; multi-hop is a FLOOR (the paper's concession 0.528 — the deep arm must not
 * regress BELOW it, but BEATING it is a stronger result and is never penalized, never a ceiling). Open-domain
 * (0.517) is NEUTRAL — measured/reported, never gated.
 */
export const PAPER_CATEGORY_TARGETS: Readonly<Record<number, number>> = {
  [LOCOMO_CAT.singleHop]: 0.776,
  [LOCOMO_CAT.temporal]: 0.65,
  [LOCOMO_CAT.adversarial]: 0.742,
  [LOCOMO_CAT.multihop]: 0.528, // FLOOR (concession) — must-not-regress-below, not an upper bound
}

/**
 * T030 MAGMA per-category reproduction — TARGET-BASED (App C.3 Fidelity-Reproduction Floor, G1 2026-07-07).
 * Each gating category {single-hop, temporal, adversarial, multi-hop} must reach its paper target within
 * `tolerance` (default 0 = strict point-target); multi-hop is a FLOOR the deep arm must not fall below (the
 * paper's concession — exceeding it is a stronger result, never a ceiling). Open-domain is NEUTRAL (never
 * gates). Supersedes the old rank-shape `multi===minAcc` proxy, which MIS-FIRED when magma BEAT the multi-hop
 * concession (making temporal, not multi-hop, the minimum) — penalizing a stronger substrate. This is a
 * reproduction leg, not a final verdict; ordering/scrambled controls are measured separately.
 */
export function reproductionCategoryPattern(
  perCatAcc: Record<number, number>,
  tolerance = 0,
): boolean {
  const gated = [
    LOCOMO_CAT.singleHop,
    LOCOMO_CAT.temporal,
    LOCOMO_CAT.adversarial,
    LOCOMO_CAT.multihop,
  ]
  if (!gated.every((c) => Number.isFinite(perCatAcc[c]))) return false
  return gated.every((c) => perCatAcc[c]! >= PAPER_CATEGORY_TARGETS[c]! - tolerance)
}

/**
 * T030 Increment-2 ORDERING leg: MAGMA's Eq-7 ordered + salience-token-budgeted briefing must PRESERVE answer
 * accuracy vs the SAME retrieved subgraph given as FULL, unordered context — within `tolerance` (default 0.05).
 * Passing means Stage-4 linearization + budgeting is "free": the same App-C.3 answer accuracy at far fewer
 * tokens (the paper's efficiency claim). NOT a recall check — both arms are answer-judged.
 */
export function reproductionOrderingPass(
  magmaOverall: number,
  fullContextOverall: number,
  tolerance = 0.05,
): boolean {
  return magmaOverall >= fullContextOverall - tolerance
}

/**
 * T030 Increment-2 SCRAMBLED-GRAPH negative control: destroying the typed-edge topology (edges shuffled,
 * counts preserved) MUST degrade magma answer accuracy by at least the judge noise floor `sigma` — proof the
 * GRAPH STRUCTURE contributes, not just the anchor chunks. Passing (control holds) = magmaReal − magmaScrambled
 * ≥ sigma. If scrambling does NOT hurt, the graph is inert and the reproduction is not credible.
 */
export function reproductionScrambledControl(
  magmaReal: number,
  magmaScrambled: number,
  sigma: number,
): boolean {
  return magmaReal - magmaScrambled >= sigma
}

/** A typed chunk→chunk edge endpoint (the `memory_edges` rows the MAGMA beam walks via dst_chunk: temporal,
 *  causal and semantic — entity edges use dst_entity, not dst_chunk). */
export interface EdgeEndpoint {
  readonly id: number
  /** 'temporal' | 'causal' | 'semantic' — the beam's `neighbors(u,type)` reads dst_chunk for these types. */
  readonly edgeType: string
  readonly dstChunk: number
}

/** One `UPDATE memory_edges SET dst_chunk = newDstChunk WHERE id = id` for the scramble to apply. */
export interface ScramblePlanEntry {
  readonly id: number
  readonly newDstChunk: number
}

/**
 * Plan a TOPOLOGY-DESTROYING permutation of typed-edge endpoints for the T030 scrambled-graph NEGATIVE
 * control. Within EACH `edgeType`, the dst_chunk endpoints are permuted among the SAME type's edges
 * (Fisher-Yates over that type's dst_chunk multiset, driven by `rng`). This preserves — per type — the edge
 * COUNT, the src out-degree, and the exact dst_chunk MULTISET (so in-degree is unchanged and every new
 * endpoint is a chunk id that already existed for that type ⇒ FK-safe). ONLY the pairing (which src reaches
 * which dst) is destroyed, so magma runs over the SAME substrate with the WRONG wiring — isolating the graph
 * STRUCTURE's contribution from the anchor chunks. Deterministic in `rng`. Returns ONLY the entries whose
 * dst_chunk actually changed, so the caller applies a minimal UPDATE and can quote the real degradation
 * (`changed` count). A type with a single edge or all-identical endpoints yields no change (you cannot destroy
 * topology that isn't there) — reported honestly, never faked.
 */
export function planEdgeScramble(
  edges: readonly EdgeEndpoint[],
  rng: () => number,
): ScramblePlanEntry[] {
  const byType = new Map<string, EdgeEndpoint[]>()
  for (const e of edges) {
    const g = byType.get(e.edgeType)
    if (g) g.push(e)
    else byType.set(e.edgeType, [e])
  }
  const plan: ScramblePlanEntry[] = []
  for (const group of byType.values()) {
    // Stable input order (by id) so the permutation is a pure function of (values, rng), not of Map/scan order.
    const rows = [...group].sort((a, b) => a.id - b.id)
    const values = rows.map((r) => r.dstChunk)
    // Fisher-Yates shuffle of the dst_chunk multiset — a same-multiset re-pairing.
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = values[i]!
      values[i] = values[j]!
      values[j] = tmp
    }
    for (let k = 0; k < rows.length; k++) {
      if (values[k] !== rows[k]!.dstChunk) plan.push({ id: rows[k]!.id, newDstChunk: values[k]! })
    }
  }
  return plan
}

/** T030 reproduction legs (a `null` control = unbuilt/unmeasured, treated as NOT passing). */
export interface ReproductionLegs {
  readonly bandPass: boolean
  readonly categoryPatternPass: boolean
  readonly orderingPass: boolean | null
  readonly scrambledPass: boolean | null
  readonly substratePass: boolean
}

/**
 * T030 FINAL reproduction verdict (contract): substrate failure ⇒ BLOCKED (a density-floor STOP dominates,
 * never REPRODUCED/NOT_REPRODUCED). Else REPRODUCED iff EVERY leg passes (band + category + ordering +
 * scrambled + substrate); a `null` control counts as not-passing, so REPRODUCED can never rest on an unbuilt
 * control. Else PARTIAL when the core (band + category) reproduces but a control is missing/failing; else
 * NOT_REPRODUCED.
 */
export function reproductionVerdict(
  legs: ReproductionLegs,
): 'REPRODUCED' | 'PARTIAL' | 'NOT_REPRODUCED' | 'BLOCKED' {
  if (!legs.substratePass) return 'BLOCKED'
  if (
    legs.bandPass &&
    legs.categoryPatternPass &&
    legs.orderingPass === true &&
    legs.scrambledPass === true
  )
    return 'REPRODUCED'
  if (legs.bandPass && legs.categoryPatternPass) return 'PARTIAL'
  return 'NOT_REPRODUCED'
}

// ── paired A/B delta (M2: the SAME items scored under two retrieval configs) ──────────────────────

export interface PairedRowLike {
  readonly category: number
  /** Judge score in [0,1], or a negative null sentinel when the row was DROPPED. */
  readonly score: number
}

export interface PairedCategoryDelta {
  readonly n: number
  readonly meanA: number
  readonly meanB: number
  readonly meanDelta: number
}

export interface PairedDeltaResult {
  /** Matched pairs where BOTH arms produced a real [0,1] grade (the only pairs a paired delta can use). */
  readonly n: number
  readonly meanA: number
  readonly meanB: number
  /** mean(scoreB − scoreA) over matched pairs — the paired estimate that cancels item difficulty. */
  readonly meanDelta: number
  /** Half-width of the 95% CI of the paired delta (`z·σ_d/√n`). */
  readonly ciDelta: number
  readonly byCategory: Record<number, PairedCategoryDelta>
}

/**
 * Matched-pair Arm-B − Arm-A delta over rows produced by scoring the SAME picked items (SAME order)
 * under two retrieval configs (M2: intentRouting false vs true + event/causal ingestion). Pairs are
 * matched by INDEX — the harness evaluates both arms over the identical `picked` list in order — and a
 * pair contributes ONLY when BOTH arms produced a real grade (either null/genError ⇒ the pair is
 * dropped, never counted as a 0.0). A paired difference cancels per-item difficulty, so its CI
 * (`z·σ_d/√n`) is tighter than the two independent-mean CIs. Throws on misaligned arrays (a
 * programming error the harness must never hit).
 */
export function pairedDeltas(
  rowsA: readonly PairedRowLike[],
  rowsB: readonly PairedRowLike[],
  z = 1.96,
): PairedDeltaResult {
  if (rowsA.length !== rowsB.length) {
    throw new Error(
      `pairedDeltas: arm arrays must align by index (A=${rowsA.length} B=${rowsB.length})`,
    )
  }
  const deltas: number[] = []
  const aScored: number[] = []
  const bScored: number[] = []
  const byCat = new Map<number, { d: number[]; a: number[]; b: number[] }>()
  for (let i = 0; i < rowsA.length; i++) {
    const ra = rowsA[i]!
    const rb = rowsB[i]!
    if (ra.category !== rb.category) {
      throw new Error(
        `pairedDeltas: category mismatch at index ${i} (A=${ra.category} B=${rb.category})`,
      )
    }
    if (ra.score < 0 || rb.score < 0) continue // count a pair ONLY when both arms graded it
    deltas.push(rb.score - ra.score)
    aScored.push(ra.score)
    bScored.push(rb.score)
    if (!byCat.has(ra.category)) byCat.set(ra.category, { d: [], a: [], b: [] })
    const g = byCat.get(ra.category)!
    g.d.push(rb.score - ra.score)
    g.a.push(ra.score)
    g.b.push(rb.score)
  }
  const ci = meanCI(deltas, z)
  const byCategory: Record<number, PairedCategoryDelta> = {}
  for (const [c, g] of byCat) {
    byCategory[c] = { n: g.d.length, meanA: avg(g.a), meanB: avg(g.b), meanDelta: avg(g.d) }
  }
  return {
    n: deltas.length,
    meanA: avg(aScored),
    meanB: avg(bScored),
    meanDelta: ci.mean,
    ciDelta: ci.ci,
    byCategory,
  }
}

// ── paired Stage-4 frontier (MAGMA §3.4 / Eq. 7: OFF vs ON on the SAME deterministic retrieved set) ──

export interface FrontierRowLike {
  readonly category: number
  /** Judge score in [0,1], or a negative null sentinel when the row was DROPPED. */
  readonly score: number
  /** REAL o200k_base token count of the injected context block (via {@link countTokens}). */
  readonly contextTokens: number
}

export interface PairedFrontierResult {
  // ── accuracy axis: matched pairs graded by BOTH arms (delegated to {@link pairedDeltas}) ──
  /** Matched pairs where BOTH Arm P and Arm S produced a real [0,1] grade. */
  readonly nAcc: number
  readonly meanScoreP: number
  readonly meanScoreS: number
  /** mean(S − P) over both-graded pairs. ≥ −σ (or positive) ⇒ Stage-4 did NOT sacrifice accuracy. */
  readonly meanDeltaScore: number
  /** Half-width of the 95% CI of the paired accuracy delta (`z·σ_d/√n`). */
  readonly ciDeltaScore: number
  // ── token axis: ALL index-aligned items (a retrieved block has tokens regardless of the grade) ──
  readonly nTok: number
  /** Mean Arm-P (S4-OFF plain-join) context tokens — the un-synthesized full-block vs-baseline reference. */
  readonly meanTokP: number
  /** Mean Arm-S (S4-ON, Eq-7) context tokens. */
  readonly meanTokS: number
  /** mean(S − P) tokens. < 0 ⇒ Stage-4 SAVED tokens (the MAGMA efficiency win); > 0 ⇒ scaffold COST. */
  readonly meanDeltaTok: number
  // ── per-item token-direction counts (self-attribution: distinguishes "scaffold overhead on a
  //    small-context corpus" from "compression that fired") — see MAGMA §3.4 salience token budgeting ──
  /** Items where S4-ON tokens < S4-OFF tokens (Stage-4 compression won net on that item). */
  readonly nItemsTokenReduced: number
  /** Items where S4-ON tokens > S4-OFF tokens (Eq-7 provenance scaffold cost > any compression). */
  readonly nItemsTokenIncreased: number
  /** Items where S4-ON tokens == S4-OFF tokens (no net char change). */
  readonly nItemsTokenEqual: number
}

/**
 * Paired Stage-4 OFF-vs-ON frontier over rows produced by scoring the SAME items (SAME index order)
 * under Arm P (`synthesize:false` — today's plain join) and Arm S (`synthesize:true` — Eq. 7 narrative
 * synthesis). Because retrieval is deterministic, both arms see the IDENTICAL retrieved SET, so the
 * paired Δ ISOLATES Stage-4 formatting (MAGMA §3.4 / Table 3's context-management + token-efficiency
 * headline). The ACCURACY axis reuses {@link pairedDeltas} (both-arms-graded pairs only, so a dropped
 * row is never counted as a 0.0). The TOKEN axis is over ALL index-aligned items — a retrieved block's
 * `contextTokens` exist regardless of the downstream grade (mirrors {@link aggregateAccuracy}'s token
 * semantics). Both directions are reported honestly: `meanDeltaTok < 0` is a saving, `> 0` a cost.
 * `contextTokens` is the REAL o200k_base token count ({@link countTokens}) of each arm's injected block.
 * Throws (via {@link pairedDeltas}) on misaligned length or per-index category mismatch.
 */
export function pairedFrontier(
  rowsP: readonly FrontierRowLike[],
  rowsS: readonly FrontierRowLike[],
  z = 1.96,
): PairedFrontierResult {
  const acc = pairedDeltas(rowsP, rowsS, z) // validates length + per-index category alignment; both-graded pairs
  const tokDeltas = rowsP.map((p, i) => rowsS[i]!.contextTokens - p.contextTokens)
  return {
    nAcc: acc.n,
    meanScoreP: acc.meanA,
    meanScoreS: acc.meanB,
    meanDeltaScore: acc.meanDelta,
    ciDeltaScore: acc.ciDelta,
    nTok: rowsP.length,
    meanTokP: avg(rowsP.map((r) => r.contextTokens)),
    meanTokS: avg(rowsS.map((r) => r.contextTokens)),
    meanDeltaTok: avg(tokDeltas),
    nItemsTokenReduced: tokDeltas.filter((d) => d < 0).length,
    nItemsTokenIncreased: tokDeltas.filter((d) => d > 0).length,
    nItemsTokenEqual: tokDeltas.filter((d) => d === 0).length,
  }
}

// ── deterministic REAL-token frontier (NO judge): S4-OFF vs S4-ON o200k Δtok + full-context framing ──

export interface TokenFrontierResult {
  readonly nItems: number
  /** Mean S4-OFF (Arm P, plain join) REAL o200k tokens. */
  readonly meanTokP: number
  /** Mean S4-ON (Arm S, Eq-7) REAL o200k tokens. */
  readonly meanTokS: number
  /** mean(S − P). < 0 ⇒ Stage-4 SAVED tokens (MAGMA efficiency win); > 0 ⇒ scaffold COST. */
  readonly meanDeltaTok: number
  /** Items where S4-ON < S4-OFF (Stage-4 compression won net on that item). */
  readonly nItemsTokenReduced: number
  /** Items where S4-ON > S4-OFF (Eq-7 scaffold cost > any compression). */
  readonly nItemsTokenIncreased: number
  /** Items where S4-ON == S4-OFF. */
  readonly nItemsTokenEqual: number
  /** Mean full-context baseline (entire conversation concatenated) REAL o200k tokens — the Table-3
   *  ~101K un-managed analog. 0 ⇒ not supplied. */
  readonly meanFullContextTok: number
  /** meanTokP / meanFullContextTok — S4-OFF as a fraction of the un-managed full context (Table-3). */
  readonly fracOfFullP: number
  /** meanTokS / meanFullContextTok — S4-ON (MAGMA) as a fraction of the un-managed full context. */
  readonly fracOfFullS: number
}

/**
 * Deterministic REAL-token (o200k) frontier over index-aligned S4-OFF vs S4-ON context-token counts,
 * with a full-context baseline for MAGMA Table-3 framing (managed retrieval as a fraction of the
 * un-managed whole conversation, the paper's ~101K→0.7–4.2K headline). NO judge: retrieval +
 * {@link countTokens} tokenization are deterministic, so this is the fast headline axis, run WITHOUT any
 * spawn. `tokP[i]`/`tokS[i]` are `countTokens()` of Arm P/S for the SAME item i (identical retrieved SET,
 * only Stage-4 formatting differs); `fullContextTok[i]` is `countTokens()` of item i's entire source
 * conversation. Throws on length mismatch. Div-by-zero-safe when no baseline is supplied (fractions → 0).
 */
export function pairedTokenFrontier(
  tokP: readonly number[],
  tokS: readonly number[],
  fullContextTok: readonly number[],
): TokenFrontierResult {
  if (tokP.length !== tokS.length || tokP.length !== fullContextTok.length) {
    throw new Error(
      `pairedTokenFrontier: token arrays misaligned (P=${tokP.length} S=${tokS.length} full=${fullContextTok.length})`,
    )
  }
  const tokDeltas = tokP.map((p, i) => tokS[i]! - p)
  const meanTokP = avg(tokP)
  const meanTokS = avg(tokS)
  const meanFull = avg(fullContextTok)
  return {
    nItems: tokP.length,
    meanTokP,
    meanTokS,
    meanDeltaTok: avg(tokDeltas),
    nItemsTokenReduced: tokDeltas.filter((d) => d < 0).length,
    nItemsTokenIncreased: tokDeltas.filter((d) => d > 0).length,
    nItemsTokenEqual: tokDeltas.filter((d) => d === 0).length,
    meanFullContextTok: meanFull,
    fracOfFullP: meanFull > 0 ? meanTokP / meanFull : 0,
    fracOfFullS: meanFull > 0 ? meanTokS / meanFull : 0,
  }
}

// ══ OFFLINE EVALUATOR — per-arm frontier value E[acc − λ·tok] + HCOPE-style high-confidence gate verdict ══
//
// The reusable measurement spine for the north-star Phases B/C/D (files/PRIOR_ART.md §CROSS-PHASE SYNTHESIS):
// score each retrieval ARM on the joint (answer-accuracy, real-token) frontier, combine via a SINGLE λ
// (accuracy-points per 1000 context tokens — FrugalGPT/Hybrid-LLM's tunable cost knob), and declare a
// candidate arm a WINNER over the incumbent ONLY on a HIGH-CONFIDENCE (Thomas et al., AAAI 2015 HCOPE analog)
// lower bound AND no negative-control regression. This module is PURE + deterministic (no spawns, no I/O of
// its own); the harness supplies the real per-arm (accuracy, tokens) rows. It flips NO default and modifies
// NO retrieval behavior — any "winner" is a REPORT; a default-ON flip stays AWAITING-JOHN (+ John's chosen λ).
//
// DEFERRED (named here, NOT built in this increment — no half-wired code): the importance-weighted HCOPE /
// Doubly-Robust / CRM-POEM OFF-policy estimator over LOGGED production traffic for a LEARNED router (Phase C
// head). On-probe we evaluate each arm DIRECTLY (no importance weights; bounded value), so the faithful
// high-confidence analog is a one-sided Student-t lower confidence bound on the paired value delta.

/** Context-token denominator for λ: λ is expressed in accuracy-points per this many context tokens (interpretable). */
export const LAMBDA_TOKEN_UNIT = 1000

/**
 * One frontier observation for an arm on one probe item: the [0,1] judge score (or a negative null sentinel
 * when the row was DROPPED) and the REAL o200k context tokens ({@link countTokens}) that produced it.
 */
export interface ArmFrontierRow {
  readonly category: number
  readonly score: number
  readonly contextTokens: number
}

export interface FrontierValueResult {
  readonly n: number
  /** Per-item value vᵢ = accᵢ − λ·(tokᵢ / {@link LAMBDA_TOKEN_UNIT}). */
  readonly perItem: number[]
  readonly mean: number
  readonly sigma: number
  /** Half-width of the 95% CI of the mean value (`z·σ/√n`). */
  readonly ci: number
}

/**
 * Per-item frontier value vᵢ = accᵢ − λ·(tokᵢ / {@link LAMBDA_TOKEN_UNIT}), plus its mean±95%CI. λ is the
 * accuracy↔token exchange rate (points per 1000 context tokens); λ=0 ⇒ pure accuracy. Pure/deterministic:
 * `acc[i]` MUST already be a real [0,1] grade (the caller drops null sentinels first) — value is intentionally
 * allowed to be NEGATIVE (a token-heavy arm), so this function never applies the score<0 drop convention
 * itself. Throws on length mismatch.
 */
export function frontierValue(
  acc: readonly number[],
  tok: readonly number[],
  lambda: number,
): FrontierValueResult {
  if (acc.length !== tok.length) {
    throw new Error(
      `frontierValue: acc/tok arrays must align (acc=${acc.length} tok=${tok.length})`,
    )
  }
  const perItem = acc.map((a, i) => a - lambda * (tok[i]! / LAMBDA_TOKEN_UNIT))
  const ci = meanCI(perItem)
  return { n: perItem.length, perItem, mean: ci.mean, sigma: ci.sigma, ci: ci.ci }
}

export interface PairedValueDeltaResult {
  /** Matched pairs where BOTH arms produced a real [0,1] grade (a paired value needs both accuracies). */
  readonly n: number
  readonly meanValueIncumbent: number
  readonly meanValueCandidate: number
  /** mean(v_candidate − v_incumbent) over both-graded pairs — the paired value gain, item difficulty cancelled. */
  readonly meanDelta: number
  /** Half-width of the 95% CI of the paired value delta (`z·σ_d/√n`). */
  readonly ciDelta: number
  /** Per-item value deltas (both-graded pairs only, in pair order) — the input to {@link hcopeLowerBound}. */
  readonly deltas: number[]
  readonly byCategory: Record<number, { n: number; meanDelta: number }>
}

/**
 * Matched-pair value delta `v_candidate − v_incumbent` over the SAME probe items scored under two arms
 * (index-aligned; the harness runs both arms over the identical picked list in order), value = acc −
 * λ·(tok/{@link LAMBDA_TOKEN_UNIT}). A pair contributes ONLY when BOTH arms produced a real grade
 * (`score >= 0`) — a dropped row is never counted as a 0.0. Unlike {@link pairedDeltas}, graded-ness is
 * judged on the ORIGINAL accuracy score (NOT on value, which may be legitimately negative for a token-heavy
 * arm). Throws on misaligned length or per-index category mismatch (a harness programming error).
 */
export function pairedValueDelta(
  incumbent: readonly ArmFrontierRow[],
  candidate: readonly ArmFrontierRow[],
  lambda: number,
  z = 1.96,
): PairedValueDeltaResult {
  if (incumbent.length !== candidate.length) {
    throw new Error(
      `pairedValueDelta: arm arrays must align by index (inc=${incumbent.length} cand=${candidate.length})`,
    )
  }
  const deltas: number[] = []
  const vInc: number[] = []
  const vCand: number[] = []
  const byCat = new Map<number, number[]>()
  for (let i = 0; i < incumbent.length; i++) {
    const ri = incumbent[i]!
    const rc = candidate[i]!
    if (ri.category !== rc.category) {
      throw new Error(
        `pairedValueDelta: category mismatch at index ${i} (inc=${ri.category} cand=${rc.category})`,
      )
    }
    if (ri.score < 0 || rc.score < 0) continue // both arms must have graded the item
    const vi = ri.score - lambda * (ri.contextTokens / LAMBDA_TOKEN_UNIT)
    const vc = rc.score - lambda * (rc.contextTokens / LAMBDA_TOKEN_UNIT)
    vInc.push(vi)
    vCand.push(vc)
    deltas.push(vc - vi)
    if (!byCat.has(ri.category)) byCat.set(ri.category, [])
    byCat.get(ri.category)!.push(vc - vi)
  }
  const ci = meanCI(deltas, z)
  const byCategory: Record<number, { n: number; meanDelta: number }> = {}
  for (const [c, ds] of byCat) byCategory[c] = { n: ds.length, meanDelta: avg(ds) }
  return {
    n: deltas.length,
    meanValueIncumbent: avg(vInc),
    meanValueCandidate: avg(vCand),
    meanDelta: ci.mean,
    ciDelta: ci.ci,
    deltas,
    byCategory,
  }
}

/**
 * Inverse standard-normal CDF (Peter Acklam's rational approximation, |abs err| < 1.15e-9). Deterministic;
 * the normal quantile seed for {@link tCritOneSided}. p≤0 ⇒ −∞, p≥1 ⇒ +∞.
 */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const plow = 0.02425
  const phigh = 1 - plow
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }
  if (p <= phigh) {
    const q = p - 0.5
    const r = q * q
    return (
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
    )
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return (
    -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  )
}

/**
 * One-sided Student-t critical value t_{1−alpha, df} via the normal quantile + the Cornish-Fisher expansion
 * (Fisher & Cornish 1960) in 1/df. Deterministic, no tables. df→∞ ⇒ the normal quantile (alpha=0.05 ⇒
 * 1.6449); df=10, alpha=0.05 ⇒ 1.8125 (matches the exact t table to 4 dp). The expansion is ASYMPTOTIC in
 * 1/df — accurate to <1% for df≳5 (our on-probe judged pass is n≈20 ⇒ df≈19); at df≲2 it mildly
 * under-estimates, but {@link hcopeLowerBound} floors at n<2 ⇒ −∞ so a <2-sample "win" is never certified.
 * Guards: df ≤ 0 or non-finite ⇒ the normal quantile.
 */
export function tCritOneSided(df: number, alpha: number): number {
  const z = normInv(1 - alpha)
  if (!isFinite(df) || df >= 1e7 || df <= 0) return z
  const z2 = z * z
  const z3 = z2 * z
  const z5 = z3 * z2
  const z7 = z5 * z2
  const z9 = z7 * z2
  const g1 = (z3 + z) / (4 * df)
  const g2 = (5 * z5 + 16 * z3 + 3 * z) / (96 * df * df)
  const g3 = (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df * df * df)
  const g4 = (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / (92160 * df * df * df * df)
  return z + g1 + g2 + g3 + g4
}

export interface HcopeBound {
  readonly n: number
  readonly mean: number
  readonly sigma: number
  /** One-sided (1−deltaConf) LOWER confidence bound: `mean − t_{1−δ, n−1}·σ/√n`. */
  readonly lowerBound: number
  readonly deltaConf: number
}

/**
 * High-confidence (1−deltaConf) one-sided LOWER bound on the mean of `deltas` (the paired value delta) — the
 * Thomas-2015 HCOPE analog for the on-probe setting: `LB = mean − t_{1−δ, n−1}·σ/√n`. A candidate arm is
 * only ever a WINNER when LB > 0 (see {@link gateVerdict}): even the pessimistic (1−δ) bound of its value
 * gain is positive, never a bare point estimate (AGENTS.md #9 "never flip on assumption"). n<2 ⇒ no bound is
 * certifiable ⇒ −∞ (never a winner). σ=0 with n≥2 ⇒ LB=mean (a deterministic gain certifies itself). Default
 * δ=0.05 (95%); overridable so John can set the confidence level.
 */
export function hcopeLowerBound(deltas: readonly number[], deltaConf = 0.05): HcopeBound {
  const n = deltas.length
  const mean = avg(deltas)
  const sigma = stddev(deltas)
  if (n < 2) return { n, mean, sigma, lowerBound: -Infinity, deltaConf }
  const t = tCritOneSided(n - 1, deltaConf)
  const lowerBound = mean - (t * sigma) / Math.sqrt(n)
  return { n, mean, sigma, lowerBound, deltaConf }
}

export type GateWinner = 'candidate' | 'no-winner'

export interface GateVerdictInput {
  /** (1−δ) lower bound on the paired value delta (candidate − incumbent) from {@link hcopeLowerBound}. */
  readonly valueDeltaLB: number
  /** mean Δaccuracy (candidate − incumbent) on the NEGATIVE controls ({@link NEG_CONTROL_CATS} = multi-hop,
   *  the paper's own concession — the deep arm is NOT expected to win there and must NOT regress).
   *  Must be ≥ −sigma to pass. */
  readonly negControlDeltaAcc: number
  /** Number of BOTH-GRADED negative-control pairs behind {@link negControlDeltaAcc}. 0 ⇒ the control was
   *  never measured ⇒ the neg leg FAILS (never a vacuous pass). */
  readonly negControlN: number
  /** mean Δaccuracy (candidate − incumbent) on the POSITIVE controls ({@link POS_CONTROL_CATS} =
   *  temporal/single-hop/adversarial, MAGMA's real Table-1 wins) — REPORTED as a sanity check, never gating. */
  readonly posControlDeltaAcc: number
  /** Judge test-retest noise floor σ (the reused σ=0.0224). */
  readonly sigma: number
}

export interface GateVerdict {
  readonly winner: GateWinner
  readonly valueGainCertified: boolean
  readonly negControlsClean: boolean
  readonly reasons: string[]
}

/**
 * The evidence-gate verdict (AGENTS.md #9): a candidate arm beats the incumbent ONLY when (a) its
 * high-confidence value-delta lower bound is POSITIVE (a certified gain on E[acc−λ·tok], not a point
 * estimate) AND (b) it does NOT regress the negative controls (Δacc ≥ −σ) — where the neg-control leg
 * requires MEASURED coverage: `negControlN === 0` fails it outright (an UNMEASURED control is not a
 * clean control — a zero-pair subset must never produce a vacuous pass). Positive controls are reported
 * as a sanity check only. Otherwise the verdict is `no-winner` — a measured NULL, honestly reported.
 * This is a REPORT: a default-ON flip stays AWAITING-JOHN (+ John's chosen λ). Pure/deterministic.
 */
export function gateVerdict(input: GateVerdictInput): GateVerdict {
  const valueGainCertified = input.valueDeltaLB > 0
  const negMeasured = input.negControlN > 0
  const negControlsClean = negMeasured && input.negControlDeltaAcc >= -input.sigma
  const reasons: string[] = []
  reasons.push(
    valueGainCertified
      ? `value-delta lower bound ${input.valueDeltaLB.toFixed(4)} > 0 (high-confidence gain certified)`
      : `value-delta lower bound ${input.valueDeltaLB.toFixed(4)} ≤ 0 (no certified gain)`,
  )
  reasons.push(
    !negMeasured
      ? `negative controls UNMEASURED (n=0 both-graded pairs) — cannot certify, blocked`
      : negControlsClean
        ? `negative-control Δacc ${input.negControlDeltaAcc.toFixed(4)} ≥ −σ (${(-input.sigma).toFixed(4)}) over n=${input.negControlN} — no regression`
        : `negative-control Δacc ${input.negControlDeltaAcc.toFixed(4)} < −σ (${(-input.sigma).toFixed(4)}) over n=${input.negControlN} — REGRESSION, blocked`,
  )
  reasons.push(`positive-control Δacc ${input.posControlDeltaAcc.toFixed(4)} (sanity, non-gating)`)
  const winner: GateWinner = valueGainCertified && negControlsClean ? 'candidate' : 'no-winner'
  reasons.push(
    winner === 'no-winner'
      ? '⇒ no-winner (measured NULL — flip stays AWAITING-JOHN)'
      : "⇒ candidate (REPORT only — flip stays AWAITING-JOHN + John's λ)",
  )
  return { winner, valueGainCertified, negControlsClean, reasons }
}

export interface WhichArmWonResult {
  /** The winning arm name per probe item (argmax value; ties involving the incumbent resolve to the incumbent). */
  readonly perItem: string[]
  /** How many items each arm won. */
  readonly tally: Record<string, number>
}

/**
 * Per-item argmax-value arm over `valuesByArm` (each arm → its per-item frontier value, index-aligned). A
 * non-incumbent arm wins an item ONLY on a STRICTLY greater value, so any tie with the incumbent resolves to
 * the incumbent (anti-churn: never unseat the incumbent on a numerical tie); ties among non-incumbent arms
 * resolve to `Object.keys` order (deterministic). Pure. `tally` is the "which arm won" headline. Throws if
 * arm arrays misalign or `incumbent` is absent.
 */
export function whichArmWon(
  valuesByArm: Record<string, readonly number[]>,
  incumbent: string,
): WhichArmWonResult {
  const arms = Object.keys(valuesByArm)
  if (!arms.includes(incumbent)) {
    throw new Error(`whichArmWon: incumbent "${incumbent}" not among arms [${arms.join(', ')}]`)
  }
  const n = valuesByArm[incumbent]!.length
  for (const a of arms) {
    if (valuesByArm[a]!.length !== n) {
      throw new Error(
        `whichArmWon: arm "${a}" length ${valuesByArm[a]!.length} ≠ incumbent length ${n}`,
      )
    }
  }
  const perItem: string[] = []
  const tally: Record<string, number> = Object.fromEntries(arms.map((a) => [a, 0]))
  for (let i = 0; i < n; i++) {
    let bestArm = incumbent
    let bestVal = valuesByArm[incumbent]![i]!
    for (const a of arms) {
      if (a === incumbent) continue
      const v = valuesByArm[a]![i]!
      if (v > bestVal) {
        bestVal = v
        bestArm = a
      }
    }
    perItem.push(bestArm)
    tally[bestArm] = (tally[bestArm] ?? 0) + 1
  }
  return { perItem, tally }
}

// ── T043/T047 [US4] — learned-controller promotion over HELD-OUT human-accepted outcomes ─────────

/**
 * MOVED to `src/reward/promotion-gate.ts` and re-exported here so there is exactly ONE
 * implementation of the promotion rule rather than a harness copy that can drift from the one the
 * live broker uses. The gate had to live under `src/` for the broker's scheduled task to import it:
 * previously the verdict existed only inside this offline harness, so the live path never computed
 * it at all. Behaviour is unchanged; every existing caller and test keeps working through these
 * re-exports.
 */
export {
  humanOutcomePromotion,
  type HumanPromotionRow,
  type HumanPromotionVerdict,
} from '../src/reward/promotion-gate.js'

// ── Substrate density-floor STOP (US2/US3; contracts/substrate-density-floor.contract.md) ────────────
// The hard pre-check that replaces the vacuous `preCheckOk = totalMaterialized > 0` the fable5 null slipped
// through (materialized=4 ⇒ "OK ✓"). The graph arms may run ONLY on a substrate dense enough that a Δ could
// be a real MAGMA effect: ≥8 materialized causal edges per conversation AND ≥0.5 per judged WHY item AND a
// per-conversation MINIMUM ≥ the floor (a sum/mean would MASK a per-conv 0 — the exact fable5 defect).

export interface SubstrateDensityFloorSpec {
  /** Minimum materialized causal edges per conversation. Contract default 8 (tunable, gated red-first). */
  readonly perConv: number
  /** Minimum materialized causal edges per judged WHY/multi-hop item. Contract default 0.5. */
  readonly perWhyItem: number
}

export const DEFAULT_SUBSTRATE_FLOOR: SubstrateDensityFloorSpec = { perConv: 8, perWhyItem: 0.5 }

/** The single STOP wording the contract mandates (identical to the STOP used elsewhere in the harness). */
export const SUBSTRATE_STOP_MESSAGE =
  'STOP — substrate below density floor; any graph-arm Δ is a NULL, not a MAGMA verdict'

export interface SubstrateDensityInput {
  /** Materialized chunk→chunk causal `memory_edges`, one entry PER conversation (never a pre-summed total). */
  readonly materializedPerConv: readonly number[]
  /** Materialized causal edges per judged WHY/multi-hop item (aggregate ratio). */
  readonly perWhyItem: number
  readonly floor?: SubstrateDensityFloorSpec
}

export interface SubstrateDensityResult {
  /** Mean materialized causal edges per conversation (report). */
  readonly materializedPerConv: number
  readonly perWhyItem: number
  /** MINIMUM across conversations — the binding check (a sum/mean would mask a per-conv 0). */
  readonly perConvMin: number
  readonly floor: SubstrateDensityFloorSpec
  /** Graph arms may run iff this is true. false ⇒ hard STOP; any graph-arm Δ is BLOCKED, not a null. */
  readonly preCheckOk: boolean
}

/**
 * Evaluate the substrate density floor (pure). `preCheckOk` requires ALL of: mean ≥ perConv floor, per-WHY
 * ≥ perWhyItem floor, AND the per-conversation MINIMUM ≥ perConv floor. An empty corpus ⇒ 0 ⇒ STOP.
 */
export function substrateDensityFloor(input: SubstrateDensityInput): SubstrateDensityResult {
  const floor = input.floor ?? DEFAULT_SUBSTRATE_FLOOR
  const convs = input.materializedPerConv
  const perConvMin = convs.length === 0 ? 0 : Math.min(...convs)
  const meanPerConv = convs.length === 0 ? 0 : convs.reduce((a, b) => a + b, 0) / convs.length
  const preCheckOk =
    meanPerConv >= floor.perConv &&
    input.perWhyItem >= floor.perWhyItem &&
    perConvMin >= floor.perConv
  return { materializedPerConv: meanPerConv, perWhyItem: input.perWhyItem, perConvMin, floor, preCheckOk }
}

// ── Fidelity-Reproduction-Floor VOID (US2/US3; data-model §3, Constitution II) ────────────────────────
// A candidate that cannot reproduce its OWN reference number (the paper) VOIDs any comparison — it is never
// recorded as a "loss". fable5's magma at 0.2492 vs the paper's ~0.700 (~3× low) should have been VOID, not
// "hybrid wins". The reproduction band (0.60 = the paper's w/o-Causal ablation floor) is the disqualify line.

export type FidelityVerdict = 'ok' | 'VOID'

export interface FidelityFloorInput {
  /** The candidate's measured overall score on its own reproduction corpus. */
  readonly candidateOverall: number
  /** The candidate's published/reference number (the paper), for the reported gap. */
  readonly referenceOverall: number
  /** Reproduction band — below this the candidate is disqualified. Default 0.60 (paper w/o-Causal floor). */
  readonly band?: number
}

export interface FidelityFloorResult {
  readonly verdict: FidelityVerdict
  readonly candidateOverall: number
  readonly referenceOverall: number
  readonly band: number
  readonly reason: string
}

/**
 * Fidelity-Reproduction-Floor (pure): `VOID` when the candidate is below its reproduction band (cannot
 * reproduce its own reference), else `ok`. A VOID comparison must NOT be recorded as a loss for the
 * incumbent — the setup was disqualified, not won.
 */
export function fidelityFloorVerdict(input: FidelityFloorInput): FidelityFloorResult {
  const band = input.band ?? 0.6
  const verdict: FidelityVerdict = input.candidateOverall >= band ? 'ok' : 'VOID'
  return {
    verdict,
    candidateOverall: input.candidateOverall,
    referenceOverall: input.referenceOverall,
    band,
    reason:
      verdict === 'VOID'
        ? `candidate ${input.candidateOverall.toFixed(4)} < reproduction band ${band.toFixed(2)} (reference ${input.referenceOverall.toFixed(4)}) — comparison VOID, never a loss`
        : `candidate ${input.candidateOverall.toFixed(4)} ≥ reproduction band ${band.toFixed(2)} — comparable`,
  }
}
