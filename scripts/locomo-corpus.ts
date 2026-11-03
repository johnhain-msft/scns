/**
 * Shared LoCoMo corpus + isolated-vault helpers for the SCNS LoCoMo rulers.
 *
 * Extracted 2026-07-02 (WS-2 Phase R, Q2) from `locomo-multihop-harness.ts` so BOTH the recall sanity
 * harness AND the new LLM-Judge harness (`locomo-judge-harness.ts`) build their isolated per-conversation
 * vaults identically — no duplication. Logic is byte-for-byte the recall harness's originals; only the
 * home moved.
 *
 * Never touches the live vault: {@link refuseIfLive} refuses a dataset path that resolves to it, and
 * {@link buildVault} always builds under a fresh `mktemp` dir. A dataset is auto-downloaded from the
 * official snap-research/locomo source if absent.
 */
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
  existsSync,
  readFileSync,
} from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { openMemoryDb } from '../src/memory/db.js'
import { createVault } from '../src/memory/vault.js'
import { indexVault } from '../src/memory/indexer.js'
import { type GazetteerEntry } from '../src/memory/entities/gazetteer.js'
// parseSessionDateTime is owned by the B3 conversation segmenter (single source of truth, shared with
// segmentConversation); re-exported here so existing harness importers keep resolving it from this module.
import { parseSessionDateTime } from '../src/memory/conversation-segmenter.js'
export { parseSessionDateTime }

export const LIVE_VAULT = resolve(homedir(), '.scns/memory/vault.db')
export const DATA_URL =
  'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json'
export const DEFAULT_DATA = join(tmpdir(), 'locomo10.json')

// ── LoCoMo dia_id parsing + gold normalization (axis-neutral; shared by ALL harnesses) ──────────
// Moved here from locomo-scoring.ts so the JUDGE harness never imports the wrong-axis recall file
// (specs/001-learning-memory-loop T012 — recall must never gate a verdict; the parsing helpers are
// corpus concerns, not metrics).

/** A LoCoMo dialog-turn id, e.g. `"D2:8"`. */
export type DiaId = string

const DIA_ID_RE = /^D(\d+):(\d+)$/

/** Parsed `dia_id`. */
export interface ParsedDiaId {
  readonly session: number
  readonly turn: number
}

/** True iff `s` is a syntactically valid LoCoMo `dia_id` (`D{n}:{m}`). */
export function isDiaId(s: unknown): s is DiaId {
  return typeof s === 'string' && DIA_ID_RE.test(s)
}

/**
 * Parse a `dia_id` into `{session, turn}`. Throws on a malformed id — callers that want to tolerate
 * benchmark noise should guard with {@link isDiaId} first (the harness does, counting drops).
 */
export function parseDiaId(s: string): ParsedDiaId {
  const m = DIA_ID_RE.exec(s)
  if (!m) throw new Error(`malformed dia_id: ${JSON.stringify(s)}`)
  return { session: Number(m[1]), turn: Number(m[2]) }
}

/**
 * Coerce a raw LoCoMo `evidence` array (which is almost always `string[]` of dia_ids, but can carry
 * stray non-dia entries) into a de-duplicated, order-preserving list of valid dia_ids plus the count
 * of entries that were dropped as non-dia (so the harness can report data-quality honestly).
 */
export function normalizeGold(evidence: readonly unknown[]): { gold: DiaId[]; dropped: number } {
  const gold: DiaId[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const e of evidence) {
    if (isDiaId(e)) {
      if (!seen.has(e)) {
        seen.add(e)
        gold.push(e)
      }
    } else {
      dropped++
    }
  }
  return { gold, dropped }
}

/** Arithmetic mean of a list (empty ⇒ 0). Used to macro-average per-question metrics. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

// ── LoCoMo types (subset we use) ─────────────────────────────────────────────────────────────────
export interface LocomoTurn {
  speaker: string
  dia_id: string
  text?: string
  blip_caption?: string
  img_url?: string
}
export interface LocomoQA {
  question: string
  answer?: unknown
  adversarial_answer?: unknown
  evidence?: unknown[]
  category: number
}
export interface LocomoSample {
  sample_id: string
  qa: LocomoQA[]
  conversation: Record<string, unknown>
}

export interface Turn {
  diaId: string
  content: string
  tauMs: number | null
}

export interface Vault {
  db: ReturnType<typeof openMemoryDb>
  root: string
  diaOfId: Map<number, string>
  turnDiaSet: Set<string>
  tauCoverage: number
}

/** Refuse any dataset path that resolves to the LIVE vault — these harnesses build their OWN vaults. */
export function refuseIfLive(p: string): void {
  if (resolve(p) === LIVE_VAULT) {
    console.error(
      `\nREFUSING: '${p}' resolves to the LIVE vault (${LIVE_VAULT}). This harness builds its OWN vaults.\n`,
    )
    process.exit(1)
  }
}

/**
 * Load the LoCoMo dataset, auto-downloading the official file if absent, and optionally slicing to the
 * first `maxConv` conversations. Never resolves to the live vault (guard with {@link refuseIfLive}).
 */
export async function loadLocomoSamples(
  dataPath: string,
  opts: { maxConv?: number } = {},
): Promise<LocomoSample[]> {
  if (!existsSync(dataPath)) {
    console.log(`dataset absent → downloading official LoCoMo to ${dataPath} …`)
    const res = await fetch(DATA_URL)
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`)
    writeFileSync(dataPath, Buffer.from(await res.arrayBuffer()))
  }
  let samples = JSON.parse(readFileSync(dataPath, 'utf8')) as LocomoSample[]
  const maxConv = opts.maxConv ?? 0
  if (maxConv > 0) samples = samples.slice(0, maxConv)
  return samples
}

// parseSessionDateTime + the MONTHS table now live in src/memory/conversation-segmenter.ts (single
// source of truth, shared by the B3 conversation segmenter). Imported + re-exported at the top.

/** dia_id `D2:8` ⇄ filesystem-safe basename `D2-8` (single ':' → single '-'). */
export function fileForDia(diaId: string): string {
  return `${diaId.replace(':', '-')}.md`
}
export function diaFromFilePath(fp: string): string {
  const base = fp.replace(/^.*\//, '').replace(/\.md$/, '')
  return base.replace('-', ':')
}

/** Flatten a conversation into ordered per-turn nodes with a real event-time τ (session datetime). */
export function extractTurns(conversation: Record<string, unknown>, maxTurns: number): Turn[] {
  const sessionKeys = Object.keys(conversation)
    .filter((k) => /^session_\d+$/.test(k))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))
  const turns: Turn[] = []
  for (const sk of sessionKeys) {
    const tauMs = parseSessionDateTime(conversation[`${sk}_date_time`])
    const arr = conversation[sk]
    if (!Array.isArray(arr)) continue
    for (const t of arr as LocomoTurn[]) {
      if (!t || typeof t.dia_id !== 'string') continue
      const text = typeof t.text === 'string' ? t.text.trim() : ''
      const cap = typeof t.blip_caption === 'string' ? t.blip_caption.trim() : ''
      let content = `${t.speaker}: ${text}`.trim()
      if (cap) content += `\n[shared image: ${cap}]`
      if (!content) continue
      turns.push({ diaId: t.dia_id, content, tauMs })
    }
  }
  return maxTurns > 0 ? turns.slice(0, maxTurns) : turns
}

// Common capitalized words that are usually sentence-initial noise, not proper nouns.
const CAP_STOP = new Set([
  'The',
  'This',
  'That',
  'These',
  'Those',
  'There',
  'Then',
  'They',
  'Their',
  'Them',
  'And',
  'But',
  'For',
  'Yes',
  'Yeah',
  'You',
  'Your',
  'Yours',
  'Was',
  'Were',
  'What',
  'When',
  'Where',
  'Which',
  'Who',
  'Why',
  'How',
  'Not',
  'Now',
  'One',
  'Two',
  'His',
  'Her',
  'Its',
  'Our',
  'She',
  'Him',
  'Have',
  'Has',
  'Had',
  'Just',
  'Its',
  'Are',
  'Its',
  'Sure',
  'Oh',
  'Hey',
  'Good',
  'Great',
  'Wow',
  'Nice',
  'Thanks',
  'Thank',
  'Well',
  'Also',
  'Some',
  'Any',
  'All',
  'Let',
  'Get',
  'Got',
  'Can',
  'Will',
  'Would',
  'Could',
  'Should',
  'Maybe',
  'Really',
  'Very',
  'Congrats',
  'Awesome',
  'Amazing',
  'Absolutely',
  'Definitely',
  'Actually',
  'Haha',
])

/**
 * ORACLE per-conversation gazetteer — UPPER-BOUND measurement control ONLY (NOT WS-2a). Built by a
 * deliberately crude, deterministic heuristic (speaker names + capitalized proper-noun tokens seen
 * ≥2×), mirroring `multihop-eval-harness.ts`'s hand-authored FIX_GAZ but derived per conversation.
 * Over-inclusion only INFLATES the graph's ceiling, which is exactly what an upper bound should do.
 */
export function oracleGazetteer(sample: LocomoSample, turns: readonly Turn[]): GazetteerEntry[] {
  const entries = new Map<string, GazetteerEntry>()
  const add = (tok: string) => {
    const canonical = tok
    const key = canonical.toLowerCase()
    if (!entries.has(key)) entries.set(key, { canonical, kind: 'concept', aliases: [key] })
  }
  for (const s of ['speaker_a', 'speaker_b'] as const) {
    const v = sample.conversation[s]
    if (typeof v === 'string' && v.trim()) add(v.trim())
  }
  const freq = new Map<string, number>()
  for (const t of turns) {
    for (const m of t.content.matchAll(/\b[A-Z][a-zA-Z]{2,}\b/g)) {
      const tok = m[0]!
      if (CAP_STOP.has(tok)) continue
      freq.set(tok, (freq.get(tok) ?? 0) + 1)
    }
  }
  const ranked = [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 60)
  for (const [tok] of ranked) add(tok)
  return [...entries.values()]
}

/** Build an isolated per-conversation vault: per-turn nodes, τ→mtime, real BGE + P-substrate edges. */
export async function buildVault(
  turns: readonly Turn[],
  prodGaz: readonly GazetteerEntry[],
): Promise<Vault> {
  const root = mkdtempSync(join(tmpdir(), 'scns-locomo-'))
  let withTau = 0
  for (const t of turns) {
    const p = join(root, fileForDia(t.diaId))
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, t.content)
    if (t.tauMs !== null) {
      const secs = t.tauMs / 1000
      utimesSync(p, secs, secs) // τ (session datetime) → file mtime → temporal backbone
      withTau++
    }
  }
  const db = openMemoryDb(join(root, 'vault.db'))
  const vault = createVault({ rootDir: root })
  await indexVault(db, vault, undefined, undefined, {
    extractEntities: true,
    buildSemantic: true,
    gazetteer: prodGaz,
  })
  const chunks = db.prepare('SELECT id, file_path FROM chunks').all() as Array<{
    id: number
    file_path: string
  }>
  const diaOfId = new Map<number, string>()
  for (const c of chunks) diaOfId.set(c.id, diaFromFilePath(c.file_path))
  const turnDiaSet = new Set(turns.map((t) => t.diaId))
  return { db, root, diaOfId, turnDiaSet, tauCoverage: turns.length ? withTau / turns.length : 0 }
}

/**
 * Snapshot a built+ingested vault's SQLite DB to `destDbPath` as a consistent standalone file via
 * better-sqlite3's online backup (WAL-safe — the source opens `journal_mode=WAL`). This is the
 * ingest-once artifact: the expensive real-BGE index + ACP event/causal ingest happen ONCE, then every
 * downstream arm (deterministic token frontier, judged accuracy, any determinism repeat) REOPENS this
 * snapshot instead of re-ingesting. Verified to preserve the sqlite-vec `chunk_embeddings` vec0 table
 * (KNN works post-reopen). Creates the parent dir.
 */
export async function snapshotVaultDb(vault: Vault, destDbPath: string): Promise<void> {
  mkdirSync(dirname(destDbPath), { recursive: true })
  await (vault.db as unknown as { backup(dest: string): Promise<unknown> }).backup(destDbPath)
}

/**
 * Reopen a {@link snapshotVaultDb} snapshot as a {@link Vault} for the retrieval-only downstream arms
 * (token frontier + judged accuracy). Rebuilds `diaOfId`/`turnDiaSet`/`tauCoverage` deterministically
 * from the snapshot's `chunks` + the sample `turns` (no re-index, no ACP). `openMemoryDb` is idempotent
 * (CREATE TABLE IF NOT EXISTS) so reopening a populated DB is a no-op on schema.
 */
export function reopenVaultSnapshot(destDbPath: string, turns: readonly Turn[]): Vault {
  const db = openMemoryDb(destDbPath)
  const chunks = db.prepare('SELECT id, file_path FROM chunks').all() as Array<{
    id: number
    file_path: string
  }>
  const diaOfId = new Map<number, string>()
  for (const c of chunks) diaOfId.set(c.id, diaFromFilePath(c.file_path))
  let withTau = 0
  for (const t of turns) if (t.tauMs !== null) withTau++
  return {
    db,
    root: dirname(destDbPath),
    diaOfId,
    turnDiaSet: new Set(turns.map((t) => t.diaId)),
    tauCoverage: turns.length ? withTau / turns.length : 0,
  }
}
