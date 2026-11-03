/**
 * One-shot backfill of transcript-derived query-chain outcomes onto historical experience rows.
 *
 * Radlinski & Joachims (KDD 2005): consecutive human turns are a query chain, and the reformulation
 * itself is implicit feedback. `src/memory/query-chain.ts` holds the mechanism; this script only
 * walks the corpus and applies it.
 *
 * DEFAULT IS DRY-RUN. Pass `--apply` to write. `--db <path>` targets a specific store.
 *
 * Guards, all mandatory:
 *  - HELD-OUT GROUND TRUTH: the GATE-verified rows are never written, and are instead run through the
 *    classifier as a POSITIVE CONTROL — an independent derivation that must not CONTRADICT them.
 *  - DELIVERY GATE: a row the extension aborted before injection is never labeled (query-chain.ts).
 *  - FIRST-SIGNAL-WINS: `settleChainOutcome` only touches rows whose `human_outcome IS NULL`.
 *  - PROVENANCE: every written row is stamped `query-chain:<rule>:turn-N:sim-X` in `answer_source`.
 *
 * Run `npx tsc` first — this imports from ../dist/.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openExperienceStore } from '../dist/memory/experience-store.js'
import { createSessionTranscript } from '../dist/memory/session-transcript.js'
import {
  findChainOutcome,
  settleChainOutcome,
  classifyChainStep,
  wilsonInterval,
  DEFAULT_DELIVERY_TIMEOUT_MS,
} from '../dist/memory/query-chain.js'
import { normalizePrompt } from '../dist/memory/reask-detector.js'
import { HUMAN_OUTCOME_GRADIENT } from '../dist/memory/human-outcome.js'

/** GATE-verified by the transcript oracle last session. NEVER trained on, NEVER written. */
const HELD_OUT_IDS = [226, 382] as const

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const dbArg = args.indexOf('--db')
const dbPath = dbArg >= 0 ? args[dbArg + 1]! : join(homedir(), '.scns', 'memory', 'experience.db')
const storeArg = args.indexOf('--session-store')
const sessionStorePath = storeArg >= 0 ? args[storeArg + 1]! : undefined

console.log(`mode: ${apply ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`)
console.log(`experience db: ${dbPath}`)
console.log(`as-of: ${new Date().toISOString()}`)

const store = openExperienceStore(dbPath)
const transcript = createSessionTranscript(
  sessionStorePath ? { path: sessionStorePath } : { env: process.env as Record<string, string> },
)
console.log(`transcript: mode=${transcript.mode} path=${transcript.path} ${transcript.reason}`)
if (transcript.mode !== 'oracle') {
  console.error('ABORT: no transcript oracle — a chain cannot be derived without real human turns.')
  process.exit(1)
}

const conversations = (
  store.db
    .prepare(
      `SELECT DISTINCT conversation_id AS c FROM retrieval_experience
        WHERE conversation_id IS NOT NULL AND human_outcome IS NULL AND retriever != 'full'`,
    )
    .all() as Array<{ c: string }>
).map((r) => r.c)

console.log(`\nunsettled conversations to scan: ${conversations.length}`)

// ── POSITIVE CONTROL — the held-out GATE-verified rows, derived independently ─────────────────────
console.log(`\n=== POSITIVE CONTROL (held-out ground truth, never written) ===`)
for (const id of HELD_OUT_IDS) {
  const row = store.db
    .prepare(
      `SELECT id, conversation_id, query_text, latency_ms, human_outcome, answer_source
         FROM retrieval_experience WHERE id = ?`,
    )
    .get(id) as
    | {
        id: number
        conversation_id: string | null
        query_text: string
        latency_ms: number | null
        human_outcome: number | null
        answer_source: string | null
      }
    | undefined
  if (!row) {
    console.log(`  row ${id}: MISSING`)
    continue
  }
  const turns = transcript.humanTurns(row.conversation_id ?? '')
  const norm = normalizePrompt(row.query_text)
  const pos = turns.findIndex((t) => normalizePrompt(t.text) === norm)
  const next = pos >= 0 ? turns[pos + 1] : undefined
  const verdict = next ? classifyChainStep(row.query_text, next.text) : null
  const truth = row.human_outcome
  const derived = verdict
    ? HUMAN_OUTCOME_GRADIENT[
        verdict.cue === 'used' ? 'accepted' : verdict.cue === 'edited' ? 'acceptedEdited' : 'waste'
      ]
    : null
  const status =
    derived === null
      ? 'ABSTAIN (conservative — acceptable)'
      : truth !== null && derived >= 0.8 && truth >= 0.8
        ? 'AGREES ✅'
        : 'CONTRADICTS ❌'
  console.log(
    `  row ${id}: truth=${truth} answer_source=${row.answer_source} latency=${row.latency_ms}ms ` +
      `derived=${verdict ? `${verdict.cue}/${verdict.rule}/sim=${verdict.similarity.toFixed(2)}` : 'null'} => ${status}`,
  )
}

// ── The backfill sweep ────────────────────────────────────────────────────────────────────────────
// The dry run exercises the REAL settle path inside a transaction and rolls it back, so what is
// reported is exactly what `--apply` would write — not a simulation of it.
const written: Array<{ id: number; cue: string; rule: string; source: string }> = []
store.db.exec('BEGIN')
try {
  for (const conv of conversations) {
    // Loop per conversation: each settle unlocks the next unsettled row in the same chain.
    for (;;) {
      const out = findChainOutcome(store, { conversationId: conv, transcript })
      if (!out) break
      if ((HELD_OUT_IDS as readonly number[]).includes(out.experienceId)) break
      if (!settleChainOutcome(store, out)) break
      written.push({ id: out.experienceId, cue: out.cue, rule: out.rule, source: out.source })
    }
  }
  store.db.exec(apply ? 'COMMIT' : 'ROLLBACK')
} catch (err) {
  store.db.exec('ROLLBACK')
  console.error('ABORT — rolled back, nothing written:', (err as Error).message)
  process.exit(1)
}

// The held-out rows must be untouched by construction; assert it rather than assume it.
for (const id of HELD_OUT_IDS) {
  const r = store.db
    .prepare('SELECT human_outcome, answer_source FROM retrieval_experience WHERE id = ?')
    .get(id) as { human_outcome: number | null; answer_source: string | null } | undefined
  const ok = r?.human_outcome === 1 && (r?.answer_source ?? '').startsWith('transcript-oracle:')
  console.log(`held-out row ${id} intact: ${ok ? 'YES' : 'NO — INVESTIGATE'}`)
}

console.log(`\n=== RESULT (${apply ? 'APPLIED' : 'DRY-RUN'}) ===`)
console.log(`rows labeled: ${written.length}`)
const byRule = written.reduce<Record<string, number>>(
  (m, w) => ((m[w.rule] = (m[w.rule] ?? 0) + 1), m),
  {},
)
const byCue = written.reduce<Record<string, number>>(
  (m, w) => ((m[w.cue] = (m[w.cue] ?? 0) + 1), m),
  {},
)
console.log(`by rule: ${JSON.stringify(byRule)}`)
console.log(`by cue:  ${JSON.stringify(byCue)}`)
for (const w of written) console.log(`  id=${w.id} ${w.cue.padEnd(9)} ${w.source}`)

// ── The BASELINE, with an honest error bar ────────────────────────────────────────────────────────
const accepts = written.filter((w) => w.cue === 'used' || w.cue === 'edited').length
const ci = wilsonInterval(accepts, written.length)
console.log(`\n=== BASELINE (query-chain derived, delivery-eligible rows only) ===`)
console.log(`delivery budget: <= ${DEFAULT_DELIVERY_TIMEOUT_MS}ms (installed extension TIMEOUT_MS)`)
console.log(
  `accept rate = ${accepts}/${written.length} = ${(ci.point * 100).toFixed(1)}%  ` +
    `95% Wilson CI [${(ci.low * 100).toFixed(1)}%, ${(ci.high * 100).toFixed(1)}%]`,
)
console.log(
  `SINGLE ARM (explore_arm is NULL on every row) => this is a BASELINE, not a comparison.`,
)

transcript.close()
store.close()
