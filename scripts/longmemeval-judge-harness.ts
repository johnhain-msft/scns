/**
 * LongMemEval judge harness (T019 [US1], specs/001-learning-memory-loop) — the HELD-OUT go-live gate
 * for output-changing retrieval flips, mirroring `locomo-judge-harness.ts` on the RIGHT axis:
 * blind LLM-judge ANSWER accuracy + real o200k context tokens. NEVER retrieval recall.
 *
 * Benchmark: LongMemEval (Wu et al. 2024, arXiv:2410.10813). Dataset auto-downloads to
 * `/tmp/longmemeval_oracle.json` from the official HF mirror when absent (pass a path to use the
 * larger `_s`/`_m` haystacks downloaded manually from huggingface.co/datasets/xw27/longmemeval).
 *
 * Usage:  npx tsx scripts/longmemeval-judge-harness.ts [/tmp/longmemeval_oracle.json] <mode>
 * Modes (SCNS_JUDGE_MODE or argv[3]):
 *   - smoke    — 1 instance end-to-end: retrieve→generate→judge, pos/neg plumbing check.
 *   - controls — R2 anti-self-grading controls over N/type items: pos (own gold) ≫ neg (other gold).
 *   - judge    — per-question-type + overall {accuracy, tokens, n} over SCNS_LME_N instances.
 * Gates: judge/generator spawn ONLY behind SCNS_LLM_JUDGE=1 / SCNS_QA_GENERATOR=1 (deny-all,
 * ephemeral, isolated cwd — inherited from judge-acp/qa-generator-acp). σ is a property of the JUDGE
 * MODEL (SCNS_JUDGE_SIGMA, established via the LoCoMo variance mode under the pinned model); any
 * Δ-vs-baseline claim must exceed it.
 * Guards: never the live vault (refuseIfLive on the dataset path; every vault is a fresh mkdtemp);
 * generator + injection budget held FIXED across arms (RETRIEVAL_TOPK/RETRIEVAL_MAX_CHARS — identical
 * to the LoCoMo ruler).
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  utimesSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseLmeInstances,
  sessionsToDocs,
  lmeToControlItems,
  aggregateByType,
  type LmeInstance,
  type LmeAccuracyRow,
} from './longmemeval-judge-lib.js'
import {
  buildControlPairs,
  controlsVerdict,
  evaluateItem,
  pickPerCategory,
  type JudgeEvalDeps,
} from './locomo-judge-lib.js'
import { refuseIfLive, mean, parseSessionDateTime } from './locomo-corpus.js'
import { openMemoryDb } from '../src/memory/db.js'
import { createVault } from '../src/memory/vault.js'
import { indexVault } from '../src/memory/indexer.js'
import { retrieveContext, makeHybridBaseSearch } from '../src/memory/retrieval-context.js'
import { makeSemanticRelevanceScorer } from '../src/memory/semantic-relevance.js'
import { classifyIntent } from '../src/memory/intent.js'
import { SCNS_GAZETTEER } from '../src/memory/entities/gazetteer.js'
import {
  createAcpQaGenerator,
  isQaGeneratorEnabled,
  GEN_MODEL_ENV,
} from '../src/memory/qa-generator-acp.js'
import { createAcpJudge, isJudgeEnabled, JUDGE_MODEL_ENV } from '../src/memory/judge-acp.js'
import type Database from 'better-sqlite3'

export const LME_DATA_URL =
  'https://huggingface.co/datasets/xw27/longmemeval/resolve/main/longmemeval_oracle.json'
export const LME_DEFAULT_DATA = join(tmpdir(), 'longmemeval_oracle.json')

// Identical injection budget to the LoCoMo ruler — the generator + budget are held FIXED (spec B3).
const RETRIEVAL_TOPK = 5
const RETRIEVAL_MAX_CHARS = 4000
// σ is judge-model-scoped (measured via the LoCoMo variance mode under the PINNED judge model —
// claude-opus-4.8 → 0.0267, 2026-07-03); re-establish before trusting a Δ under any other model.
const JUDGE_SIGMA = Number(process.env.SCNS_JUDGE_SIGMA ?? 0.0267)
const CONTROLS_N = Number(process.env.SCNS_LME_CONTROLS_N ?? 2) // per question type
const JUDGE_N = Number(process.env.SCNS_LME_N ?? 12) // instances graded in judge mode

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4

async function loadLmeInstances(dataPath: string): Promise<LmeInstance[]> {
  refuseIfLive(dataPath)
  if (!existsSync(dataPath)) {
    console.log(`dataset absent → downloading LongMemEval (oracle split) to ${dataPath} …`)
    const res = await fetch(LME_DATA_URL)
    if (!res.ok)
      throw new Error(
        `download failed: ${res.status} ${res.statusText} — fetch it manually from ` +
          `huggingface.co/datasets/xw27/longmemeval and pass the path as argv[2]`,
      )
    writeFileSync(dataPath, Buffer.from(await res.arrayBuffer()))
  }
  const { instances, dropped } = parseLmeInstances(JSON.parse(readFileSync(dataPath, 'utf8')))
  console.log(
    `loaded ${instances.length} instances (${dropped} malformed dropped) from ${dataPath}`,
  )
  return instances
}

/** Fresh isolated vault per instance: write session docs (τ → mtime), index through the REAL pipeline. */
async function buildLmeVault(inst: LmeInstance): Promise<{ db: Database.Database; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'scns-lme-'))
  const docs = sessionsToDocs(inst)
  docs.forEach((doc, i) => {
    const p = join(root, doc.path)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, doc.content)
    const date = inst.haystackDates[i]
    const tauMs = date ? parseSessionDateTime(date) : null
    if (tauMs !== null) utimesSync(p, tauMs / 1000, tauMs / 1000) // τ → mtime → temporal backbone
  })
  const db = openMemoryDb(join(root, 'vault.db'))
  await indexVault(db, createVault({ rootDir: root }), undefined, undefined, {
    extractEntities: true,
    buildSemantic: true,
    gazetteer: SCNS_GAZETTEER,
  })
  return { db, root }
}

function makeDeps(
  db: Database.Database,
  generator: ReturnType<typeof createAcpQaGenerator>,
  judge: ReturnType<typeof createAcpJudge>,
): JudgeEvalDeps {
  return {
    retrieve: async (q) => {
      const r = await retrieveContext(
        db,
        q,
        { intentRouting: false, topK: RETRIEVAL_TOPK, maxChars: RETRIEVAL_MAX_CHARS },
        {
          baseSearch: makeHybridBaseSearch(db),
          makeSemanticRelevanceScorer: (qq) => makeSemanticRelevanceScorer(db, qq),
        },
      )
      return { text: r.text, chunkIds: r.chunkIds }
    },
    intentOf: (q) => classifyIntent(q, SCNS_GAZETTEER),
    generator,
    judge,
  }
}

async function runSmoke(instances: readonly LmeInstance[], deps0: DepsFactory): Promise<void> {
  const inst = instances.find((i) => !i.isAbstention) ?? instances[0]
  if (!inst) throw new Error('no instances to smoke-test')
  console.log(`\n=== LME SMOKE :: ${inst.questionId} (${inst.questionType}) ===`)
  const vault = await buildLmeVault(inst)
  const deps = deps0(vault.db)
  const row = await evaluateItem({ question: inst.question, gold: inst.answer, category: 0 }, deps)
  // Plumbing controls on the SAME judge: own gold must grade high, a wrong answer low.
  const pos = await deps.judge.judge({
    question: inst.question,
    gold: inst.answer,
    candidate: inst.answer,
  })
  const neg = await deps.judge.judge({
    question: inst.question,
    gold: inst.answer,
    candidate: 'a fabricated, unrelated hallucination',
  })
  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'lme-smoke',
      questionId: inst.questionId,
      genAnswer: row.answer.slice(0, 120),
      genError: row.genError,
      score: r4(row.score),
      contextTokens: row.contextTokens,
      posScore: r4(pos.score),
      negScore: r4(neg.score),
      plumbingOk: !row.genError && pos.score >= 0 && neg.score >= 0,
    })}`,
  )
}

async function runControls(instances: readonly LmeInstance[], deps0: DepsFactory): Promise<void> {
  const pool = instances.filter((i) => !i.isAbstention)
  const picked = pickPerCategory(
    lmeToControlItems(pool),
    CONTROLS_N,
    (p) => p.category,
    (p) => p.question,
  )
  const { pos, neg } = buildControlPairs(picked)
  console.log(
    `\n=== LME CONTROLS :: ${picked.length} items → ${pos.length} pos + ${neg.length} neg ===`,
  )
  // Controls need NO vault (candidate is injected, not generated) — judge-only spawns.
  const judge = deps0.judgeOnly()
  const posScores: number[] = []
  for (const c of pos) posScores.push((await judge.judge(c)).score)
  const negScores: number[] = []
  for (const c of neg) negScores.push((await judge.judge(c)).score)
  const posOk = posScores.filter((s) => s >= 0)
  const negOk = negScores.filter((s) => s >= 0)
  const v = controlsVerdict(posOk, negOk, 0.3)
  console.log(
    `  pos mean=${r4(v.posMean)} (n=${posOk.length}) neg mean=${r4(v.negMean)} (n=${negOk.length}) separation=${r4(v.separation)} ⇒ ${v.pass ? 'PASS' : 'FAIL'}`,
  )
  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'lme-controls',
      nItems: picked.length,
      posMean: r4(v.posMean),
      negMean: r4(v.negMean),
      separation: r4(v.separation),
      sigma: JUDGE_SIGMA,
      separationExceedsSigma: v.separation > JUDGE_SIGMA,
      pass: v.pass,
      posDropped: posScores.length - posOk.length,
      negDropped: negScores.length - negOk.length,
    })}`,
  )
}

async function runJudge(instances: readonly LmeInstance[], deps0: DepsFactory): Promise<void> {
  const pool = instances.filter((i) => !i.isAbstention).slice(0, JUDGE_N)
  console.log(`\n=== LME JUDGE :: ${pool.length} instances (SCNS_LME_N=${JUDGE_N}) ===`)
  const rows: LmeAccuracyRow[] = []
  const latencies: number[] = []
  for (const inst of pool) {
    const vault = await buildLmeVault(inst)
    const deps = deps0(vault.db)
    const row = await evaluateItem(
      { question: inst.question, gold: inst.answer, category: 0 },
      deps,
    )
    latencies.push(row.latencyMs)
    rows.push({
      questionType: inst.questionType,
      score: row.score,
      contextTokens: row.contextTokens,
      judgeNull: row.judgeNull,
      genError: row.genError,
    })
    console.log(
      `  [${inst.questionType}] ${inst.questionId} score=${row.score >= 0 ? r4(row.score) : 'NULL'} tok=${row.contextTokens}${row.genError ? ' GEN-ERROR' : ''}`,
    )
  }
  const agg = aggregateByType(rows)
  console.log(
    `\n  overall: acc=${r4(agg.overall.meanScore)} (n=${agg.overall.nScored}, dropped ${agg.overall.nDropped}) tokens=${Math.round(agg.overall.meanContextTokens)}`,
  )
  for (const [t, a] of Object.entries(agg.byType)) {
    console.log(`  ${t}: acc=${r4(a.meanScore)} (n=${a.nScored})`)
  }
  console.log(
    `\nRESULTS_JSON: ${JSON.stringify({
      mode: 'lme-judge',
      n: pool.length,
      overall: {
        accuracy: r4(agg.overall.meanScore),
        nScored: agg.overall.nScored,
        nDropped: agg.overall.nDropped,
        meanContextTokens: Math.round(agg.overall.meanContextTokens),
      },
      byType: Object.fromEntries(
        Object.entries(agg.byType).map(([t, a]) => [
          t,
          { accuracy: r4(a.meanScore), n: a.nScored },
        ]),
      ),
      sigma: JUDGE_SIGMA,
      meanLatencyMs: Math.round(mean(latencies)),
      note: 'held-out go-live gate — any Δ vs a baseline must exceed sigma with pos/neg controls passing; recall is NEVER the verdict',
    })}`,
  )
}

interface DepsFactory {
  (db: Database.Database): JudgeEvalDeps
  judgeOnly(): ReturnType<typeof createAcpJudge>
}

async function main(): Promise<void> {
  const dataPath = process.argv[2] ?? LME_DEFAULT_DATA
  const MODE = process.argv[3] ?? process.env.SCNS_JUDGE_MODE ?? 'smoke'

  // Default-OFF: every LME mode is a judged gate — no flags, no spawn, exit 0 (mirrors the LoCoMo
  // harness). `controls` needs only the judge; smoke/judge need the generator too.
  const needsGenerator = MODE !== 'controls'
  if (!isJudgeEnabled() || (needsGenerator && !isQaGeneratorEnabled())) {
    console.log(
      'generator/judge default-OFF — set SCNS_LLM_JUDGE=1 (and SCNS_QA_GENERATOR=1 for smoke/judge) to run real spawns (no spawn performed)',
    )
    process.exit(0)
  }

  const instances = await loadLmeInstances(dataPath)

  const ISO = mkdtempSync(join(tmpdir(), 'scns-lme-iso-'))
  const judge = createAcpJudge({ cwd: ISO, model: process.env[JUDGE_MODEL_ENV] })
  const generator = createAcpQaGenerator({ cwd: ISO, model: process.env[GEN_MODEL_ENV] })
  const deps0: DepsFactory = Object.assign(
    (db: Database.Database) => makeDeps(db, generator, judge),
    {
      judgeOnly: () => judge,
    },
  )

  if (MODE === 'smoke') await runSmoke(instances, deps0)
  else if (MODE === 'controls') await runControls(instances, deps0)
  else if (MODE === 'judge') await runJudge(instances, deps0)
  else throw new Error(`unknown mode '${MODE}' (want smoke|controls|judge)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
