/**
 * DECISION RATIONALE — the durable record of why John said yes or no.
 *
 * WHY THIS EXISTS. Until now the system learned from half of John's reasoning. When he REJECTED a
 * proposal his words survived (a rejection is terminal; nothing transitions it again) and Monday's
 * sweep carried them to `proposal_outcomes`. When he APPROVED, the same words were erased minutes
 * later by a reason-less `updateStatus(id, 'implemented')` on the auto-execute path. The corpus that
 * is meant to teach the system to model his intent was therefore being built from his objections
 * only. In his words:
 *
 *   "it is important to understand why i approve *and* reject something because otherwise i'm
 *    allowing the machine to make assumptions about *why* i accepted something -- which could
 *    incorrectly skew the intent algorithm."
 *
 * DESIGN — option C′ (John's ruling, 2026-08-03). Three properties, each load-bearing:
 *
 * 1. **Separate from the verdict row.** `proposal_outcomes` is
 *    `UNIQUE(suggestion_id, entity, family) ON CONFLICT DO NOTHING`, and on conflict it RETURNS the
 *    pre-existing row — so a caller checking the result is actively misled into thinking its write
 *    landed. Banking an outcome at approval time (option A) would therefore make the real terminal
 *    outcome a silent no-op and the learner would never find out whether an approved proposal
 *    actually shipped. Measured, not assumed:
 *      1st write -> implemented | 2nd write ATTEMPTED failed -> API returned implemented
 *      ROWS STORED: [{"verdict":"implemented", ...}]   (the 'failed' verdict simply vanished)
 *    So this record is its own table, and capture NEVER writes `proposal_outcomes`.
 *
 * 2. **Append-only, and deliberately WITHOUT a unique constraint.** Same lesson: a constraint here
 *    would make a second decision on the same proposal a silent no-op. Two decisions are two facts.
 *
 * 3. **Two surfaces, neither redundant** — John: *"Markdown is easy for me to audit and read -- as
 *    well as an llm. the row is perfect for scns."* The markdown is the human/LLM audit surface and
 *    is explicitly TEMPORARY (its named successor is a dashboard, or an API/skill); the row is the
 *    machine surface. A later refactor must not drop the markdown in favour of the table.
 *
 * WRITER OWNERSHIP (FR-053a). The weekly review runs in the CLI process; the BROKER owns the vault
 * db handle (`weekly-session.ts:228-231`), and `openMemoryDb` runs migrations on every open. So the
 * two surfaces are split by who can safely write them:
 *
 *   - `vault` (markdown) is a plain atomic filesystem write — `writeFileSync` + `renameSync`,
 *     `vault.ts:83`, no SQLite whatsoever. The CLI writes it AT DECISION TIME, and a failure is
 *     returned synchronously so John learns about it while he is still sitting there (FR-053).
 *   - `db` (the row) is written only where a db handle is already owned — i.e. in the broker, via
 *     `ingestDecisionRationales`. The CLI never opens the vault, so the single-writer invariant is
 *     not touched.
 *
 * Passing BOTH is supported and is what tests (and any future single-process caller) do.
 */
import type Database from 'better-sqlite3'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Vault } from './vault.js'

export type RationaleAuthor = 'human' | 'machine'
/**
 * `explain` is deliberately a PEER of the two decisions, not a variant of either.
 *
 * It is John's answer when the proposal cannot be judged at all — signal about the PROPOSAL, not
 * about the idea. Banking it as a rejection would teach the learner the idea was bad when the
 * write-up was bad, the exact inversion a live review already exposed. Its own value means a
 * consumer counting approvals or rejections can never accidentally include it.
 */
export type ReviewVerdict = 'approve' | 'reject' | 'explain'

export interface DecisionRationaleInput {
  readonly suggestionId: string
  readonly title?: string
  /** The words, VERBATIM. Never summarised, never reformatted. */
  readonly text: string
  readonly author: RationaleAuthor
  /** What John chose. */
  readonly reviewVerdict: ReviewVerdict
  /**
   * The suggestion's status at that moment — which DIVERGES from the verdict and must be stored
   * separately. `weekly-session.ts:203-206` keeps the existing status for already-terminal items,
   * so most of Monday's approvals are backfills onto items already marked `implemented`. Storing
   * only the status would count zero approvals in a week where John approved everything.
   */
  readonly suggestionStatus: string
  /** Structured reason code, when the review captured one. */
  readonly code?: string | null
  readonly at?: Date
}

export interface DecisionRationaleDeps {
  /** Markdown surface. Plain filesystem — safe from any process. */
  readonly vault?: Vault
  /** Row surface. Only supply where the vault db handle is already owned (the broker). */
  readonly db?: Database.Database
  readonly now?: () => Date
}

export interface DecisionRationaleResult {
  readonly recorded: boolean
  readonly markdownPath?: string
  readonly rowId?: number
  /**
   * FR-053: surfaced, never swallowed. John has already spent the effort of typing; a silent
   * infrastructure failure is the same data loss by another route.
   */
  readonly errors: readonly string[]
}

export interface DecisionRationaleRow {
  readonly id: number
  readonly suggestionId: string
  readonly title: string | null
  readonly text: string
  readonly author: RationaleAuthor
  readonly reviewVerdict: string
  readonly suggestionStatus: string
  readonly code: string | null
  readonly recordedAt: string
  readonly sourcePath: string | null
}

/** Where the markdown corpus lives inside the vault. */
export const DECISIONS_DIR = 'decisions'

export function ensureDecisionRationaleSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_rationale (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      suggestion_id TEXT NOT NULL,
      title TEXT,
      text TEXT NOT NULL,
      author TEXT NOT NULL CHECK (author IN ('human','machine')),
      review_verdict TEXT NOT NULL,
      suggestion_status TEXT NOT NULL,
      code TEXT,
      recorded_at TEXT NOT NULL,
      source_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_decision_rationale_suggestion
      ON decision_rationale(suggestion_id);
    CREATE INDEX IF NOT EXISTS idx_decision_rationale_author
      ON decision_rationale(author);
  `)
}

function tableExists(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decision_rationale'")
    .get() as { name?: string } | undefined
  return Boolean(row?.name)
}

/** A stable, collision-free path for one decision. Sorts chronologically. */
export function decisionEntryPath(input: {
  readonly suggestionId: string
  readonly reviewVerdict: string
  readonly at: Date
}): string {
  const iso = input.at.toISOString()
  const date = iso.slice(0, 10)
  const time = iso.slice(11, 23).replace(/[:.]/g, '')
  // Time BEFORE verdict so plain filename order is chronological order — for `ls`, for the ingest
  // sweep, and for anyone reading the corpus by hand.
  return `${DECISIONS_DIR}/${date}-${time}-${input.reviewVerdict}-${input.suggestionId.slice(0, 8)}.md`
}

/**
 * Render one decision.
 *
 * The words go in a fenced block, unmodified, so nothing downstream is tempted to reflow them and
 * no markdown character in John's text can change how the entry parses.
 */
const VERDICT_HEADINGS: Readonly<Record<string, string>> = {
  approve: 'Approved',
  reject: 'Rejected',
  explain: 'Could not judge',
}

export function renderDecisionEntry(input: DecisionRationaleInput, at: Date): string {
  return [
    '---',
    `suggestionId: "${input.suggestionId}"`,
    `author: "${input.author}"`,
    `reviewVerdict: "${input.reviewVerdict}"`,
    `suggestionStatus: "${input.suggestionStatus}"`,
    ...(input.code ? [`code: "${input.code}"`] : []),
    `recordedAt: "${at.toISOString()}"`,
    '---',
    '',
    `# ${VERDICT_HEADINGS[input.reviewVerdict] ?? 'Decision'}: ${input.title ?? input.suggestionId}`,
    '',
    `## Why (${input.author}, verbatim)`,
    '',
    '```text',
    input.text,
    '```',
    '',
  ].join('\n')
}

/**
 * Capture one decision. Writes whichever surfaces the caller supplied a dependency for.
 *
 * An absent dependency is reported in `errors` rather than being silently skipped — a capture that
 * quietly wrote nothing is the failure mode this whole feature exists to remove.
 */
export function recordDecisionRationale(
  deps: DecisionRationaleDeps,
  input: DecisionRationaleInput,
): DecisionRationaleResult {
  const at = input.at ?? deps.now?.() ?? new Date()
  const errors: string[] = []

  // FR-051: absence must stay representable. A decision with no substance records nothing at all,
  // rather than an empty placeholder that a later reader would mistake for a reason.
  if (input.text.trim() === '') {
    return { recorded: false, errors: ['no rationale text — nothing recorded'] }
  }

  let markdownPath: string | undefined
  if (deps.vault) {
    const path = decisionEntryPath({ ...input, at })
    try {
      deps.vault.write(path, renderDecisionEntry(input, at))
      markdownPath = path
    } catch (err) {
      errors.push(`markdown rationale NOT saved (${path}): ${(err as Error).message}`)
    }
  } else {
    errors.push('no vault available — the markdown rationale was not written')
  }

  let rowId: number | undefined
  if (deps.db) {
    try {
      ensureDecisionRationaleSchema(deps.db)
      const res = deps.db
        .prepare(
          `INSERT INTO decision_rationale
             (suggestion_id, title, text, author, review_verdict, suggestion_status, code, recorded_at, source_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.suggestionId,
          input.title ?? null,
          input.text,
          input.author,
          input.reviewVerdict,
          input.suggestionStatus,
          input.code ?? null,
          at.toISOString(),
          markdownPath ?? null,
        )
      rowId = Number(res.lastInsertRowid)
    } catch (err) {
      errors.push(`rationale row NOT saved: ${(err as Error).message}`)
    }
  }

  return {
    recorded: markdownPath !== undefined || rowId !== undefined,
    ...(markdownPath ? { markdownPath } : {}),
    ...(rowId !== undefined ? { rowId } : {}),
    errors,
  }
}

/**
 * Read the corpus.
 *
 * Tolerates a missing table on purpose: the live vault is opened read-only by probes and by
 * `runRewardReport`, so a read must never have a write side-effect such as creating a table.
 */
export function readDecisionRationales(
  db: Database.Database,
  filter: { readonly suggestionId?: string; readonly author?: RationaleAuthor } = {},
): DecisionRationaleRow[] {
  if (!tableExists(db)) return []

  const where: string[] = []
  const params: unknown[] = []
  if (filter.suggestionId) {
    where.push('suggestion_id = ?')
    params.push(filter.suggestionId)
  }
  if (filter.author) {
    where.push('author = ?')
    params.push(filter.author)
  }

  const rows = db
    .prepare(
      `SELECT id, suggestion_id, title, text, author, review_verdict, suggestion_status, code,
              recorded_at, source_path
         FROM decision_rationale
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        -- Chronological by when John SPOKE, not by when a sweep happened to ingest the file.
        -- Ingest order is directory order, and the entry filename carries the verdict before the
        -- timestamp, so an approve entry sorts ahead of an earlier explain entry for the same item.
        -- Ordering by id would present his responses in the wrong sequence.
        ORDER BY recorded_at ASC, id ASC`,
    )
    .all(...params) as Array<Record<string, unknown>>

  return rows.map((r) => ({
    id: Number(r['id']),
    suggestionId: String(r['suggestion_id']),
    title: (r['title'] as string | null) ?? null,
    text: String(r['text']),
    author: r['author'] as RationaleAuthor,
    reviewVerdict: String(r['review_verdict']),
    suggestionStatus: String(r['suggestion_status']),
    code: (r['code'] as string | null) ?? null,
    recordedAt: String(r['recorded_at']),
    sourcePath: (r['source_path'] as string | null) ?? null,
  }))
}

/** Frontmatter of one markdown decision entry, plus the verbatim body. */
export function parseDecisionEntry(
  content: string,
): (Omit<DecisionRationaleInput, 'at'> & { readonly recordedAt: string }) | null {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(content)
  if (!fm) return null
  const field = (name: string): string | undefined =>
    new RegExp(`^${name}:\\s*"([\\s\\S]*?)"\\s*$`, 'm').exec(fm[1]!)?.[1]

  const suggestionId = field('suggestionId')
  const author = field('author')
  const reviewVerdict = field('reviewVerdict')
  const recordedAt = field('recordedAt')
  if (!suggestionId || !author || !reviewVerdict || !recordedAt) return null

  const body = /```text\n([\s\S]*?)\n```/.exec(content)
  if (!body) return null

  const title = /^#\s+(?:Approved|Rejected):\s*(.+)$/m.exec(content)?.[1]

  return {
    suggestionId,
    text: body[1]!,
    author: author as RationaleAuthor,
    reviewVerdict: reviewVerdict as ReviewVerdict,
    suggestionStatus: field('suggestionStatus') ?? 'unknown',
    code: field('code') ?? null,
    recordedAt,
    ...(title ? { title } : {}),
  }
}

export interface IngestResult {
  readonly scanned: number
  readonly ingested: number
  readonly errors: readonly string[]
}

/**
 * Carry markdown decisions the CLI wrote into the row surface. Runs in the BROKER, which already
 * owns the db handle — see the writer-ownership note at the top of this file.
 *
 * Dedupe is an EXPLICIT `source_path` lookup rather than a unique constraint, because a constraint
 * is precisely what makes a second genuine decision a silent no-op (the `proposal_outcomes` lesson).
 */
export function ingestDecisionRationales(deps: {
  readonly db: Database.Database
  readonly vault: Vault
}): IngestResult {
  ensureDecisionRationaleSchema(deps.db)

  // Scoped to the decisions dir rather than `vault.listFiles()`, which walks the WHOLE vault and
  // reads every markdown file into memory — a quarter-gigabyte of unrelated content to find a
  // handful of entries.
  const dir = join(deps.vault.rootDir, DECISIONS_DIR)
  const entries = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => `${DECISIONS_DIR}/${f}`)
    : []

  const errors: string[] = []
  let ingested = 0

  const seen = deps.db.prepare('SELECT 1 FROM decision_rationale WHERE source_path = ?')
  const insert = deps.db.prepare(
    `INSERT INTO decision_rationale
       (suggestion_id, title, text, author, review_verdict, suggestion_status, code, recorded_at, source_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const path of entries) {
    try {
      if (seen.get(path)) continue
      const file = deps.vault.read(path)
      if (!file) continue
      const parsed = parseDecisionEntry(file.content)
      if (!parsed) {
        errors.push(`unparseable decision entry: ${path}`)
        continue
      }
      insert.run(
        parsed.suggestionId,
        parsed.title ?? null,
        parsed.text,
        parsed.author,
        parsed.reviewVerdict,
        parsed.suggestionStatus,
        parsed.code ?? null,
        parsed.recordedAt,
        path,
      )
      ingested++
    } catch (err) {
      errors.push(`could not ingest ${path}: ${(err as Error).message}`)
    }
  }

  return { scanned: entries.length, ingested, errors }
}
