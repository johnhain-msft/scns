/**
 * Fusion-vs-binary retrieval QUALITY harness (P2, MAGMA go-live readiness).
 *
 * Quantifies the answer-quality delta of flipping `SCNS_FUSION_ROUTING=1` on a
 * REAL vault COPY, so the go-live decision rests on a number, not a mechanism.
 *
 * It mirrors the production retrieval wiring in `src/cli.ts` (memorySearch):
 *   - baseSearch  = hybridSearch (FTS5 + vector) with keyword-only fallback
 *   - hybrid      = enabled:false  → baseSearch verbatim (today's floor)
 *   - binary      = enabled:true, semantic:true, +cosine scorer  (LIVE broker config)
 *   - fusion      = binary + fusion:true                          (the proposed flip)
 *
 * For each labeled query the ANCHOR is the set of chunk ids whose content
 * contains a distinctive ground-truth token (resolved by LIKE, independent of
 * any ranking). We report rank-of-first-anchor, hit@k and MRR per config and
 * the fusion−binary delta with real chunk ids.
 *
 * USAGE (never touches the live vault — pass a COPY):
 *   cp ~/.scns/memory/vault.db /tmp/loopP2.db
 *   SCNS_EMBED_WORKER_PATH=dist/memory/embedding-worker.js \
 *     npx tsx scripts/fusion-quality-harness.ts /tmp/loopP2.db
 *
 * Semantic edges are rebuilt on the copy first (they may be stale/absent).
 */
import { openMemoryDb } from '../src/memory/db.js'
import { hybridSearch, keywordOnlySearch, type SearchResult } from '../src/memory/search.js'
import { buildSemanticEdges } from '../src/memory/semantic-edges.js'
import { intentAwareSearch, type IntentSearchOptions, type FusionWeights } from '../src/memory/intent-search.js'
import { makeSemanticRelevanceScorer } from '../src/memory/semantic-relevance.js'
import { resetEmbeddingClient } from '../src/memory/embeddings.js'

const K = 10
const KS = [1, 3, 5, 10] as const

// Labeled set — each anchor token is the ground-truth answer locus, chosen by
// content (NOT by which router ranks it well). Queries whose anchor resolves to
// zero chunks on the given vault are skipped and reported.
const LABELED: ReadonlyArray<{ query: string; anchor: string }> = [
  { query: 'What network port does the SCNS broker listen on?', anchor: '3456' },
  { query: 'Where does the broker read its database path configuration from?', anchor: 'BROKER_DB_PATH' },
  { query: 'How do the brain autonomy levels progress from observer to autonomous?', anchor: 'autonomy level' },
  { query: 'What does MAGMA mean for the SCNS memory layer?', anchor: 'MAGMA' },
  { query: 'What is dream consolidation in SCNS?', anchor: 'dream consolidation' },
  { query: 'What is the autonomous self-improvement north star?', anchor: 'north star' },
  // Expanded set (2026-06-28, session a6094428) — verified-present anchors from
  // the curated (non-telemetry) vault files, mixing ENTITY-classified lookups
  // (exercise the route that recency-dumps) with DEFAULT controls (must not
  // regress). Anchor = a distinctive ground-truth token resolved by content LIKE.
  { query: 'What does the broker quality gate reject proposals for?', anchor: 'Quality gate rejected' },
  { query: 'What does the negative memory say about fabricating evidence?', anchor: 'fabricate' },
  { query: 'What verdict did the autonomy transition log proposal receive?', anchor: 'verdict: reject' },
  { query: 'What negative memory governs claiming things from HTTP status codes?', anchor: 'HTTP status' },
  { query: 'What must an agent never claim without manual verification?', anchor: 'claim tests pass' },
  { query: 'What does the user say should happen if agents never do anything?', anchor: 'self innovate' },
  { query: 'What was the restart resilience harvest phase?', anchor: 'Restart-Resilience' },
  { query: 'What guardrail covers claiming functionality works?', anchor: 'live verification' },
]

type Cfg = { name: string; opts: (q: string) => IntentSearchOptions }

function rankOfAnchor(results: readonly SearchResult[], anchorIds: ReadonlySet<number>): number {
  for (let i = 0; i < results.length; i++) if (anchorIds.has(results[i]!.chunkId)) return i + 1
  return 0 // miss
}

function pad(s: string | number, n: number): string {
  const v = String(s)
  return v.length >= n ? v : v + ' '.repeat(n - v.length)
}

async function main(): Promise<void> {
  const vaultPath = process.argv[2] ?? '/tmp/loopP2.db'
  const db = openMemoryDb(vaultPath)

  const chunks = (db.prepare('SELECT count(*) AS c FROM chunks').get() as { c: number }).c
  const edgeStats = buildSemanticEdges(db)
  console.log(`\n=== fusion-quality-harness :: ${vaultPath} ===`)
  console.log(`chunks=${chunks}  semantic_edges(rebuilt)=${edgeStats.semanticEdges}\n`)

  const baseSearch = async (q: string, k: number): Promise<readonly SearchResult[]> => {
    try {
      return await hybridSearch(db, q, { limit: k })
    } catch {
      return keywordOnlySearch(db, q, k)
    }
  }

  const fusionCfg = (name: string, w: FusionWeights): Cfg => ({
    name,
    opts: (q) => ({
      enabled: true,
      semantic: true,
      fusion: true,
      fusionWeights: w,
      semanticRelevance: makeSemanticRelevanceScorer(db, q),
    }),
  })
  const configs: Cfg[] = [
    { name: 'hybrid', opts: () => ({ enabled: false }) },
    { name: 'traverse', opts: (q) => ({ traverse: true, semanticRelevance: makeSemanticRelevanceScorer(db, q) }) },
    {
      name: 'binary',
      opts: (q) => ({ enabled: true, semantic: true, semanticRelevance: makeSemanticRelevanceScorer(db, q) }),
    },
    // The shippable default-OFF fix: binary router + relevance-ranked ENTITY route.
    {
      name: 'bin-erank',
      opts: (q) => ({
        enabled: true,
        entityRelevanceRank: true,
        semanticRelevance: makeSemanticRelevanceScorer(db, q),
      }),
    },
    // fusion @ default weights (hybrid1 entity1 semantic.5 temporal.5) + tuned presets
    fusionCfg('fus-def', {}),
    fusionCfg('fus-hyb', { hybrid: 1, entity: 0.3, semantic: 0.5, temporal: 0.2 }),
    fusionCfg('fus-h1', { hybrid: 1, entity: 0.1, semantic: 0.3, temporal: 0.1 }),
    // "relevance-rank the ENTITY route" hypothesis: hybrid⊕entity ONLY (no
    // semantic/temporal dilution) — anchors on relevance, keeps entity substrate.
    fusionCfg('fus-he', { hybrid: 1, entity: 1, semantic: 0, temporal: 0 }),
    fusionCfg('fus-h2e1', { hybrid: 2, entity: 1, semantic: 0, temporal: 0 }),
    fusionCfg('fus-h3e1', { hybrid: 3, entity: 1, semantic: 0, temporal: 0 }),
    fusionCfg('fus-h4e1', { hybrid: 4, entity: 1, semantic: 0, temporal: 0 }),
    fusionCfg('fus-h6e1', { hybrid: 6, entity: 1, semantic: 0, temporal: 0 }),
  ]
  const FUSION_DEFAULT = 'fus-def' // determinism + delta baseline-of-comparison

  // Resolve anchors and filter to scoreable queries.
  const scoreable = LABELED.map((t) => {
    const rows = db
      .prepare('SELECT id FROM chunks WHERE content LIKE ?')
      .all(`%${t.anchor}%`) as Array<{ id: number }>
    return { ...t, anchorIds: new Set(rows.map((r) => r.id)) }
  })
  for (const t of scoreable) {
    if (t.anchorIds.size === 0) console.log(`SKIP (anchor '${t.anchor}' not in vault): ${t.query}`)
  }
  const active = scoreable.filter((t) => t.anchorIds.size > 0)

  // Per-query ranks + raw top-K ids (for determinism check on fusion).
  const ranks: Record<string, number[]> = {}
  for (const c of configs) ranks[c.name] = []
  const fusionTop: number[][] = []
  // Capture top-K id lists for hybrid (today's floor) and traverse (MAGMA Algorithm 1)
  // so the POSITIVE CONTROL can prove adaptiveTraversalSearch actually RUNS on real data
  // (result set differs from a pass-through) rather than silently degrading to baseSearch.
  const hybridTop: number[][] = []
  const traverseTop: number[][] = []

  const cfgNames = configs.map((c) => c.name)
  console.log(pad('anchor(token,#)', 26) + cfgNames.map((n) => pad(n, 9)).join('') + 'query')
  const fmt = (r: number) => (r === 0 ? 'miss' : `#${r}`)
  for (const t of active) {
    const row: Record<string, number> = {}
    for (const cfg of configs) {
      const res = await intentAwareSearch(db, t.query, K, baseSearch, cfg.opts(t.query))
      const r = rankOfAnchor(res, t.anchorIds)
      ranks[cfg.name]!.push(r)
      row[cfg.name] = r
      if (cfg.name === FUSION_DEFAULT) fusionTop.push(res.map((x) => x.chunkId))
      if (cfg.name === 'hybrid') hybridTop.push(res.map((x) => x.chunkId))
      if (cfg.name === 'traverse') traverseTop.push(res.map((x) => x.chunkId))
    }
    console.log(
      pad(`${t.anchor} (${t.anchorIds.size})`, 26) +
        cfgNames.map((n) => pad(fmt(row[n]!), 9)).join('') +
        t.query,
    )
  }

  // Determinism: re-run the default-weight fusion once, compare top-K id lists.
  const fusDefCfg = configs.find((c) => c.name === FUSION_DEFAULT)!
  let deterministic = true
  for (let i = 0; i < active.length; i++) {
    const res = await intentAwareSearch(db, active[i]!.query, K, baseSearch, fusDefCfg.opts(active[i]!.query))
    if (JSON.stringify(res.map((x) => x.chunkId)) !== JSON.stringify(fusionTop[i])) deterministic = false
  }

  // Aggregate.
  const agg = (rs: number[]) => {
    const found = rs.filter((r) => r > 0)
    const mrr = rs.reduce((a, r) => a + (r > 0 ? 1 / r : 0), 0) / (rs.length || 1)
    const meanRank = found.length ? found.reduce((a, r) => a + r, 0) / found.length : 0
    const hits = KS.map((k) => rs.filter((r) => r > 0 && r <= k).length)
    return { mrr, meanRank, hits, n: rs.length, found: found.length }
  }
  const A: Record<string, ReturnType<typeof agg>> = {}
  for (const n of cfgNames) A[n] = agg(ranks[n]!)

  console.log(`\n=== AGGREGATE over ${active.length} scoreable queries (K=${K}) ===`)
  console.log(
    pad('config', 9) + pad('MRR', 8) + KS.map((k) => pad(`hit@${k}`, 8)).join('') + pad('meanRank', 10) + 'found',
  )
  for (const name of cfgNames) {
    const a = A[name]!
    console.log(
      pad(name, 9) +
        pad(a.mrr.toFixed(3), 8) +
        a.hits.map((h) => pad(`${h}/${a.n}`, 8)).join('') +
        pad(a.meanRank.toFixed(2), 10) +
        `${a.found}/${a.n}`,
    )
  }

  // ---- POSITIVE CONTROL (anti-mistesting): the feature must be ACTIVE on REAL data ----
  // (1) edge substrate active: semantic_edges rebuilt on the copy must be > 0.
  // (2) traverse path active: adaptiveTraversalSearch must produce a top-K that DIFFERS from the
  //     base-hybrid floor (if traverse silently fell back to baseSearch the lists would be identical),
  //     and we surface the concrete chunk ids traverse REACHES that hybrid's top-K does not.
  // (3) labeled-anchor uniqueness: honest no-tax framing — does traverse uniquely FIND any anchor the
  //     hybrid floor misses, or does it only DROP anchors hybrid finds (the single-hop tax)?
  console.log(`\n=== POSITIVE CONTROL (substrate + traverse path ACTIVE on real data) ===`)
  const edgesActive = edgeStats.semanticEdges > 0
  console.log(`semantic_edges(rebuilt)=${edgeStats.semanticEdges}  (>0 ⇒ edge substrate active): ${edgesActive ? 'PASS' : 'FAIL'}`)
  let traverseRunsOn = 0
  let exampleQ = ''
  let exampleReaches: number[] = []
  for (let i = 0; i < active.length; i++) {
    const h = hybridTop[i] ?? []
    const t = traverseTop[i] ?? []
    if (JSON.stringify(h) !== JSON.stringify(t)) {
      traverseRunsOn++
      if (exampleQ === '') {
        const hs = new Set(h)
        const reaches = t.filter((id) => !hs.has(id))
        if (reaches.length > 0) {
          exampleQ = active[i]!.query
          exampleReaches = reaches
        }
      }
    }
  }
  const traversePathActive = traverseRunsOn > 0
  console.log(
    `traverse top-K DIFFERS from hybrid on ${traverseRunsOn}/${active.length} queries ` +
      `(>0 ⇒ adaptiveTraversalSearch runs, NOT a pass-through): ${traversePathActive ? 'PASS' : 'FAIL'}`,
  )
  if (exampleQ !== '')
    console.log(`  e.g. "${exampleQ}" — traverse REACHES chunk ids hybrid's top-${K} lacks: [${exampleReaches.join(', ')}]`)
  let traverseUniqueFinds = 0
  let traverseUniqueDrops = 0
  for (let i = 0; i < active.length; i++) {
    const hr = ranks['hybrid']?.[i] ?? 0
    const tr = ranks['traverse']?.[i] ?? 0
    if (tr > 0 && hr === 0) traverseUniqueFinds++
    if (tr === 0 && hr > 0) traverseUniqueDrops++
  }
  console.log(
    `labeled-anchor uniqueness: traverse uniquely FINDS (hybrid miss) on ${traverseUniqueFinds}; ` +
      `traverse uniquely DROPS (hybrid hit) on ${traverseUniqueDrops}`,
  )

  // ---- NO-TAX VERDICT (the crux): traverse must not regress the single-hop-literal axis vs hybrid ----
  const NOISE = 0.02
  const tMrr = A['traverse']?.mrr ?? 0
  const hMrr = A['hybrid']?.mrr ?? 0
  const noTax = tMrr >= hMrr - NOISE
  console.log(
    `\nNO-TAX (single-hop literal, n=${active.length}): traverse MRR ${tMrr.toFixed(3)} vs hybrid MRR ${hMrr.toFixed(3)} ` +
      `(Δ=${(tMrr - hMrr >= 0 ? '+' : '') + (tMrr - hMrr).toFixed(3)}, noise±${NOISE}) ⇒ ` +
      `${noTax ? 'NO-TAX (within noise)' : 'TAX (traverse regresses — keep traverse opt-in/QG-gated, do NOT flip global default)'}`,
  )

  console.log(`\nDELTA vs binary (current prod router):`)
  for (const name of cfgNames.filter((n) => n.startsWith('fus'))) {
    const dMrr = (A[name]?.mrr ?? 0) - (A.binary?.mrr ?? 0)
    const dHits = KS.map((_k, i) => (A[name]?.hits[i] ?? 0) - (A.binary?.hits[i] ?? 0))
    console.log(
      `  ${pad(name, 9)} ΔMRR=${dMrr >= 0 ? '+' : ''}${dMrr.toFixed(3)}  ` +
        KS.map((k, i) => `Δhit@${k}=${(dHits[i] ?? 0) >= 0 ? '+' : ''}${dHits[i] ?? 0}`).join('  '),
    )
  }
  console.log(`\nfusion(${FUSION_DEFAULT}) determinism (top-${K} ids stable ×2): ${deterministic ? 'PASS' : 'FAIL'}`)

  db.close()
  await resetEmbeddingClient()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
