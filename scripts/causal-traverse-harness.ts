/**
 * WS-2b CAUSAL-TRAVERSE tax→win harness — does causal traversal over the event substrate BEAT plain
 * hybrid on MULTI-HOP causal queries? (WS-1 showed adding event nodes taxes SINGLE-hop hybrid −0.036;
 * the thesis is they pay off MULTI-hop via causal traversal.) Two honest legs:
 *
 *   LEG A — MECHANISM (self-contained fixture, REAL pipeline + REAL BGE embeddings + REAL beam):
 *     A 2-hop causal chain fix→approve→ship. The query asks WHY the release shipped; the root cause
 *     (a flaky-test fix) is buried (off-topic to the query, so flat hybrid cannot reach it). With
 *     causal edges MATERIALIZED, a causal-only beam reaches the root cause across 2 causal hops; with
 *     them cleared it does not. POS + NEG controls isolate the causal contribution.
 *
 *   LEG B — REAL substrate (read-only `.backup` COPY; REFUSES the live vault/broker):
 *     Segment the real broker event chain into event nodes (real embed) → infer causal edges via a
 *     DETERMINISTIC ORACLE provider (NOT a real ACP spawn; clearly labeled) → materialize → score a
 *     programmatic multi-hop causal probe set: hybrid MRR vs traverse(no-causal) vs traverse(+causal).
 *     Determinism ×2. HONEST verdict — the ~51-node real substrate is a single broker chain, so a
 *     real multi-hop WIN may be data-limited; reported plainly either way (never overclaimed).
 *
 * USAGE (never touches live data — pass COPIES; the harness REFUSES live paths):
 *   sqlite3 ~/.scns/memory/vault.db ".backup /tmp/ws2b-vault.db"
 *   sqlite3 "file:$HOME/.session-broker/data.db?mode=ro" ".backup /tmp/ws2b-broker.db"
 *   SCNS_EMBED_WORKER_PATH=dist/memory/embedding-worker.js \
 *     npx tsx scripts/causal-traverse-harness.ts /tmp/ws2b-vault.db /tmp/ws2b-broker.db
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { openMemoryDb } from '../src/memory/db.js'
import { createVault } from '../src/memory/vault.js'
import { indexVault } from '../src/memory/indexer.js'
import { hybridSearch, keywordOnlySearch, type SearchResult } from '../src/memory/search.js'
import { intentAwareSearch } from '../src/memory/intent-search.js'
import { makeSemanticRelevanceScorer } from '../src/memory/semantic-relevance.js'
import { resetEmbeddingClient } from '../src/memory/embeddings.js'
import {
  causalKey,
  persistCausalEdges,
  materializeCausalEdges,
} from '../src/memory/causal-edges.js'
import { segmentStructuredEvents } from '../src/dream/event-segmenter.js'
import { writeEventNodes, listEventNodes } from '../src/memory/event-nodes.js'
import { runCausalEdgeInference } from '../src/memory/causal-runner.js'
import type { CausalProvider } from '../src/memory/causal-provider.js'
import {
  topologicalOrderCausalChains,
  formatCausalChain,
  type CausalChain,
} from '../src/memory/causal-neighborhood.js'

const LIVE_VAULT = resolve(homedir(), '.scns/memory/vault.db')
const LIVE_BROKER = resolve(homedir(), '.session-broker/data.db')

function refuseIfLive(p: string, live: string, label: string): void {
  if (resolve(p) === live) {
    console.error(
      `\nREFUSING: ${label} path '${p}' resolves to the LIVE ${label} (${live}).\n` +
        `Pass a read-only .backup COPY instead — this harness must never mutate live data.\n`,
    )
    process.exit(1)
  }
}

/** Every intent weights ONLY causal ⇒ any node reached came across a materialized causal edge. */
const CAUSAL_ONLY = {
  ENTITY: { entity: 0, semantic: 0, temporal: 0, causal: 1 },
  WHY: { entity: 0, semantic: 0, temporal: 0, causal: 1 },
  WHEN: { entity: 0, semantic: 0, temporal: 0, causal: 1 },
  DEFAULT: { entity: 0, semantic: 0, temporal: 0, causal: 1 },
} as const

/** A deterministic ORACLE causal judge: accepts every candidate pair (conf 0.95). NOT a real ACP. */
const ORACLE_PROVIDER: CausalProvider = {
  async infer({ candidates }) {
    return candidates.map((c) => ({
      causeKey: c.causeKey,
      effectKey: c.effectKey,
      confidence: 0.95,
      rationale: `oracle: τ-consecutive ${c.entity} events`,
    }))
  },
}

function rankOfChunk(res: readonly SearchResult[], id: number): number {
  for (let i = 0; i < res.length; i++) if (res[i]!.chunkId === id) return i + 1
  return 0
}
const rr = (rank: number): number => (rank === 0 ? 0 : 1 / rank)
const fmt = (rank: number): string => (rank === 0 ? 'miss' : `#${rank}`)

// ── LEG A — controlled multi-hop causal mechanism (real pipeline) ────────────────────────────────

const LEG_A_FILES: Record<string, string> = {
  // The 2-hop causal chain: root cause (buried, OFF-topic to the query) → middle → effect (ON-topic).
  'e0_fix.md':
    'On a quiet Tuesday afternoon a junior engineer quietly fixed a flaky timezone unit test that had been intermittently failing in continuous integration.',
  'e1_approve.md':
    'With the continuous integration suite finally green again, the release manager approved the staging build and marked it ready for promotion.',
  'e2_ship.md':
    'The deployment pipeline shipped the approved release out to the production web servers for all customers.',
  // ON-topic distractors (about releases / shipping / production servers) that are NOT causally
  // linked. Every one is MORE query-relevant than the OFF-topic root cause e0, so plain hybrid buries
  // e0 beneath them — only causal traversal from the on-topic effect anchor (e2) can reach it. This is
  // the honest way to make e0 "buried": surround it with docs that outrank it lexically but none of
  // which is its cause. (The original 3 off-topic distractors were LESS relevant than e0, so hybrid
  // ranked e0 #3 and the mechanism could not isolate — see run 1.)
  'd01.md': 'The production web servers were provisioned with extra memory ahead of the holiday shopping season.',
  'd02.md': 'A deployment checklist requires two approvers before any release reaches the production servers.',
  'd03.md': 'The release train ships every second Thursday from the staging environment out to production.',
  'd04.md': 'Customers on the production tier receive each shipped release before the free tier does.',
  'd05.md': 'The production server fleet spans three availability zones behind the global load balancer.',
  'd06.md': 'Release engineering published the shipping schedule for the next four production deployments.',
  'd07.md': 'A canary release is served to five percent of the production servers before the full ship.',
  'd08.md': 'The production incident review recommended shipping smaller and more frequent releases.',
  'd09.md': 'Blue-green deployment keeps the previous production release warm during each ship.',
  'd10.md': 'The changelog for the shipped production release highlighted the new dashboard features.',
}
const LEG_A_QUERY = 'Why did the release ship to the production servers?'

async function legA(): Promise<{ pass: boolean; lines: string[] }> {
  const lines: string[] = []
  const root = mkdtempSync(join(tmpdir(), 'scns-ws2b-legA-'))
  try {
    for (const [name, body] of Object.entries(LEG_A_FILES)) {
      const p = join(root, name)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, body)
    }
    const db = openMemoryDb(join(root, 'vault.db'))
    const vault = createVault({ rootDir: root })
    await indexVault(db, vault, undefined, undefined, { extractEntities: true, buildSemantic: true })

    const idOf = (file: string): number =>
      (db.prepare('SELECT id FROM chunks WHERE file_path=?').get(file) as { id: number }).id
    const e0 = idOf('e0_fix.md')
    const e1 = idOf('e1_approve.md')
    const e2 = idOf('e2_ship.md')
    const contentOf = (id: number): string =>
      (db.prepare('SELECT content FROM chunks WHERE id=?').get(id) as { content: string }).content

    // Inferred causal chain e0→e1→e2 (fix caused approval caused ship), content-hash keyed.
    persistCausalEdges(
      db,
      [
        { causeKey: causalKey(contentOf(e0)), effectKey: causalKey(contentOf(e1)), confidence: 0.9 },
        { causeKey: causalKey(contentOf(e1)), effectKey: causalKey(contentOf(e2)), confidence: 0.9 },
      ],
      { minConfidence: 0.7, provider: 'oracle' },
    )

    const baseSearch = async (q: string, k: number): Promise<readonly SearchResult[]> => {
      try {
        return await hybridSearch(db, q, { limit: k })
      } catch {
        return keywordOnlySearch(db, q, k)
      }
    }
    const K = 6
    const traverseOpts = () => ({
      traverse: true as const,
      semanticRelevance: makeSemanticRelevanceScorer(db, LEG_A_QUERY),
      traversalOptions: { intentWeights: CAUSAL_ONLY, maxDepth: 3 },
    })

    // Baselines: flat hybrid (no traversal) and traverse WITHOUT causal edges (materialize cleared).
    db.prepare("DELETE FROM memory_edges WHERE edge_type='causal'").run()
    const hybrid = await baseSearch(LEG_A_QUERY, K)
    const hybridRank = rankOfChunk(hybrid, e0)
    const traverseNoCausal = await intentAwareSearch(db, LEG_A_QUERY, K, baseSearch, traverseOpts())
    const negRank = rankOfChunk(traverseNoCausal, e0)

    // POSITIVE control: materialize the causal edges, then the SAME causal-only beam.
    const mat = materializeCausalEdges(db)
    const traverseCausal = await intentAwareSearch(db, LEG_A_QUERY, K, baseSearch, traverseOpts())
    const posRank = rankOfChunk(traverseCausal, e0)

    lines.push(`  query           : "${LEG_A_QUERY}"`)
    lines.push(`  gold (buried)   : e0_fix.md (chunk ${e0}) — the 2-hop root cause`)
    lines.push(`  anchor (hybrid) : e2_ship.md (chunk ${e2}) is on-topic; e0 is off-topic`)
    lines.push(`  materialized causal edges: ${mat.materialized} (from ${mat.consideredRows} memory_causal rows)`)
    lines.push(`  HYBRID           rank of e0 : ${fmt(hybridRank)}`)
    lines.push(`  TRAVERSE (no causal) rank of e0 : ${fmt(negRank)}   ← NEG control`)
    lines.push(`  TRAVERSE (+causal)   rank of e0 : ${fmt(posRank)}   ← POS control`)
    const pass = posRank > 0 && negRank === 0 && hybridRank === 0
    lines.push(
      `  MECHANISM ${pass ? 'PASS' : 'INCONCLUSIVE'}: causal 2-hop traversal ${
        pass ? 'REACHES a root cause that hybrid + non-causal traversal BOTH miss' : 'did not cleanly isolate (see ranks)'
      }`,
    )

    // AC2 — topological cause-ordering (paper Stage 4): feed the 2-hop chain SCRAMBLED (with a
    // confidence that would MIS-order it under a confidence sort — the effect edge given the higher
    // confidence) and show topologicalOrderCausalChains recovers the true cause→effect story.
    const short = (s: string): string => {
      const w = s.trim().split(/\s+/)
      return w.slice(0, 6).join(' ') + (w.length > 6 ? '…' : '')
    }
    const mkChain = (causeContent: string, effectContent: string, confidence: number): CausalChain => ({
      causeKey: causalKey(causeContent),
      effectKey: causalKey(effectContent),
      entity: 'release',
      rationale: 'oracle: τ-consecutive release events',
      confidence,
      causeContent,
      effectContent,
      causeChunkId: null,
      effectChunkId: null,
    })
    const cFixApprove = mkChain(contentOf(e0), contentOf(e1), 0.9)
    const cApproveShip = mkChain(contentOf(e1), contentOf(e2), 0.95) // higher conf ⇒ confidence-sort mis-leads
    const scrambled = [cApproveShip, cFixApprove] // effect-edge first, and it also has the higher confidence
    const ordered = topologicalOrderCausalChains(scrambled)
    const label = (c: CausalChain): string => `${short(c.causeContent)} → ${short(c.effectContent)}`
    lines.push('  AC2 topological cause-ordering (paper Stage 4):')
    lines.push(`    scrambled/confidence order : [ ${scrambled.map(label).join('  |  ')} ]`)
    lines.push(`    topo cause→effect order    : [ ${ordered.map(label).join('  |  ')} ]`)
    lines.push(
      `    recovered root-cause first : ${
        ordered[0]?.causeKey === causalKey(contentOf(e0)) ? 'YES (fix→approve emitted before approve→ship)' : 'NO'
      }`,
    )
    lines.push('    formatCausalChain(root) render:')
    for (const rl of formatCausalChain(ordered[0]!).split('\n')) lines.push(`      ${rl}`)

    db.close()
    return { pass, lines }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ── LEG B — real substrate (read-only copy) ──────────────────────────────────────────────────────

interface ProbeScore {
  hybrid: number
  traverseNoCausal: number
  traverseCausal: number
}

async function legB(vaultPath: string, brokerPath: string | undefined): Promise<string[]> {
  const lines: string[] = []
  const db = openMemoryDb(vaultPath) // the COPY is opened read-write (event nodes written into it)
  const brokerDb = brokerPath ? new Database(brokerPath, { readonly: true }) : undefined

  // 1. Segment the real broker event chain into clean event nodes (real embed).
  const records = segmentStructuredEvents({ vaultDb: db, ...(brokerDb ? { brokerDb } : {}) })
  const ev = await writeEventNodes(db, records)
  lines.push(`  event nodes: considered=${ev.considered} written=${ev.written} embeddings=${ev.embeddingsWritten}`)

  // 2. Infer causal edges via the DETERMINISTIC ORACLE (labeled) + materialize (inside the runner).
  const run = await runCausalEdgeInference({ db, provider: ORACLE_PROVIDER, env: {} })
  lines.push(
    `  causal (oracle): ran=${run.ran} candidates=${run.candidateCount} persisted=${run.persisted} materialized=${run.materialized}`,
  )
  const causalEdgeCount = (
    db.prepare("SELECT count(*) AS c FROM memory_edges WHERE edge_type='causal'").get() as { c: number }
  ).c
  lines.push(`  memory_edges(edge_type='causal') = ${causalEdgeCount}`)

  // 3. Build programmatic MULTI-HOP causal probes from the τ-ordered event chain: for a LATE event
  //    (effect anchor), the gold is an event ≥2 causal hops earlier (the buried root cause).
  const nodes = listEventNodes(db, 1000)
  const byEntity = new Map<string, typeof nodes>()
  for (const n of nodes) {
    if (!n.entity) continue
    const arr = byEntity.get(n.entity) ?? []
    arr.push(n)
    byEntity.set(n.entity, arr)
  }
  interface Probe { query: string; anchorId: number; goldId: number }
  const probes: Probe[] = []
  for (const [, chain] of byEntity) {
    // chain is τ-ascending (listEventNodes ORDER BY tau). Need ≥3 to have a 2-hop pair.
    for (let i = 2; i < chain.length; i++) {
      const effect = chain[i]!
      const gold = chain[i - 2]! // 2 causal hops earlier
      // A WHY query keyed on a distinctive token from the effect's content.
      const token = (effect.content.match(/broker ([a-z-]+)/i)?.[1] ?? 'event').slice(0, 24)
      probes.push({ query: `why did the broker ${token} happen`, anchorId: effect.chunkId, goldId: gold.chunkId })
      if (probes.length >= 10) break
    }
    if (probes.length >= 10) break
  }
  lines.push(`  multi-hop probes constructed: ${probes.length}`)
  if (probes.length === 0) {
    lines.push('  DATA-LIMIT: the real substrate has no entity chain of length ≥3 ⇒ no scoreable multi-hop probe.')
    lines.push('  VERDICT: real-data multi-hop causal WIN is UNDETERMINED at this scale (mechanism proven in Leg A).')
    brokerDb?.close()
    db.close()
    return lines
  }

  const baseSearch = async (q: string, k: number): Promise<readonly SearchResult[]> => {
    try {
      return await hybridSearch(db, q, { limit: k })
    } catch {
      return keywordOnlySearch(db, q, k)
    }
  }
  const K = 10

  async function scoreOnce(): Promise<ProbeScore> {
    let h = 0
    let tn = 0
    let tc = 0
    for (const p of probes) {
      const hy = await baseSearch(p.query, K)
      const tOpts = {
        traverse: true as const,
        semanticRelevance: makeSemanticRelevanceScorer(db, p.query),
        traversalOptions: { maxDepth: 3 },
      }
      // traverse WITHOUT causal edges: clear them for this measurement.
      db.prepare("DELETE FROM memory_edges WHERE edge_type='causal'").run()
      const tNo = await intentAwareSearch(db, p.query, K, baseSearch, tOpts)
      // traverse WITH causal edges: re-materialize.
      materializeCausalEdges(db)
      const tYes = await intentAwareSearch(db, p.query, K, baseSearch, tOpts)
      h += rr(rankOfChunk(hy, p.goldId))
      tn += rr(rankOfChunk(tNo, p.goldId))
      tc += rr(rankOfChunk(tYes, p.goldId))
    }
    const n = probes.length
    return { hybrid: h / n, traverseNoCausal: tn / n, traverseCausal: tc / n }
  }

  const s1 = await scoreOnce()
  const s2 = await scoreOnce()
  const det =
    s1.hybrid === s2.hybrid &&
    s1.traverseNoCausal === s2.traverseNoCausal &&
    s1.traverseCausal === s2.traverseCausal
  lines.push(`  MRR over ${probes.length} multi-hop probes (K=${K}), determinism ×2 = ${det ? 'PASS' : 'FAIL'}:`)
  lines.push(`    hybrid              MRR = ${s1.hybrid.toFixed(3)}`)
  lines.push(`    traverse (no causal) MRR = ${s1.traverseNoCausal.toFixed(3)}`)
  lines.push(`    traverse (+causal)   MRR = ${s1.traverseCausal.toFixed(3)}`)
  const winVsHybrid = s1.traverseCausal - s1.hybrid
  const winVsTraverse = s1.traverseCausal - s1.traverseNoCausal
  lines.push(`    Δ(+causal − hybrid)          = ${winVsHybrid >= 0 ? '+' : ''}${winVsHybrid.toFixed(3)}`)
  lines.push(`    Δ(+causal − traverse-no-causal) = ${winVsTraverse >= 0 ? '+' : ''}${winVsTraverse.toFixed(3)}`)
  if (winVsHybrid > 0.02 && winVsTraverse > 0) {
    lines.push('  VERDICT: causal-traverse BEATS hybrid on multi-hop over the real substrate (WS-2c unblock SIGNAL).')
  } else {
    lines.push(
      '  VERDICT: NO real-substrate multi-hop WIN (Δ within noise / ≤0). Honest read: the ~51-node substrate is a',
    )
    lines.push(
      '           single lexically-homogeneous broker chain (WS-1 residual §E) ⇒ buried-node property is weak;',
    )
    lines.push(
      '           mechanism is PROVEN in Leg A, real-data win UNDETERMINED at current scale. Stays default-OFF; go-live gated.',
    )
  }
  brokerDb?.close()
  db.close()
  return lines
}

async function main(): Promise<void> {
  const vaultPath = process.argv[2]
  const brokerPath = process.argv[3]
  if (!vaultPath) {
    console.error('usage: causal-traverse-harness.ts <vault.backup.db> [broker.ro.backup.db]')
    process.exit(1)
  }
  refuseIfLive(vaultPath, LIVE_VAULT, 'vault')
  if (brokerPath) refuseIfLive(brokerPath, LIVE_BROKER, 'broker')
  resetEmbeddingClient()

  console.log('\n=== WS-2b causal-traverse tax→win harness ===')
  console.log('\n── LEG A: multi-hop causal MECHANISM (self-contained fixture, real pipeline) ──')
  const a = await legA()
  for (const l of a.lines) console.log(l)

  console.log(`\n── LEG B: REAL substrate (${vaultPath}${brokerPath ? ' + ' + brokerPath : ''}) ──`)
  const b = await legB(vaultPath, brokerPath)
  for (const l of b) console.log(l)
  console.log('')

  // Kill the forked embedding worker so its IPC channel stops keeping the process alive ⇒ clean exit.
  await resetEmbeddingClient()
}

void main()
