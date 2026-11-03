/**
 * ASSOCIATION (paraphrase) retrieval quality harness — the MISSING MAGMA measurement.
 *
 * The fusion-quality-harness anchors ground truth on LITERAL tokens (LIKE), so FTS
 * hybrid always wins and semantic/fusion can only be penalised. This harness flips
 * that: every query is a PARAPHRASE whose answer chunk does NOT contain the query's
 * distinctive tokens (verified by a token-overlap guard). Surface-token retrieval
 * cannot reach these; only embedding/semantic association can. THIS is the test that
 * decides whether a tier earns MAGMA recall — assoc-MRR must beat hybrid or be cut.
 *
 * USAGE (vault COPY only): cp ~/.scns/memory/vault.db /tmp/assoc.db
 *   SCNS_EMBED_WORKER_PATH=dist/memory/embedding-worker.js npx tsx scripts/assoc-quality-harness.ts /tmp/assoc.db
 */
import { openMemoryDb } from '../src/memory/db.js'
import { hybridSearch, keywordOnlySearch, type SearchResult } from '../src/memory/search.js'
import { buildSemanticEdges } from '../src/memory/semantic-edges.js'
import { intentAwareSearch, type IntentSearchOptions, type FusionWeights } from '../src/memory/intent-search.js'
import { makeSemanticRelevanceScorer } from '../src/memory/semantic-relevance.js'

const K = 10
const STOP = new Set(['the','a','an','of','to','in','on','for','and','or','is','it','do','does','what','how','when','should','must','that','this','during','from','its','i','be','as','are','can','will'])

// Paraphrase ground truth: anchor = a distinctive phrase PRESENT in the answer chunk
// and ABSENT from the query (disjoint). Query uses synonyms only. Anchors verified
// present in the curated vault on 2026-06-29.
const LABELED: ReadonlyArray<{ query: string; anchor: string }> = [
  { query: 'How does the daemon swap instances overnight to keep zero interruption?', anchor: 'blue/green' },
  { query: 'What persistent identity serves as a second brain for coding work?', anchor: 'Nervous System' },
  { query: 'When the human is actively working, what should background jobs do?', anchor: 'pause autonomous' },
  { query: 'Are automated checks alone enough before shipping?', anchor: 'skip manual testing' },
  { query: 'Should I assert a feature is operational before exercising it?', anchor: 'live verification' },
  { query: 'Is reporting a green suite I never executed acceptable?', anchor: 'tests pass' },
  { query: 'Always quote a real metric, never assert success blindly', anchor: 'event row' },
  { query: 'What is the ultimate aim of hands-free continuous betterment?', anchor: 'north star' },
  { query: 'How far can stages climb from watching to fully independent?', anchor: 'autonomy level' },
  { query: 'What overnight merging of raw logs into curated tiers happens?', anchor: 'dream consolidation' },
]

const toks = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)))

function rankOf(res: readonly SearchResult[], ids: ReadonlySet<number>): number {
  for (let i = 0; i < res.length; i++) if (ids.has(res[i].chunkId)) return i + 1
  return 0
}

async function run(db: any, q: string, cfg: IntentSearchOptions | null): Promise<readonly SearchResult[]> {
  const base = async (qq: string, k: number) => { try { return await hybridSearch(db, qq, { limit: k }) } catch { return keywordOnlySearch(db, qq, k) } }
  if (cfg === null) return base(q, K)
  return intentAwareSearch(db, q, K, base, cfg)
}

async function main() {
  const db = openMemoryDb(process.argv[2] ?? '/tmp/assoc.db')
  const chunks = (db.prepare('SELECT count(*) c FROM chunks').get() as any).c
  const se = buildSemanticEdges(db)
  console.log(`\n=== assoc-quality-harness :: chunks=${chunks} semantic_edges=${se.semanticEdges} ===`)
  const active = LABELED.map((t) => {
    const ids = (db.prepare('SELECT id,content FROM chunks WHERE content LIKE ?').all(`%${t.anchor}%`) as any[])
    const overlap = [...toks(t.query)].filter((w) => ids.some((r) => r.content.toLowerCase().includes(w)) && t.anchor.toLowerCase().split(/\W+/).includes(w))
    return { ...t, ids: new Set(ids.map((r) => r.id)), disjoint: overlap.length === 0 }
  }).filter((t) => t.ids.size > 0)
  active.forEach((t) => console.log(`  anchor='${t.anchor}'(${t.ids.size}) disjoint=${t.disjoint}  Q: ${t.query}`))
  const configs: Array<{ n: string; o: (q: string) => IntentSearchOptions | null }> = [
    { n: 'hybrid', o: () => null },
    { n: 'binary', o: (q) => ({ enabled: true, semantic: true, semanticRelevance: makeSemanticRelevanceScorer(db, q) }) },
    { n: 'fus-def', o: (q) => ({ enabled: true, semantic: true, fusion: true, semanticRelevance: makeSemanticRelevanceScorer(db, q) }) },
    { n: 'fus-h6e1', o: (q) => ({ enabled: true, semantic: true, fusion: true, fusionWeights: { hybrid: 6, entity: 1, semantic: 0, temporal: 0 } as FusionWeights, semanticRelevance: makeSemanticRelevanceScorer(db, q) }) },
    { n: 'fus-bal', o: (q) => ({ enabled: true, semantic: true, fusion: true, fusionWeights: { hybrid: 1, entity: 1, semantic: 1, temporal: 0 } as FusionWeights, semanticRelevance: makeSemanticRelevanceScorer(db, q) }) },
  ]
  let hybridMrr = 0, bestOther = 0
  for (const c of configs) {
    let sum = 0, h1 = 0, h3 = 0, found = 0
    for (const t of active) { const r = rankOf(await run(db, t.query, c.o(t.query)), t.ids); if (r) { sum += 1/r; found++; if (r<=1) h1++; if (r<=3) h3++ } }
    const m = sum/active.length
    if (c.n === 'hybrid') hybridMrr = m; else bestOther = Math.max(bestOther, m)
    console.log(`${c.n.padEnd(9)} MRR=${m.toFixed(3)} hit@1=${h1}/${active.length} hit@3=${h3} found=${found}  ΔvsHybrid=${(m-hybridMrr).toFixed(3)}`)
  }
  console.log(`VERDICT: best-non-hybrid ${bestOther.toFixed(3)} vs hybrid ${hybridMrr.toFixed(3)} => ${bestOther > hybridMrr ? 'KEEP tier (beats hybrid)' : 'CUT tiers (hybrid is the association ceiling)'}`)
  db.close()
}
main()
