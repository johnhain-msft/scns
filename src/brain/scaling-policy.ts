/**
 * Phase 13.12.13 — Brain-side scaling policy.
 *
 * Pure decision module: given a task description + an extractor "hint"
 * about shape (solo/team/complex) + a slice of historical outcomes,
 * choose the actual shape to spawn and explain why.
 *
 * The module is deterministic and side-effect free. Persistence of
 * decisions and outcomes lives in the broker repositories.
 */

import { createHash } from 'node:crypto'

// ── Types ────────────────────────────────────────────────────────────

export type TaskShape = 'solo' | 'team'

export interface ScalingOutcome {
  readonly task_signature: string
  readonly spawned_as: TaskShape
  /** 1 if the spawn resulted in a successful completion (QG pass / solo success). */
  readonly success: number
  readonly duration_ms: number | null
  readonly quality_score: number | null
  readonly created_at?: string
}

export interface ScalingDecisionInput {
  readonly description: string
  /** Extractor's estimated complexity — becomes a hint here. */
  readonly hint: 'solo' | 'team' | 'complex'
  /** Extractor's suggestedRoles (used for team shape). */
  readonly suggestedRoles?: readonly string[]
  /** Recent outcomes for the matching signature. Pass the filtered slice. */
  readonly history: readonly ScalingOutcome[]
}

export interface ScalingDecision {
  readonly shape: TaskShape
  readonly roles: readonly string[]
  readonly reasoning: string
  readonly hintShape: TaskShape
  readonly signature: string
  /** Number of matching history entries considered. */
  readonly historyCount: number
}

// ── Signature ────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a','an','the','and','or','but','of','in','on','at','to','for','with','from','by',
  'is','are','was','were','be','been','being','this','that','these','those','it','its',
  'as','into','over','under','upon','then','than','so','not','no','yes','if','else',
  'do','does','did','done','have','has','had','will','would','can','could','should',
  'make','made','use','used','uses','using','i','we','you','they','he','she','me','my',
  'your','our','their','also','just','only','some','any','all','each','every','more',
  'less','most','least','very','really','about','because','while','when','where','which',
  'who','whom','what','why','how',
])

const WORD_RE = /[A-Za-z][A-Za-z0-9_-]{1,}/g

/**
 * Stable signature for a task description. Same semantic task → same signature.
 * Small edits (punctuation, common words, case) → identical signature; wholly
 * different vocabulary → different signature.
 */
export function computeTaskSignature(description: string): string {
  const raw = description.toLowerCase()
  const matches = raw.match(WORD_RE) ?? []
  const tokens = matches
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  // Deduplicate and sort for stability regardless of phrasing order.
  const unique = Array.from(new Set(tokens)).sort()
  // Keep a bounded number of keywords so very long descriptions don't
  // explode the signature space; first 12 is generous.
  const top = unique.slice(0, 12).join(' ')
  if (top.length === 0) {
    return 'sig:empty'
  }
  const hash = createHash('sha1').update(top).digest('hex').slice(0, 16)
  return `sig:${hash}`
}

// ── Decision ─────────────────────────────────────────────────────────

/** Minimum history count before policy can override the extractor hint. */
export const POLICY_MIN_SAMPLES = 3
/** Quality-score threshold below which a team outcome is considered "low-quality". */
export const LOW_QUALITY_THRESHOLD = 0.6

function normalizeHint(hint: ScalingDecisionInput['hint']): TaskShape {
  return hint === 'team' || hint === 'complex' ? 'team' : 'solo'
}

interface ShapeStats {
  readonly count: number
  readonly successes: number
  readonly avgQuality: number | null
}

function statsFor(history: readonly ScalingOutcome[], shape: TaskShape): ShapeStats {
  const subset = history.filter((h) => h.spawned_as === shape)
  if (subset.length === 0) {
    return { count: 0, successes: 0, avgQuality: null }
  }
  const successes = subset.filter((h) => h.success === 1).length
  const qualities = subset
    .map((h) => h.quality_score)
    .filter((q): q is number => typeof q === 'number' && Number.isFinite(q))
  const avgQuality = qualities.length > 0
    ? qualities.reduce((a, b) => a + b, 0) / qualities.length
    : null
  return { count: subset.length, successes, avgQuality }
}

/**
 * Decide the final shape given a hint and historical outcomes for a matching
 * signature.
 *
 * Rules (conservative, auditable):
 *  - If history has < POLICY_MIN_SAMPLES total entries → defer to the hint.
 *  - If the hint is "team" but matching solo history shows >=3 successes and
 *    solo success-rate >= team success-rate → override to solo.
 *  - If the hint is "team" but matching team history shows avg quality < 0.6
 *    and at least one successful solo run exists → override to solo.
 *  - If the hint is "solo" but solo history shows >=3 failures and team
 *    history has a successful run with quality >= 0.6 → override to team.
 *  - Otherwise: defer to the hint.
 *
 * The reasoning string explains exactly which rule fired, so decisions are
 * auditable in the dashboard.
 */
export function decideShape(input: ScalingDecisionInput): ScalingDecision {
  const signature = computeTaskSignature(input.description)
  const hintShape = normalizeHint(input.hint)
  const rolesFromHint = [...(input.suggestedRoles ?? [])]
  const history = input.history.filter((h) => h.task_signature === signature)

  if (history.length < POLICY_MIN_SAMPLES) {
    return {
      shape: hintShape,
      roles: hintShape === 'team' ? rolesFromHint : [],
      reasoning: `Insufficient history (${history.length}/${POLICY_MIN_SAMPLES}) — deferring to extractor hint "${input.hint}" → ${hintShape}.`,
      hintShape,
      signature,
      historyCount: history.length,
    }
  }

  const solo = statsFor(history, 'solo')
  const team = statsFor(history, 'team')

  const soloSuccessRate = solo.count > 0 ? solo.successes / solo.count : 0
  const teamSuccessRate = team.count > 0 ? team.successes / team.count : 0

  // Hint = team → consider downgrade to solo.
  if (hintShape === 'team') {
    if (solo.successes >= POLICY_MIN_SAMPLES && soloSuccessRate >= teamSuccessRate) {
      return {
        shape: 'solo',
        roles: [],
        reasoning: `Override team→solo: ${solo.successes}/${solo.count} solo runs succeeded (rate ${soloSuccessRate.toFixed(2)}) vs ${team.successes}/${team.count} team (rate ${teamSuccessRate.toFixed(2)}).`,
        hintShape,
        signature,
        historyCount: history.length,
      }
    }
    if (
      team.count >= POLICY_MIN_SAMPLES &&
      team.avgQuality !== null &&
      team.avgQuality < LOW_QUALITY_THRESHOLD &&
      solo.successes >= 1
    ) {
      return {
        shape: 'solo',
        roles: [],
        reasoning: `Override team→solo: team avg quality ${team.avgQuality.toFixed(2)} < ${LOW_QUALITY_THRESHOLD} across ${team.count} runs; solo has ${solo.successes} successful run(s).`,
        hintShape,
        signature,
        historyCount: history.length,
      }
    }
  }

  // Hint = solo → consider upgrade to team.
  if (hintShape === 'solo') {
    const soloFailures = solo.count - solo.successes
    const teamHighQualitySuccesses = history.filter(
      (h) =>
        h.spawned_as === 'team' &&
        h.success === 1 &&
        typeof h.quality_score === 'number' &&
        h.quality_score >= LOW_QUALITY_THRESHOLD,
    ).length
    if (soloFailures >= POLICY_MIN_SAMPLES && teamHighQualitySuccesses >= 1) {
      return {
        shape: 'team',
        roles: rolesFromHint.length > 0 ? rolesFromHint : ['implementer', 'reviewer'],
        reasoning: `Override solo→team: ${soloFailures} solo failures vs ${teamHighQualitySuccesses} high-quality team success(es).`,
        hintShape,
        signature,
        historyCount: history.length,
      }
    }
  }

  return {
    shape: hintShape,
    roles: hintShape === 'team' ? rolesFromHint : [],
    reasoning: `Defer to extractor hint "${input.hint}" → ${hintShape} (history: solo ${solo.successes}/${solo.count}, team ${team.successes}/${team.count}).`,
    hintShape,
    signature,
    historyCount: history.length,
  }
}
