/**
 * WS-2d — the REAL, held-out MULTI-HOP retrieval RULER (LoCoMo).
 *
 * WHY: go-live has been mis-judged on the SINGLE-HOP `fusion-quality-harness.ts`, where the MAGMA paper
 * itself predicts hybrid≈graph (near-tie). MAGMA's win is MULTI-HOP. This harness grades SCNS's graph
 * tiers on the paper's OWN benchmark — LoCoMo (snap-research/locomo) — over its labeled MULTI-HOP
 * questions (category 1), whose `evidence` dia_ids are the GOLD multi-hop answer path. It reports a
 * per-graph ABLATION (hybrid vs +fusion/+semantic/+traverse/+causal) under TWO entity substrates:
 *   (P) the prod 27-entry gazetteer — the honest pre-WS-2a baseline (≈empty on LoCoMo), AND
 *   (O) an ORACLE per-conversation gazetteer (proper nouns mined from the conversation, like
 *       multihop-eval-harness.ts's FIX_GAZ) — a LABELED UPPER-BOUND measurement control that answers
 *       "is the MAGMA mechanism CAPABLE of the multi-hop win once a substrate exists?" (O is NOT WS-2a
 *       entity extraction; it is never wired into src/, never a default — measurement only.)
 *
 * The deterministic core (real BGE embeddings + graph + pure scoring) carries the verdict. LLM-gated
 * legs (+fact-nodes, QA-accuracy, an LLM causal judge) are OUT OF SCOPE here (labeled, non-gating);
 * the SCNS structured-event segmenter consumes broker/proposal TELEMETRY, not conversational turns, so
 * per-turn τ-stamped nodes (session datetime → node mtime) are the honest conversational event analog.
 *
 * USAGE (never touches the live vault — builds its own isolated vaults under mktemp):
 *   npm run build   # produces dist/memory/embedding-worker.js (real fastembed worker)
 *   # dataset auto-downloads from the official source if the path is absent:
 *   SCNS_EMBED_WORKER_PATH=dist/memory/embedding-worker.js \
 *     npx tsx scripts/locomo-multihop-harness.ts [locomo10.json]
 * Env knobs: SCNS_LOCOMO_CONVERSATIONS=N (default all 10), SCNS_LOCOMO_MAXTURNS=M (default 0 = all).
 */
import { rmSync, existsSync, statSync } from 'node:fs'
import { hybridSearch, keywordOnlySearch, type SearchResult } from '../src/memory/search.js'
import { intentAwareSearch } from '../src/memory/intent-search.js'
import { makeSemanticRelevanceScorer } from '../src/memory/semantic-relevance.js'
import { rebuildMemoryEdges } from '../src/memory/entities/edges.js'
import { materializeCausalEdges } from '../src/memory/causal-edges.js'
import { SCNS_GAZETTEER, type GazetteerEntry } from '../src/memory/entities/gazetteer.js'
import { resetEmbeddingClient } from '../src/memory/embeddings.js'
import {
  normalizeGold,
  recallAtK,
  allHopsRecallAtK,
  mrrFirstGold,
  mean,
  fractionTrue,
  type DiaId,
} from './locomo-scoring.js'
import {
  LIVE_VAULT,
  DEFAULT_DATA,
  refuseIfLive,
  extractTurns,
  oracleGazetteer,
  buildVault,
  loadLocomoSamples,
  type LocomoQA,
  type Vault,
} from './locomo-corpus.js'

const K = 10
const KS = [1, 3, 5, 10] as const
// The graph ablation (deterministic core). +causal ≡ +traverse structurally on this corpus (0 causal
// edges without an LLM judge — see WS-2b), included to document the WS-2b path runs + adds nothing here.
const CONFIGS = ['hybrid', '+fusion', '+semantic', '+traverse', '+causal'] as const
type Config = (typeof CONFIGS)[number]
// Category codes (verified empirically from locomo10.json).
const CAT = { multihop: 1, temporal: 2, openDomain: 3, singleHop: 4, adversarial: 5 } as const

function baseSearch(db: Vault['db']) {
  return async (q: string, k: number): Promise<readonly SearchResult[]> => {
    try {
      return await hybridSearch(db, q, { limit: k })
    } catch {
      return keywordOnlySearch(db, q, k)
    }
  }
}

async function runConfig(
  v: Vault,
  cfg: Config,
  q: string,
  gaz: readonly GazetteerEntry[],
): Promise<readonly SearchResult[]> {
  const base = baseSearch(v.db)
  if (cfg === 'hybrid') return base(q, K)
  const semanticRelevance = makeSemanticRelevanceScorer(v.db, q)
  if (cfg === '+fusion')
    return intentAwareSearch(v.db, q, K, base, { fusion: true, gazetteer: gaz, semanticRelevance })
  if (cfg === '+semantic')
    return intentAwareSearch(v.db, q, K, base, {
      semantic: true,
      gazetteer: gaz,
      semanticRelevance,
    })
  // +traverse and +causal both run MAGMA Alg.1 beam search; +causal differs only if causal edges exist.
  return intentAwareSearch(v.db, q, K, base, { traverse: true, gazetteer: gaz, semanticRelevance })
}

/** Project a ranked SearchResult list to the ranked list of dialog-turn ids (one chunk = one slot). */
function projectDiaIds(res: readonly SearchResult[], diaOfId: Map<number, string>): DiaId[] {
  const out: DiaId[] = []
  for (const r of res) {
    const d = diaOfId.get(r.chunkId)
    if (d) out.push(d)
  }
  return out
}

interface ScoreRow {
  sub: 'P' | 'O'
  cfg: Config
  cat: number
  mrr: number
  recall: Record<number, number>
  allHops: Record<number, boolean>
  rankedJson: string // for the positive control (traverse ≠ hybrid)
}

function scoreQuestion(
  ranked: DiaId[],
  gold: DiaId[],
): Omit<ScoreRow, 'sub' | 'cfg' | 'cat' | 'rankedJson'> {
  const recall: Record<number, number> = {}
  const allHops: Record<number, boolean> = {}
  for (const k of KS) {
    recall[k] = recallAtK(ranked, gold, k)
    allHops[k] = allHopsRecallAtK(ranked, gold, k)
  }
  return { mrr: mrrFirstGold(ranked, gold), recall, allHops }
}

// ── aggregation ────────────────────────────────────────────────────────────────────────────────
interface Agg {
  n: number
  mrr: number[]
  recall: Record<number, number[]>
  allHops: Record<number, boolean[]>
}
function newAgg(): Agg {
  const recall: Record<number, number[]> = {}
  const allHops: Record<number, boolean[]> = {}
  for (const k of KS) {
    recall[k] = []
    allHops[k] = []
  }
  return { n: 0, mrr: [], recall, allHops }
}
function pushAgg(a: Agg, r: ScoreRow): void {
  a.n++
  a.mrr.push(r.mrr)
  for (const k of KS) {
    a.recall[k]!.push(r.recall[k]!)
    a.allHops[k]!.push(r.allHops[k]!)
  }
}
function summarize(a: Agg): {
  n: number
  mrr: number
  recall: Record<number, number>
  allHops: Record<number, number>
} {
  const recall: Record<number, number> = {}
  const allHops: Record<number, number> = {}
  for (const k of KS) {
    recall[k] = mean(a.recall[k]!)
    allHops[k] = fractionTrue(a.allHops[k]!)
  }
  return { n: a.n, mrr: mean(a.mrr), recall, allHops }
}

const r4 = (x: number) => Math.round(x * 10000) / 10000
const pad = (s: string | number, n: number) => String(s).padEnd(n)

async function main(): Promise<void> {
  const dataPath = process.argv[2] ?? DEFAULT_DATA
  refuseIfLive(dataPath)
  const maxConv = Number(process.env.SCNS_LOCOMO_CONVERSATIONS ?? '0') || 0
  const maxTurns = Number(process.env.SCNS_LOCOMO_MAXTURNS ?? '0') || 0

  // Zero-mutation guard on the live vault (we never open it; assert regardless).
  const liveMtimeStart = existsSync(LIVE_VAULT) ? statSync(LIVE_VAULT).mtimeMs : null

  const samples = await loadLocomoSamples(dataPath, { maxConv })

  console.log(
    `\n=== LoCoMo multi-hop ruler :: ${samples.length} conversation(s) from ${dataPath} ===`,
  )
  console.log(
    `configs: ${CONFIGS.join(', ')} | substrates: (P) prod-gazetteer, (O) oracle-per-conv UPPER-BOUND`,
  )

  // rows[sub][cfg] accumulated across all conversations, keyed by category + a special 'mh2' (cat-1, gold≥2).
  const rows: ScoreRow[] = []
  const scored = { multihop2: 0, cat: new Map<number, number>() }
  let unresolvedGold = 0
  let tauCoverageSum = 0
  let causalEdgesTotal = 0
  const prodGaz = SCNS_GAZETTEER

  for (const sample of samples) {
    const turns = extractTurns(sample.conversation, maxTurns)
    if (turns.length === 0) continue
    const oracleGaz = oracleGazetteer(sample, turns)
    const v = await buildVault(turns, prodGaz)
    tauCoverageSum += v.tauCoverage

    // Scorable questions for THIS conversation (gold fully resolvable to ingested turns).
    interface SQ {
      qa: LocomoQA
      gold: DiaId[]
    }
    const scorable: SQ[] = []
    for (const qa of sample.qa) {
      if (qa.category === CAT.adversarial) continue
      if (
        !([CAT.multihop, CAT.temporal, CAT.openDomain, CAT.singleHop] as number[]).includes(
          qa.category,
        )
      )
        continue
      const { gold } = normalizeGold(qa.evidence ?? [])
      if (gold.length === 0) continue
      if (!gold.every((g) => v.turnDiaSet.has(g))) {
        unresolvedGold++
        continue
      }
      if (qa.category === CAT.multihop && gold.length < 2) continue // strict multi-hop
      scorable.push({ qa, gold })
    }

    // Measure both substrates. (P) first on the as-built prod edges; then rebuild entity/temporal
    // edges under the ORACLE gazetteer (semantic tier is gazetteer-independent and survives) and
    // measure (O) — reusing the SAME embeddings (no re-embed).
    for (const sub of ['P', 'O'] as const) {
      const gaz = sub === 'P' ? prodGaz : oracleGaz
      if (sub === 'O') rebuildMemoryEdges(v.db, oracleGaz)
      const mat = materializeCausalEdges(v.db) // WS-2b path; 0 on a conversational corpus (no LLM judge)
      causalEdgesTotal += mat.materialized
      for (const cfg of CONFIGS) {
        for (const { qa, gold } of scorable) {
          const res = await runConfig(v, cfg, qa.question, gaz)
          const ranked = projectDiaIds(res, v.diaOfId)
          const s = scoreQuestion(ranked, gold)
          rows.push({ sub, cfg, cat: qa.category, ...s, rankedJson: JSON.stringify(ranked) })
        }
      }
    }

    // per-conversation scorable tally (count once, from the P pass structure)
    for (const { qa } of scorable) {
      scored.cat.set(qa.category, (scored.cat.get(qa.category) ?? 0) + 1)
      if (qa.category === CAT.multihop) scored.multihop2++
    }
    rmSync(v.root, { recursive: true, force: true })
  }

  // ── positive control: does +traverse EVER differ from hybrid under (O)? (beam actually active) ──
  // rows are pushed per (conversation → substrate → config → question) in a stable order, so the
  // i-th (O,hybrid) list and the i-th (O,+traverse) list are the SAME question.
  const diffO = (() => {
    const hy: string[] = []
    const tv: string[] = []
    for (const r of rows) {
      if (r.sub !== 'O' || r.cat !== CAT.multihop) continue
      if (r.cfg === 'hybrid') hy.push(r.rankedJson)
      else if (r.cfg === '+traverse') tv.push(r.rankedJson)
    }
    let differ = 0
    const nn = Math.min(hy.length, tv.length)
    for (let i = 0; i < nn; i++) if (hy[i] !== tv[i]) differ++
    return { differ, total: nn }
  })()

  // ── aggregate + render ───────────────────────────────────────────────────────────────────────
  function agg(sub: 'P' | 'O', cfg: Config, catPred: (cat: number) => boolean): Agg {
    const a = newAgg()
    for (const r of rows) if (r.sub === sub && r.cfg === cfg && catPred(r.cat)) pushAgg(a, r)
    return a
  }
  const isMH = (c: number) => c === CAT.multihop // (already restricted to gold≥2 at scoring time)
  const isSingle = (c: number) => c === CAT.singleHop

  const resultsJson: Record<string, unknown> = {
    dataset: 'locomo10',
    conversations: samples.length,
  }

  function renderBlock(
    title: string,
    sub: 'P' | 'O',
    catPred: (c: number) => boolean,
    tag: string,
  ): void {
    const hy = summarize(agg(sub, 'hybrid', catPred))
    console.log(`\n[substrate ${sub}] ${title}  (n=${hy.n} questions)`)
    console.log(
      `  ${pad('config', 12)} ${pad('MRR', 8)} ${pad('R@1', 8)} ${pad('R@5', 8)} ${pad('R@10', 8)} ${pad('allHops@10', 12)} Δhybrid(allHops@10)`,
    )
    for (const cfg of CONFIGS) {
      const s = summarize(agg(sub, cfg, catPred))
      const d = s.allHops[10]! - hy.allHops[10]!
      const delta = cfg === 'hybrid' ? '—' : `${d >= 0 ? '+' : ''}${r4(d)}`
      const note = cfg === '+causal' ? '  (0 causal edges ⇒ ≡ traverse)' : ''
      console.log(
        `  ${pad(cfg, 12)} ${pad(r4(s.mrr), 8)} ${pad(r4(s.recall[1]!), 8)} ${pad(r4(s.recall[5]!), 8)} ${pad(r4(s.recall[10]!), 8)} ${pad(r4(s.allHops[10]!), 12)} ${delta}${note}`,
      )
      resultsJson[`${tag}.${sub}.${cfg}`] = {
        n: s.n,
        mrr: r4(s.mrr),
        r: { 1: r4(s.recall[1]!), 3: r4(s.recall[3]!), 5: r4(s.recall[5]!), 10: r4(s.recall[10]!) },
        allHops: {
          1: r4(s.allHops[1]!),
          3: r4(s.allHops[3]!),
          5: r4(s.allHops[5]!),
          10: r4(s.allHops[10]!),
        },
      }
    }
  }

  console.log('\n\n========== PRIMARY: MULTI-HOP (category 1, evidence ≥ 2 — the RULER) ==========')
  renderBlock('MULTI-HOP', 'P', isMH, 'mh')
  renderBlock('MULTI-HOP', 'O', isMH, 'mh')
  console.log(
    '\n\n========== CONTROL: SINGLE-HOP (category 4 — graph must NOT beat hybrid materially) ==========',
  )
  renderBlock('SINGLE-HOP', 'P', isSingle, 'sh')
  renderBlock('SINGLE-HOP', 'O', isSingle, 'sh')

  // ── verdict (per plan §4) ──────────────────────────────────────────────────────────────────────
  const EPS = 0.005
  const mhP = {
    hybrid: summarize(agg('P', 'hybrid', isMH)),
    traverse: summarize(agg('P', '+traverse', isMH)),
    semantic: summarize(agg('P', '+semantic', isMH)),
  }
  const mhO = {
    hybrid: summarize(agg('O', 'hybrid', isMH)),
    traverse: summarize(agg('O', '+traverse', isMH)),
    semantic: summarize(agg('O', '+semantic', isMH)),
  }
  const bestP = Math.max(mhP.traverse.allHops[10]!, mhP.semantic.allHops[10]!)
  const bestO = Math.max(mhO.traverse.allHops[10]!, mhO.semantic.allHops[10]!)
  const winP = bestP > mhP.hybrid.allHops[10]! + EPS
  const winO = bestO > mhO.hybrid.allHops[10]! + EPS
  const shP = {
    hybrid: summarize(agg('P', 'hybrid', isSingle)),
    traverse: summarize(agg('P', '+traverse', isSingle)),
  }
  const singleHopSafe = shP.traverse.allHops[10]! <= shP.hybrid.allHops[10]! + EPS

  console.log('\n\n========== VERDICT (all-hops recall@10, multi-hop) ==========')
  console.log(
    `  (P) prod-gazetteer:   hybrid ${r4(mhP.hybrid.allHops[10]!)}  best-graph ${r4(bestP)}  → graph ${winP ? 'WINS' : 'does NOT win'} (Δ ${r4(bestP - mhP.hybrid.allHops[10]!)})`,
  )
  console.log(
    `  (O) oracle-substrate: hybrid ${r4(mhO.hybrid.allHops[10]!)}  best-graph ${r4(bestO)}  → graph ${winO ? 'WINS' : 'does NOT win'} (Δ ${r4(bestO - mhO.hybrid.allHops[10]!)})`,
  )
  let diagnosis: string
  if (winP)
    diagnosis = 'GRAPH BEATS HYBRID on the prod substrate → ship-signal for WS-2c (quote carriers).'
  else if (winO)
    diagnosis =
      'Graph wins ONLY under the oracle substrate → the MECHANISM is MAGMA-faithful; the blocker is the SUBSTRATE (27-entry gazetteer). Commission WS-2a; do NOT flip anything.'
  else
    diagnosis =
      'Graph loses under BOTH substrates → implementation-gap OR corpus/metric limit OR paper-not-reproduced-here. Diagnose before any flip. This is itself the critical finding.'
  console.log(`  DIAGNOSIS: ${diagnosis}`)

  // ── sharpest diagnostic: on multi-hop questions where HYBRID misses ≥1 gold hop (allHops@10=false),
  //    does +traverse RECOVER it (reach the buried hop)? minus any it REGRESSES. This is the precise
  //    MAGMA claim, isolated on exactly the questions that need a graph. Paired per-question (same
  //    scorable order across configs), per substrate.
  function pairedAllHops10(
    sub: 'P' | 'O',
    cfg: Config,
    catPred: (c: number) => boolean,
  ): boolean[] {
    const out: boolean[] = []
    for (const r of rows)
      if (r.sub === sub && r.cfg === cfg && catPred(r.cat)) out.push(r.allHops[10]!)
    return out
  }
  function recovery(sub: 'P' | 'O'): {
    missed: number
    recovered: number
    regressed: number
    net: number
  } {
    const hy = pairedAllHops10(sub, 'hybrid', isMH)
    const tv = pairedAllHops10(sub, '+traverse', isMH)
    let missed = 0,
      recovered = 0,
      regressed = 0
    const n = Math.min(hy.length, tv.length)
    for (let i = 0; i < n; i++) {
      if (!hy[i]) missed++
      if (!hy[i] && tv[i]) recovered++
      if (hy[i] && !tv[i]) regressed++
    }
    return { missed, recovered, regressed, net: recovered - regressed }
  }
  const recP = recovery('P')
  const recO = recovery('O')
  console.log(
    '\n  hybrid-missed multi-hop RECOVERY by +traverse (reach the buried hop hybrid misses):',
  )
  console.log(
    `    (P) prod:   hybrid missed ${recP.missed} → +traverse recovered ${recP.recovered}, regressed ${recP.regressed} ⇒ net ${recP.net >= 0 ? '+' : ''}${recP.net}`,
  )
  console.log(
    `    (O) oracle: hybrid missed ${recO.missed} → +traverse recovered ${recO.recovered}, regressed ${recO.regressed} ⇒ net ${recO.net >= 0 ? '+' : ''}${recO.net}`,
  )
  resultsJson['recovery.P'] = recP
  resultsJson['recovery.O'] = recO

  // ── controls / provenance ────────────────────────────────────────────────────────────────────
  console.log('\n--- controls & provenance ---')
  console.log(
    `  positive control (beam active): +traverse ranked list DIFFERS from hybrid on ${diffO.differ}/${diffO.total} multi-hop questions under (O) ⇒ ${diffO.differ > 0 ? 'PASS ✓' : 'FAIL ✗ (beam is pass-through!)'}`,
  )
  console.log(
    `  negative control (single-hop):  (P) +traverse allHops@10 ${r4(shP.traverse.allHops[10]!)} ≤ hybrid ${r4(shP.hybrid.allHops[10]!)}+${EPS} ⇒ ${singleHopSafe ? 'PASS ✓ (no single-hop over-win)' : 'FAIL ✗'}`,
  )
  console.log(
    `  causal edges materialized across all builds: ${causalEdgesTotal} (expected 0 — WS-2b path runs, adds nothing on conversational corpus w/o LLM judge)`,
  )
  console.log(
    `  τ coverage (nodes with parsed session datetime): ${r4((tauCoverageSum / Math.max(1, samples.length)) * 100)}% mean/conversation`,
  )
  console.log(
    `  scorable multi-hop (cat1, gold≥2): ${scored.multihop2} | per-cat: ${[...scored.cat.entries()]
      .sort()
      .map(([c, n]) => `cat${c}=${n}`)
      .join(' ')} | unresolved-gold dropped: ${unresolvedGold}`,
  )

  resultsJson['verdict'] = {
    winP,
    winO,
    singleHopSafe,
    positiveControlDiffer: diffO.differ,
    causalEdgesTotal,
  }
  console.log(`\nRESULTS_JSON: ${JSON.stringify(resultsJson)}`)

  // ── zero-pollution + live-untouched guards ──────────────────────────────────────────────────
  const liveMtimeEnd = existsSync(LIVE_VAULT) ? statSync(LIVE_VAULT).mtimeMs : null
  const liveOk = liveMtimeStart === liveMtimeEnd
  console.log(
    `\nlive vault mtime unchanged: ${liveOk ? 'YES ✓' : 'NO ✗'} (${liveMtimeStart} → ${liveMtimeEnd})`,
  )
  resetEmbeddingClient()
  if (!liveOk) process.exit(2)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
