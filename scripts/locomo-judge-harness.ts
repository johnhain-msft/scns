/**
 * WS-2 Phase R — the LLM-as-a-Judge QA-accuracy harness (thin orchestrator).
 *
 * Wires the already-unit-tested pieces into the paper's metric pipeline (MAGMA App C.2 → C.3):
 *   retrieved context (SCNS prod `retrieveContext`, `intentRouting:false` = HONEST hybrid baseline)
 *     → an isolated ephemeral App-C.2 QA GENERATOR (`createAcpQaGenerator`)
 *     → a BLIND isolated ephemeral App-C.3 semantic JUDGE (`createAcpJudge`, 0.0–1.0 rubric).
 * The metric is ANSWER accuracy + token efficiency — NEVER retrieval recall (the twice-made mistake).
 *
 * This file is THIN WIRING only; all pure logic (gold selection, token accounting, accuracy
 * aggregation, retrieve→generate→judge, the R2 controls, R3 variance math, R1 deterministic
 * sampling, the human slice) lives in the unit-tested `locomo-judge-lib.ts`.
 *
 * MODES (`SCNS_JUDGE_MODE`, default `baseline`):
 *   - `smoke`     — 1 gen + 2 judge spawns on a trivial fixed item; de-risks the ACP plumbing cheaply.
 *   - `controls`  — R2 anti-self-grading: pos (gold-as-candidate)≫neg (mismatched). Also WRITES the
 *                   ~15-triple human-calibration slice (AWAITING-JOHN) to `files/human-slice.json`.
 *   - `variance`  — R3 judge test-retest σ: freeze ~R3_ITEMS triples, judge each R3_RUNS×; pooled σ + N.
 *   - `baseline`  — R4 honest hybrid baseline: BASELINE_N QA/category over the DEV slice (conv 1..DEV);
 *                   reports accuracy + tokens/query + latency JOINTLY, generator+judge model CONSTANT.
 *   - `armb`      — M2 PAIRED Arm A (hybrid) vs Arm B (event+causal, intentRouting:true) on auto-selected
 *                   LoCoMo Qs; the causal WHY-read only helps if the router classifies WHY (M2: it did not).
 *   - `whyeval`   — the FAITHFUL MAGMA WHY-retrieval probe: paired Arm A (hybrid) vs Arm B (the Alg-1
 *                   adaptive-traversal BEAM, S1–S3: RRF anchors ⊕ intent-weighted multi-hop over typed
 *                   edges incl. materialized causal, query-conditioned per Eq. 5; depth/budget 5/200) over
 *                   20 hand-authored corpus-grounded "Why …" questions (`locomo-why-questions.ts`) that DO
 *                   fire the WHY route. Reports a PRE-CHECK (materialized causal edges the beam can walk),
 *                   by-item + per-anchor Δ, and a fired-subset Δ. Confounds DECLARED, not hidden: MAGMA
 *                   Stage-4 (linearization/provenance/salience) is ABSENT on every path ⇒ token-efficiency
 *                   is EXCLUDED; the transition us*ew*decay is a linearized surrogate of exp(λ1φ+λ2·sim).
 *   - `frontier-ingest`   — the MAGMA Stage-4 (Eq. 7) GATE, restructured for ingest-once + cheap reuse.
 *                   Build a real-BGE ORACLE-gaz vault + ACP event/causal ingest per DEV conversation, then
 *                   SNAPSHOT each vault.db (better-sqlite3 online backup) + a PRE-CHECK manifest to
 *                   SCNS_FRONTIER_SNAPSHOT. ACP-heavy; run ONCE. The token + accuracy arms REOPEN this
 *                   snapshot (reopened by the token/accuracy sub-modes) instead of re-ingesting — killing the det×2 re-ingest.
 *   - `frontier-tokens`   — the DETERMINISTIC token headline (NO spawns): paired Arm P (synthesize:false =
 *                   plain join) vs Arm S (synthesize:true = Eq-7 narrative synthesis: topo-order +
 *                   `<ref:id>` provenance + salience token budget) over the IDENTICAL deterministic
 *                   retrieved set. Context tokens are REAL o200k_base BPE (`countTokens`, gpt-tokenizer —
 *                   NOT chars/4), reported vs a full-context baseline (entire conversation = Table-3's
 *                   ~101K un-managed analog) with compression attribution. Δtok < 0 ⇒ the MAGMA efficiency
 *                   win; HARD PRE-CHECK (materialized>0) gates trust.
 *   - `frontier-accuracy` — the economical accuracy-not-sacrificed check: paired Arm P vs Arm S JUDGED on
 *                   the SAME snapshot, REUSING a pinned σ (SCNS_JUDGE_SIGMA) + controls PASS (not
 *                   recomputed). Δacc ≥ −σ ⇒ accuracy not sacrificed (expect a NULL). det×2 = re-run this on
 *                   the SAME snapshot (JUDGING only, never re-ingest).
 *   - `cert-ingest`           — C1.3: build + ACP-ingest the HELD-OUT certification snapshot (convs OUTSIDE the
 *                   DEV tuning slice + the WHY-authored convs — kills train-on-test, §9 evaluator risk #1). Same
 *                   snapshot format; the arm-frontier sub-modes reopen it. Default {conv-44, conv-47}; override
 *                   SCNS_CERT_SAMPLE_IDS / SCNS_CERT_CONV_N.
 *   - `arm-frontier-tokens`   — the SHARED OFFLINE EVALUATOR, deterministic token axis (NO spawns): per-arm
 *                   REAL o200k tokens over the REDESIGNED faithful arms {hybrid (incumbent), magma (Alg-1
 *                   traverse + Stage-4 synthesize), multihop-iter (C2 iterative)} on the SAME snapshot. Flips NO
 *                   default; the value/HCOPE-gate/whichArmWon are the judged sub-mode.
 *   - `arm-frontier-accuracy` — the SHARED OFFLINE EVALUATOR, judged gate: per-arm accuracy + a λ-SWEEP of the
 *                   paired value delta E[acc−λ·tok] → HCOPE one-sided lower bound → gateVerdict per candidate vs
 *                   the INCUMBENT (hybrid), with the PAPER-AXIS controls (POS={temporal,singleHop,adversarial} =
 *                   MAGMA's Table-1 wins, sanity/non-gating; NEG={multihop} = the paper's concession,
 *                   must-not-regress, gating; NEUTRAL={openDomain} reported). Winner = REPORT ONLY (default-ON
 *                   flip stays AWAITING-JOHN + John's λ). Reuses σ; labels CONFIRMATORY unless powered AND held-out.
 *   - `repro-accuracy` — T030 MAGMA-only judged reproduction read: reopen a frontier snapshot, run only the
 *                   faithful magma arm, and report absolute accuracy vs the paper band + category pattern.
 *
 * MEASURED — Phase-A Stage-4 (Eq-7) GATE, LOCAL, ONE snapshot (conv-26+conv-30; materialized [4,0], persisted
 * [2,0]); n=20 paired WHY probes; REAL o200k tokens; σ=0.0224 REUSED; pos/neg controls PASS (0.98 sep, NOT
 * recomputed — session 27b6c4be). Live vault untouched (mtime/size asserted equal); ACP 0-leak (80 spawned /
 * 0 alive / 80 exit-signalled):
 *   • frontier-tokens  : S4-OFF 160 tok / S4-ON 285 tok / Δtok +125 (0/20 compressed) ⇒ NO TOKEN WIN. STRUCTURAL
 *                        NULL — Eq-7 compression NEVER fired (no retrieved block > budget on small-context LoCoMo);
 *                        S4-ON = provenance-scaffold overhead only. Both arms ~1-2% of full-context (13869 tok).
 *   • frontier-accuracy: Arm P 0.7975 / Arm S 0.7975 / Δacc 0 ± 0.0246 (n=20) ⇒ accuracy NOT sacrificed (NULL).
 *                        CONFIRMATORY-ONLY: causal edges materialized on conv-26 ONLY (conv-30 → 0 via a malformed
 *                        causal-critic JSON), so Eq-7's causal topo-order is weakly exercised — a real Δacc row
 *                        with controls, NOT a powered/generalizable verdict.
 *   GATE DECISION: no token win ⇒ keep Stage-4 default-OFF regardless of accuracy. The structural token NULL is
 *                  decisive; the confirmatory accuracy NULL cannot flip it. Raw rows: session files/ gate.tokens.*
 *                  + gate.accuracy.* (this session 5cd46171).
 *
 * SUPERSEDED HISTORY — the 2026-07-04 "ARM-FRONTIER go-live" run (hybrid 0.556 · entity 0.222 · causal-beam
 * 0.344 · synthesis 0.783, "measured NULL, hybrid stands") was produced by the QUARANTINED MIS-SPECIFIED
 * design (near-inverted controls: POS={multihop,temporal} vs the paper's actual wins; strawman arms; n=9;
 * train-on-test conv-26/30). Commit 5f9745c holds the quarantine record. Those numbers are NOT evidence for
 * or against any arm. The redesign above (paper-axis controls from the lib, faithful arms, held-out
 * cert-ingest snapshot, N/cat 6) replaces it; trust only rows produced by the redesigned gate.
 *
 * GUARDS (absolute): live vault `~/.scns/memory/vault.db` is NEVER opened (assert mtime unchanged at
 * start+end); real spawns are gated behind `SCNS_LLM_JUDGE=1 SCNS_QA_GENERATOR=1` (default-OFF: a dry
 * run spawns nothing and exits 0); every gen/judge spawn is deny-all + bounded + `close()`d in finally
 * (in the seam) + isolated `cwd=mktemp` (never the checkout); spawned PIDs are tracked and any stray is
 * killed BY ITS OWN PID (never pkill/killall); the ISO dir + every built vault is `rmSync`'d (zero
 * pollution, asserted).
 *
 * USAGE (see the Phase-R runbook COMMON PREAMBLE):
 *   npm run build
 *   export SCNS_HOME=$(mktemp -d) SCNS_EMBED_WORKER_PATH=dist/memory/embedding-worker.js
 *   export SCNS_LLM_JUDGE=1 SCNS_QA_GENERATOR=1
 *   SCNS_JUDGE_MODE=controls npx tsx scripts/locomo-judge-harness.ts /tmp/locomo10.json
 */
import {
  rmSync,
  existsSync,
  statSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { commitRoutingPolicy } from '../src/memory/routing-policy.js'
import { applyExperienceReinforcement } from '../src/memory/edge-reinforcement.js'
import {
  retrieveContext,
  makeHybridBaseSearch,
  hasBrevityCode,
  type RetrievalContextConfig,
} from '../src/memory/retrieval-context.js'
import {
  openExperienceStore,
  settleRetrievalExperience,
  logFullContextBaseline,
  countExplorations24h,
  type ExperienceStore,
} from '../src/memory/experience-store.js'
import {
  isExploreRoutingEnabled,
  selectExplorationArm,
  mulberry32,
  DEFAULT_MAX_EXPLORATIONS_24H,
} from '../src/memory/explore-router.js'
import { makeSemanticRelevanceScorer } from '../src/memory/semantic-relevance.js'
import { routeQueryArm } from '../src/memory/arm-router.js'
import { classifyIntent } from '../src/memory/intent.js'
import { openMemoryDb } from '../src/memory/db.js'
import { SCNS_GAZETTEER, type GazetteerEntry } from '../src/memory/entities/gazetteer.js'
import { resetEmbeddingClient } from '../src/memory/embeddings.js'
import { createAcpClient } from '../src/broker/services/acp-client.js'
import type { AcpClient, AcpClientOptions } from '../src/broker/services/acp-client.js'
import {
  createAcpQaGenerator,
  isQaGeneratorEnabled,
  GEN_MODEL_ENV,
} from '../src/memory/qa-generator-acp.js'
import { createAcpJudge, isJudgeEnabled, JUDGE_MODEL_ENV } from '../src/memory/judge-acp.js'
import { ingestConversationEventNodes } from '../src/memory/conversation-segmenter.js'
import {
  createAcpConversationEventExtractor,
  isConversationEventExtractEnabled,
  CONVERSATION_EVENT_ACP_ENV,
} from '../src/memory/conversation-event-extractor-acp.js'
import { createAcpCausalProvider, CAUSAL_ACP_ENV } from '../src/memory/causal-runner.js'
import { listEventNodes } from '../src/memory/event-nodes.js'
import { causalNeighborhood } from '../src/memory/causal-neighborhood.js'
import type { QaGenerator } from '../src/memory/qa-generator.js'
import type { JudgeProvider } from '../src/memory/judge-provider.js'
import {
  LIVE_VAULT,
  DEFAULT_DATA,
  refuseIfLive,
  extractTurns,
  oracleGazetteer,
  buildVault,
  snapshotVaultDb,
  reopenVaultSnapshot,
  loadLocomoSamples,
  type LocomoSample,
  type Vault,
} from './locomo-corpus.js'
import { normalizeGold, mean } from './locomo-corpus.js'
import {
  WHY_EVAL_QUESTIONS,
  groupWhyQuestionsBySample,
  validateWhyEvalQuestions,
} from './locomo-why-questions.js'
import {
  goldFor,
  evaluateItem,
  aggregateAccuracy,
  pairedDeltas,
  pairedFrontier,
  countTokens,
  pairedTokenFrontier,
  meanCI,
  pooledStddev,
  nToResolveDelta,
  pickPerCategory,
  buildControlPairs,
  controlsVerdict,
  buildHumanSlice,
  frontierValue,
  pairedValueDelta,
  hcopeLowerBound,
  gateVerdict,
  whichArmWon,
  substrateDensityFloor,
  SUBSTRATE_STOP_MESSAGE,
  reproductionBand,
  reproductionCategoryPattern,
  reproductionOrderingPass,
  reproductionScrambledControl,
  reproductionVerdict,
  planEdgeScramble,
  type EdgeEndpoint,
  LAMBDA_TOKEN_UNIT,
  LOCOMO_CAT,
  POS_CONTROL_CATS,
  NEG_CONTROL_CATS,
  NEUTRAL_CATS,
  type JudgeEvalDeps,
  type JudgeEvalRow,
  type ControlItem,
  type ArmFrontierRow,
  type SubstrateDensityResult,
} from './locomo-judge-lib.js'

// ── env knobs ──────────────────────────────────────────────────────────────────────────────────
const MODE = (process.env.SCNS_JUDGE_MODE ?? 'baseline').trim()
const DEV_CONV = Number(process.env.SCNS_LOCOMO_DEV_CONV ?? '5') || 5
const BASELINE_N = Number(process.env.SCNS_BASELINE_N ?? '6') || 6
const CONTROLS_N = Number(process.env.SCNS_CONTROLS_N ?? '2') || 2 // per category
const R3_ITEMS = Number(process.env.SCNS_R3_ITEMS ?? '10') || 10
const R3_RUNS = Number(process.env.SCNS_R3_RUNS ?? '8') || 8
// test-retest σ is MODEL-dependent — re-establish via variance mode under the pinned model (claude-opus-4.8 → 0.0267, 2026-07-03); never trust a σ measured under a different model.
const JUDGE_SIGMA = Number(process.env.SCNS_JUDGE_SIGMA ?? 0.0267)

// Retrieval injection budget shared by every scored arm (topK chunks + char cap). The char cap IS the
// MAGMA Stage-4 salience-budget compression trigger: an item only COMPRESSES (elides a low-salience tail
// into a brevity code) when its full retrieved block exceeds RETRIEVAL_MAX_CHARS; below it, Stage-4 ON is
// pure provenance scaffold (Δtok > 0 that says nothing about the compression mechanism). Surfaced in the
// frontier RESULTS_JSON as the compression trigger point so a no-token-win is correctly attributed.
const RETRIEVAL_TOPK = 5
const RETRIEVAL_MAX_CHARS = 4000
// MAGMA Stage-4 (Eq. 7) briefing TOKEN budget for the graph arm (paper Table 3 ≈ 3.37k tok/query). With it
// set on a `synthesize+traverse` arm, retrieveContext serializes ALL of Visited (Alg 1 L22-23) and Stage-4
// salience-token-budgets to this cap — so magma AUGMENTS (anchors ∪ reached typed nodes) instead of the
// topK-forced 1-for-1 swap. Anchors are always retained. Overridable for sensitivity via SCNS_MAGMA_MAX_TOKENS.
const MAGMA_STAGE4_MAX_TOKENS = Number(process.env.SCNS_MAGMA_MAX_TOKENS ?? '3400') || 3400
const HUMAN_SLICE_TARGET = Number(process.env.SCNS_HUMAN_SLICE_N ?? '15') || 15
const SESSION_FILES =
  process.env.SCNS_SESSION_FILES ?? join(process.cwd(), 'out', 'locomo-session-files')
const HUMAN_SLICE_PATH =
  process.env.SCNS_HUMAN_SLICE_PATH ?? join(SESSION_FILES, 'human-slice.json')

// ── Frontier snapshot (ingest-once + reuse) ─────────────────────────────────────────────────────
// The frontier is split into three sub-modes sharing ONE on-disk snapshot so the expensive real-BGE
// index + ACP event/causal ingest happen exactly ONCE (`frontier-ingest`), and the deterministic REAL-
// token axis (`frontier-tokens`, NO spawns) + the economical judged accuracy axis (`frontier-accuracy`,
// det×2 on JUDGING only) both REOPEN the snapshot instead of re-ingesting. SCNS_FRONTIER_SNAPSHOT points
// at the snapshot dir; the token/accuracy sub-modes always reopen it (that IS the reuse — no re-ingest).
const FRONTIER_SNAPSHOT = process.env.SCNS_FRONTIER_SNAPSHOT ?? ''
const FRONTIER_MANIFEST = 'manifest.json'

// Single source of truth for category ids + the paper control axis lives in the LIB (unit-tested
// against Table 1) — the harness only aliases it, so the twice-made inversion cannot re-enter here.
const CAT = LOCOMO_CAT
const r4 = (x: number) => Math.round(x * 10000) / 10000

// ── spawn-PID tracking (kill-by-PID only; never pkill/killall) ──────────────────────────────────
// The ACP client's `.pid` getter returns `process?.pid ?? null` and `close()` nulls the process, so
// the pid MUST be snapshotted the instant the process is spawned (right after initialize() resolves)
// — reading it after the seam's finally-close() would yield null. Exit is matched via a captured
// closure pid so we never depend on `.pid` at teardown time.
const spawnedPids = new Set<number>()
const exitedPids = new Set<number>()

/** Wrap the real ACP client factory to snapshot each spawned pid at init and note its clean exit. */
function trackingCreate(opts: AcpClientOptions): AcpClient {
  let capturedPid: number | null = null
  const client = createAcpClient({
    ...opts,
    onProcessExit: () => {
      if (capturedPid != null) exitedPids.add(capturedPid)
    },
  })
  const origInitialize = client.initialize.bind(client)
  ;(client as { initialize: AcpClient['initialize'] }).initialize = async () => {
    const res = await origInitialize()
    capturedPid = client.pid // non-null here: the process is spawned + alive, not yet closed
    if (capturedPid != null) spawnedPids.add(capturedPid)
    return res
  }
  return client
}

/**
 * After a run (and a short grace for SIGTERM to land): a spawned pid is a STRAY only if it is STILL
 * ALIVE at the OS level; kill it by its OWN pid. Aliveness (`kill(pid,0)`) is authoritative — the
 * async 'exit' event can lag a clean teardown, so we never classify a just-terminating process as a
 * stray. `exitedPids` (from onProcessExit) is reported for transparency only.
 */
function spawnGuardReport(): {
  spawned: number
  alive: number
  strayKilled: number
  exitedSignalled: number
} {
  const pids = [...spawnedPids]
  let alive = 0
  let strayKilled = 0
  for (const pid of pids) {
    let isAlive = false
    try {
      process.kill(pid, 0) // throws ESRCH if already gone
      isAlive = true
    } catch {
      isAlive = false
    }
    if (isAlive) {
      alive++
      try {
        process.kill(pid, 'SIGKILL') // this exact pid only (still running after teardown ⇒ genuine stray)
        strayKilled++
      } catch {
        /* raced to exit */
      }
    }
  }
  return {
    spawned: pids.length,
    alive,
    strayKilled,
    exitedSignalled: pids.filter((p) => exitedPids.has(p)).length,
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Providers + isolated spawn cwd — assigned in main() AFTER the default-OFF guard (a dry run makes none).
let ISO = ''

// Phase B — the shared retrieval-experience store for the OFFLINE eval path. Opened lazily UNDER the
// per-run ISO tmp dir (NEVER the live ~/.scns/memory/experience.db, NEVER vault.db) when
// SCNS_EXPERIENCE_STORE !== '0', giving the offline retrieveContext seam + logFullContextBaseline a real
// (non-test) caller. Writes are post-retrieval + fail-safe ⇒ every RESULTS_JSON stays byte-identical.
let harnessExperienceStore: ExperienceStore | null = null
let harnessStoreResolved = false
function getHarnessStore(): ExperienceStore | null {
  if (process.env.SCNS_EXPERIENCE_STORE === '0') return null
  if (harnessExperienceStore || harnessStoreResolved || !ISO) return harnessExperienceStore
  harnessStoreResolved = true
  try {
    harnessExperienceStore = openExperienceStore(join(ISO, 'experience.db'))
  } catch {
    harnessExperienceStore = null
  }
  return harnessExperienceStore
}
process.on('exit', () => harnessExperienceStore?.close())
let generator: QaGenerator
let judge: JudgeProvider

// ── shared helpers ───────────────────────────────────────────────────────────────────────────────
interface PoolItem extends ControlItem {
  readonly key: string
}

/** Build a deterministic {question, gold, category, sortKey} pool from a dataset slice (judge-blind modes). */
function devPool(samples: readonly LocomoSample[]): PoolItem[] {
  const pool: PoolItem[] = []
  for (const s of samples) {
    for (const qa of s.qa) {
      const gold = goldFor(qa)
      if (gold === '') continue
      const { gold: dias } = normalizeGold(qa.evidence ?? [])
      pool.push({
        question: qa.question,
        gold,
        category: qa.category,
        key: `${dias[0] ?? ''}|${qa.question}`,
      })
    }
  }
  return pool
}

/** The candidate the judge sees for a generator result (abstain → the App C.2 sentinel). */
function candidateOf(row: JudgeEvalRow): string {
  if (row.genError) return '(generator error — dropped)'
  return row.answer
}

// ── smoke: prove the ACP plumbing end-to-end (cheap) ───────────────────────────────────────────
async function runSmoke(): Promise<void> {
  const q = 'What is the capital of France?'
  const gold = 'Paris'
  const ctx = 'Relevant SCNS memories:\nSpeaker A: The capital of France is Paris.'
  const gen = await generator.generate({ question: q, context: ctx, intent: 'ENTITY' })
  const pos = await judge.judge({ question: q, gold, candidate: gold, category: CAT.singleHop })
  const neg = await judge.judge({ question: q, gold, candidate: 'Berlin', category: CAT.singleHop })
  console.log(
    `SMOKE gen.answer=${JSON.stringify(gen.answer)} notFound=${gen.notFound} error=${!!gen.error}`,
  )
  console.log(`SMOKE judge pos(gold "Paris")=${pos.score}  neg("Berlin")=${neg.score}`)
  console.log(
    `RESULTS_JSON: ${JSON.stringify({
      mode: 'smoke',
      genAnswer: gen.answer,
      genError: !!gen.error,
      posScore: pos.score,
      negScore: neg.score,
      plumbingOk: !gen.error && pos.score >= 0 && neg.score >= 0,
    })}`,
  )
}

// ── R2 controls (+ human slice) ─────────────────────────────────────────────────────────────────
async function runControls(devSamples: readonly LocomoSample[]): Promise<void> {
  const pool = devPool(devSamples)
  const picked = pickPerCategory(
    pool,
    CONTROLS_N,
    (p) => p.category,
    (p) => p.key,
  )
  const { pos, neg } = buildControlPairs(
    picked.map((p) => ({ question: p.question, gold: p.gold, category: p.category })),
  )

  console.log(
    `\n=== R2 CONTROLS :: ${picked.length} items (${CONTROLS_N}/cat) → ${pos.length} pos + ${neg.length} neg judge spawns ===`,
  )
  const posScores: number[] = []
  for (const c of pos) {
    const v = await judge.judge({
      question: c.question,
      gold: c.gold,
      candidate: c.candidate,
      category: c.category,
    })
    posScores.push(v.score)
    console.log(
      `  POS [cat${c.category}] score=${v.score >= 0 ? r4(v.score) : 'NULL'}  gold=${JSON.stringify(c.gold).slice(0, 42)}`,
    )
  }
  const negScores: number[] = []
  for (const c of neg) {
    const v = await judge.judge({
      question: c.question,
      gold: c.gold,
      candidate: c.candidate,
      category: c.category,
    })
    negScores.push(v.score)
    console.log(
      `  NEG [cat${c.category}] score=${v.score >= 0 ? r4(v.score) : 'NULL'}  gold=${JSON.stringify(c.gold).slice(0, 28)} cand=${JSON.stringify(c.candidate).slice(0, 28)}`,
    )
  }
  const posOk = posScores.filter((s) => s >= 0)
  const negOk = negScores.filter((s) => s >= 0)
  const verdict = controlsVerdict(posOk, negOk, 0.3)
  console.log(
    `\n  pos mean = ${r4(verdict.posMean)} (n=${posOk.length}, dropped ${posScores.length - posOk.length})`,
  )
  console.log(
    `  neg mean = ${r4(verdict.negMean)} (n=${negOk.length}, dropped ${negScores.length - negOk.length})`,
  )
  console.log(
    `  separation (pos−neg) = ${r4(verdict.separation)}  ⇒ ${verdict.pass ? 'PASS ✓ (pos ≫ neg)' : 'FAIL ✗ (judge cannot separate right from wrong)'}`,
  )

  // Human-calibration slice (AWAITING-JOHN; non-blocking on R3/R4).
  const slice = buildHumanSlice(pool, HUMAN_SLICE_TARGET)
  mkdirSync(dirname(HUMAN_SLICE_PATH), { recursive: true })
  writeFileSync(HUMAN_SLICE_PATH, `${JSON.stringify(slice, null, 2)}\n`)
  const kinds = slice.reduce<Record<string, number>>(
    (a, s) => ((a[s.kind] = (a[s.kind] ?? 0) + 1), a),
    {},
  )
  console.log(
    `\n  human slice: ${slice.length} triples across cats {${[...new Set(slice.map((s) => s.category))].sort().join(',')}} kinds ${JSON.stringify(kinds)} → ${HUMAN_SLICE_PATH}`,
  )
  console.log(
    '  AWAITING-JOHN: add a "human_score" (0.0–1.0) to each triple; on return the harness computes judge↔human agreement.',
  )

  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'controls',
      posMean: r4(verdict.posMean),
      negMean: r4(verdict.negMean),
      separation: r4(verdict.separation),
      pass: verdict.pass,
      nPos: posOk.length,
      nNeg: negOk.length,
      posDropped: posScores.length - posOk.length,
      negDropped: negScores.length - negOk.length,
      humanSlicePath: HUMAN_SLICE_PATH,
      humanSliceN: slice.length,
    })}`,
  )
}

// ── R3 variance (judge test-retest σ + N) ────────────────────────────────────────────────────────
async function runVariance(devSamples: readonly LocomoSample[]): Promise<void> {
  const pool = devPool(devSamples)
  const frozen = buildHumanSlice(pool, R3_ITEMS) // mixed candidates spanning the [0,1] scale
  console.log(
    `\n=== R3 VARIANCE :: ${frozen.length} frozen triples × ${R3_RUNS} runs = ${frozen.length * R3_RUNS} judge spawns ===`,
  )
  const perItem: number[][] = []
  for (const t of frozen) {
    const scores: number[] = []
    for (let k = 0; k < R3_RUNS; k++) {
      const v = await judge.judge({
        question: t.question,
        gold: t.gold,
        candidate: t.candidate,
        category: t.category,
      })
      if (v.score >= 0) scores.push(v.score)
    }
    perItem.push(scores)
    const ci = meanCI(scores)
    console.log(
      `  [cat${t.category}/${t.kind}] n=${scores.length} mean=${r4(ci.mean)} sd=${r4(ci.sigma)} ci95=±${r4(ci.ci)}  scores=[${scores.map(r4).join(',')}]`,
    )
  }
  const sigma = pooledStddev(perItem)
  const N = nToResolveDelta(0.04, sigma)

  // "scorable-per-config" available on the DEV slice: min & max QA per category we could muster.
  const perCatCounts = new Map<number, number>()
  for (const p of pool) perCatCounts.set(p.category, (perCatCounts.get(p.category) ?? 0) + 1)
  const availPerCat = [...perCatCounts.values()]
  const minAvail = availPerCat.length ? Math.min(...availPerCat) : 0
  const maxAvail = availPerCat.length ? Math.max(...availPerCat) : 0

  console.log(`\n  pooled test-retest σ = ${r4(sigma)}`)
  console.log(`  N per arm to resolve a 4-pt (0.04) delta at σ=${r4(sigma)}, z=1.96: ${N}`)
  console.log(
    `  LoCoMo DEV scorable-per-category: min ${minAvail}, max ${maxAvail} (per-cat: ${[
      ...perCatCounts.entries(),
    ]
      .sort()
      .map(([c, n]) => `cat${c}=${n}`)
      .join(' ')})`,
  )
  const canResolve = Number.isFinite(N) && N <= maxAvail
  if (!canResolve) {
    console.log(
      `  FINDING: N=${N} per arm EXCEEDS LoCoMo's per-config scorable (max ${maxAvail}) ⇒ LoCoMo CANNOT resolve a 4-pt delta at this judge σ. Need LongMemEval / a bigger corpus before trusting any Phase-B delta of this size.`,
    )
  } else {
    console.log(
      `  N=${N} ≤ available ${maxAvail} ⇒ LoCoMo could resolve a 4-pt delta at this σ (still confirm with pos/neg controls + determinism).`,
    )
  }

  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'variance',
      pooledSigma: r4(sigma),
      nToResolve4pt: N,
      items: frozen.length,
      runs: R3_RUNS,
      minScorablePerCat: minAvail,
      maxScorablePerCat: maxAvail,
      canResolve4pt: canResolve,
      perItemMean: perItem.map((a) => r4(mean(a))),
      perItemSd: perItem.map((a) => r4(meanCI(a).sigma)),
    })}`,
  )
}

// ── R4 honest hybrid baseline (accuracy + tokens/query + latency, jointly) ────────────────────────
interface BaselineItem {
  readonly question: string
  readonly gold: string
  readonly category: number
  readonly key: string
  readonly vault: Vault
}

async function runBaseline(devSamples: readonly LocomoSample[]): Promise<void> {
  const vaults: Vault[] = []
  const scorable: BaselineItem[] = []
  console.log(
    `\n=== R4 BASELINE :: building ${devSamples.length} DEV vault(s) (real BGE) then ${BASELINE_N} QA/cat ===`,
  )
  for (const s of devSamples) {
    const turns = extractTurns(s.conversation, 0)
    if (turns.length === 0) continue
    const v = await buildVault(turns, SCNS_GAZETTEER)
    vaults.push(v)
    for (const qa of s.qa) {
      const gold = goldFor(qa)
      if (gold === '') continue
      const { gold: dias } = normalizeGold(qa.evidence ?? [])
      if (qa.category !== CAT.adversarial) {
        // factual cats: only score questions whose gold-evidence turns are actually ingested.
        if (dias.length === 0) continue
        if (!dias.every((d) => v.turnDiaSet.has(d))) continue
      }
      scorable.push({
        question: qa.question,
        gold,
        category: qa.category,
        key: `${dias[0] ?? ''}|${qa.question}`,
        vault: v,
      })
    }
  }
  const picked = pickPerCategory(
    scorable,
    BASELINE_N,
    (x) => x.category,
    (x) => x.key,
  )
  console.log(`  selected ${picked.length} items (per-cat: ${countByCat(picked)})`)

  const rows: JudgeEvalRow[] = []
  for (const item of picked) {
    const deps: JudgeEvalDeps = {
      retrieve: async (q) => {
        const r = await retrieveContext(
          item.vault.db,
          q,
          { intentRouting: false, topK: RETRIEVAL_TOPK, maxChars: RETRIEVAL_MAX_CHARS },
          {
            baseSearch: makeHybridBaseSearch(item.vault.db),
            makeSemanticRelevanceScorer: (qq) => makeSemanticRelevanceScorer(item.vault.db, qq),
          },
        )
        return { text: r.text, chunkIds: r.chunkIds }
      },
      intentOf: (q) => classifyIntent(q, SCNS_GAZETTEER),
      generator,
      judge,
    }
    const row = await evaluateItem(
      { question: item.question, gold: item.gold, category: item.category },
      deps,
    )
    rows.push(row)
    console.log(
      `  [cat${row.category}] score=${row.score >= 0 ? r4(row.score) : 'DROP'} tok≈${row.contextTokens} ${row.latencyMs}ms notFound=${row.notFound} genErr=${row.genError} ans=${JSON.stringify(candidateOf(row)).slice(0, 40)}`,
    )
  }

  const agg = aggregateAccuracy(rows)
  const scoredArr = rows.filter((r) => r.score >= 0).map((r) => r.score)
  const ci = meanCI(scoredArr)
  const meanLatency = mean(rows.map((r) => r.latencyMs))

  console.log(`\n  ── R4 honest hybrid baseline (intentRouting:false) ──`)
  console.log(
    `  meanScore = ${r4(agg.meanScore)} ± ${r4(ci.ci)} (95% CI)  over n=${agg.nScored} scored (${agg.nDropped} dropped)`,
  )
  console.log(
    `  meanContextTokens ≈ ${Math.round(agg.meanContextTokens)} (real o200k tokens) | meanLatency = ${Math.round(meanLatency)} ms/item`,
  )
  for (const c of [1, 2, 3, 4, 5]) {
    const b = agg.byCategory[c]
    if (b) console.log(`    cat${c}: n=${b.nScored} meanScore=${r4(b.meanScore)}`)
  }

  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'baseline',
      nScored: agg.nScored,
      nDropped: agg.nDropped,
      meanScore: r4(agg.meanScore),
      ci95: r4(ci.ci),
      meanContextTokens: Math.round(agg.meanContextTokens),
      meanLatencyMs: Math.round(meanLatency),
      byCategory: Object.fromEntries(
        Object.entries(agg.byCategory).map(([c, a]) => [
          c,
          { n: a.nScored, mean: r4(a.meanScore) },
        ]),
      ),
    })}`,
  )

  for (const v of vaults) rmSync(v.root, { recursive: true, force: true })
}

// ── M2 armb: PAIRED Arm A (hybrid) vs Arm B (event+causal) on the SAME items ─────────────────────
// The ONLY variable across arms is the retrieval config (intentRouting false→true + event/causal
// ingestion between the two passes). Held CONSTANT: generator+judge model, DEV slice, per-conversation
// vaults, token budget (topK/maxChars), and the ORACLE gazetteer (B3.4 — the WHERE entity=? WHY read is
// gazetteer-anchored). Both arms score the identical `picked` list in the same order ⇒ a matched-pair Δ.
// SCNS_M2_MAX_CANDIDATES un-capped from the fable5-era 20 to 200 (research R3 / T025): the causal ingest
// now judges candidates in ≤20-pair chunks (createAcpCausalProvider batchSize) so a larger pool is wall-safe
// and the substrate can reach the density floor. Still env-overridable for sweeps.
const M2_MAX_CANDIDATES = Number(process.env.SCNS_M2_MAX_CANDIDATES ?? '200') || 200
// Causal-edge confidence gate, env-overridable so the reproduction run can sweep {0.5,0.6,0.7} (research
// R3 / T025) without a code change. Default 0.7 (persistCausalEdges DEFAULT_MIN_CONFIDENCE) — unchanged.
const M2_MIN_CONFIDENCE = Number(process.env.SCNS_M2_MIN_CONFIDENCE ?? '0.7') || 0.7
const M2_CAUSAL_ATTEMPT_MS = Number(process.env.SCNS_M2_CAUSAL_ATTEMPT_MS ?? '300000') || 300000
const M2_N_DEFAULT = Number(process.env.SCNS_M2_N_DEFAULT ?? String(BASELINE_N)) || BASELINE_N
const M2_N_WHY = Number(process.env.SCNS_M2_N_WHY ?? String(M2_N_DEFAULT)) || M2_N_DEFAULT
/** WHY-relevant categories (multi-hop, temporal — where causal edges should help) get the oversample cap. */
const m2CapForCat = (c: number): number =>
  c === CAT.multihop || c === CAT.temporal ? M2_N_WHY : M2_N_DEFAULT

// ── whyeval Arm B = the FAITHFUL MAGMA Alg-1 beam (S1–S3). Depth/budget default to the paper's 5/200
// (adaptive-traversal.ts module defaults are 3/60, tuned for a small curated vault). Overridable for tuning. ──
const WHY_BEAM_MAX_DEPTH = Number(process.env.SCNS_WHY_BEAM_MAX_DEPTH ?? '5') || 5
const WHY_BEAM_BUDGET = Number(process.env.SCNS_WHY_BEAM_BUDGET ?? '200') || 200
// B-EXPLORE §7b — ε-router exploration params for the `arm-explore` offline mode (deterministic seed ⇒ det×2).
const EXPLORE_EPSILON = Number(process.env.SCNS_EXPLORE_EPSILON ?? '0.1') || 0.1
const EXPLORE_SEED = Number(process.env.SCNS_EXPLORE_SEED ?? '1337') || 1337

/** A fresh isolated deny-all spawn cwd under the run's ISO dir (never the checkout). */
function mkIso(): string {
  return mkdtempSync(join(ISO, 'iso-'))
}

interface ArmBItem {
  readonly question: string
  readonly gold: string
  readonly category: number
  readonly key: string
  readonly convIdx: number
}
interface ConvRecord {
  readonly sample: LocomoSample
  readonly vault: Vault
  readonly gaz: readonly GazetteerEntry[]
  ingested?: Awaited<ReturnType<typeof ingestConversationEventNodes>>
  /** Materialized chunk→chunk causal `memory_edges` (Stage-4 topo-order input). Set by fresh ingest OR
   *  restored from the snapshot manifest on reuse — the HARD PRE-CHECK reads this on both paths. */
  materialized?: number
  /** Persisted `memory_causal` rows (confidence-gated). Fresh-ingest or manifest-restored. */
  persisted?: number
}

/** Score one picked item under a given retrieval config; also surfaces the retrieved text + intent. */
async function scoreItem(
  item: ArmBItem,
  conv: ConvRecord,
  arm: Pick<
    RetrievalContextConfig,
    | 'intentRouting'
    | 'traverse'
    | 'traversalOptions'
    | 'synthesize'
    | 'multiHop'
    | 'multiHopOptions'
    | 'maxTokens'
    | 'returnBudget'
    | 'maxChars'
  >,
  explore?: { readonly exploreArm: string; readonly propensity: number },
): Promise<{ row: JudgeEvalRow; text: string; intent: string }> {
  const store = getHarnessStore()
  let text = ''
  let intent = ''
  let experienceId: number | undefined
  const deps: JudgeEvalDeps = {
    retrieve: async (q) => {
      const r = await retrieveContext(
        conv.vault.db,
        q,
        { ...arm, topK: RETRIEVAL_TOPK, maxChars: arm.maxChars ?? RETRIEVAL_MAX_CHARS },
        {
          gazetteer: conv.gaz,
          baseSearch: makeHybridBaseSearch(conv.vault.db),
          makeSemanticRelevanceScorer: (qq) => makeSemanticRelevanceScorer(conv.vault.db, qq),
          ...(store
            ? {
                experienceLog: {
                  store,
                  // §7b: when the ε-router explored, stamp explore_arm + propensity onto the row for
                  // later off-policy correction; otherwise a plain (exploit) episode.
                  episode: {
                    conversationId: conv.sample.sample_id,
                    category: item.category,
                    ...(explore
                      ? {
                          exploreArm: explore.exploreArm,
                          epsilon: EXPLORE_EPSILON,
                          propensity: explore.propensity,
                        }
                      : {}),
                  },
                },
              }
            : {}),
        },
      )
      text = r.text
      intent = r.intent
      experienceId = r.experienceId
      return { text: r.text, chunkIds: r.chunkIds }
    },
    // intentOf held CONSTANT across arms (same oracle gaz) ⇒ the generator instruction is identical;
    // ONLY the retrieved context differs.
    intentOf: (q) => classifyIntent(q, conv.gaz),
    generator,
    judge,
  }
  const row = await evaluateItem(
    { question: item.question, gold: item.gold, category: item.category },
    deps,
  )
  // Phase B — SETTLE the post-hoc judge outcome onto the row this item's retrieval logged (offline only).
  if (store && experienceId !== undefined) {
    settleRetrievalExperience(store, experienceId, {
      genAnswer: row.answer,
      judgeScore: row.judgeNull ? null : row.score,
      dropped: row.score < 0,
      tokens: row.contextTokens,
      latencyMs: row.latencyMs,
    })
  }
  return { row, text, intent }
}

async function runArmB(devSamples: readonly LocomoSample[]): Promise<void> {
  if (!isConversationEventExtractEnabled(process.env) || process.env[CAUSAL_ACP_ENV] !== '1') {
    throw new Error(
      `armb mode also requires ${CONVERSATION_EVENT_ACP_ENV}=1 AND ${CAUSAL_ACP_ENV}=1 (real event+causal ingestion)`,
    )
  }
  const convs: ConvRecord[] = []
  const scorable: ArmBItem[] = []
  console.log(
    `\n=== M2 ARMB :: ${devSamples.length} DEV vault(s) (real BGE, ORACLE gaz) ; N/cat why=${M2_N_WHY} other=${M2_N_DEFAULT} ; maxCand=${M2_MAX_CANDIDATES} causalMs=${M2_CAUSAL_ATTEMPT_MS} ===`,
  )
  for (const s of devSamples) {
    const turns = extractTurns(s.conversation, 0)
    if (turns.length === 0) continue
    const gaz = oracleGazetteer(s, turns)
    const vault = await buildVault(turns, gaz)
    const convIdx = convs.length
    convs.push({ sample: s, vault, gaz })
    for (const qa of s.qa) {
      const gold = goldFor(qa)
      if (gold === '') continue
      const { gold: dias } = normalizeGold(qa.evidence ?? [])
      if (qa.category !== CAT.adversarial) {
        if (dias.length === 0) continue
        if (!dias.every((d) => vault.turnDiaSet.has(d))) continue
      }
      scorable.push({
        question: qa.question,
        gold,
        category: qa.category,
        key: `${dias[0] ?? ''}|${qa.question}`,
        convIdx,
      })
    }
  }
  const picked = pickPerCategory(
    scorable,
    m2CapForCat,
    (x) => x.category,
    (x) => x.key,
  )
  console.log(`  selected ${picked.length} items (per-cat: ${countByCat(picked)})`)

  // ── Arm A pass (pristine vaults, intentRouting:false = hybrid) ──
  console.log(`\n  ── Arm A (hybrid, intentRouting:false) ──`)
  const armARows: JudgeEvalRow[] = []
  const armAText: string[] = []
  for (const item of picked) {
    const { row, text } = await scoreItem(item, convs[item.convIdx]!, { intentRouting: false })
    armARows.push(row)
    armAText.push(text)
    console.log(
      `  A[cat${row.category}] score=${row.score >= 0 ? r4(row.score) : 'DROP'} tok≈${row.contextTokens} ${row.latencyMs}ms`,
    )
  }

  // ── Ingest pass (ONCE per conversation: event nodes + real deny-all causal judge, capped batch) ──
  console.log(`\n  ── Ingest (event + causal) per conversation ──`)
  for (const conv of convs) {
    const ingest = await ingestConversationEventNodes(conv.vault.db, conv.sample.conversation, {
      extractor: createAcpConversationEventExtractor({
        cwd: mkIso(),
        createClient: trackingCreate,
      }),
      gazetteer: conv.gaz,
      rebuildEdges: true,
      buildSemantic: true,
      env: { [CAUSAL_ACP_ENV]: '1' },
      makeAcpProvider: () =>
        createAcpCausalProvider({
          cwd: mkIso(),
          attemptTimeoutMs: M2_CAUSAL_ATTEMPT_MS,
          createClient: trackingCreate,
        }),
      minConfidence: M2_MIN_CONFIDENCE,
      maxCandidates: M2_MAX_CANDIDATES,
    })
    conv.ingested = ingest
    console.log(
      `  [${conv.sample.sample_id}] segmented=${ingest.segmented} dated=${ingest.datedEpisodes} eventCand=${ingest.eventCausalCandidates} chunkCand=${ingest.chunkCausalCandidates} persisted=${ingest.causal.persisted} materialized=${ingest.causal.materialized}`,
    )
  }

  // ── Arm B pass (ingested vaults, intentRouting:true = entity-anchored WHY read over causal edges) ──
  console.log(`\n  ── Arm B (event+causal, intentRouting:true) ──`)
  const armBRows: JudgeEvalRow[] = []
  let ctxDiffered = 0
  const intentCounts = new Map<string, number>()
  for (let i = 0; i < picked.length; i++) {
    const { row, text, intent } = await scoreItem(picked[i]!, convs[picked[i]!.convIdx]!, {
      intentRouting: true,
    })
    armBRows.push(row)
    intentCounts.set(intent, (intentCounts.get(intent) ?? 0) + 1)
    if (text !== armAText[i]) ctxDiffered++
    console.log(
      `  B[cat${row.category}] score=${row.score >= 0 ? r4(row.score) : 'DROP'} tok≈${row.contextTokens} ${row.latencyMs}ms intent=${intent} ctxΔ=${text !== armAText[i]}`,
    )
  }

  // ── aggregate + paired delta ──
  const aggA = aggregateAccuracy(armARows)
  const aggB = aggregateAccuracy(armBRows)
  const ciA = meanCI(armARows.filter((r) => r.score >= 0).map((r) => r.score))
  const ciB = meanCI(armBRows.filter((r) => r.score >= 0).map((r) => r.score))
  const paired = pairedDeltas(armARows, armBRows)
  const latA = mean(armARows.map((r) => r.latencyMs))
  const latB = mean(armBRows.map((r) => r.latencyMs))
  const aboveSigma = Math.abs(paired.meanDelta) > JUDGE_SIGMA

  console.log(`\n  ── M2 paired result (σ_judge = ${JUDGE_SIGMA}) ──`)
  console.log(
    `  Arm A: mean=${r4(aggA.meanScore)} ± ${r4(ciA.ci)}  n=${aggA.nScored} (${aggA.nDropped} dropped)  tok≈${Math.round(aggA.meanContextTokens)}  lat=${Math.round(latA)}ms`,
  )
  console.log(
    `  Arm B: mean=${r4(aggB.meanScore)} ± ${r4(ciB.ci)}  n=${aggB.nScored} (${aggB.nDropped} dropped)  tok≈${Math.round(aggB.meanContextTokens)}  lat=${Math.round(latB)}ms`,
  )
  console.log(
    `  paired Δ(B−A) = ${r4(paired.meanDelta)} ± ${r4(paired.ciDelta)}  over n=${paired.n} matched pairs  ⇒ ${aboveSigma ? 'ABOVE σ (inspect tokens)' : 'WITHIN σ ⇒ measured NULL (success)'}`,
  )
  console.log(
    `  intent-diff: ${ctxDiffered}/${picked.length} items had Arm-B ctx ≠ Arm-A ctx  intents=${JSON.stringify(Object.fromEntries(intentCounts))}`,
  )
  for (const c of [1, 2, 3, 4, 5]) {
    const pc = paired.byCategory[c]
    if (pc)
      console.log(
        `    cat${c}: n=${pc.n} A=${r4(pc.meanA)} B=${r4(pc.meanB)} Δ=${r4(pc.meanDelta)}`,
      )
  }

  const nodeQuality = convs.map((c) => ({
    sampleId: c.sample.sample_id,
    segmented: c.ingested?.segmented,
    datedEpisodes: c.ingested?.datedEpisodes,
    eventCausalCandidates: c.ingested?.eventCausalCandidates,
    chunkCausalCandidates: c.ingested?.chunkCausalCandidates,
    persisted: c.ingested?.causal.persisted,
    materialized: c.ingested?.causal.materialized,
    sampleEventNodes: listEventNodes(c.vault.db, 6).map((n) => n.content),
  }))
  const byCatJson = (agg: ReturnType<typeof aggregateAccuracy>) =>
    Object.fromEntries(
      Object.entries(agg.byCategory).map(([c, a]) => [c, { n: a.nScored, mean: r4(a.meanScore) }]),
    )

  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'armb',
      dev: devSamples.length,
      nWhy: M2_N_WHY,
      nOther: M2_N_DEFAULT,
      maxCandidates: M2_MAX_CANDIDATES,
      causalAttemptMs: M2_CAUSAL_ATTEMPT_MS,
      armA: {
        meanScore: r4(aggA.meanScore),
        ci95: r4(ciA.ci),
        nScored: aggA.nScored,
        nDropped: aggA.nDropped,
        meanTok: Math.round(aggA.meanContextTokens),
        meanLatencyMs: Math.round(latA),
        byCategory: byCatJson(aggA),
      },
      armB: {
        meanScore: r4(aggB.meanScore),
        ci95: r4(ciB.ci),
        nScored: aggB.nScored,
        nDropped: aggB.nDropped,
        meanTok: Math.round(aggB.meanContextTokens),
        meanLatencyMs: Math.round(latB),
        byCategory: byCatJson(aggB),
      },
      paired: {
        meanDelta: r4(paired.meanDelta),
        ciDelta: r4(paired.ciDelta),
        n: paired.n,
        aboveSigma,
        byCategory: Object.fromEntries(
          Object.entries(paired.byCategory).map(([c, p]) => [
            c,
            { n: p.n, meanA: r4(p.meanA), meanB: r4(p.meanB), meanDelta: r4(p.meanDelta) },
          ]),
        ),
      },
      intentDiff: { ctxDiffered, total: picked.length, intents: Object.fromEntries(intentCounts) },
      nodeQuality,
    })}`,
  )

  for (const c of convs) rmSync(c.vault.root, { recursive: true, force: true })
}

// ── whyeval: the causal-subspace answer-value probe (20 authored WHY Qs that DO fire the WHY route) ──
// Mirrors runArmB's paired A/B machinery EXACTLY (same scoreItem, ingest, pairedDeltas, aggregate,
// spawn-PID tracker, ISO cleanup, live-vault assert) — the ONLY differences are: (1) the item source is
// WHY_EVAL_QUESTIONS grouped by sampleId (NO pickPerCategory — every authored item is scored), (2) after
// ingest a read-only per-anchor `causalNeighborhood` dump surfaces which anchors actually got persisted
// edges (the SPARSITY finding), and (3) it emits a by-item table, a per-anchor Δ, and a fired-subset Δ over
// only the ctxΔ=true items (where the beam's context differed). Arm A = intentRouting:false (hybrid); Arm B =
// the FAITHFUL Alg-1 beam (traverse:true, depth/budget 5/200). The single ingest runs ONCE UP FRONT so BOTH
// arms score the IDENTICAL post-ingest vault (corpus symmetry — the only A/B difference is the beam).
interface WhyItem extends ArmBItem {
  readonly anchor: string
  readonly sampleId: string
}

async function runWhyEval(devSamples: readonly LocomoSample[]): Promise<void> {
  if (!isConversationEventExtractEnabled(process.env) || process.env[CAUSAL_ACP_ENV] !== '1') {
    throw new Error(
      `whyeval mode also requires ${CONVERSATION_EVENT_ACP_ENV}=1 AND ${CAUSAL_ACP_ENV}=1 (real event+causal ingestion)`,
    )
  }
  console.log(
    `\n=== WHYEVAL :: ${devSamples.length} DEV vault(s) (real BGE, ORACLE gaz) ; ${WHY_EVAL_QUESTIONS.length} authored WHY Qs ; maxCand=${M2_MAX_CANDIDATES} causalMs=${M2_CAUSAL_ATTEMPT_MS} ===`,
  )

  // Build one isolated ORACLE-gaz vault per DEV conversation (identical machinery to armb).
  const convs: ConvRecord[] = []
  const convIdxBySample = new Map<string, number>()
  for (const s of devSamples) {
    const turns = extractTurns(s.conversation, 0)
    if (turns.length === 0) continue
    const gaz = oracleGazetteer(s, turns)
    const vault = await buildVault(turns, gaz)
    convIdxBySample.set(s.sample_id, convs.length)
    convs.push({ sample: s, vault, gaz })
  }

  // Attach each authored WHY question to its conversation's vault (grouped by sampleId; NO pickPerCategory).
  // Defensive build guard (the unit test is the primary): every stem must classify WHY + name its anchor.
  const items: WhyItem[] = []
  for (const [sampleId, qs] of groupWhyQuestionsBySample(WHY_EVAL_QUESTIONS)) {
    const convIdx = convIdxBySample.get(sampleId)
    if (convIdx === undefined) {
      throw new Error(
        `whyeval: sample '${sampleId}' not in the DEV slice (raise SCNS_LOCOMO_DEV_CONV to cover it)`,
      )
    }
    const issues = validateWhyEvalQuestions(qs, convs[convIdx]!.gaz)
    if (issues.length > 0) {
      throw new Error(
        `whyeval: ${issues.length} malformed question(s) for ${sampleId}: ${JSON.stringify(issues)}`,
      )
    }
    for (const q of qs) {
      items.push({
        question: q.question,
        gold: q.gold,
        category: q.category,
        key: `${q.anchor}|${q.question}`,
        convIdx,
        anchor: q.anchor,
        sampleId,
      })
    }
  }
  console.log(
    `  attached ${items.length} WHY items across ${convs.length} conv(s) (per-anchor: ${countByAnchor(items)})`,
  )

  // ── Ingest pass FIRST — ONCE per conversation (event nodes + real deny-all causal judge, capped batch).
  // CORPUS SYMMETRY (MAGMA Table-4 fidelity): event nodes are written as SEARCHABLE chunks (event-nodes.ts),
  // so ingest MUST precede BOTH arms — else Arm A (hybrid) would score the pre-ingest corpus while Arm B (beam)
  // scores the enriched one, confounding Δ with corpus enrichment. Both arms score the IDENTICAL post-ingest
  // vault below; the ONLY A/B difference is traverse:true → the Adaptive Policy beam. ──
  console.log(
    `\n  ── Ingest (event + causal) per conversation [BEFORE both arms — corpus symmetry] ──`,
  )
  for (const conv of convs) {
    const ingest = await ingestConversationEventNodes(conv.vault.db, conv.sample.conversation, {
      extractor: createAcpConversationEventExtractor({
        cwd: mkIso(),
        createClient: trackingCreate,
      }),
      gazetteer: conv.gaz,
      rebuildEdges: true,
      buildSemantic: true,
      env: { [CAUSAL_ACP_ENV]: '1' },
      makeAcpProvider: () =>
        createAcpCausalProvider({
          cwd: mkIso(),
          attemptTimeoutMs: M2_CAUSAL_ATTEMPT_MS,
          createClient: trackingCreate,
        }),
      minConfidence: M2_MIN_CONFIDENCE,
      maxCandidates: M2_MAX_CANDIDATES,
    })
    conv.ingested = ingest
    console.log(
      `  [${conv.sample.sample_id}] segmented=${ingest.segmented} dated=${ingest.datedEpisodes} eventCand=${ingest.eventCausalCandidates} chunkCand=${ingest.chunkCausalCandidates} persisted=${ingest.causal.persisted} materialized=${ingest.causal.materialized}`,
    )
  }

  // ── PRE-CHECK (beam input): the Alg-1 causal beam walks chunk→chunk `memory_edges(edge_type='causal')`,
  // which only exist where materializeCausalEdges resolved BOTH cause+effect to live chunks. If this is 0 the
  // beam sees NO causal edges (outcome-only edges stay in memory_causal, invisible to it) ⇒ any Δ is a NULL,
  // not a MAGMA verdict. Reported loudly; materialized>0 is a HARD input to the fired-gate below. ──
  const totalMaterialized = convs.reduce((a, c) => a + (c.ingested?.causal.materialized ?? 0), 0)
  const totalPersisted = convs.reduce((a, c) => a + (c.ingested?.causal.persisted ?? 0), 0)
  console.log(
    `\n  ── PRE-CHECK (beam causal input) ──\n  materialized chunk→chunk causal memory_edges = ${totalMaterialized} (persisted memory_causal = ${totalPersisted}) ⇒ ${totalMaterialized > 0 ? 'OK — beam has causal edges to walk ✓' : 'STOP — beam sees NO causal edges; treat any Δ as NULL ✗'}`,
  )

  // ── Per-anchor causalNeighborhood dump (read-only) — the SPARSITY finding: which anchors got edges ──
  console.log(`\n  ── Per-anchor causal neighborhood (read-only) ──`)
  interface AnchorEdgeDump {
    readonly anchor: string
    readonly sampleId: string
    readonly edgeCount: number
    readonly rationales: string[]
  }
  const anchorEdges: AnchorEdgeDump[] = []
  for (const conv of convs) {
    const convIdx = convIdxBySample.get(conv.sample.sample_id)!
    const anchors = [
      ...new Set(items.filter((it) => it.convIdx === convIdx).map((it) => it.anchor)),
    ]
    for (const anchor of anchors) {
      const chains = causalNeighborhood(conv.vault.db, anchor, { gazetteer: conv.gaz })
      const rationales = chains.map((c) => (c.rationale ?? '').trim()).filter((r) => r !== '')
      anchorEdges.push({
        anchor,
        sampleId: conv.sample.sample_id,
        edgeCount: chains.length,
        rationales,
      })
      console.log(
        `  [${conv.sample.sample_id} · ${anchor}] edges=${chains.length}${rationales.length ? ` rationales=${JSON.stringify(rationales.slice(0, 3))}` : ''}`,
      )
    }
  }
  const totalAnchorEdges = anchorEdges.reduce((a, e) => a + e.edgeCount, 0)
  const anchorsWithEdges = anchorEdges.filter((e) => e.edgeCount > 0).length

  // ── Arm A pass (POST-ingest vault, intentRouting:false = hybrid). Scores the SAME enriched corpus Arm B
  // sees (event chunks + causal edges present) so the ONLY A/B difference is the Adaptive Policy beam. ──
  console.log(`\n  ── Arm A (hybrid, intentRouting:false) [post-ingest — same vault as Arm B] ──`)
  const armARows: JudgeEvalRow[] = []
  const armAText: string[] = []
  for (const item of items) {
    const { row, text } = await scoreItem(item, convs[item.convIdx]!, { intentRouting: false })
    armARows.push(row)
    armAText.push(text)
    console.log(
      `  A[${item.anchor}] score=${row.score >= 0 ? r4(row.score) : 'DROP'} tok≈${row.contextTokens} ${row.latencyMs}ms`,
    )
  }

  // ── Arm B pass (SAME post-ingest vault, traverse:true = the FAITHFUL Alg-1 beam over the typed-edge graph,
  // incl. materialized causal edges — NOT the superseded single-hop binary WHY-router). ──
  console.log(
    `\n  ── Arm B (FAITHFUL beam — MAGMA Alg-1 S1–S3; traverse, depth/budget=${WHY_BEAM_MAX_DEPTH}/${WHY_BEAM_BUDGET}) ──`,
  )
  const armBRows: JudgeEvalRow[] = []
  const armBIntents: string[] = []
  const ctxDiffered: boolean[] = []
  const intentCounts = new Map<string, number>()
  for (let i = 0; i < items.length; i++) {
    const { row, text, intent } = await scoreItem(items[i]!, convs[items[i]!.convIdx]!, {
      intentRouting: false,
      traverse: true,
      traversalOptions: { maxDepth: WHY_BEAM_MAX_DEPTH, budget: WHY_BEAM_BUDGET },
    })
    armBRows.push(row)
    armBIntents.push(intent)
    intentCounts.set(intent, (intentCounts.get(intent) ?? 0) + 1)
    const differed = text !== armAText[i]
    ctxDiffered.push(differed)
    console.log(
      `  B[${items[i]!.anchor}] score=${row.score >= 0 ? r4(row.score) : 'DROP'} tok≈${row.contextTokens} ${row.latencyMs}ms intent=${intent} ctxΔ=${differed}`,
    )
  }
  const nCtxDiffered = ctxDiffered.filter(Boolean).length
  const whyCount = intentCounts.get('WHY') ?? 0

  // ── aggregate + paired delta (overall) ──
  const aggA = aggregateAccuracy(armARows)
  const aggB = aggregateAccuracy(armBRows)
  const ciA = meanCI(armARows.filter((r) => r.score >= 0).map((r) => r.score))
  const ciB = meanCI(armBRows.filter((r) => r.score >= 0).map((r) => r.score))
  const paired = pairedDeltas(armARows, armBRows)
  const latA = mean(armARows.map((r) => r.latencyMs))
  const latB = mean(armBRows.map((r) => r.latencyMs))
  const aboveSigma = Math.abs(paired.meanDelta) > JUDGE_SIGMA

  // ── by-item table ──
  interface ByItem {
    readonly anchor: string
    readonly question: string
    readonly scoreA: number
    readonly scoreB: number
    readonly delta: number | null
    readonly intent: string
    readonly ctxDiffered: boolean
    readonly tokA: number
    readonly tokB: number
  }
  const byItem: ByItem[] = items.map((it, i) => {
    const a = armARows[i]!
    const b = armBRows[i]!
    const both = a.score >= 0 && b.score >= 0
    return {
      anchor: it.anchor,
      question: it.question,
      scoreA: r4(a.score),
      scoreB: r4(b.score),
      delta: both ? r4(b.score - a.score) : null,
      intent: armBIntents[i]!,
      ctxDiffered: ctxDiffered[i]!,
      tokA: a.contextTokens,
      tokB: b.contextTokens,
    }
  })

  // ── per-anchor Δ (paired over that anchor's items where BOTH arms graded) ──
  interface AnchorDelta {
    readonly anchor: string
    readonly n: number
    readonly meanA: number
    readonly meanB: number
    readonly meanDelta: number
    readonly ciDelta: number
  }
  const anchorOrder = [...new Set(items.map((it) => it.anchor))]
  const perAnchorDelta: AnchorDelta[] = anchorOrder.map((anchor) => {
    const idx = items.map((it, i) => (it.anchor === anchor ? i : -1)).filter((i) => i >= 0)
    const pa = pairedDeltas(
      idx.map((i) => armARows[i]!),
      idx.map((i) => armBRows[i]!),
    )
    return {
      anchor,
      n: pa.n,
      meanA: r4(pa.meanA),
      meanB: r4(pa.meanB),
      meanDelta: r4(pa.meanDelta),
      ciDelta: r4(pa.ciDelta),
    }
  })

  // ── fired-subset Δ (ONLY items where a causal chain was actually read: ctxΔ=true) ──
  const firedIdx = ctxDiffered.map((d, i) => (d ? i : -1)).filter((i) => i >= 0)
  const firedPaired = pairedDeltas(
    firedIdx.map((i) => armARows[i]!),
    firedIdx.map((i) => armBRows[i]!),
  )

  // ── FIRED-GATE (durable plan §d): a valid BEAM measurement needs WHY=all items, the beam's context to
  // actually differ from hybrid (ctxΔ>0), AND materialized causal edges for the beam to walk (its real input;
  // totalAnchorEdges is the independent single-hop causalNeighborhood sanity reference, not the beam's reader). ──
  const firedGate = whyCount === items.length && nCtxDiffered > 0 && totalMaterialized > 0

  console.log(`\n  ── WHYEVAL paired result (σ_judge = ${JUDGE_SIGMA}) ──`)
  console.log(
    `  Arm A: mean=${r4(aggA.meanScore)} ± ${r4(ciA.ci)}  n=${aggA.nScored} (${aggA.nDropped} dropped)  tok≈${Math.round(aggA.meanContextTokens)}  lat=${Math.round(latA)}ms`,
  )
  console.log(
    `  Arm B: mean=${r4(aggB.meanScore)} ± ${r4(ciB.ci)}  n=${aggB.nScored} (${aggB.nDropped} dropped)  tok≈${Math.round(aggB.meanContextTokens)}  lat=${Math.round(latB)}ms`,
  )
  console.log(
    `  paired Δ(B−A) = ${r4(paired.meanDelta)} ± ${r4(paired.ciDelta)}  over n=${paired.n} matched pairs  ⇒ ${aboveSigma ? 'ABOVE σ (inspect tokens)' : 'WITHIN σ ⇒ measured NULL (success)'}`,
  )
  console.log(
    `  fired-subset Δ(B−A) = ${r4(firedPaired.meanDelta)} ± ${r4(firedPaired.ciDelta)}  over n=${firedPaired.n} ctxΔ=true pairs`,
  )
  console.log(
    `  intent-diff: WHY=${whyCount}/${items.length} ; ctxΔ ${nCtxDiffered}/${items.length} items had Arm-B ctx ≠ Arm-A ctx  intents=${JSON.stringify(Object.fromEntries(intentCounts))}`,
  )
  console.log(
    `  per-anchor edges READ: ${anchorsWithEdges}/${anchorEdges.length} anchors fired ; total edges=${totalAnchorEdges}`,
  )
  console.log(
    `  FIRED-GATE: ${firedGate ? `PASS ✓ (WHY=all + ctxΔ + materialized=${totalMaterialized} causal edges)` : `NULL ✗ (WHY=${whyCount}/${items.length}, ctxΔ=${nCtxDiffered}, materialized=${totalMaterialized} ⇒ treat Δ as NULL)`}`,
  )
  for (const pa of perAnchorDelta)
    console.log(`    ${pa.anchor}: n=${pa.n} A=${pa.meanA} B=${pa.meanB} Δ=${pa.meanDelta}`)

  const nodeQuality = convs.map((c) => ({
    sampleId: c.sample.sample_id,
    segmented: c.ingested?.segmented,
    datedEpisodes: c.ingested?.datedEpisodes,
    eventCausalCandidates: c.ingested?.eventCausalCandidates,
    chunkCausalCandidates: c.ingested?.chunkCausalCandidates,
    persisted: c.ingested?.causal.persisted,
    materialized: c.ingested?.causal.materialized,
    sampleEventNodes: listEventNodes(c.vault.db, 6).map((n) => n.content),
  }))
  const byCatJson = (agg: ReturnType<typeof aggregateAccuracy>) =>
    Object.fromEntries(
      Object.entries(agg.byCategory).map(([c, a]) => [c, { n: a.nScored, mean: r4(a.meanScore) }]),
    )

  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'whyeval',
      armBMode: 'faithful-beam-S1-3',
      beam: { maxDepth: WHY_BEAM_MAX_DEPTH, budget: WHY_BEAM_BUDGET },
      preCheck: { materialized: totalMaterialized, persisted: totalPersisted },
      judgeSigmaUsed: JUDGE_SIGMA,
      controls: {
        corpusSymmetry:
          'both arms scored on the IDENTICAL post-ingest vault (event chunks + causal edges present for both); the ONLY A/B difference is traverse:true → the Adaptive Policy beam (MAGMA Table-4 ablation)',
        firedSubsetBeamAttributable:
          'ctxΔ=true items = where the beam changed the retrieved context vs hybrid on the SAME corpus (attribute a positive Δ to the beam only here)',
      },
      confounds: [
        'MAGMA Stage-4 narrative synthesis (topological order + <ref:id> provenance + salience token budget) ABSENT on every path ⇒ token-efficiency axis EXCLUDED from this verdict',
        'transition us*ew*decay is a linearized surrogate, not literal exp(λ1·φ+λ2·sim) (Eq. 5); OSS also linearizes',
      ],
      dev: devSamples.length,
      nItems: items.length,
      maxCandidates: M2_MAX_CANDIDATES,
      causalAttemptMs: M2_CAUSAL_ATTEMPT_MS,
      armA: {
        meanScore: r4(aggA.meanScore),
        ci95: r4(ciA.ci),
        nScored: aggA.nScored,
        nDropped: aggA.nDropped,
        meanTok: Math.round(aggA.meanContextTokens),
        meanLatencyMs: Math.round(latA),
        byCategory: byCatJson(aggA),
      },
      armB: {
        meanScore: r4(aggB.meanScore),
        ci95: r4(ciB.ci),
        nScored: aggB.nScored,
        nDropped: aggB.nDropped,
        meanTok: Math.round(aggB.meanContextTokens),
        meanLatencyMs: Math.round(latB),
        byCategory: byCatJson(aggB),
      },
      paired: {
        meanDelta: r4(paired.meanDelta),
        ciDelta: r4(paired.ciDelta),
        n: paired.n,
        aboveSigma,
      },
      firedSubset: {
        meanDelta: r4(firedPaired.meanDelta),
        ciDelta: r4(firedPaired.ciDelta),
        n: firedPaired.n,
      },
      intentDiff: {
        why: whyCount,
        ctxDiffered: nCtxDiffered,
        total: items.length,
        intents: Object.fromEntries(intentCounts),
      },
      firedGate,
      perAnchorEdges: anchorEdges,
      perAnchorDelta,
      byItem,
      nodeQuality,
    })}`,
  )

  for (const c of convs) rmSync(c.vault.root, { recursive: true, force: true })
}

// ── frontier (MAGMA Stage-4 / Eq-7) — the token-efficiency + accuracy GATE, RESTRUCTURED into three
// snapshot-sharing sub-modes so the expensive ingest happens exactly ONCE (see the SCNS_FRONTIER_SNAPSHOT
// block above):
//   frontier-ingest   — build a real-BGE ORACLE-gaz vault + ACP event/causal ingest per DEV conversation,
//                       then SNAPSHOT each vault.db (+ a manifest of the PRE-CHECK counts). ACP-heavy; ONCE.
//   frontier-tokens   — DETERMINISTIC REAL-token (o200k) Δtok frontier S4-OFF vs S4-ON over the shared
//                       snapshot. NO judge/gen spawns ⇒ the fast headline (MAGMA Table-3 efficiency),
//                       reported vs a full-context baseline with compression attribution.
//   frontier-accuracy — economical PAIRED S4-OFF vs S4-ON JUDGED accuracy over the SAME snapshot, reusing a
//                       pinned σ (SCNS_JUDGE_SIGMA). Expect a NULL (|Δacc| < σ). det×2 = re-run on the SAME
//                       snapshot (JUDGING only — never re-ingest).
// Both downstream sub-modes ISOLATE Stage-4 (intentRouting:false + beam OFF held constant; only synthesize
// differs over the IDENTICAL deterministic retrieved set) and keep the HARD PRE-CHECK (materialized>0 ⇒
// Eq-7 has real causal chains to topo-order). The token counter is REAL o200k (countTokens), never chars/4.

interface FrontierManifest {
  readonly createdAt: string
  readonly dev: number
  readonly sampleIds: readonly string[] // index = convIdx
  readonly materialized: readonly number[] // per conv — materialized chunk→chunk causal memory_edges
  readonly persisted: readonly number[] // per conv — persisted memory_causal rows
  readonly totalMaterialized: number
  readonly totalPersisted: number
}

/** The event+causal ACP flags gate the ingest sub-mode's real spawns (Stage-4 needs causal chains). */
function requireFrontierIngestFlags(): void {
  if (!isConversationEventExtractEnabled(process.env) || process.env[CAUSAL_ACP_ENV] !== '1') {
    throw new Error(
      `frontier-ingest requires ${CONVERSATION_EVENT_ACP_ENV}=1 AND ${CAUSAL_ACP_ENV}=1 (real event+causal ingestion so Stage-4 topo-ordering has causal edges to walk)`,
    )
  }
}

/** Sample ids that carry authored WHY items (the ONLY convs the frontier ingests — no wasted ACP work). */
const FRONTIER_SAMPLE_IDS = new Set<string>([
  ...groupWhyQuestionsBySample(WHY_EVAL_QUESTIONS).keys(),
])

/** Build (real BGE, NO ingest) one ORACLE-gaz vault per selected conversation. */
async function buildConvsForSampleIds(
  samples: readonly LocomoSample[],
  sampleIds: ReadonlySet<string>,
): Promise<ConvRecord[]> {
  const convs: ConvRecord[] = []
  for (const s of samples) {
    if (!sampleIds.has(s.sample_id)) continue
    const turns = extractTurns(s.conversation, 0)
    if (turns.length === 0) continue
    const gaz = oracleGazetteer(s, turns)
    const vault = await buildVault(turns, gaz)
    convs.push({ sample: s, vault, gaz })
  }
  return convs
}

/** Build (real BGE, NO ingest) one ORACLE-gaz vault per WHY-relevant conversation only. */
async function buildFrontierConvs(devSamples: readonly LocomoSample[]): Promise<ConvRecord[]> {
  return buildConvsForSampleIds(devSamples, FRONTIER_SAMPLE_IDS)
}

// ── C1.3 — HELD-OUT certification snapshot selection (kills train-on-test, §9 evaluator risk #1) ──
// TAINTED-for-certification conversations = the DEV tuning slice (samples[0..DEV_CONV), where every arm
// and the WHY set were tuned) ∪ the WHY-authored convs (FRONTIER_SAMPLE_IDS). Certification runs on
// conversations OUTSIDE both. Default: the first SCNS_CERT_CONV_N (2) untainted samples; override the
// exact set with SCNS_CERT_SAMPLE_IDS=conv-44,conv-47.
const CERT_CONV_N = Number(process.env.SCNS_CERT_CONV_N ?? '2') || 2

/** Sample ids used for TUNING (never valid for certification). */
function tuningSampleIds(samples: readonly LocomoSample[]): Set<string> {
  return new Set<string>([
    ...samples.slice(0, DEV_CONV).map((s) => s.sample_id),
    ...FRONTIER_SAMPLE_IDS,
  ])
}

/** The held-out certification sample ids (env override or first CERT_CONV_N untainted). Throws when none. */
function certSampleIds(samples: readonly LocomoSample[]): Set<string> {
  const tainted = tuningSampleIds(samples)
  const envIds = (process.env.SCNS_CERT_SAMPLE_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (envIds.length > 0) {
    const known = new Set(samples.map((s) => s.sample_id))
    for (const id of envIds) {
      if (!known.has(id))
        throw new Error(`cert-ingest: SCNS_CERT_SAMPLE_IDS names unknown sample '${id}'`)
      if (tainted.has(id))
        throw new Error(
          `cert-ingest: sample '${id}' is TAINTED for certification (DEV tuning slice or WHY-authored) — pick a held-out conversation`,
        )
    }
    return new Set(envIds)
  }
  const heldOut = samples.filter((s) => !tainted.has(s.sample_id)).slice(0, CERT_CONV_N)
  if (heldOut.length === 0)
    throw new Error(
      'cert-ingest: no held-out conversations available (raise SCNS_LOCOMO_CONVERSATIONS / provide more data)',
    )
  return new Set(heldOut.map((s) => s.sample_id))
}

/** True iff every snapshot conversation is OUTSIDE the tuning set (no train-on-test). */
function snapshotIsHeldOut(
  convs: readonly ConvRecord[],
  samples: readonly LocomoSample[],
): boolean {
  const tainted = tuningSampleIds(samples)
  return convs.length > 0 && convs.every((c) => !tainted.has(c.sample.sample_id))
}

/** ACP event+causal ingest per conversation ONCE (the expensive step; sets materialized/persisted). */
async function ingestFrontierConvs(convs: readonly ConvRecord[]): Promise<void> {
  console.log(
    `\n  ── Ingest (event + causal) per conversation [ONCE — corpus symmetry across all arms] ──`,
  )
  for (const conv of convs) {
    const ingest = await ingestConversationEventNodes(conv.vault.db, conv.sample.conversation, {
      extractor: createAcpConversationEventExtractor({
        cwd: mkIso(),
        createClient: trackingCreate,
      }),
      gazetteer: conv.gaz,
      rebuildEdges: true,
      buildSemantic: true,
      env: { [CAUSAL_ACP_ENV]: '1' },
      makeAcpProvider: () =>
        createAcpCausalProvider({
          cwd: mkIso(),
          attemptTimeoutMs: M2_CAUSAL_ATTEMPT_MS,
          createClient: trackingCreate,
        }),
      minConfidence: M2_MIN_CONFIDENCE,
      maxCandidates: M2_MAX_CANDIDATES,
    })
    conv.ingested = ingest
    conv.materialized = ingest.causal.materialized
    conv.persisted = ingest.causal.persisted
    console.log(
      `  [${conv.sample.sample_id}] segmented=${ingest.segmented} dated=${ingest.datedEpisodes} eventCand=${ingest.eventCausalCandidates} chunkCand=${ingest.chunkCausalCandidates} persisted=${ingest.causal.persisted} materialized=${ingest.causal.materialized}`,
    )
  }
}

/** Snapshot each conv's vault.db → $SNAPSHOT/conv-<i>.db and write the PRE-CHECK manifest (ingest-once). */
async function snapshotFrontierConvs(
  convs: readonly ConvRecord[],
  snapshotDir: string,
): Promise<FrontierManifest> {
  mkdirSync(snapshotDir, { recursive: true })
  for (let i = 0; i < convs.length; i++) {
    await snapshotVaultDb(convs[i]!.vault, join(snapshotDir, `conv-${i}.db`))
  }
  const manifest: FrontierManifest = {
    createdAt: new Date().toISOString(),
    dev: convs.length,
    sampleIds: convs.map((c) => c.sample.sample_id),
    materialized: convs.map((c) => c.materialized ?? 0),
    persisted: convs.map((c) => c.persisted ?? 0),
    totalMaterialized: convs.reduce((a, c) => a + (c.materialized ?? 0), 0),
    totalPersisted: convs.reduce((a, c) => a + (c.persisted ?? 0), 0),
  }
  writeFileSync(join(snapshotDir, FRONTIER_MANIFEST), JSON.stringify(manifest, null, 2))
  return manifest
}

/** Reopen the shared snapshot: reconstruct ConvRecords (reopened vault + re-derived gaz) WITHOUT re-ingest. */
function loadFrontierConvsFromSnapshot(
  devSamples: readonly LocomoSample[],
  snapshotDir: string,
): ConvRecord[] {
  const manifestPath = join(snapshotDir, FRONTIER_MANIFEST)
  if (!existsSync(manifestPath)) {
    throw new Error(
      `frontier snapshot manifest not found at ${manifestPath} — run SCNS_JUDGE_MODE=frontier-ingest first`,
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FrontierManifest
  const sampleById = new Map(devSamples.map((s) => [s.sample_id, s]))
  const convs: ConvRecord[] = []
  for (let i = 0; i < manifest.sampleIds.length; i++) {
    const sampleId = manifest.sampleIds[i]!
    const sample = sampleById.get(sampleId)
    if (!sample)
      throw new Error(
        `snapshot conv ${i} sample '${sampleId}' not in the current DEV slice (raise SCNS_LOCOMO_DEV_CONV)`,
      )
    const turns = extractTurns(sample.conversation, 0)
    const gaz = oracleGazetteer(sample, turns)
    const dbPath = join(snapshotDir, `conv-${i}.db`)
    if (!existsSync(dbPath))
      throw new Error(`snapshot db missing: ${dbPath} — re-run frontier-ingest`)
    const vault = reopenVaultSnapshot(dbPath, turns)
    convs.push({
      sample,
      vault,
      gaz,
      materialized: manifest.materialized[i] ?? 0,
      persisted: manifest.persisted[i] ?? 0,
    })
  }
  return convs
}

/** Bind the authored WHY items to their conversation vaults (shared by tokens + accuracy sub-modes). */
function bindFrontierItems(convs: readonly ConvRecord[]): WhyItem[] {
  const convIdxBySample = new Map<string, number>()
  convs.forEach((c, i) => convIdxBySample.set(c.sample.sample_id, i))
  const items: WhyItem[] = []
  for (const [sampleId, qs] of groupWhyQuestionsBySample(WHY_EVAL_QUESTIONS)) {
    const convIdx = convIdxBySample.get(sampleId)
    if (convIdx === undefined) {
      throw new Error(
        `frontier: sample '${sampleId}' not in the DEV slice (raise SCNS_LOCOMO_DEV_CONV to cover it)`,
      )
    }
    const issues = validateWhyEvalQuestions(qs, convs[convIdx]!.gaz)
    if (issues.length > 0) {
      throw new Error(
        `frontier: ${issues.length} malformed question(s) for ${sampleId}: ${JSON.stringify(issues)}`,
      )
    }
    for (const q of qs) {
      items.push({
        question: q.question,
        gold: q.gold,
        category: q.category,
        key: `${q.anchor}|${q.question}`,
        convIdx,
        anchor: q.anchor,
        sampleId,
      })
    }
  }
  return items
}

/** HARD PRE-CHECK input: total materialized/persisted causal edges across convs (fresh or manifest-restored). */
function frontierPreCheck(
  convs: readonly ConvRecord[],
  whyItemCount?: number,
): {
  materialized: number
  persisted: number
  materializedPerConv: number[]
  substrate: SubstrateDensityResult
} {
  const materializedPerConv = convs.map((c) => c.materialized ?? 0)
  const materialized = materializedPerConv.reduce((a, b) => a + b, 0)
  const persisted = convs.reduce((a, c) => a + (c.persisted ?? 0), 0)
  // Substrate density floor (contracts/substrate-density-floor.contract.md): replaces the vacuous
  // `materialized > 0` — graph arms may run ONLY at ≥8 causal edges/conv, ≥0.5/WHY-item, per-conv MIN ≥ 8.
  const substrate = substrateDensityFloor({
    materializedPerConv,
    perWhyItem: materialized / Math.max(1, whyItemCount ?? convs.length),
  })
  return { materialized, persisted, materializedPerConv, substrate }
}

/** Full-context baseline (MAGMA Table-3 ~101K analog): REAL o200k tokens of the ENTIRE conversation. */
function fullContextTokens(conv: ConvRecord): number {
  const turns = extractTurns(conv.sample.conversation, 0)
  return countTokens(turns.map((t) => t.content).join('\n\n'))
}

/** Retrieve (deterministic, NO generate/judge) the S4-OFF/S4-ON injected context TEXT for the token axis. */
async function retrieveFrontierText(
  conv: ConvRecord,
  question: string,
  synthesize: boolean,
): Promise<string> {
  const r = await retrieveContext(
    conv.vault.db,
    question,
    { intentRouting: false, synthesize, topK: RETRIEVAL_TOPK, maxChars: RETRIEVAL_MAX_CHARS },
    {
      gazetteer: conv.gaz,
      baseSearch: makeHybridBaseSearch(conv.vault.db),
      makeSemanticRelevanceScorer: (qq) => makeSemanticRelevanceScorer(conv.vault.db, qq),
    },
  )
  return r.text
}

// ── frontier-ingest: build + ACP ingest ONCE, then snapshot (the only expensive step). ──
async function runFrontierIngest(devSamples: readonly LocomoSample[]): Promise<void> {
  requireFrontierIngestFlags()
  if (!FRONTIER_SNAPSHOT)
    throw new Error(
      'frontier-ingest requires SCNS_FRONTIER_SNAPSHOT=<dir> (the shared snapshot the token+accuracy arms reopen)',
    )
  console.log(
    `\n=== FRONTIER-INGEST (real BGE + ACP event/causal, ONCE) :: WHY-relevant convs → snapshot ${FRONTIER_SNAPSHOT} ; maxCand=${M2_MAX_CANDIDATES} causalMs=${M2_CAUSAL_ATTEMPT_MS} ===`,
  )
  const convs = await buildFrontierConvs(devSamples)
  const items = bindFrontierItems(convs) // fail fast on a malformed/uncovered WHY set BEFORE the costly ingest
  console.log(
    `  built ${convs.length} WHY-relevant conv vault(s); bound ${items.length} WHY items (per-anchor: ${countByAnchor(items)})`,
  )
  await ingestFrontierConvs(convs) // the expensive ACP step — only after bind validates
  const pre = frontierPreCheck(convs, items.length)
  console.log(
    `\n  ── PRE-CHECK (substrate density floor — Stage-4 causal input) ──\n  materialized chunk→chunk causal memory_edges = ${pre.materialized} (persisted memory_causal = ${pre.persisted}); perConv=[${pre.materializedPerConv.join(',')}] min=${pre.substrate.perConvMin} ⇒ ${pre.substrate.preCheckOk ? 'OK — Eq-7 has a dense-enough causal substrate to topo-order ✓' : SUBSTRATE_STOP_MESSAGE}`,
  )
  const manifest = await snapshotFrontierConvs(convs, FRONTIER_SNAPSHOT)
  for (const c of convs) c.vault.db.close()
  console.log(
    `\n  SNAPSHOT WRITTEN: ${FRONTIER_SNAPSHOT} (${manifest.dev} conv db(s) + ${FRONTIER_MANIFEST}) ✓`,
  )
  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'frontier-ingest',
      snapshot: FRONTIER_SNAPSHOT,
      dev: manifest.dev,
      nItems: items.length,
      sampleIds: manifest.sampleIds,
      materialized: manifest.materialized,
      persisted: manifest.persisted,
      totalMaterialized: manifest.totalMaterialized,
      totalPersisted: manifest.totalPersisted,
      maxCandidates: M2_MAX_CANDIDATES,
      causalAttemptMs: M2_CAUSAL_ATTEMPT_MS,
      preCheckOk: pre.substrate.preCheckOk,
      substrate: {
        perConv: pre.materializedPerConv,
        perConvMin: pre.substrate.perConvMin,
        perWhyItem: pre.substrate.perWhyItem,
        floor: pre.substrate.floor,
        preCheckOk: pre.substrate.preCheckOk,
      },
    })}`,
  )
  for (const c of convs) rmSync(c.vault.root, { recursive: true, force: true }) // working vaults; the snapshot persists
}

// ── cert-ingest: build + ACP-ingest the HELD-OUT certification snapshot (C1.3). Same snapshot format
// as frontier-ingest (the arm-frontier sub-modes reopen it via SCNS_FRONTIER_SNAPSHOT), but the convs
// come from certSampleIds — OUTSIDE the DEV tuning slice and the WHY-authored convs, so the judged
// certification never trains-on-test. ACP-heavy; run ONCE per snapshot dir. ──
async function runCertIngest(samples: readonly LocomoSample[]): Promise<void> {
  requireFrontierIngestFlags()
  if (!FRONTIER_SNAPSHOT)
    throw new Error(
      'cert-ingest requires SCNS_FRONTIER_SNAPSHOT=<dir> (the held-out snapshot the arm-frontier sub-modes reopen)',
    )
  const ids = certSampleIds(samples)
  console.log(
    `\n=== CERT-INGEST (real BGE + ACP event/causal, ONCE) :: HELD-OUT convs {${[...ids].join(', ')}} → snapshot ${FRONTIER_SNAPSHOT} ; maxCand=${M2_MAX_CANDIDATES} causalMs=${M2_CAUSAL_ATTEMPT_MS} ===`,
  )
  const convs = await buildConvsForSampleIds(samples, ids)
  if (convs.length === 0) throw new Error('cert-ingest: selected conversations produced no turns')
  const items = bindArmFrontierItems(convs) // fail fast: the probe must be non-empty BEFORE the costly ingest
  console.log(
    `  built ${convs.length} held-out conv vault(s); bound ${items.length} probe items (${countByCat(items)})`,
  )
  await ingestFrontierConvs(convs) // the expensive ACP step — only after bind validates
  const pre = frontierPreCheck(convs, items.length)
  const substrateOk = pre.substrate.preCheckOk
  console.log(
    `\n  ── PRE-CHECK (substrate density floor — causal input for the magma/multihop-iter arms) ──\n` +
      `  materialized chunk→chunk causal memory_edges = ${pre.materialized} (persisted memory_causal = ${pre.persisted}); ` +
      `perConv=[${pre.materializedPerConv.join(',')}] min=${pre.substrate.perConvMin} perWhyItem=${pre.substrate.perWhyItem.toFixed(2)} ` +
      `floor={perConv:${pre.substrate.floor.perConv},perWhyItem:${pre.substrate.floor.perWhyItem}} ⇒ ` +
      `${substrateOk ? 'OK — the beam has a dense-enough causal substrate to walk ✓' : SUBSTRATE_STOP_MESSAGE}`,
  )
  const manifest = await snapshotFrontierConvs(convs, FRONTIER_SNAPSHOT)
  for (const c of convs) c.vault.db.close()
  console.log(
    `\n  SNAPSHOT WRITTEN: ${FRONTIER_SNAPSHOT} (${manifest.dev} conv db(s) + ${FRONTIER_MANIFEST}) ✓`,
  )
  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'cert-ingest',
      heldOut: true,
      snapshot: FRONTIER_SNAPSHOT,
      dev: manifest.dev,
      nItems: items.length,
      byCategory: countByCat(items),
      sampleIds: manifest.sampleIds,
      materialized: manifest.materialized,
      persisted: manifest.persisted,
      totalMaterialized: manifest.totalMaterialized,
      totalPersisted: manifest.totalPersisted,
      maxCandidates: M2_MAX_CANDIDATES,
      causalAttemptMs: M2_CAUSAL_ATTEMPT_MS,
      preCheckOk: pre.substrate.preCheckOk,
      substrate: {
        perConv: pre.materializedPerConv,
        perConvMin: pre.substrate.perConvMin,
        meanPerConv: pre.substrate.materializedPerConv,
        perWhyItem: pre.substrate.perWhyItem,
        floor: pre.substrate.floor,
        preCheckOk: pre.substrate.preCheckOk,
      },
    })}`,
  )
  for (const c of convs) rmSync(c.vault.root, { recursive: true, force: true }) // working vaults; the snapshot persists
}

// ── frontier-tokens: DETERMINISTIC REAL-token Δtok frontier (S4-OFF vs S4-ON), NO spawns. THE HEADLINE. ──
async function runFrontierTokens(devSamples: readonly LocomoSample[]): Promise<void> {
  if (!FRONTIER_SNAPSHOT)
    throw new Error('frontier-tokens requires SCNS_FRONTIER_SNAPSHOT=<dir> from frontier-ingest')
  console.log(
    `\n=== FRONTIER-TOKENS (deterministic REAL o200k Δtok, NO judge/gen spawns) :: snapshot ${FRONTIER_SNAPSHOT} ===`,
  )
  const convs = loadFrontierConvsFromSnapshot(devSamples, FRONTIER_SNAPSHOT)
  const items = bindFrontierItems(convs)
  const pre = frontierPreCheck(convs)
  console.log(
    `  bound ${items.length} WHY items across ${convs.length} conv(s) (per-anchor: ${countByAnchor(items)})`,
  )
  console.log(
    `\n  ── PRE-CHECK (Stage-4 causal input, from manifest) ──\n  materialized = ${pre.materialized} (persisted = ${pre.persisted}) ⇒ ${pre.materialized > 0 ? 'OK — Eq-7 has causal chains to topo-order ✓' : 'STOP — treat any Δtok as NULL ✗'}`,
  )
  const fullCtxByConv = convs.map((c) => fullContextTokens(c))
  // Phase B — record the per-conversation `full`-context token baseline (retriever='full') so the §9 enum
  // is faithful and the evaluator's token frontier has the ~101K denominator. No retrieval/answer (tokens only).
  const fullStore = getHarnessStore()
  if (fullStore) {
    convs.forEach((c, i) =>
      logFullContextBaseline(fullStore, {
        queryText: `__full_context__:${c.sample.sample_id}`,
        tokens: fullCtxByConv[i]!,
        conversationId: c.sample.sample_id,
      }),
    )
  }

  const tokP: number[] = []
  const tokS: number[] = []
  const fullCtx: number[] = []
  const ctxDifferedArr: boolean[] = []
  const brevityArr: boolean[] = []
  const byItem: Array<Record<string, unknown>> = []
  console.log(
    `\n  ── S4-OFF vs S4-ON REAL-token counts (retrieve-only; identical retrieved SET) ──`,
  )
  for (const item of items) {
    const conv = convs[item.convIdx]!
    const textP = await retrieveFrontierText(conv, item.question, false)
    const textS = await retrieveFrontierText(conv, item.question, true)
    const tp = countTokens(textP)
    const ts = countTokens(textS)
    const differed = textS !== textP
    const brevity = hasBrevityCode(textS)
    tokP.push(tp)
    tokS.push(ts)
    fullCtx.push(fullCtxByConv[item.convIdx]!)
    ctxDifferedArr.push(differed)
    brevityArr.push(brevity)
    byItem.push({
      anchor: item.anchor,
      question: item.question,
      tokP: tp,
      tokS: ts,
      deltaTok: ts - tp,
      fullContextTok: fullCtxByConv[item.convIdx]!,
      ctxDiffered: differed,
      brevityApplied: brevity,
    })
    console.log(
      `  [${item.anchor}] tokP=${tp} tokS=${ts} Δ=${ts - tp} ctxΔ=${differed} brevity=${brevity}`,
    )
  }
  const nCtxDiffered = ctxDifferedArr.filter(Boolean).length
  const nBrevityApplied = brevityArr.filter(Boolean).length

  const tf = pairedTokenFrontier(tokP, tokS, fullCtx)
  const firedGate = pre.materialized > 0
  const tokenWin = tf.meanDeltaTok < 0
  const compressionFired = tf.nItemsTokenReduced > 0 || nBrevityApplied > 0
  const noWinAttribution = compressionFired
    ? `Stage-4 compression FIRED on ${Math.max(tf.nItemsTokenReduced, nBrevityApplied)} item(s) but net Δtok ≥ 0 — the Eq-7 provenance scaffold on the non-overflowing majority outweighs it`
    : `Stage-4 compression NEVER fired (no retrieved block overflowed the ${RETRIEVAL_MAX_CHARS}-char budget) ⇒ S4-ON = provenance scaffold overhead ONLY; this NULL reflects small-context LoCoMo, NOT a failure of MAGMA's compression mechanism`

  console.log(`\n  ── FRONTIER-TOKENS result (REAL o200k tokens) ──`)
  console.log(
    `  S4-OFF (Arm P, plain join):   mean ${Math.round(tf.meanTokP)} tok  (${r4(tf.fracOfFullP)} of full-context)`,
  )
  console.log(
    `  S4-ON  (Arm S, Eq-7 synth):   mean ${Math.round(tf.meanTokS)} tok  (${r4(tf.fracOfFullS)} of full-context)`,
  )
  console.log(
    `  full-context baseline (entire conversation) = mean ${Math.round(tf.meanFullContextTok)} tok [Table-3 un-managed analog]`,
  )
  console.log(
    `  paired Δtok(S−P) = ${Math.round(tf.meanDeltaTok)} tok over n=${tf.nItems} items ⇒ ${tokenWin ? 'FEWER tokens (win direction)' : 'MORE-or-EQUAL tokens (no saving)'}`,
  )
  console.log(
    `  token direction: reduced ${tf.nItemsTokenReduced} / increased ${tf.nItemsTokenIncreased} / equal ${tf.nItemsTokenEqual} ; brevity-fired ${nBrevityApplied}/${items.length} ; ctxΔ ${nCtxDiffered}/${items.length}`,
  )
  console.log(
    `  VERDICT: ${
      !firedGate
        ? 'NULL ✗ (materialized=0 ⇒ Eq-7 had no causal chains to topo-order)'
        : tokenWin
          ? 'TOKEN WIN ✓ (Δtok<0 at the identical retrieved set)'
          : `NO TOKEN WIN (honest NULL) — ${noWinAttribution}`
    }`,
  )

  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'frontier-tokens',
      tokenizer:
        'REAL o200k_base BPE (gpt-tokenizer, offline, deterministic) via countTokens — NOT chars/4',
      stage4: 'Eq-7 narrative synthesis (topo-order + <ref:id> provenance + salience token budget)',
      isolation:
        'S4-OFF vs S4-ON over the IDENTICAL deterministic retrieved set (intentRouting:false + beam OFF); only synthesize differs ⇒ Δtok isolates Eq-7',
      snapshot: FRONTIER_SNAPSHOT,
      preCheck: { materialized: pre.materialized, persisted: pre.persisted },
      synthesizeBudgetChars: RETRIEVAL_MAX_CHARS,
      dev: convs.length,
      nItems: items.length,
      meanTokP_S4off: Math.round(tf.meanTokP),
      meanTokS_S4on: Math.round(tf.meanTokS),
      meanDeltaTok: Math.round(tf.meanDeltaTok),
      meanFullContextTok: Math.round(tf.meanFullContextTok),
      fracOfFullContext_S4off: r4(tf.fracOfFullP),
      fracOfFullContext_S4on: r4(tf.fracOfFullS),
      nItemsTokenReduced: tf.nItemsTokenReduced,
      nItemsTokenIncreased: tf.nItemsTokenIncreased,
      nItemsTokenEqual: tf.nItemsTokenEqual,
      nItemsBrevityApplied: nBrevityApplied,
      ctxDiffered: nCtxDiffered,
      compressionFired,
      tokenWin,
      firedGate,
      noWinAttribution: tokenWin ? null : noWinAttribution,
      byItem,
    })}`,
  )
  for (const c of convs) c.vault.db.close()
}

// ── frontier-accuracy: economical PAIRED S4-OFF vs S4-ON JUDGED accuracy on the SAME snapshot, reuse σ. ──
async function runFrontierAccuracy(devSamples: readonly LocomoSample[]): Promise<void> {
  if (!FRONTIER_SNAPSHOT)
    throw new Error('frontier-accuracy requires SCNS_FRONTIER_SNAPSHOT=<dir> from frontier-ingest')
  console.log(
    `\n=== FRONTIER-ACCURACY (paired S4-OFF vs S4-ON judged, reuse σ=${JUDGE_SIGMA}) :: snapshot ${FRONTIER_SNAPSHOT} ===`,
  )
  const convs = loadFrontierConvsFromSnapshot(devSamples, FRONTIER_SNAPSHOT)
  const items = bindFrontierItems(convs)
  const pre = frontierPreCheck(convs)
  console.log(
    `  bound ${items.length} WHY items across ${convs.length} conv(s) (per-anchor: ${countByAnchor(items)})`,
  )
  console.log(
    `\n  ── PRE-CHECK (Stage-4 causal input, from manifest) ──\n  materialized = ${pre.materialized} (persisted = ${pre.persisted}) ⇒ ${pre.materialized > 0 ? 'OK — Eq-7 has causal chains to topo-order ✓' : 'STOP — treat any Δacc as NULL ✗'}`,
  )

  // ── Arm P (Stage-4 OFF — synthesize:false). Capture text to diff against Arm S. ──
  console.log(`\n  ── Arm P (Stage-4 OFF — intentRouting:false, synthesize:false = plain join) ──`)
  const armPRows: JudgeEvalRow[] = []
  const armPText: string[] = []
  for (const item of items) {
    const { row, text } = await scoreItem(item, convs[item.convIdx]!, {
      intentRouting: false,
      synthesize: false,
    })
    armPRows.push(row)
    armPText.push(text)
    console.log(
      `  P[${item.anchor}] score=${row.score >= 0 ? r4(row.score) : 'DROP'} tok=${row.contextTokens} ${row.latencyMs}ms`,
    )
  }

  // ── Arm S (Stage-4 ON — synthesize:true). SAME retrieved set as Arm P; only Stage-4 formatting differs. ──
  console.log(
    `\n  ── Arm S (Stage-4 ON — intentRouting:false, synthesize:true = Eq-7 narrative synthesis) ──`,
  )
  const armSRows: JudgeEvalRow[] = []
  const ctxDifferedArr: boolean[] = []
  for (let i = 0; i < items.length; i++) {
    const { row, text } = await scoreItem(items[i]!, convs[items[i]!.convIdx]!, {
      intentRouting: false,
      synthesize: true,
    })
    armSRows.push(row)
    const differed = text !== armPText[i]
    ctxDifferedArr.push(differed)
    console.log(
      `  S[${items[i]!.anchor}] score=${row.score >= 0 ? r4(row.score) : 'DROP'} tok=${row.contextTokens} ${row.latencyMs}ms ctxΔ=${differed}`,
    )
  }
  const nCtxDiffered = ctxDifferedArr.filter(Boolean).length

  const aggP = aggregateAccuracy(armPRows)
  const aggS = aggregateAccuracy(armSRows)
  const ciP = meanCI(armPRows.filter((r) => r.score >= 0).map((r) => r.score))
  const ciS = meanCI(armSRows.filter((r) => r.score >= 0).map((r) => r.score))
  const front = pairedFrontier(armPRows, armSRows)
  const latP = mean(armPRows.map((r) => r.latencyMs))
  const latS = mean(armSRows.map((r) => r.latencyMs))

  const accNotSacrificed = front.meanDeltaScore >= -JUDGE_SIGMA
  const firedGate = pre.materialized > 0
  const byCatJson = (agg: ReturnType<typeof aggregateAccuracy>) =>
    Object.fromEntries(
      Object.entries(agg.byCategory).map(([c, a]) => [c, { n: a.nScored, mean: r4(a.meanScore) }]),
    )

  const byItem = items.map((it, i) => {
    const p = armPRows[i]!
    const s = armSRows[i]!
    const both = p.score >= 0 && s.score >= 0
    return {
      anchor: it.anchor,
      question: it.question,
      scoreP: r4(p.score),
      scoreS: r4(s.score),
      deltaScore: both ? r4(s.score - p.score) : null,
      tokP: p.contextTokens,
      tokS: s.contextTokens,
      ctxDiffered: ctxDifferedArr[i]!,
    }
  })

  console.log(`\n  ── FRONTIER-ACCURACY paired result (σ_judge = ${JUDGE_SIGMA}, REUSED) ──`)
  console.log(
    `  Arm P (S4-OFF): mean=${r4(aggP.meanScore)} ± ${r4(ciP.ci)}  n=${aggP.nScored} (${aggP.nDropped} dropped)  tok=${Math.round(aggP.meanContextTokens)} [o200k]  lat=${Math.round(latP)}ms`,
  )
  console.log(
    `  Arm S (S4-ON):  mean=${r4(aggS.meanScore)} ± ${r4(ciS.ci)}  n=${aggS.nScored} (${aggS.nDropped} dropped)  tok=${Math.round(aggS.meanContextTokens)} [o200k]  lat=${Math.round(latS)}ms`,
  )
  console.log(
    `  paired Δacc(S−P) = ${r4(front.meanDeltaScore)} ± ${r4(front.ciDeltaScore)}  over n=${front.nAcc} pairs ⇒ ${accNotSacrificed ? 'accuracy NOT sacrificed (≥ −σ)' : 'ACCURACY REGRESSED (< −σ)'}`,
  )
  console.log(`  ctxΔ: ${nCtxDiffered}/${items.length} items had S4-ON text ≠ S4-OFF text`)
  console.log(
    `  VERDICT: ${
      !firedGate
        ? 'NULL ✗ (materialized=0 ⇒ Eq-7 had no causal chains to topo-order)'
        : accNotSacrificed
          ? 'ACCURACY NOT SACRIFICED ✓ (Δacc ≥ −σ; a NULL here is expected — the token win is the headline, see frontier-tokens)'
          : 'ACCURACY REGRESSED ✗ (Δacc < −σ)'
    }`,
  )

  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'frontier-accuracy',
      stage4:
        'Eq-7 narrative synthesis via graph linearization (topo-order + <ref:id> provenance + salience token budget)',
      isolation:
        'Arm P vs Arm S share intentRouting:false + beam OFF; only synthesize differs over the IDENTICAL deterministic retrieved set ⇒ the paired Δ isolates Eq-7',
      tokenizer: 'contextTokens = REAL o200k_base (countTokens), consistent with frontier-tokens',
      snapshot: FRONTIER_SNAPSHOT,
      preCheck: { materialized: pre.materialized, persisted: pre.persisted },
      judgeSigmaReused: JUDGE_SIGMA,
      dev: convs.length,
      nItems: items.length,
      armP: {
        meanScore: r4(aggP.meanScore),
        ci95: r4(ciP.ci),
        nScored: aggP.nScored,
        nDropped: aggP.nDropped,
        contextTokensO200k: Math.round(aggP.meanContextTokens),
        meanLatencyMs: Math.round(latP),
        byCategory: byCatJson(aggP),
      },
      armS: {
        meanScore: r4(aggS.meanScore),
        ci95: r4(ciS.ci),
        nScored: aggS.nScored,
        nDropped: aggS.nDropped,
        contextTokensO200k: Math.round(aggS.meanContextTokens),
        meanLatencyMs: Math.round(latS),
        byCategory: byCatJson(aggS),
      },
      frontier: {
        nAcc: front.nAcc,
        meanDeltaScore: r4(front.meanDeltaScore),
        ciDeltaScore: r4(front.ciDeltaScore),
        meanTokP_o200k: Math.round(front.meanTokP),
        meanTokS_o200k: Math.round(front.meanTokS),
        meanDeltaTok_o200k: Math.round(front.meanDeltaTok),
        accNotSacrificed,
      },
      ctxDiffered: nCtxDiffered,
      firedGate,
      byItem,
    })}`,
  )
  for (const c of convs) c.vault.db.close()
}

function countByAnchor(items: readonly { anchor: string }[]): string {
  const m = new Map<string, number>()
  for (const it of items) m.set(it.anchor, (m.get(it.anchor) ?? 0) + 1)
  return [...m.entries()]
    .sort()
    .map(([a, n]) => `${a}=${n}`)
    .join(' ')
}

function countByCat(items: readonly { category: number }[]): string {
  const m = new Map<number, number>()
  for (const it of items) m.set(it.category, (m.get(it.category) ?? 0) + 1)
  return [...m.entries()]
    .sort()
    .map(([c, n]) => `cat${c}=${n}`)
    .join(' ')
}

// ══ ARM-FRONTIER: the shared offline EVALUATOR over SCNS's real, reachable retrieval arms ═════════
// The north-star measurement spine (files/PRIOR_ART.md §CROSS-PHASE SYNTHESIS). Scores each arm on the joint
// (answer-accuracy, real-o200k-token) frontier via a tunable λ, and — in the judged sub-mode — declares a
// candidate arm a winner over the INCUMBENT (hybrid) ONLY on a high-confidence value lower bound AND no
// negative-control regression (locomo-judge-lib.ts gateVerdict). It flips NO default and modifies NO
// retrieval behavior; a "winner" is a REPORT — a default-ON flip stays AWAITING-JOHN (+ John's chosen λ).
//
// THE ARMS — REDESIGNED 2026-07-04 after the quarantine audit (the old {entity, synthesis} strawman arms
// and the near-inverted control sets are DELETED — see commit 5f9745c for the quarantine record). Every
// arm is REAL + REACHABLE through the single prod entry `retrieveContext`; the evaluator only INVOKES +
// MEASURES them, never modifies them:
//   hybrid        {intentRouting:false}
//       INCUMBENT — today's production default (vector+FTS5 RRF).
//   magma         {traverse:true, {maxDepth:5, budget:200}, synthesize:true}
//       The FAITHFUL end-to-end MAGMA pipeline: Stage 1–3 = Algorithm 1 adaptive traversal
//       (adaptiveTraversalSearch — literal Eq. 5/6 transition, Table-6 depth/budget 5/200; the paper's
//       single biggest ablation lever, Table 4: 0.700→0.637 without it) + Stage 4 = Eq-7 narrative
//       synthesis (topo order + provenance scaffold + salience budget). NOT a recency dump, NOT bare
//       formatting — the whole faithful path or nothing.
//   multihop-iter {multiHop:true}
//       C2 — the BEYOND-MAGMA iterative arm (IRCoT/FLARE family, multihop-iterative.ts): round-0 via the
//       faithful Alg-1 beam, graph-native bridge-entity follow-ups, zero-information-gain stop. Targets
//       the category the paper CONCEDES (Table 1 Multi-Hop 0.528 < Nemori 0.569).
// CONTROLS — the PAPER axis, imported from the lib (unit-tested against Table 1; never redefined here):
//   POS = {temporal, singleHop, adversarial} (MAGMA's real wins — sanity, non-gating)
//   NEG = {multihop} (the paper's concession — must-not-regress, gates the verdict)
//   NEUTRAL = {openDomain} (narrow 0.517 win — reported, gates nothing)
interface FrontierArm {
  readonly name: string
  readonly config: Pick<
    RetrievalContextConfig,
    | 'intentRouting'
    | 'traverse'
    | 'traversalOptions'
    | 'synthesize'
    | 'multiHop'
    | 'multiHopOptions'
    | 'maxTokens'
  >
}
const ARM_INCUMBENT = 'hybrid'
const FRONTIER_ARMS: readonly FrontierArm[] = [
  { name: 'hybrid', config: { intentRouting: false } },
  {
    name: 'magma',
    config: {
      intentRouting: false,
      traverse: true,
      traversalOptions: { maxDepth: WHY_BEAM_MAX_DEPTH, budget: WHY_BEAM_BUDGET },
      synthesize: true,
      maxTokens: MAGMA_STAGE4_MAX_TOKENS, // serialize-all-visited → Eq-7 token budget (augment, not swap)
    },
  },
  {
    name: 'multihop-iter',
    config: {
      intentRouting: false,
      multiHop: true,
      multiHopOptions: {
        traversalOptions: { maxDepth: WHY_BEAM_MAX_DEPTH, budget: WHY_BEAM_BUDGET },
      },
    },
  },
  // T047 [US4] — the edge-weight-REINFORCED beam challenger (behind SCNS_REINFORCED_ARM=1):
  // identical to 'magma' except the beam READS learned memory_edges.weight (useEdgeWeights). It only
  // diverges after applyExperienceReinforcement has moved weights on the SNAPSHOT COPY (see the
  // pre-step in runArmFrontierAccuracy); with neutral weights it is literal-Eq-5-identical, so its
  // presence never distorts the other arms (they ignore weight entirely).
  ...(process.env.SCNS_REINFORCED_ARM === '1'
    ? [
        {
          name: 'magma-reinforced',
          config: {
            intentRouting: false,
            traverse: true,
            traversalOptions: {
              maxDepth: WHY_BEAM_MAX_DEPTH,
              budget: WHY_BEAM_BUDGET,
              useEdgeWeights: true,
            },
            synthesize: true,
            maxTokens: MAGMA_STAGE4_MAX_TOKENS,
          },
        } satisfies FrontierArm,
      ]
    : []),
]
/** λ sweep (accuracy-points per 1000 context tokens) — REPORTED; the operating λ for any default-ON flip is JOHN's call. */
const LAMBDA_SWEEP = [0, 0.05, 0.1, 0.25, 0.5, 1.0]
/** δ for the HCOPE one-sided lower bound (John-overridable; default 95%). */
const HCOPE_DELTA = Number(process.env.SCNS_HCOPE_DELTA ?? '0.05') || 0.05
/** Probe size per category per conversation. 6 (not the old confirmatory-only 3) — with 2 held-out convs
 *  that is ~12/cat, ~60 items/arm; still label the run confirmatory unless the power check passes. */
const ARM_N_PER_CAT = Number(process.env.SCNS_ARM_N_PER_CAT ?? '6') || 6

/** Deterministic category-spanning probe from the snapshot convs (pickPerCategory cap per conv). */
function bindArmFrontierItems(convs: readonly ConvRecord[]): ArmBItem[] {
  const items: ArmBItem[] = []
  convs.forEach((c, convIdx) => {
    const pool: ArmBItem[] = []
    for (const qa of c.sample.qa) {
      const gold = goldFor(qa)
      if (gold === '') continue
      const { gold: dias } = normalizeGold(qa.evidence ?? [])
      pool.push({
        question: qa.question,
        gold,
        category: qa.category,
        key: `${dias[0] ?? ''}|${qa.question}`,
        convIdx,
      })
    }
    items.push(
      ...pickPerCategory(
        pool,
        ARM_N_PER_CAT,
        (it) => it.category,
        (it) => it.key,
      ),
    )
  })
  return items
}

/** Retrieve one arm's injected context for a question (NO gen/judge spawn) — the deterministic token axis. */
async function retrieveArmText(
  conv: ConvRecord,
  question: string,
  arm: FrontierArm,
): Promise<string> {
  const r = await retrieveContext(
    conv.vault.db,
    question,
    { ...arm.config, topK: RETRIEVAL_TOPK, maxChars: RETRIEVAL_MAX_CHARS },
    {
      gazetteer: conv.gaz,
      baseSearch: makeHybridBaseSearch(conv.vault.db),
      makeSemanticRelevanceScorer: (qq) => makeSemanticRelevanceScorer(conv.vault.db, qq),
    },
  )
  return r.text
}

// arm-frontier-tokens: DETERMINISTIC per-arm real-o200k token frontier, NO spawns (flag-exempt like frontier-tokens).
async function runArmFrontierTokens(devSamples: readonly LocomoSample[]): Promise<void> {
  if (!FRONTIER_SNAPSHOT)
    throw new Error(
      'arm-frontier-tokens requires SCNS_FRONTIER_SNAPSHOT=<dir> from frontier-ingest',
    )
  console.log(
    `\n=== ARM-FRONTIER-TOKENS (deterministic per-arm REAL o200k tokens, NO judge/gen spawns) :: snapshot ${FRONTIER_SNAPSHOT} ===`,
  )
  const convs = loadFrontierConvsFromSnapshot(devSamples, FRONTIER_SNAPSHOT)
  const items = bindArmFrontierItems(convs)
  const pre = frontierPreCheck(convs)
  console.log(
    `  bound ${items.length} probe items across ${convs.length} conv(s) (${countByCat(items)})`,
  )
  console.log(
    `  PRE-CHECK causal materialized=${pre.materialized} persisted=${pre.persisted} ⇒ ${pre.materialized > 0 ? 'beam has causal chains on ≥1 conv' : 'NO causal chains — the deep arms lose their causal dimension'}`,
  )

  const tokByArm: Record<string, number[]> = {}
  for (const arm of FRONTIER_ARMS) {
    const toks: number[] = []
    for (const it of items)
      toks.push(countTokens(await retrieveArmText(convs[it.convIdx]!, it.question, arm)))
    tokByArm[arm.name] = toks
  }
  const incTok = mean(tokByArm[ARM_INCUMBENT]!)
  console.log(
    `\n  ── per-arm REAL o200k context tokens/query (incumbent '${ARM_INCUMBENT}' = ${Math.round(incTok)}) ──`,
  )
  const perArm = FRONTIER_ARMS.map((arm) => {
    const meanTok = mean(tokByArm[arm.name]!)
    console.log(
      `  ${arm.name.padEnd(12)} mean ${Math.round(meanTok)} tok  (Δ vs incumbent ${meanTok - incTok >= 0 ? '+' : ''}${Math.round(meanTok - incTok)})`,
    )
    return {
      name: arm.name,
      meanTokO200k: Math.round(meanTok),
      deltaVsIncumbent: Math.round(meanTok - incTok),
    }
  })
  console.log(
    `\n  NOTE: accuracy is UNKNOWN here (no judge) ⇒ this is the token axis only; the value frontier E[acc−λ·tok],`,
  )
  console.log(
    `        the HCOPE gate verdict, and whichArmWon(value) are the judged sub-mode (arm-frontier-accuracy).`,
  )
  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'arm-frontier-tokens',
      note: 'DETERMINISTIC token axis (real o200k, NO spawns); flips NO default, modifies NO retrieval behavior',
      snapshot: FRONTIER_SNAPSHOT,
      preCheck: { materialized: pre.materialized, persisted: pre.persisted },
      nItems: items.length,
      byCategory: countByCat(items),
      arms: perArm,
      incumbent: ARM_INCUMBENT,
    })}`,
  )
  for (const c of convs) c.vault.db.close()
}

// arm-frontier-accuracy: JUDGED multi-arm gate — per-arm accuracy + pairedValueDelta→HCOPE→gateVerdict vs incumbent.
async function runArmFrontierAccuracy(devSamples: readonly LocomoSample[]): Promise<void> {
  if (!FRONTIER_SNAPSHOT)
    throw new Error(
      'arm-frontier-accuracy requires SCNS_FRONTIER_SNAPSHOT=<dir> from frontier-ingest',
    )
  console.log(
    `\n=== ARM-FRONTIER-ACCURACY (judged multi-arm gate vs '${ARM_INCUMBENT}', reuse σ=${JUDGE_SIGMA}, δ=${HCOPE_DELTA}) :: snapshot ${FRONTIER_SNAPSHOT} ===`,
  )
  const convs = loadFrontierConvsFromSnapshot(devSamples, FRONTIER_SNAPSHOT)
  const items = bindArmFrontierItems(convs)
  const pre = frontierPreCheck(convs, items.length)
  // HONEST framing: confirmatory/directional UNLESS the probe is powered (≥ POWER_MIN items), every conv
  // carries causal chains (a sum would MASK a per-conv 0 — check the minimum), AND the snapshot is
  // HELD-OUT (no train-on-test: certification convs must be outside the DEV tuning slice and outside the
  // WHY-authored convs — §9 evaluator risk #1). n is small ⇒ wide CIs ⇒ a NULL is CONFIRMATORY.
  const POWER_MIN_ITEMS = 15
  const anyConvNoCausal = convs.some((c) => (c.materialized ?? 0) === 0)
  const heldOut = snapshotIsHeldOut(convs, devSamples)
  const thinProbe =
    pre.materialized === 0 ||
    convs.length < 2 ||
    items.length < POWER_MIN_ITEMS ||
    anyConvNoCausal ||
    !heldOut
  console.log(
    `  bound ${items.length} probe items (${countByCat(items)}); PRE-CHECK causal materialized=${pre.materialized}/persisted=${pre.persisted}`,
  )
  console.log(
    `  held-out: ${heldOut ? 'YES ✓ (certification convs outside the DEV tuning slice + WHY-authored convs)' : 'NO ✗ — TRAIN-ON-TEST snapshot (tuning/authored convs) ⇒ confirmatory-only, never a certification'}`,
  )
  console.log(
    `  probe strength: ${thinProbe ? `THIN ⇒ CONFIRMATORY-ONLY / directional (n=${items.length}, convs w/o causal=${convs.filter((c) => (c.materialized ?? 0) === 0).length}, heldOut=${heldOut}) — NOT a powered arm-comparison verdict` : 'multi-conv, powered, held-out, all convs carry causal chains'}`,
  )

  // T028 [US3] substrate density-floor STOP (contracts/substrate-density-floor.contract.md): the graph arms
  // may run ONLY on a dense-enough causal substrate (≥8 causal edges/conv, ≥0.5/WHY-item, per-conv MIN ≥ 8).
  // A starved substrate ⇒ any Δ is a NULL, not a MAGMA verdict ⇒ hard REFUSE (BLOCKED), never a soft label.
  // This is the exact hole the fable5 null slipped through (materialized=4 reported "OK ✓").
  if (!pre.substrate.preCheckOk) {
    console.log(`\n  ${SUBSTRATE_STOP_MESSAGE}`)
    console.log(
      `\nRESULTS_JSON: ${JSON.stringify({
        mode: 'arm-frontier-accuracy',
        verdict: 'BLOCKED',
        reason: 'substrate below density floor — graph arms refused (BLOCKED, not a measured null)',
        substrate: {
          perConv: pre.materializedPerConv,
          perConvMin: pre.substrate.perConvMin,
          meanPerConv: pre.substrate.materializedPerConv,
          perWhyItem: pre.substrate.perWhyItem,
          floor: pre.substrate.floor,
          preCheckOk: false,
        },
      })}`,
    )
    return
  }

  // T047 [US4] — reinforcement pre-step for the challenger: apply settled human outcomes from the
  // experience store (SCNS_EXPERIENCE_DB, read-only) onto each conv's SNAPSHOT-COPY vault so the
  // 'magma-reinforced' arm has real learned weights to read. Idempotent per experience row (the
  // vault-side edge_reinforcement_log); NEVER the live vault (the snapshot copies are mkdtemp
  // reopens). Arms without useEdgeWeights ignore weight, so this cannot contaminate the incumbent.
  if (FRONTIER_ARMS.some((a) => a.name === 'magma-reinforced')) {
    const expPath = process.env.SCNS_EXPERIENCE_DB ?? ''
    if (!expPath || !existsSync(expPath)) {
      console.log(
        '  reinforced arm: no SCNS_EXPERIENCE_DB store found — weights stay neutral (challenger ≡ magma this run)',
      )
    } else {
      const expDb = new BetterSqlite3(expPath, { readonly: true, fileMustExist: true })
      try {
        for (const conv of convs) {
          const applied = applyExperienceReinforcement(conv.vault.db, {
            db: expDb,
            close: () => expDb.close(),
          })
          console.log(
            `  reinforced arm pre-step [${conv.sample.sample_id}]: applied=${JSON.stringify(applied)}`,
          )
        }
      } finally {
        expDb.close()
      }
    }
  }

  // Score EVERY arm over the SAME items in the SAME order ⇒ matched pairs vs the incumbent.
  const rowsByArm: Record<string, JudgeEvalRow[]> = {}
  for (const arm of FRONTIER_ARMS) {
    const rows: JudgeEvalRow[] = []
    console.log(`\n  ── arm ${arm.name} ${JSON.stringify(arm.config)} ──`)
    for (const it of items) {
      const { row } = await scoreItem(it, convs[it.convIdx]!, arm.config)
      rows.push(row)
      console.log(
        `  ${arm.name}[cat${it.category}] score=${row.score >= 0 ? r4(row.score) : 'DROP'} tok=${row.contextTokens} ${row.latencyMs}ms`,
      )
    }
    rowsByArm[arm.name] = rows
  }

  const armRows = (name: string): ArmFrontierRow[] =>
    rowsByArm[name]!.map((r) => ({
      category: r.category,
      score: r.score,
      contextTokens: r.contextTokens,
    }))
  const incRows = armRows(ARM_INCUMBENT)

  // Per-arm (accuracy, tokens) headline + a λ=0 pure-accuracy value±CI (exercises frontierValue).
  const perArm = FRONTIER_ARMS.map((arm) => {
    const agg = aggregateAccuracy(rowsByArm[arm.name]!)
    const graded = rowsByArm[arm.name]!.filter((r) => r.score >= 0)
    const fv0 = frontierValue(
      graded.map((r) => r.score),
      graded.map((r) => r.contextTokens),
      0,
    )
    console.log(
      `  ${arm.name.padEnd(12)} acc=${r4(agg.meanScore)} ± ${r4(fv0.ci)}  tok=${Math.round(agg.meanContextTokens)}  n=${agg.nScored} (${agg.nDropped} drop)`,
    )
    return {
      name: arm.name,
      meanScore: r4(agg.meanScore),
      ci95: r4(fv0.ci),
      nScored: agg.nScored,
      nDropped: agg.nDropped,
      tokO200k: Math.round(agg.meanContextTokens),
    }
  })

  // Paired Δacc on the pos/neg control subsets (both-graded), per candidate vs incumbent. Returns the
  // pair count too — gateVerdict fails the neg leg outright on n=0 (an unmeasured control never passes).
  const controlDeltaAcc = (
    candName: string,
    cats: ReadonlySet<number>,
  ): { delta: number; n: number } => {
    const cr = rowsByArm[candName]!
    const deltas: number[] = []
    for (let i = 0; i < items.length; i++) {
      if (!cats.has(items[i]!.category)) continue
      const b = incRows[i]!
      const c = cr[i]!
      if (b.score < 0 || c.score < 0) continue
      deltas.push(c.score - b.score)
    }
    return { delta: deltas.length ? mean(deltas) : 0, n: deltas.length }
  }

  // λ sweep × candidate → paired value delta, HCOPE lower bound, gate verdict (all REPORT — no flip).
  const candidates = FRONTIER_ARMS.filter((a) => a.name !== ARM_INCUMBENT)
  console.log(
    `\n  ── λ-sweep gate (candidate vs '${ARM_INCUMBENT}'; winner = value-LB>0 AND neg-controls ≥ −σ; REPORT only) ──`,
  )
  const sweep = LAMBDA_SWEEP.map((lambda) => {
    const perCand = candidates.map((cand) => {
      const pvd = pairedValueDelta(incRows, armRows(cand.name), lambda)
      const lb = hcopeLowerBound(pvd.deltas, HCOPE_DELTA)
      const negCtl = controlDeltaAcc(cand.name, NEG_CONTROL_CATS)
      const posCtl = controlDeltaAcc(cand.name, POS_CONTROL_CATS)
      const neutralCtl = controlDeltaAcc(cand.name, NEUTRAL_CATS)
      const verdict = gateVerdict({
        valueDeltaLB: lb.lowerBound,
        negControlDeltaAcc: negCtl.delta,
        negControlN: negCtl.n,
        posControlDeltaAcc: posCtl.delta,
        sigma: JUDGE_SIGMA,
      })
      console.log(
        `  λ=${lambda}  ${cand.name.padEnd(13)} Δvalue=${r4(pvd.meanDelta)} LB=${r4(lb.lowerBound)} negΔacc(multihop)=${r4(negCtl.delta)}(n=${negCtl.n}) posΔacc(temp/sh/adv)=${r4(posCtl.delta)} neutralΔacc(od)=${r4(neutralCtl.delta)} ⇒ ${verdict.winner}`,
      )
      return {
        cand: cand.name,
        n: pvd.n,
        meanValueDelta: r4(pvd.meanDelta),
        ciValueDelta: r4(pvd.ciDelta),
        valueDeltaLB: r4(lb.lowerBound),
        negControlDeltaAcc: r4(negCtl.delta),
        negControlN: negCtl.n,
        posControlDeltaAcc: r4(posCtl.delta),
        neutralDeltaAcc: r4(neutralCtl.delta),
        winner: verdict.winner,
      }
    })

    // C3 — ROUTER-AS-POLICY, evaluated at the SAME λ with ZERO extra spawns: per item the deterministic
    // router (arm-router.ts) picks an arm; the policy's row IS that arm's already-scored row. Judged by
    // the identical gate (paired value delta → HCOPE LB → controls). REPORT ONLY — the live default stays
    // exploit-only hybrid until John certifies + flips (AGENTS.md #9).
    const routerPicks: Record<string, number> = Object.fromEntries(
      FRONTIER_ARMS.map((a) => [a.name, 0]),
    )
    const routerRows: ArmFrontierRow[] = items.map((it, i) => {
      const conv = convs[it.convIdx]!
      const d = routeQueryArm(conv.vault.db, it.question, { gazetteer: conv.gaz, lambda })
      routerPicks[d.arm] = (routerPicks[d.arm] ?? 0) + 1
      const r = rowsByArm[d.arm]![i]!
      return { category: r.category, score: r.score, contextTokens: r.contextTokens }
    })
    const controlDeltaAccRows = (
      rows: readonly ArmFrontierRow[],
      cats: ReadonlySet<number>,
    ): { delta: number; n: number } => {
      const deltas: number[] = []
      for (let i = 0; i < items.length; i++) {
        if (!cats.has(items[i]!.category)) continue
        const b = incRows[i]!
        const c = rows[i]!
        if (b.score < 0 || c.score < 0) continue
        deltas.push(c.score - b.score)
      }
      return { delta: deltas.length ? mean(deltas) : 0, n: deltas.length }
    }
    const rpvd = pairedValueDelta(incRows, routerRows, lambda)
    const rlb = hcopeLowerBound(rpvd.deltas, HCOPE_DELTA)
    const rNeg = controlDeltaAccRows(routerRows, NEG_CONTROL_CATS)
    const rPos = controlDeltaAccRows(routerRows, POS_CONTROL_CATS)
    const rNeutral = controlDeltaAccRows(routerRows, NEUTRAL_CATS)
    const rVerdict = gateVerdict({
      valueDeltaLB: rlb.lowerBound,
      negControlDeltaAcc: rNeg.delta,
      negControlN: rNeg.n,
      posControlDeltaAcc: rPos.delta,
      sigma: JUDGE_SIGMA,
    })
    console.log(
      `  λ=${lambda}  ${'router'.padEnd(13)} Δvalue=${r4(rpvd.meanDelta)} LB=${r4(rlb.lowerBound)} negΔacc(multihop)=${r4(rNeg.delta)}(n=${rNeg.n}) posΔacc(temp/sh/adv)=${r4(rPos.delta)} neutralΔacc(od)=${r4(rNeutral.delta)} picks=${JSON.stringify(routerPicks)} ⇒ ${rVerdict.winner}`,
    )
    perCand.push({
      cand: 'router',
      n: rpvd.n,
      meanValueDelta: r4(rpvd.meanDelta),
      ciValueDelta: r4(rpvd.ciDelta),
      valueDeltaLB: r4(rlb.lowerBound),
      negControlDeltaAcc: r4(rNeg.delta),
      negControlN: rNeg.n,
      posControlDeltaAcc: r4(rPos.delta),
      neutralDeltaAcc: r4(rNeutral.delta),
      winner: rVerdict.winner,
      ...({ routerPicks } as object),
    })
    return { lambda, candidates: perCand }
  })

  // whichArmWon at λ=0 (pure accuracy) and λ=0.25 (mid) over per-item value (drops → −∞ so a dropped arm never wins).
  const valueByArmAt = (lambda: number): Record<string, number[]> => {
    const out: Record<string, number[]> = {}
    for (const arm of FRONTIER_ARMS) {
      out[arm.name] = rowsByArm[arm.name]!.map((r) =>
        r.score >= 0
          ? r.score - lambda * (r.contextTokens / LAMBDA_TOKEN_UNIT)
          : Number.NEGATIVE_INFINITY,
      )
    }
    return out
  }
  const won0 = whichArmWon(valueByArmAt(0), ARM_INCUMBENT)
  const wonMid = whichArmWon(valueByArmAt(0.25), ARM_INCUMBENT)
  console.log(`\n  whichArmWon λ=0 (accuracy): ${JSON.stringify(won0.tally)}`)
  console.log(`  whichArmWon λ=0.25 (value): ${JSON.stringify(wonMid.tally)}`)

  const anyWinner = sweep.some((s) => s.candidates.some((c) => c.winner === 'candidate'))
  console.log(
    `\n  VERDICT: ${
      anyWinner
        ? 'at least one candidate arm posts a certified win at some λ — the evidence arbiter decides promotion (FR-026)'
        : 'no candidate arm certifies a win vs the incumbent at any swept λ ⇒ measured NULL (incumbent hybrid stands)'
    }${thinProbe ? ' [CONFIRMATORY-ONLY — thin probe, not a powered verdict]' : ''}`,
  )

  // ── T037 [US3] — the automated EVIDENCE ARBITER (FR-026), strictly bounded (FR-027) ────────────
  // Promotion requires DOMINANCE (one candidate is the certified winner at EVERY swept λ — no
  // human λ pick needed) on a HELD-OUT, adequately-powered run. Enactment writes ONLY the routing
  // policy record via commitRoutingPolicy, which itself refuses uncertified evidence (LB ≤ 0,
  // failing/unmeasured controls, no σ, <2 deterministic runs, higher cost) and any guardrail path —
  // so even a buggy caller cannot promote on assumption or touch a safety file. During arbiter
  // bring-up (research.md D5) the decision runs SHADOW/advisory unless SCNS_ARBITER_ENACT=1; det×2
  // is attested via SCNS_ARBITER_DET_RUNS after two identical gate runs.
  const winnersAtEveryLambda = FRONTIER_ARMS.map((a) => a.name)
    .filter((name) => name !== ARM_INCUMBENT)
    .concat(['router'])
    .filter((cand) =>
      sweep.every((s) => s.candidates.some((c) => c.cand === cand && c.winner === 'candidate')),
    )
  const dominantArm = winnersAtEveryLambda.length === 1 ? winnersAtEveryLambda[0]! : null
  const lambda0 = sweep.find((s) => s.lambda === 0) ?? sweep[0]!
  const domRow = dominantArm ? lambda0.candidates.find((c) => c.cand === dominantArm) : undefined
  const domTok = dominantArm ? perArm.find((a) => a.name === dominantArm)?.tokO200k : undefined
  const incTok = perArm.find((a) => a.name === ARM_INCUMBENT)?.tokO200k ?? 0
  const detRuns = Number(process.env.SCNS_ARBITER_DET_RUNS ?? '1') || 1
  const arbiterPolicyPath =
    process.env.SCNS_ROUTING_POLICY_PATH ??
    join(homedir(), '.scns', 'policy', 'routing-policy.json')
  let arbiterDecision: 'promote' | 'shadow-advise' | 'hold-incumbent' = 'hold-incumbent'
  let arbiterEnacted = false
  let arbiterReason = 'no dominant certified winner across the λ sweep — incumbent hybrid stands'
  if (dominantArm && domRow && heldOut && !thinProbe) {
    const evidence = {
      deltaAcc: Number(domRow.meanValueDelta),
      sigma: JUDGE_SIGMA,
      hcopeLowerBound: Number(domRow.valueDeltaLB),
      controlsPass: true, // winner ⇒ gateVerdict already required neg-controls clean + measured
      negControlN: Number(domRow.negControlN ?? 0),
      meanTokensDelta: (domTok ?? 0) - incTok,
      deterministicRuns: detRuns,
      gate: 'arm-frontier-accuracy',
      heldOut,
    }
    if (process.env.SCNS_ARBITER_ENACT === '1') {
      const res = commitRoutingPolicy(arbiterPolicyPath, {
        arm: dominantArm as never,
        committedAt: new Date().toISOString(),
        evidence,
      })
      arbiterEnacted = res.committed
      arbiterDecision = res.committed ? 'promote' : 'hold-incumbent'
      arbiterReason = res.committed
        ? `promoted ${dominantArm} — grounding evidence recorded at ${arbiterPolicyPath}`
        : `enactment refused by commitRoutingPolicy: ${res.reason}`
    } else {
      arbiterDecision = 'shadow-advise'
      arbiterReason = `dominant certified winner ${dominantArm} — SHADOW (arbiter bring-up; set SCNS_ARBITER_ENACT=1 after a second identical run + SCNS_ARBITER_DET_RUNS=2 to enact)`
    }
  } else if (dominantArm && (!heldOut || thinProbe)) {
    arbiterReason = `dominant winner ${dominantArm} but the run is ${heldOut ? 'under-powered (thin probe)' : 'NOT held-out'} — never certifiable`
  }
  console.log(
    `\nARBITER_JSON: ${JSON.stringify({
      decision: arbiterDecision,
      enacted: arbiterEnacted,
      dominantArm,
      reason: arbiterReason,
      policyPath: arbiterPolicyPath,
      sigma: JUDGE_SIGMA,
      detRuns,
    })}`,
  )
  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'arm-frontier-accuracy',
      note: 'JUDGED multi-arm gate; flips NO default, modifies NO retrieval behavior; winner = REPORT only (AWAITING-JOHN + λ)',
      confirmatoryOnly: thinProbe,
      heldOut,
      snapshot: FRONTIER_SNAPSHOT,
      sampleIds: convs.map((c) => c.sample.sample_id),
      preCheck: { materialized: pre.materialized, persisted: pre.persisted },
      judgeSigmaReused: JUDGE_SIGMA,
      hcopeDelta: HCOPE_DELTA,
      incumbent: ARM_INCUMBENT,
      nItems: items.length,
      byCategory: countByCat(items),
      perArm,
      posControlCats: [...POS_CONTROL_CATS],
      negControlCats: [...NEG_CONTROL_CATS],
      neutralCats: [...NEUTRAL_CATS],
      lambdaSweep: sweep,
      whichArmWon: { lambda0_accuracy: won0.tally, 'lambda0.25_value': wonMid.tally },
      anyCertifiedWinner: anyWinner,
      deferred:
        'IS-weighted HCOPE / Doubly-Robust / CRM off-policy estimation over LOGGED traffic for a LEARNED router (Phase C head)',
    })}`,
  )
  for (const c of convs) c.vault.db.close()
}

// repro-accuracy: T030 MAGMA-only reproduction read. This is NOT a comparative arm gate: Hybrid MUST NOT
// run here. It reopens the existing held-out frontier snapshot and scores the faithful magma path only.

/** One reproduction arm's judged rows + aggregates (magma / full-context / scrambled all share this shape). */
interface ScoredReproArm {
  readonly rows: JudgeEvalRow[]
  readonly agg: ReturnType<typeof aggregateAccuracy>
  readonly ci: ReturnType<typeof meanCI>
  readonly perCatAcc: Record<number, number>
  readonly perCategory: Record<string, { n: number; accuracy: number }>
}

/** Score one retrieval config over the SAME bound items (magma, the full-context ordering arm, or the
 *  scrambled-graph arm over scrambled convs) — logging per-item + per-category so every arm is quotable. */
async function scoreReproArm(
  label: string,
  items: readonly ArmBItem[],
  convs: readonly ConvRecord[],
  config: Parameters<typeof scoreItem>[2],
): Promise<ScoredReproArm> {
  const rows: JudgeEvalRow[] = []
  console.log(`\n  ── ${label} ${JSON.stringify(config)} ──`)
  for (const it of items) {
    const { row } = await scoreItem(it, convs[it.convIdx]!, config)
    rows.push(row)
    console.log(
      `  ${label}[cat${it.category}] score=${row.score >= 0 ? r4(row.score) : 'DROP'} tok=${row.contextTokens} ${row.latencyMs}ms`,
    )
  }
  const agg = aggregateAccuracy(rows)
  const ci = meanCI(rows.filter((r) => r.score >= 0).map((r) => r.score))
  const perCatAcc: Record<number, number> = {}
  const perCategory = Object.fromEntries(
    [1, 2, 3, 4, 5].map((cat) => {
      const catAgg = aggregateAccuracy(rows.filter((r) => r.category === cat))
      const accuracy = r4(catAgg.meanScore)
      perCatAcc[cat] = catAgg.meanScore
      console.log(`    ${label} cat${cat}: n=${catAgg.nScored} meanScore=${accuracy}`)
      return [`cat${cat}`, { n: catAgg.nScored, accuracy }]
    }),
  ) as Record<string, { n: number; accuracy: number }>
  return { rows, agg, ci, perCatAcc, perCategory }
}

/** Per-conv degradation the scramble applied — the deterministic-verify proof + RESULTS_JSON quote this. */
interface ScrambleConvReport {
  readonly conv: number
  /** memory_edges rows with a dst_chunk endpoint (temporal + causal + semantic) — the chunk→chunk typed edges
   *  the beam walks (entity edges use dst_entity, not dst_chunk, and are NOT scrambled). */
  readonly totalEdges: number
  /** endpoints actually re-paired (topology destroyed). */
  readonly changed: number
  readonly byType: Array<{ edgeType: string; edges: number; changed: number }>
}

/**
 * Build a SCRAMBLED copy of the frontier snapshot for the negative control — NEVER mutates the snapshot.
 * Copies each `conv-*.db` + the manifest into `destDir`, then destroys the typed-edge TOPOLOGY of every
 * dst_chunk-bearing edge — i.e. ALL chunk→chunk typed edges: temporal + causal + semantic (entity edges use
 * dst_entity and are left intact) — via {@link planEdgeScramble} (permute dst_chunk WITHIN each edge_type:
 * per-type count/src-out-degree/dst-multiset preserved, FK-safe). Deterministic in `seed` (mulberry32). The
 * caller reopens `destDir` with {@link loadFrontierConvsFromSnapshot} and runs the magma config over it.
 * Returns per-conv, per-edge_type degradation counts so the run can quote which tiers actually changed.
 */
function scrambleSnapshotGraph(
  snapshotDir: string,
  convCount: number,
  destDir: string,
  seed: number,
): ScrambleConvReport[] {
  mkdirSync(destDir, { recursive: true })
  copyFileSync(join(snapshotDir, FRONTIER_MANIFEST), join(destDir, FRONTIER_MANIFEST))
  const rng = mulberry32(seed)
  const reports: ScrambleConvReport[] = []
  for (let i = 0; i < convCount; i++) {
    copyFileSync(join(snapshotDir, `conv-${i}.db`), join(destDir, `conv-${i}.db`))
    const db = openMemoryDb(join(destDir, `conv-${i}.db`))
    try {
      const edges = db
        .prepare(
          `SELECT id, edge_type AS edgeType, dst_chunk AS dstChunk
             FROM memory_edges WHERE dst_chunk IS NOT NULL ORDER BY id`,
        )
        .all() as EdgeEndpoint[]
      const plan = planEdgeScramble(edges, rng)
      const update = db.prepare('UPDATE memory_edges SET dst_chunk = ? WHERE id = ?')
      const apply = db.transaction((entries: readonly { id: number; newDstChunk: number }[]) => {
        for (const e of entries) update.run(e.newDstChunk, e.id)
      })
      apply(plan)
      const changedIds = new Set(plan.map((p) => p.id))
      const typeCounts = new Map<string, { edges: number; changed: number }>()
      for (const e of edges) {
        const t = typeCounts.get(e.edgeType) ?? { edges: 0, changed: 0 }
        t.edges++
        if (changedIds.has(e.id)) t.changed++
        typeCounts.set(e.edgeType, t)
      }
      reports.push({
        conv: i,
        totalEdges: edges.length,
        changed: plan.length,
        byType: [...typeCounts.entries()].map(([edgeType, v]) => ({
          edgeType,
          edges: v.edges,
          changed: v.changed,
        })),
      })
    } finally {
      db.close()
    }
  }
  return reports
}

async function runReproAccuracy(samples: readonly LocomoSample[]): Promise<void> {
  if (!FRONTIER_SNAPSHOT)
    throw new Error('repro-accuracy requires SCNS_FRONTIER_SNAPSHOT=<dir> from frontier-ingest')
  console.log(
    `\n=== REPRO-ACCURACY (T030 MAGMA-only judged reproduction; no hybrid/comparative arms) :: snapshot ${FRONTIER_SNAPSHOT} ===`,
  )
  // Snapshot-integrity guard: capture conv-*.db mtimes BEFORE any open. The read arms only SELECT and the
  // scramble runs on COPIES, so these must be byte-for-byte unchanged at the end (asserted below).
  const snapMtimesStart = new Map<string, number>()
  for (let i = 0; existsSync(join(FRONTIER_SNAPSHOT, `conv-${i}.db`)); i++)
    snapMtimesStart.set(`conv-${i}.db`, statSync(join(FRONTIER_SNAPSHOT, `conv-${i}.db`)).mtimeMs)
  const convs = loadFrontierConvsFromSnapshot(samples, FRONTIER_SNAPSHOT)
  const items = bindArmFrontierItems(convs)
  const pre = frontierPreCheck(convs, items.length)
  console.log(
    `  bound ${items.length} native LoCoMo QA items (${countByCat(items)}); PRE-CHECK causal materialized=${pre.materialized}/persisted=${pre.persisted}`,
  )

  if (!pre.substrate.preCheckOk) {
    console.log(`\n  ${SUBSTRATE_STOP_MESSAGE}`)
    console.log(
      `\nRESULTS_JSON: ${JSON.stringify({
        mode: 'repro-accuracy',
        reproduction: {
          overall: null,
          full_context_overall: null,
          perCategory: Object.fromEntries(
            [1, 2, 3, 4, 5].map((c) => [`cat${c}`, { n: 0, accuracy: null }]),
          ),
          band_pass: false,
          category_pattern_pass: false,
          ordering_pass: null,
          substrate_pass: false,
          scrambled_control: null,
          diagnostics: {
            anchor_retention: 1,
            anchor_retention_source: 'T021 unit-test-proven',
            mean_tokens_per_query: null,
          },
          verdict: 'BLOCKED',
          reason: 'substrate below density floor — MAGMA reproduction read refused',
          substrate: {
            perConv: pre.materializedPerConv,
            perConvMin: pre.substrate.perConvMin,
            meanPerConv: pre.substrate.materializedPerConv,
            perWhyItem: pre.substrate.perWhyItem,
            floor: pre.substrate.floor,
          },
        },
      })}`,
    )
    for (const c of convs) c.vault.db.close()
    return
  }

  const magmaConfig = {
    intentRouting: false,
    traverse: true,
    traversalOptions: { maxDepth: WHY_BEAM_MAX_DEPTH, budget: WHY_BEAM_BUDGET },
    synthesize: true,
    maxTokens: MAGMA_STAGE4_MAX_TOKENS, // serialize-all-visited → Eq-7 token budget (augment, not swap)
  } as const

  // ── ARM 1: MAGMA (the reproduction subject) — Eq-7 ordered + salience-token-budgeted briefing ──
  const magma = await scoreReproArm('magma', items, convs, magmaConfig)

  // ── ARM 2: FULL-CONTEXT ordering POSITIVE control — the SAME retrieved subgraph as magma (returnBudget
  // forces serialize-all-visited even with synthesize:false) but injected as PLAIN, unordered, effectively
  // unbudgeted context (no Eq-7). If magma's ordered+budgeted briefing preserves answer accuracy at far
  // fewer tokens, Stage-4 linearization/budgeting is "free" (the paper's efficiency claim). ──
  const FULL_CONTEXT_MAX_CHARS = 200000
  const fullContextConfig = {
    intentRouting: false,
    traverse: true,
    traversalOptions: { maxDepth: WHY_BEAM_MAX_DEPTH, budget: WHY_BEAM_BUDGET },
    synthesize: false,
    returnBudget: WHY_BEAM_BUDGET,
    maxChars: FULL_CONTEXT_MAX_CHARS,
  } as const
  const fullContext = await scoreReproArm('full-context', items, convs, fullContextConfig)

  // ── ARM 3: SCRAMBLED-GRAPH NEGATIVE control — magma over a COPY of the snapshot whose chunk→chunk typed-edge
  // topology has been destroyed (dst_chunk permuted within each edge_type — temporal + causal + semantic;
  // counts/types/degrees preserved; entity co-occurrence edges use dst_entity and are left intact). Copies
  // ONLY (the snapshot is never mutated). If scrambling degrades magma ≥ σ, the chunk→chunk GRAPH STRUCTURE
  // contributes; if it does NOT, that structure is inert for retrieval — either way reported honestly. ──
  const SCRAMBLE_SEED = Number(process.env.SCNS_SCRAMBLE_SEED ?? '20260707') || 20260707
  const scrambledDir = join(ISO || FRONTIER_SNAPSHOT, 'repro-scrambled')
  const scrambleReport = scrambleSnapshotGraph(
    FRONTIER_SNAPSHOT,
    convs.length,
    scrambledDir,
    SCRAMBLE_SEED,
  )
  console.log(
    `\n  scramble (seed=${SCRAMBLE_SEED}) → ${scrambledDir}: ${scrambleReport
      .map(
        (r) =>
          `conv-${r.conv} ${r.changed}/${r.totalEdges} re-paired [${r.byType
            .map((t) => `${t.edgeType} ${t.changed}/${t.edges}`)
            .join(', ')}]`,
      )
      .join(' · ')}`,
  )
  const scrambledConvs = loadFrontierConvsFromSnapshot(samples, scrambledDir)
  let scrambled: ScoredReproArm
  try {
    scrambled = await scoreReproArm('scrambled', items, scrambledConvs, magmaConfig)
  } finally {
    for (const c of scrambledConvs) c.vault.db.close()
  }

  // ── legs + FINAL verdict (contract). ordering/scrambled are now MEASURED (never null). ──
  const bandPass = reproductionBand(magma.agg.meanScore)
  const categoryPatternPass = reproductionCategoryPattern(magma.perCatAcc)
  const orderingPass = reproductionOrderingPass(magma.agg.meanScore, fullContext.agg.meanScore)
  const scrambledDelta = magma.agg.meanScore - scrambled.agg.meanScore
  const scrambledPass = reproductionScrambledControl(
    magma.agg.meanScore,
    scrambled.agg.meanScore,
    JUDGE_SIGMA,
  )
  const verdict = reproductionVerdict({
    bandPass,
    categoryPatternPass,
    orderingPass,
    scrambledPass,
    substratePass: true,
  })

  for (const c of convs) c.vault.db.close()
  // Snapshot-integrity assertion (the scramble ran on copies; the read arms only SELECT).
  let snapshotUnchanged = true
  for (const [name, m0] of snapMtimesStart) {
    if (statSync(join(FRONTIER_SNAPSHOT, name)).mtimeMs !== m0) snapshotUnchanged = false
  }

  console.log(
    `\n  MAGMA reproduction: overall=${r4(magma.agg.meanScore)} ± ${r4(magma.ci.ci)} (95% CI) n=${magma.agg.nScored} dropped=${magma.agg.nDropped}` +
      `\n  full-context(ordering)=${r4(fullContext.agg.meanScore)} → ordering_pass=${orderingPass} (magma ≥ full − 0.05)` +
      `\n  scrambled(negative)=${r4(scrambled.agg.meanScore)} → Δ=${r4(scrambledDelta)} vs σ=${JUDGE_SIGMA} → scrambled_control=${scrambledPass}` +
      `\n  band_pass=${bandPass}; category_pattern_pass=${categoryPatternPass}; substrate_pass=true; snapshot_unchanged=${snapshotUnchanged}` +
      `\n  ⇒ VERDICT=${verdict}`,
  )

  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'repro-accuracy',
      snapshot: FRONTIER_SNAPSHOT,
      sampleIds: convs.map((c) => c.sample.sample_id),
      nItems: items.length,
      byCategory: countByCat(items),
      reproduction: {
        overall: r4(magma.agg.meanScore),
        overall_ci95: r4(magma.ci.ci),
        full_context_overall: r4(fullContext.agg.meanScore),
        scrambled_overall: r4(scrambled.agg.meanScore),
        scrambled_delta: r4(scrambledDelta),
        perCategory: magma.perCategory,
        full_context_perCategory: fullContext.perCategory,
        scrambled_perCategory: scrambled.perCategory,
        band_pass: bandPass,
        category_pattern_pass: categoryPatternPass,
        ordering_pass: orderingPass,
        scrambled_control: scrambledPass,
        substrate_pass: true,
        diagnostics: {
          anchor_retention: 1,
          anchor_retention_source: 'T021 unit-test-proven',
          mean_tokens_per_query: Math.round(magma.agg.meanContextTokens),
          full_context_mean_tokens: Math.round(fullContext.agg.meanContextTokens),
          scrambled_mean_tokens: Math.round(scrambled.agg.meanContextTokens),
          judge_sigma: JUDGE_SIGMA,
          scramble_seed: SCRAMBLE_SEED,
          scramble_report: scrambleReport,
          snapshot_unchanged: snapshotUnchanged,
        },
        verdict,
      },
    })}`,
  )
}

// arm-explore: B-EXPLORE §7b ε-router over the judged snapshot. Samples ONE arm per item (bounded),
// runs+judges it, and logs explore_arm + propensity + the judged outcome so a later off-policy estimator
// (IPS/DR/HCOPE) has real tuples. DEFAULT-OFF: requires SCNS_EXPLORE_ROUTING=1 (the router gate). This is
// the ONLY place the router is exercised — the LIVE prompt path stays exploit-only hybrid (decision C).
async function runArmExplore(devSamples: readonly LocomoSample[]): Promise<void> {
  if (!FRONTIER_SNAPSHOT)
    throw new Error('arm-explore requires SCNS_FRONTIER_SNAPSHOT=<dir> from frontier-ingest')
  if (!isExploreRoutingEnabled()) {
    throw new Error(
      'arm-explore requires SCNS_EXPLORE_ROUTING=1 — the ε-router is DEFAULT-OFF; this mode is the sanctioned way to turn it on for OFFLINE data collection (live traffic is NEVER routed by it)',
    )
  }
  const store = getHarnessStore()
  if (!store)
    throw new Error(
      'arm-explore requires the experience store (do not set SCNS_EXPERIENCE_STORE=0)',
    )
  console.log(
    `\n=== ARM-EXPLORE (§7b ε-router, ε=${EXPLORE_EPSILON}, seed=${EXPLORE_SEED}, bound ≤${DEFAULT_MAX_EXPLORATIONS_24H}/24h + per-process) :: snapshot ${FRONTIER_SNAPSHOT} ===`,
  )
  const convs = loadFrontierConvsFromSnapshot(devSamples, FRONTIER_SNAPSHOT)
  const items = bindArmFrontierItems(convs)
  console.log(
    `  bound ${items.length} probe items (${countByCat(items)}); hybrid stays the exploit default — variant arms are LOGGED, never made default`,
  )

  const rng = mulberry32(EXPLORE_SEED)
  let processCount = 0
  const armCounts: Record<string, number> = Object.fromEntries(
    FRONTIER_ARMS.map((a) => [a.name, 0]),
  )
  for (const it of items) {
    const decision = selectExplorationArm({
      rng,
      epsilon: EXPLORE_EPSILON,
      explorations24h: countExplorations24h(store),
      processCount,
    })
    const armName = decision.explore ? decision.arm! : 'hybrid'
    const cfg = FRONTIER_ARMS.find((a) => a.name === armName)!.config
    if (decision.explore) processCount++
    const { row } = await scoreItem(
      it,
      convs[it.convIdx]!,
      cfg,
      decision.explore ? { exploreArm: decision.arm!, propensity: decision.propensity } : undefined,
    )
    armCounts[armName] = (armCounts[armName] ?? 0) + 1
    console.log(
      `  [cat${it.category}] arm=${armName}${decision.explore ? ` p=${r4(decision.propensity)}` : ' (exploit)'} score=${row.score >= 0 ? r4(row.score) : 'DROP'} tok=${row.contextTokens}`,
    )
  }
  console.log(
    `\n  exploration slice: ${processCount}/${items.length} explored; arm distribution ${JSON.stringify(armCounts)}`,
  )
  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'arm-explore',
      note: 'ε-router OFFLINE data-collection; flips NO default; LIVE stays exploit-only hybrid (decision C). explore_arm + propensity + judged outcome logged to the experience store for later off-policy correction.',
      epsilon: EXPLORE_EPSILON,
      seed: EXPLORE_SEED,
      bound: { max24h: DEFAULT_MAX_EXPLORATIONS_24H },
      nItems: items.length,
      explored: processCount,
      armCounts,
    })}`,
  )
  for (const c of convs) c.vault.db.close()
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const dataPath = process.argv[2] ?? DEFAULT_DATA
  refuseIfLive(dataPath)
  const liveMtimeStart = existsSync(LIVE_VAULT) ? statSync(LIVE_VAULT).mtimeMs : null

  // Default-OFF: gate ALL real spawns behind both flags. A dry run spawns nothing and touches nothing.
  // EXEMPTION: the DETERMINISTIC token axes (`frontier-tokens`, `arm-frontier-tokens`) retrieve + tokenize
  // only (NO generator/judge spawn), so they run without the flags (they need only the snapshot + BGE worker).
  const DETERMINISTIC_MODES = new Set(['frontier-tokens', 'arm-frontier-tokens'])
  if (!DETERMINISTIC_MODES.has(MODE) && (!isJudgeEnabled() || !isQaGeneratorEnabled())) {
    console.log(
      'generator/judge default-OFF — set SCNS_LLM_JUDGE=1 SCNS_QA_GENERATOR=1 to run real spawns (no spawn performed)',
    )
    process.exit(0)
  }

  const maxConv = Number(process.env.SCNS_LOCOMO_CONVERSATIONS ?? '0') || 0
  const samples = await loadLocomoSamples(dataPath, { maxConv })
  const devSamples = samples.slice(0, DEV_CONV)

  const isoRoot = join(process.cwd(), '.copilot-scratch')
  mkdirSync(isoRoot, { recursive: true })
  ISO = mkdtempSync(join(isoRoot, 'scns-judge-iso-'))
  generator = createAcpQaGenerator({
    cwd: ISO,
    model: process.env[GEN_MODEL_ENV],
    createClient: trackingCreate,
  })
  judge = createAcpJudge({
    cwd: ISO,
    model: process.env[JUDGE_MODEL_ENV],
    createClient: trackingCreate,
  })

  console.log(
    `=== LoCoMo LLM-Judge harness :: mode=${MODE} :: DEV=${devSamples.length} conv (held-out ${Math.max(0, samples.length - DEV_CONV)}) ===`,
  )
  console.log(
    `ISO spawn cwd: ${ISO} | gen model: ${process.env[GEN_MODEL_ENV] ?? '(session default)'} | judge model: ${process.env[JUDGE_MODEL_ENV] ?? '(session default)'}`,
  )

  let runError: unknown
  try {
    if (MODE === 'smoke') await runSmoke()
    else if (MODE === 'controls') await runControls(devSamples)
    else if (MODE === 'variance') await runVariance(devSamples)
    else if (MODE === 'baseline') await runBaseline(devSamples)
    else if (MODE === 'armb') await runArmB(devSamples)
    else if (MODE === 'whyeval') await runWhyEval(devSamples)
    // Frontier sub-modes select their own WHY-relevant convs (conv-26/conv-30) from the FULL sample list,
    // so they are independent of the DEV_CONV slice (which could otherwise drop a WHY conversation).
    else if (MODE === 'frontier-ingest') await runFrontierIngest(samples)
    else if (MODE === 'cert-ingest') await runCertIngest(samples)
    else if (MODE === 'frontier-tokens') await runFrontierTokens(samples)
    else if (MODE === 'frontier-accuracy') await runFrontierAccuracy(samples)
    else if (MODE === 'arm-frontier-tokens') await runArmFrontierTokens(samples)
    else if (MODE === 'arm-frontier-accuracy') await runArmFrontierAccuracy(samples)
    else if (MODE === 'repro-accuracy') await runReproAccuracy(samples)
    else if (MODE === 'arm-explore') await runArmExplore(samples)
    else
      throw new Error(
        `unknown SCNS_JUDGE_MODE '${MODE}' (want smoke|controls|variance|baseline|armb|whyeval|frontier-ingest|cert-ingest|frontier-tokens|frontier-accuracy|arm-frontier-tokens|arm-frontier-accuracy|repro-accuracy|arm-explore)`,
      )
  } catch (err) {
    runError = err
    console.error(`run error: ${String(err)}`)
  } finally {
    resetEmbeddingClient()
    await delay(2000) // let close()'s SIGTERM land so a cleanly-terminating spawn isn't misread as a stray
    const g = spawnGuardReport()
    console.log(
      `\nspawn guard: ${g.spawned} ephemeral ACP process(es) spawned; still-alive ${g.alive}; strays killed-by-pid ${g.strayKilled}; exit-signalled ${g.exitedSignalled}`,
    )
    try {
      rmSync(ISO, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    console.log(`ISO cleaned (zero-pollution): ${ISO && !existsSync(ISO) ? 'YES ✓' : 'NO ✗'}`)
  }

  const liveMtimeEnd = existsSync(LIVE_VAULT) ? statSync(LIVE_VAULT).mtimeMs : null
  const liveOk = liveMtimeStart === liveMtimeEnd
  console.log(
    `live vault mtime unchanged: ${liveOk ? 'YES ✓' : 'NO ✗'} (${liveMtimeStart} → ${liveMtimeEnd})`,
  )
  if (runError) process.exit(1)
  if (!liveOk) process.exit(2)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
