/**
 * WS-1 event/outcome substrate — NODE-QUALITY evidence harness.
 *
 * Demonstrates, on a READ-ONLY `.backup` COPY of the real vault (+ an optional broker DB copy), that
 * the deterministic slow-path segmenter distills the ~telemetry-dominated corpus into a small set of
 * CLEAN, narratable decision→action→outcome EVENT nodes with a real per-node event-time τ — the
 * "node quality is the gating variable" thesis. Reports the before→after event-vs-telemetry ratio,
 * concrete BEFORE(telemetry fragment)→AFTER(event node) examples, and the WS-2b narratable
 * causal-candidate SIGNAL (demonstration only — does NOT start WS-2 / persist edges).
 *
 * USAGE (never touches the live vault/broker — pass COPIES; the harness REFUSES live paths):
 *   sqlite3 ~/.scns/memory/vault.db ".backup /tmp/ws1-vault.db"
 *   sqlite3 "file:$HOME/.session-broker/data.db?mode=ro" ".backup /tmp/ws1-broker.db"
 *   SCNS_EMBED_WORKER_PATH=dist/memory/embedding-worker.js \
 *     npx tsx scripts/event-substrate-harness.ts /tmp/ws1-vault.db /tmp/ws1-broker.db
 *
 * The vault copy is opened READ-WRITE (event nodes are written into the COPY). The broker copy is
 * opened READ-ONLY (segmentation only READS `events`; openMemoryDb would WAL-mutate it, so we don't
 * use it for the broker handle).
 */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { openMemoryDb, EVENT_CHUNK_INDEX_BASE } from '../src/memory/db.js'
import { isLowSignalContent } from '../src/memory/causal-edges.js'
import { DECISION_EVENT_TYPES, segmentStructuredEvents } from '../src/dream/event-segmenter.js'
import {
  writeEventNodes,
  buildEventCausalCandidates,
  listEventNodes,
  countEventNodes,
} from '../src/memory/event-nodes.js'
import { resetEmbeddingClient } from '../src/memory/embeddings.js'

/** Fact-node chunk_index base (un-exported from db.ts) — redeclared locally (as other harnesses do). */
const FACT_BASE = 1_000_000

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

interface Ratio {
  total: number
  source: number
  fact: number
  event: number
  telemetrySource: number
}

function classify(db: Database.Database): Ratio {
  const one = (sql: string, ...args: number[]): number =>
    (db.prepare(sql).get(...args) as { n: number }).n
  const total = one('SELECT COUNT(*) AS n FROM chunks')
  const source = one('SELECT COUNT(*) AS n FROM chunks WHERE chunk_index < ?', FACT_BASE)
  const fact = one(
    'SELECT COUNT(*) AS n FROM chunks WHERE chunk_index >= ? AND chunk_index < ?',
    FACT_BASE,
    EVENT_CHUNK_INDEX_BASE,
  )
  const event = one('SELECT COUNT(*) AS n FROM chunks WHERE chunk_index >= ?', EVENT_CHUNK_INDEX_BASE)
  // Telemetry share is measured over SOURCE chunks using the objective low-signal oracle.
  const sourceRows = db
    .prepare('SELECT content FROM chunks WHERE chunk_index < ?')
    .all(FACT_BASE) as Array<{ content: string }>
  const telemetrySource = sourceRows.filter((r) => isLowSignalContent(r.content)).length
  return { total, source, fact, event, telemetrySource }
}

const pct = (num: number, den: number): string => (den === 0 ? '0.0%' : `${((100 * num) / den).toFixed(1)}%`)
const oneLine = (s: string, n = 140): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

async function main(): Promise<void> {
  const vaultPath = process.argv[2]
  const brokerPath = process.argv[3]
  if (!vaultPath) {
    console.error('usage: event-substrate-harness.ts <vault-copy.db> [broker-copy.db]')
    process.exit(2)
  }
  refuseIfLive(vaultPath, LIVE_VAULT, 'vault')
  if (brokerPath) {
    refuseIfLive(brokerPath, LIVE_BROKER, 'broker')
    // Belt-and-suspenders: openMemoryDb sets WAL (a write); never allow the vault handle to BE the broker.
    refuseIfLive(brokerPath, LIVE_VAULT, 'vault')
  }

  const db = openMemoryDb(vaultPath) // COPY, read-write (event nodes are written here)
  const brokerDb = brokerPath ? new Database(brokerPath, { readonly: true }) : undefined

  console.log(`\n=== event-substrate-harness :: vault=${vaultPath}${brokerPath ? `  broker=${brokerPath}` : ''} ===`)

  // ── Thesis framing: raw telemetry volume → clean decision events ──
  if (brokerDb) {
    const rawEvents = (brokerDb.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    const placeholders = DECISION_EVENT_TYPES.map(() => '?').join(', ')
    const decisionRows = brokerDb
      .prepare(
        `SELECT event_type AS t, COUNT(*) AS n FROM events WHERE event_type IN (${placeholders}) GROUP BY event_type ORDER BY n DESC`,
      )
      .all(...DECISION_EVENT_TYPES) as Array<{ t: string; n: number }>
    const decisionTotal = decisionRows.reduce((a, r) => a + r.n, 0)
    console.log(
      `\nBROKER: ${rawEvents} raw events → ${decisionTotal} on the decision allowlist ` +
        `(${pct(decisionTotal, rawEvents)} of raw): ` +
        decisionRows.map((r) => `${r.t}=${r.n}`).join(', '),
    )
  } else {
    console.log('\nBROKER: (no broker copy supplied — segmenting proposal_outcomes only)')
  }
  const outcomeCount = (db.prepare('SELECT COUNT(*) AS n FROM proposal_outcomes').get() as { n: number }).n
  console.log(`VAULT: proposal_outcomes rows = ${outcomeCount}`)

  // ── BEFORE ratio ──
  const before = classify(db)
  console.log(`\n=== BEFORE (chunk classification) ===`)
  console.log(
    `total=${before.total}  source(<1e6)=${before.source}  fact([1e6,2e6))=${before.fact}  event(>=2e6)=${before.event}`,
  )
  console.log(
    `telemetry(low-signal) source chunks = ${before.telemetrySource}/${before.source} (${pct(
      before.telemetrySource,
      before.source,
    )} of source; ${pct(before.telemetrySource, before.total)} of all chunks)`,
  )
  console.log(`event nodes = ${before.event} (${pct(before.event, before.total)} of all chunks)`)

  // Capture BEFORE telemetry-fragment examples (the kind of "node" the corpus has today).
  const telemetryExamples = (
    db.prepare('SELECT content FROM chunks WHERE chunk_index < ? ').all(FACT_BASE) as Array<{ content: string }>
  )
    .filter((r) => isLowSignalContent(r.content))
    .slice(0, 5)
    .map((r) => oneLine(r.content))

  // ── SEGMENT + WRITE (real embed) ──
  const records = segmentStructuredEvents({ vaultDb: db, ...(brokerDb ? { brokerDb } : {}) })
  console.log(`\nsegmentStructuredEvents → ${records.length} candidate event records`)
  const stats = await writeEventNodes(db, records) // real fastembed + edge rebuild (production path)
  console.log(
    `writeEventNodes: considered=${stats.considered} written=${stats.written} ` +
      `skippedExisting=${stats.skippedExisting} embeddings=${stats.embeddingsWritten}`,
  )

  // ── AFTER ratio ──
  const after = classify(db)
  console.log(`\n=== AFTER (chunk classification) ===`)
  console.log(
    `total=${after.total}  source(<1e6)=${after.source}  fact([1e6,2e6))=${after.fact}  event(>=2e6)=${after.event}`,
  )
  console.log(
    `event nodes: ${before.event} → ${after.event}  (${pct(before.event, before.total)} → ${pct(
      after.event,
      after.total,
    )} of all chunks)`,
  )
  const counts = countEventNodes(db)
  console.log(`event_nodes sidecar total=${counts.total}  byKind=${JSON.stringify(counts.byKind)}`)

  // ── BEFORE → AFTER examples (thesis contrast: telemetry fragment vs clean event node) ──
  const eventExamples = listEventNodes(db, 5)
  console.log(`\n=== BEFORE (telemetry fragment) → AFTER (clean event node) — thesis contrast ===`)
  for (let i = 0; i < Math.max(telemetryExamples.length, eventExamples.length); i++) {
    if (telemetryExamples[i]) console.log(`  BEFORE[${i}] (low-signal): ${telemetryExamples[i]}`)
    const e = eventExamples[i]
    if (e) console.log(`  AFTER [${i}] (τ=${e.tau}, kind=${e.kind}): ${oneLine(e.content)}`)
  }
  const anyEventLowSignal = eventExamples.filter((e) => isLowSignalContent(e.content)).length
  console.log(
    `\nnarratability: ${anyEventLowSignal}/${eventExamples.length} sampled event nodes are low-signal ` +
      `(want 0 ⇒ ${anyEventLowSignal === 0 ? 'PASS' : 'FAIL'})`,
  )

  // ── WS-2b narratable causal-candidate SIGNAL (demonstration only — NOT WS-2) ──
  const candidates = buildEventCausalCandidates(db)
  const lowSignalCandidates = candidates.filter(
    (c) => isLowSignalContent(c.causeContent) || isLowSignalContent(c.effectContent),
  ).length
  console.log(`\n=== WS-2b causal-candidate SIGNAL (demonstration only; does NOT start WS-2) ===`)
  console.log(
    `event-substrate causal candidates = ${candidates.length}; low-signal = ${lowSignalCandidates} ` +
      `(want 0 ⇒ ${candidates.length > 0 && lowSignalCandidates === 0 ? 'PASS (narratable)' : candidates.length === 0 ? 'NONE (no entity has ≥2 τ-consecutive events)' : 'FAIL'})`,
  )
  for (const c of candidates.slice(0, 3)) {
    console.log(`  [${c.entity}] cause: ${oneLine(c.causeContent, 90)}`)
    console.log(`  [${c.entity}] effect: ${oneLine(c.effectContent, 90)}`)
  }

  // ── Determinism ×2 (2nd segment+write is a no-op; event_key set stable) ──
  const records2 = segmentStructuredEvents({ vaultDb: db, ...(brokerDb ? { brokerDb } : {}) })
  const keys1 = records.map((r) => r.eventKey).sort()
  const keys2 = records2.map((r) => r.eventKey).sort()
  const keysStable = JSON.stringify(keys1) === JSON.stringify(keys2)
  const stats2 = await writeEventNodes(db, records2)
  console.log(`\n=== DETERMINISM ×2 ===`)
  console.log(`segmenter event_key set stable ×2: ${keysStable ? 'PASS' : 'FAIL'}`)
  console.log(
    `2nd writeEventNodes written=${stats2.written} skippedExisting=${stats2.skippedExisting} ` +
      `(want written=0 ⇒ ${stats2.written === 0 ? 'PASS (idempotent)' : 'FAIL'})`,
  )

  db.close()
  if (brokerDb) brokerDb.close()
  await resetEmbeddingClient()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
