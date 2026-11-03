/**
 * LongMemEval judge-harness pure core (T019 [US1], specs/001-learning-memory-loop).
 *
 * The LongMemEval benchmark (Wu et al. 2024, arXiv:2410.10813; huggingface.co/datasets/xw27/longmemeval)
 * is the HELD-OUT go-live gate for output-changing retrieval flips — graded on the SAME right axis as
 * the LoCoMo ruler: blind LLM-judge ANSWER accuracy + o200k context tokens, never retrieval recall.
 *
 * This module is the importable, side-effect-free core the harness CLI wires: instance parsing
 * (tolerant, drop-counting — benchmark noise is reported, never silently kept), a deterministic
 * session→doc mapping for isolated-vault ingestion, control-item construction that reuses the PROVEN
 * LoCoMo control builder (`buildControlPairs`), and per-question-type aggregation that reuses
 * `aggregateAccuracy` (question types map to stable numeric indexes so the shared category-keyed
 * machinery applies unchanged — zero duplication).
 *
 * σ note: judge test-retest σ is a property of the JUDGE MODEL, not the corpus — the pinned-model σ
 * established via the LoCoMo variance mode applies here unchanged (re-establish on model change).
 */
import {
  aggregateAccuracy,
  type ControlItem,
  type CategoryAccuracy,
  type AccuracyAggregate,
} from './locomo-judge-lib.js'

// ── question types (the paper's five core abilities → six labeled types) ─────────────────────────

/** The six official LongMemEval question types. Index = the stable numeric category used internally. */
export const LME_QUESTION_TYPES = [
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'temporal-reasoning',
  'knowledge-update',
  'multi-session',
] as const

export type LmeQuestionType = (typeof LME_QUESTION_TYPES)[number]

/** Stable index of a question type. Throws on an unknown type — never a silent bucket. */
export function lmeTypeIndex(t: string): number {
  const i = (LME_QUESTION_TYPES as readonly string[]).indexOf(t)
  if (i < 0) throw new Error(`unknown LongMemEval question_type: ${JSON.stringify(t)}`)
  return i
}

/** Inverse of {@link lmeTypeIndex}. Throws on an out-of-range index. */
export function lmeTypeOfIndex(i: number): LmeQuestionType {
  const t = LME_QUESTION_TYPES[i]
  if (!t) throw new Error(`unknown LongMemEval question_type index: ${i}`)
  return t
}

// ── instance parsing ──────────────────────────────────────────────────────────────────────────────

export interface LmeTurn {
  readonly role: string
  readonly content: string
}

export interface LmeInstance {
  readonly questionId: string
  readonly questionType: LmeQuestionType
  readonly question: string
  /** Gold answer, coerced to string (the dataset carries strings and numbers). */
  readonly answer: string
  readonly questionDate: string | null
  readonly haystackDates: readonly string[]
  readonly haystackSessionIds: readonly string[]
  readonly haystackSessions: readonly (readonly LmeTurn[])[]
  readonly answerSessionIds: readonly string[]
  /** `question_id` ending `_abs` — the abstention subset (gold = "not answerable"). */
  readonly isAbstention: boolean
}

function parseTurns(raw: unknown): LmeTurn[] | null {
  if (!Array.isArray(raw)) return null
  const out: LmeTurn[] = []
  for (const t of raw) {
    if (t === null || typeof t !== 'object') return null
    const role = (t as Record<string, unknown>).role
    const content = (t as Record<string, unknown>).content
    if (typeof role !== 'string' || typeof content !== 'string') return null
    out.push({ role, content })
  }
  return out
}

function parseOne(raw: unknown): LmeInstance | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.question_id !== 'string') return null
  if (
    typeof r.question_type !== 'string' ||
    !(LME_QUESTION_TYPES as readonly string[]).includes(r.question_type)
  )
    return null
  if (typeof r.question !== 'string') return null
  if (typeof r.answer !== 'string' && typeof r.answer !== 'number') return null
  if (!Array.isArray(r.haystack_sessions)) return null
  const sessions: (readonly LmeTurn[])[] = []
  for (const s of r.haystack_sessions) {
    const turns = parseTurns(s)
    if (turns === null) return null
    sessions.push(turns)
  }
  const strArray = (v: unknown): readonly string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return {
    questionId: r.question_id,
    questionType: r.question_type as LmeQuestionType,
    question: r.question,
    answer: String(r.answer),
    questionDate: typeof r.question_date === 'string' ? r.question_date : null,
    haystackDates: strArray(r.haystack_dates),
    haystackSessionIds: strArray(r.haystack_session_ids),
    haystackSessions: sessions,
    answerSessionIds: strArray(r.answer_session_ids),
    isAbstention: r.question_id.endsWith('_abs'),
  }
}

/**
 * Parse a raw LongMemEval JSON payload. Malformed entries are DROPPED and counted (the harness
 * reports data quality honestly); a non-array root throws — a corrupt dataset must be loud, never
 * grade as "empty but fine".
 */
export function parseLmeInstances(raw: unknown): { instances: LmeInstance[]; dropped: number } {
  if (!Array.isArray(raw)) throw new Error('LongMemEval dataset root must be an array of instances')
  const instances: LmeInstance[] = []
  let dropped = 0
  for (const entry of raw) {
    const inst = parseOne(entry)
    if (inst === null) dropped++
    else instances.push(inst)
  }
  return { instances, dropped }
}

// ── session → doc mapping (isolated-vault ingestion) ─────────────────────────────────────────────

export interface LmeDoc {
  /** Vault-relative path, stable per (questionId, session index). */
  readonly path: string
  readonly content: string
}

/**
 * Map an instance's haystack sessions to deterministic, ingestible markdown docs: one doc per
 * session — `# Session <sid> (<date>)` header + `role: content` lines. Empty-content turns are
 * skipped; a session with no non-empty turns yields no doc.
 */
export function sessionsToDocs(inst: LmeInstance): LmeDoc[] {
  const docs: LmeDoc[] = []
  inst.haystackSessions.forEach((session, i) => {
    const lines = session
      .filter((t) => t.content.trim() !== '')
      .map((t) => `${t.role}: ${t.content}`)
    if (lines.length === 0) return
    const sid = inst.haystackSessionIds[i] ?? `session-${i}`
    const date = inst.haystackDates[i]
    const header = `# Session ${sid}${date ? ` (${date})` : ''}`
    docs.push({
      path: `${inst.questionId}/session-${String(i).padStart(3, '0')}.md`,
      content: `${header}\n\n${lines.join('\n')}\n`,
    })
  })
  return docs
}

// ── controls + aggregation (REUSE the proven LoCoMo machinery) ───────────────────────────────────

/**
 * Instances → {@link ControlItem}s (category = the stable type index) so the judge-lib
 * `buildControlPairs` yields the R2 controls unchanged: pos candidate = own gold, neg = another
 * item's gold.
 */
export function lmeToControlItems(instances: readonly LmeInstance[]): ControlItem[] {
  return instances.map((i) => ({
    question: i.question,
    gold: i.answer,
    category: lmeTypeIndex(i.questionType),
  }))
}

export interface LmeAccuracyRow {
  readonly questionType: string
  readonly score: number
  readonly contextTokens: number
  readonly judgeNull: boolean
  readonly genError: boolean
}

export interface LmeAggregate {
  readonly overall: Omit<AccuracyAggregate, 'byCategory'>
  readonly byType: Record<string, CategoryAccuracy>
}

/**
 * Per-question-type + overall {accuracy, tokens, n} via the shared {@link aggregateAccuracy} (rows
 * with a negative score are dropped from accuracy but keep their token cost — identical semantics to
 * the LoCoMo gate). Throws on an unknown type — aggregation never invents a bucket.
 */
export function aggregateByType(rows: readonly LmeAccuracyRow[]): LmeAggregate {
  const catRows = rows.map((r) => ({
    category: lmeTypeIndex(r.questionType),
    score: r.score,
    contextTokens: r.contextTokens,
    judgeNull: r.judgeNull,
    genError: r.genError,
  }))
  const agg = aggregateAccuracy(catRows)
  const byType: Record<string, CategoryAccuracy> = {}
  for (const [cat, acc] of Object.entries(agg.byCategory)) {
    byType[lmeTypeOfIndex(Number(cat))] = acc
  }
  return {
    overall: {
      nScored: agg.nScored,
      nDropped: agg.nDropped,
      meanScore: agg.meanScore,
      meanContextTokens: agg.meanContextTokens,
    },
    byType,
  }
}
