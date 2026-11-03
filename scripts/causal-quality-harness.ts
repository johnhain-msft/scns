/**
 * D4 causal-subspace quality harness (read-only on a /tmp copy of the live vault).
 *
 * Measures the causal pipeline's REAL counts WITHOUT any LLM spawn:
 *   R = raw causal candidates from buildCausalCandidates over the temporal backbone
 *   (with default curated-tier / same-file / low-signal filters), and the variant
 *   with the filters relaxed, so we can attribute how much each filter removes.
 *   P = edges that WOULD persist (we cannot run the real judge here; we report the
 *       structural gate outcome under a NULL provider == 0, matching prod default).
 *   N = SELECT count(*) FROM memory_causal (the live table state).
 *
 * Also prints a sample of the top candidate pairs so a human can see whether they are
 * narratable cause->effect events or telemetry fragments.
 *
 * Usage: SCNS_EMBED_WORKER_PATH=dist/memory/embedding-worker.js \
 *        npx --offline tsx scripts/causal-quality-harness.ts /tmp/magma-D4.db
 */
import Database from 'better-sqlite3'
import { buildCausalCandidates, isLowSignalContent } from '../src/memory/causal-edges.js'
import { buildOutcomeCausalCandidates } from '../src/memory/outcome-causal-candidates.js'

const dbPath = process.argv[2] ?? '/tmp/magma-D4.db'
const db = new Database(dbPath, { readonly: true })

function count(sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c
}

const temporalEdges = count(`SELECT count(*) AS c FROM memory_edges WHERE edge_type='temporal'`)
const causalRows = count(`SELECT count(*) AS c FROM memory_causal`)
const factNodes = count(`SELECT count(*) AS c FROM chunks WHERE chunk_index>=1000000`)
const outcomeRows = count(`SELECT count(*) AS c FROM proposal_outcomes`)

// R with production defaults (excludeSameFile + excludeLowSignal both ON).
const candDefault = buildCausalCandidates(db, {})
// Relaxed variants to attribute filter impact.
const candNoLowSignal = buildCausalCandidates(db, { excludeLowSignal: false })
const candNoFilters = buildCausalCandidates(db, { excludeSameFile: false, excludeLowSignal: false })
// Event-level (proposal_outcomes decision→result) candidates — the higher-signal source.
const candOutcome = buildOutcomeCausalCandidates(db, {})

// How many of the no-filter candidates are low-signal on EITHER side?
let lowSignalEither = 0
for (const c of candNoFilters) {
  if (isLowSignalContent(c.causeContent) || isLowSignalContent(c.effectContent)) lowSignalEither++
}

console.log('=== D4 CAUSAL QUALITY (read-only', dbPath, ') ===')
console.log('SUBSTRATE: temporalEdges=%d factNodes=%d proposalOutcomes=%d memory_causal(N)=%d', temporalEdges, factNodes, outcomeRows, causalRows)
console.log(
  'CANDIDATES: R_chunk(default)=%d  R_chunk(no-lowsignal)=%d  R_chunk(no-filters)=%d  R_outcome(event-level)=%d',
  candDefault.length,
  candNoLowSignal.length,
  candNoFilters.length,
  candOutcome.length,
)
console.log('PERSIST(P): under prod default NULL provider = 0 (no judge runs); table N =', causalRows)
console.log('LOW-SIGNAL: %d of %d no-filter chunk pairs are telemetry/stat fragments on either side', lowSignalEither, candNoFilters.length)

console.log('\n--- sample of up-to-8 DEFAULT-filter candidate pairs (would be sent to judge) ---')
for (const c of candDefault.slice(0, 8)) {
  const cause = c.causeContent.replace(/\s+/g, ' ').slice(0, 90)
  const effect = c.effectContent.replace(/\s+/g, ' ').slice(0, 90)
  console.log(`entity=${c.entity || '∅'} | ${c.causeFilePath} -> ${c.effectFilePath}`)
  console.log(`   cause:  ${cause}`)
  console.log(`   effect: ${effect}`)
}

console.log('\nGATE-LINE: R_chunk=%d R_outcome=%d P=0(null-provider) N=%d', candDefault.length, candOutcome.length, causalRows)
db.close()
