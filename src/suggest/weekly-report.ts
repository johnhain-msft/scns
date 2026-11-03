/**
 * The weekly ROUTING report — ONE renderer, TWO callers.
 *
 * F1: the learning section used to have a single caller inside `scns review weekly`, so the Monday
 * `weekly-promotion-review` cron (scheduler task id kept for continuity — it is a stored key) emitted
 * only a pino line telling the human to go run that command. This module holds the evidence-read +
 * render so BOTH the scheduled handler and the interactive command render from exactly the same code.
 *
 * Step 2 (2026-08-15): the section now reports ROUTING ACCURACY under the purpose frame (NORTH_STAR
 * "Retrieval design intent", 2026-08-14) — per-tool accept/waste, sliced by the shadow hop-shape
 * classifier's predicted shape, plus classifier-vs-outcome agreement — instead of a promote/retire
 * verdict. The honesty discipline (three-state evidence, no zero rendered as fact, measured caveats)
 * is carried over unchanged.
 *
 * Kept deliberately thin: the presentation lives in `routing-format.ts` (pure, I/O-free) and the
 * numbers in `reward/routing-accuracy.ts`; this module owns only the I/O and the three-state
 * evidence handling around them.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ARM_SAMPLE_WHERE,
  type EvidenceRead,
  type ExperienceStore,
  openExperienceStoreReadOnly,
  readSettledByArm,
  readServedByArm,
  countExcludedFromArmSample,
} from '../memory/experience-store.js'
import { resolveBriefingTools } from '../memory/explore-router.js'
import {
  computeRoutingAccuracy,
  loadRoutingRows,
  type RoutingAccuracyReport,
} from '../reward/routing-accuracy.js'
import type { Suggestion } from './types.js'
import type { WeeklySession } from './weekly-session.js'
import { formatReviewItem, formatWeeklyHeader } from './weekly-format.js'
import { formatRoutingAccuracy } from './routing-format.js'

export interface RoutingAccuracySectionInput {
  /** The `.scns` directory (i.e. `join(resolveScnsHome(), '.scns')`). */
  readonly scnsDir: string
  /** The tools the briefing can serve today; defaults to `resolveBriefingTools()` (env-derived). */
  readonly tools?: readonly string[]
  /**
   * Explicit experience-store path (the offline harness points it at a copy or a snapshot). Defaults
   * to `<scnsDir>/memory/experience.db`, which is what both live callers use.
   */
  readonly dbPath?: string
}

export interface RoutingAccuracySection {
  /** The rendered section, ready to print or to embed in the review document. */
  readonly text: string
  /** Non-null when the evidence base could NOT be read — never conflate this with "zero outcomes". */
  readonly evidenceError: string | null
  readonly settledByArm: ReadonlyMap<string, number>
  readonly servedByArm: ReadonlyMap<string, number>
  /** The computed report, or null when the evidence could not be read. */
  readonly report: RoutingAccuracyReport | null
}

/**
 * The known OPEN defects touching the records the routing numbers are computed from (FR-038),
 * MEASURED against the corpus rather than hardcoded.
 *
 * The spec names "two records in the current quorum — 1825 and 1826" as provenance-free. Measured on
 * the live corpus 2026-08-02 there are THREE (1824, 1825, 1826), and the duplicate-binding defect
 * touches ZERO rows of the arm sample. A hardcoded list would have understated the real defect and
 * asserted one that is not there — and would be wrong again next week.
 *
 * SCOPED TO `arms` — the live tools the numbers are actually computed over. Measuring across every
 * arm-assigned row instead meant a defect on a no-longer-served third arm qualified numbers it could
 * not have affected. Over-reporting is not the safe direction: it trains the reader to discount
 * caveats that do not apply, which is how the ones that do get missed. Omitting `arms` falls back to
 * the whole arm sample, because a caller that cannot name the comparison must not be handed silence.
 *
 * NOT fail-safe: an unreadable corpus must not render as "no known open defect".
 */
export function detectSampleCaveats(store: ExperienceStore, arms?: readonly string[]): string[] {
  const out: string[] = []
  // Identifiers come from resolveBriefingTools(), never from user input, but they are still bound
  // rather than interpolated.
  const armScope = arms && arms.length > 0 ? ` AND explore_arm IN (${arms.map(() => '?').join(',')})` : ''
  const armParams = arms && arms.length > 0 ? [...arms] : []

  const noProvenance = store.db
    .prepare(
      `SELECT id FROM retrieval_experience WHERE ${ARM_SAMPLE_WHERE}${armScope} AND answer_source IS NULL
        ORDER BY id`,
    )
    .all(...armParams) as Array<{ id: number }>
  if (noProvenance.length > 0) {
    const ids = noProvenance.map((r) => r.id).join(', ')
    out.push(
      `FR-034 — ${noProvenance.length} record(s) in this sample carry no answer_source provenance ` +
        `(id ${ids}); a derived label cannot be told apart from one you gave me directly.`,
    )
  }

  // WHERE THE TURN ACTUALLY LIVES. Measured on the live corpus 2026-08-02: `turn` is NULL on all
  // 2059 rows, while 27 settled rows carry their turn inside `answer_source`
  // (`transcript-oracle:turn-4`, `followup:dispute:turn-4:conf-0.90`). Keying this check on the
  // column alone made it UNREACHABLE in production — it could never fire, so its silence read as
  // "no duplicate binding" when it actually meant "never looked". SQLite's CAST stops at the first
  // non-digit, so `4:conf-0.90` parses to 4.
  const turnExpr = `CASE
      WHEN turn IS NOT NULL THEN turn
      WHEN answer_source LIKE '%turn-%'
        THEN CAST(substr(answer_source, instr(answer_source, 'turn-') + 5) AS INTEGER)
      ELSE NULL END`

  const dupes = store.db
    .prepare(
      `SELECT conversation_id, COUNT(*) n, GROUP_CONCAT(id) ids
         FROM (SELECT id, conversation_id, ${turnExpr} AS turn_no
                 FROM retrieval_experience
                WHERE ${ARM_SAMPLE_WHERE}${armScope} AND conversation_id IS NOT NULL)
        WHERE turn_no IS NOT NULL
        GROUP BY conversation_id, turn_no HAVING n > 1`,
    )
    .all(...armParams) as Array<{ n: number; ids: string }>
  if (dupes.length > 0) {
    const total = dupes.reduce((a, d) => a + d.n, 0)
    out.push(
      `issue #18 (duplicate turn binding) — ${total} record(s) across ${dupes.length} turn(s) share ` +
        `one human turn as their labelling basis (id ${dupes.map((d) => d.ids).join('; ')}); ` +
        `those outcomes are not independent evidence.`,
    )
  }

  return out
}

/**
 * Read the evidence base and render ROUTING ACCURACY — what the labels say about whether each query
 * went to the tool its hop-shape required (NORTH_STAR "Retrieval design intent", 2026-08-14). Replaces
 * the promote/retire section; the honesty discipline is unchanged.
 *
 * READ-ONLY by construction: merely viewing a review must never create, migrate or WAL-checkpoint the
 * live corpus, so the strict reads open with `{ readonly: true, fileMustExist: true }` behind an
 * ENOENT check (`statSync`, NOT `existsSync` — the latter reports a permissions failure as "absent";
 * PR #24, finding A). The three states — absent / failed / ok — stay distinguishable because an I/O
 * failure that rendered as zeros would name the WRONG blocking precondition, which is the exact defect
 * this section exists to eliminate.
 *
 * Classification happens HERE, at read time, from `query_text` — the heuristic is a pure, versioned
 * function, so storing its verdict would duplicate derivable data and go stale on every revision. No
 * schema change, no live-path change: the experience store is opened read-only and nothing is written.
 */
interface RoutingEvidence {
  readonly evidence: EvidenceRead
  readonly settledByArm: ReadonlyMap<string, number>
  readonly servedByArm: ReadonlyMap<string, number>
  readonly report: RoutingAccuracyReport | null
  readonly excluded: { unassigned: number; machine: number }
  /** `undefined` = NOT MEASURED, `[]` = measured and clean — load-bearing, never collapsed. */
  readonly sampleCaveats: string[] | undefined
}

/** The read half: strict three-state counts, then the routing rows, exclusions and caveats — all read-only. */
function readRoutingEvidence(expPath: string, liveTools: readonly string[]): RoutingEvidence {
  // The STRICT reads own the three-state discrimination [FR-024/FR-026]. The GROUP BY they run
  // touches every column the counts depend on (`explore_arm`, `retriever`, `prompt_origin`,
  // `human_outcome`), so schema drift surfaces as `failed` instead of being swallowed by the fail-safe
  // counters and re-rendered as an empty corpus one layer down. A HALF-read evidence base is not a
  // usable one: if either side is unreadable the section reports the worse state.
  const settledRead = readSettledByArm(expPath)
  const servedRead = readServedByArm(expPath)
  const empty: RoutingEvidence = {
    evidence: settledRead.status !== 'ok' ? settledRead : servedRead,
    settledByArm: new Map(),
    servedByArm: new Map(),
    report: null,
    excluded: { unassigned: 0, machine: 0 },
    sampleCaveats: undefined,
  }
  if (settledRead.status !== 'ok' || servedRead.status !== 'ok') return empty

  let s: ExperienceStore | undefined
  let report: RoutingAccuracyReport | null = null
  let excluded = { unassigned: 0, machine: 0 }
  let sampleCaveats: string[] | undefined
  let evidence: EvidenceRead = servedRead
  try {
    s = openExperienceStoreReadOnly(expPath)
    // The routing rows ARE the evidence this section is about; a failure here is a failed read of
    // the evidence base, not a lost annotation, and is reported as such (never as an empty corpus).
    report = computeRoutingAccuracy(loadRoutingRows(s), { tools: liveTools })
    // FR-019: reported on their own line, never merged into a tool.
    excluded = countExcludedFromArmSample(s)
  } catch (err) {
    report = null
    evidence = { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
  if (s && report) {
    try {
      // FR-038: measured against THIS corpus, scoped to the tools the numbers are computed over.
      sampleCaveats = detectSampleCaveats(s, liveTools)
    } catch {
      // These annotations sit ON a sample that was already read successfully. Losing them degrades
      // the caveats, not the counts — so it must not escalate an `ok` evidence base to `failed`.
      // `undefined`, NOT a one-element array: "nothing was checked" is the true state and must not
      // file itself under "known open defects" as a finding ABOUT the corpus.
      sampleCaveats = undefined
    }
  }
  try {
    s?.close()
  } catch {
    /* idempotent */
  }
  return {
    evidence,
    settledByArm: settledRead.counts,
    servedByArm: servedRead.counts,
    report,
    excluded,
    sampleCaveats,
  }
}

export function renderRoutingAccuracySection(
  input: RoutingAccuracySectionInput,
): RoutingAccuracySection {
  const liveTools = input.tools ?? resolveBriefingTools()
  const expPath = input.dbPath ?? join(input.scnsDir, 'memory', 'experience.db')
  const ev = readRoutingEvidence(expPath, liveTools)

  const text = formatRoutingAccuracy({
    evidence: ev.evidence.status === 'ok' ? { status: 'ok' } : ev.evidence,
    report: ev.report ?? undefined,
    excluded: ev.excluded,
    sampleCaveats: ev.sampleCaveats,
  })

  // Preserved for callers that branch on "could the evidence be read at all" (`cli.ts`). Derived from
  // the discriminant rather than being a second source of truth for it.
  const evidenceError =
    ev.evidence.status === 'absent'
      ? `no experience store at ${ev.evidence.path} (the live broker creates it on first retrieval)`
      : ev.evidence.status === 'failed'
        ? ev.evidence.error
        : null

  return {
    text,
    evidenceError,
    settledByArm: ev.settledByArm,
    servedByArm: ev.servedByArm,
    report: ev.report,
  }
}

/**
 * Where the Monday cron lands its report. `~/.scns/reviews/weekly-<date>.md` (John's ruling
 * 2026-08-02: file + a log pointer, so he never has to run a second command to read it).
 *
 * Dated from the ISO calendar day so a Monday 09:00 run and a re-run are the same file rather than
 * accumulating near-duplicates the human then has to reconcile.
 */
export function weeklyReviewFilePath(scnsDir: string, now: Date): string {
  return join(scnsDir, 'reviews', `weekly-${now.toISOString().slice(0, 10)}.md`)
}

export interface WeeklyReviewDocumentInput {
  readonly session: WeeklySession
  /** The already-rendered routing-accuracy section (so the caller controls how the evidence read is guarded). */
  readonly learningText: string
  /** Resolves a packet item id to the full suggestion; nullish when it has since vanished. */
  readonly getSuggestion: (id: string) => Suggestion | null | undefined
}

/**
 * The COMPLETE weekly report: header, learning status, and the detail of every item awaiting a ruling.
 *
 * The items are the point. A report that says "3 of 20 pending item(s) selected" and then names none
 * still forces the human to run `scns review weekly` to find out WHAT to rule on, which is exactly the
 * second command John's ruling removed. Rendering the same `formatReviewItem` the interactive path
 * uses is also what keeps the two from drifting: the file and the terminal describe an item
 * identically, so a disagreement between them is impossible rather than merely unlikely.
 *
 * Recording a decision remains interactive by nature — a file cannot take input — so the document ends
 * by naming the command that records, not the command that reveals.
 */
export function renderWeeklyReviewDocument(input: WeeklyReviewDocumentInput): string {
  const { session, learningText, getSuggestion } = input
  const parts: string[] = [formatWeeklyHeader(session), learningText]

  if (session.hasWork) {
    const items = session.packet.items
    for (const [i, item] of items.entries()) {
      const s = getSuggestion(item.id)
      if (s) parts.push(formatReviewItem(s, i + 1, items.length, item.why))
    }
    parts.push('', 'To record your decisions: `scns review weekly`')
  }

  return `${parts.join('\n')}\n`
}

export interface WriteWeeklyReviewFileInput {
  readonly scnsDir: string
  readonly now: Date
  readonly text: string
}

/** Write the rendered review and return its path. Creates `reviews/` on first use. */
export function writeWeeklyReviewFile(input: WriteWeeklyReviewFileInput): string {
  const path = weeklyReviewFilePath(input.scnsDir, input.now)
  mkdirSync(join(input.scnsDir, 'reviews'), { recursive: true })
  writeFileSync(path, input.text, 'utf-8')
  return path
}
