/**
 * SCNS selfopt — Phase 0 validation gate (strict-improve).
 *
 * SCNS-native port of the MIT SkillOpt validation gate
 * (`skillopt_sleep/gate.py`). The two are kept behaviourally identical: a
 * candidate artifact is accepted ONLY if its score is STRICTLY greater than the
 * current score — never on a tie. This is the load-bearing safety mechanism the
 * North-Star plan generalises from "skills" to any capability artifact.
 *
 * Pure functions only — no I/O, no agent calls. Phase 0 is read/measure only.
 */
import type { GateMetric, GateResult } from './types.js'

/** Project a (hard, soft) pair onto a single comparison metric. */
export function selectGateScore(
  hard: number,
  soft: number,
  metric: GateMetric = 'hard',
  mixedWeight = 0.5,
): number {
  if (metric === 'hard') return hard
  if (metric === 'soft') return soft
  // metric === 'mixed'
  const w = Math.max(0, Math.min(1, mixedWeight))
  return (1 - w) * hard + w * soft
}

export interface EvaluateGateInput {
  readonly candidateSkill: string
  readonly candHard: number
  readonly candSoft?: number
  readonly currentSkill: string
  readonly currentScore: number
  readonly bestSkill: string
  readonly bestScore: number
  readonly bestStep: number
  readonly globalStep: number
  readonly metric?: GateMetric
  readonly mixedWeight?: number
}

/**
 * Pure gate decision: compare a candidate's projected score to the current and
 * best scores.
 *
 *   - candScore > currentScore && candScore > bestScore -> "accept_new_best"
 *   - candScore > currentScore                          -> "accept"
 *   - otherwise (including ties)                         -> "reject"
 */
export function evaluateGate(input: EvaluateGateInput): GateResult {
  const {
    candidateSkill,
    candHard,
    candSoft = 0,
    currentSkill,
    currentScore,
    bestSkill,
    bestScore,
    bestStep,
    globalStep,
    metric = 'hard',
    mixedWeight = 0.5,
  } = input

  const candScore = selectGateScore(candHard, candSoft, metric, mixedWeight)

  if (candScore > currentScore) {
    if (candScore > bestScore) {
      return {
        action: 'accept_new_best',
        currentSkill: candidateSkill,
        currentScore: candScore,
        bestSkill: candidateSkill,
        bestScore: candScore,
        bestStep: globalStep,
      }
    }
    return {
      action: 'accept',
      currentSkill: candidateSkill,
      currentScore: candScore,
      bestSkill,
      bestScore,
      bestStep,
    }
  }

  return {
    action: 'reject',
    currentSkill,
    currentScore,
    bestSkill,
    bestScore,
    bestStep,
  }
}
