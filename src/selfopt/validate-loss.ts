/**
 * SCNS selfopt — Phase 1 wedge B: single-spawn empirical validation of the loss.
 *
 * The whole gate/shadow/behavioral substrate is Mock-INERT by construction:
 * `MockBackend.attempt()` returns the same `skill\n memory\n intent` string for
 * the baseline AND the candidate, so every measured delta is 0. This module is
 * the bounded experiment that closes the one missing empirical link — it shows a
 * RULE-JUDGED held-out task's per-task hard score is a genuine FUNCTION of a REAL
 * agent response: it MOVES under a real `AcpReplayBackend` where it is a CONSTANT
 * under `MockBackend`.
 *
 * "Both readings, ONE spawn": the candidate backend is asked for a response
 * exactly once (`replayOne(candidateBackend, HEADLINE_TASK)`); the SAME captured
 * response string is then scored two ways with `scoreRuleJudge` (no extra spawn):
 *   - HEADLINE `min_chars 200` — pollution-immune. The Mock baseline response is
 *     just the short intent (skill/memory empty), whose length << 200 ⇒ FAILS ⇒
 *     hard 0; a substantive real answer is > 200 chars ⇒ PASSES ⇒ hard 1 ⇒ a clean
 *     +1. This is the proof.
 *   - SECONDARY `contains 'verify'` — a deliberate delta TRAP: the headline intent
 *     already contains "verify", so the Mock baseline passes (hard 1) and a real
 *     answer that also says "verify" stays hard 1 ⇒ delta ~0. Illustrative only:
 *     it shows WHY contains-verify is a poor headline. Never the proof.
 *
 * This module is PURE + fully injectable: no I/O, no git, no agent spawn. The real
 * `AcpReplayBackend` is constructed ONLY by the separate, default-OFF
 * `validate-loss-runner` behind an env opt-in. With the default `MockBackend`
 * candidate the measurement is byte-identical to a symmetric no-op (delta 0).
 *
 * Honesty: baseline=Mock vs candidate=real proves the loss RESPONDS to a real
 * agent — it is NOT itself a real-vs-real non-regression decision (that needs a
 * second real spawn, which is out of scope).
 */
import { scoreRuleJudge } from './judges.js'
import { MockBackend, replayOne } from './replay.js'
import type { ReplayBackend } from './replay.js'
import type { RuleJudge, TaskRecord } from './types.js'

/** Env opt-in for the real-agent spawn (default-OFF). */
export const VALIDATE_LOSS_ACP_ENV = 'SCNS_SELFOPT_VALIDATE_LOSS_ACP'

/** Minimum response length the headline `min_chars` reading requires. */
export const HEADLINE_MIN_CHARS = 200

/** Which backend produced the candidate response. */
export type BackendLabel = 'mock' | 'acp'

export interface ValidateLossMode {
  /** Build the isolated worktree + real `AcpReplayBackend` candidate (ONE spawn). */
  readonly useAcp: boolean
}

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

/** Resolve the (default-OFF) real-agent opt-in. */
export function resolveValidateLossMode(env: NodeJS.ProcessEnv): ValidateLossMode {
  return { useAcp: isTruthy(env[VALIDATE_LOSS_ACP_ENV]) }
}

/** The headline `min_chars` rule judge (the proof reading). */
const HEADLINE_JUDGE: RuleJudge = {
  kind: 'rule',
  checks: [{ op: 'min_chars', arg: HEADLINE_MIN_CHARS }],
}

/** The secondary `contains 'verify'` rule judge (the illustrative trap reading). */
export const SECONDARY_CONTAINS_VERIFY: RuleJudge = {
  kind: 'rule',
  checks: [{ op: 'contains', arg: 'verify' }],
}

/**
 * The SINGLE held-out task driving the one real prompt. Its intent is short
 * (< {@link HEADLINE_MIN_CHARS}) so the Mock baseline fails `min_chars`, yet it
 * reliably elicits a substantive (> {@link HEADLINE_MIN_CHARS}-char) real answer
 * so the candidate passes — a clean +1. The intent deliberately contains the word
 * "verify" so the SECONDARY reading's baseline already passes (the documented trap).
 */
export const HEADLINE_TASK: TaskRecord = {
  id: 'validate_loss_headline',
  project: 'scns',
  intent: 'Explain how to verify that a code change works before claiming success.',
  contextExcerpt: '',
  attemptedSolution: '',
  outcome: 'mixed',
  referenceKind: 'rule',
  reference: '',
  recordedScore: null,
  judge: HEADLINE_JUDGE,
  tags: ['validate-loss'],
  sourceSessions: [],
  split: 'val',
  origin: 'real',
  derivedFrom: '',
}

interface ReadingDef {
  readonly id: 'min_chars' | 'contains_verify'
  readonly op: string
  readonly arg: string | number
  readonly headline: boolean
  readonly judge: RuleJudge
}

const READINGS: readonly ReadingDef[] = [
  { id: 'min_chars', op: 'min_chars', arg: HEADLINE_MIN_CHARS, headline: true, judge: HEADLINE_JUDGE },
  { id: 'contains_verify', op: 'contains', arg: 'verify', headline: false, judge: SECONDARY_CONTAINS_VERIFY },
]

export interface LossReading {
  readonly id: 'min_chars' | 'contains_verify'
  readonly op: string
  readonly arg: string | number
  /** True for the `min_chars` proof reading; false for the illustrative trap. */
  readonly headline: boolean
  /** Hard score of the rule judge over the BASELINE (Mock) response. */
  readonly baselineHard: number
  /** Hard score of the rule judge over the CANDIDATE response. */
  readonly candidateHard: number
  /** `candidateHard - baselineHard`. */
  readonly delta: number
}

/**
 * Pure: score a baseline + candidate response pair against BOTH rule judges. No
 * backend, no I/O — the same `scoreRuleJudge` primitive the gate uses internally.
 */
export function scoreLossReadings(
  baselineResponse: string,
  candidateResponse: string,
): LossReading[] {
  return READINGS.map((r) => {
    const baselineHard = scoreRuleJudge(r.judge, baselineResponse).hard
    const candidateHard = scoreRuleJudge(r.judge, candidateResponse).hard
    return {
      id: r.id,
      op: r.op,
      arg: r.arg,
      headline: r.headline,
      baselineHard,
      candidateHard,
      delta: candidateHard - baselineHard,
    }
  })
}

export interface ValidateLossInput {
  /** Candidate (post-change) backend. Default `MockBackend` ⇒ NO spawn. */
  readonly candidateBackend?: ReplayBackend
  /** Baseline (current/HEAD) backend. Default `MockBackend`. */
  readonly baselineBackend?: ReplayBackend
  /** Held-out task driving the single prompt. Default {@link HEADLINE_TASK}. */
  readonly task?: TaskRecord
  /** Label for the candidate backend (drives `nSpawns`). Default 'mock'. */
  readonly backendLabel?: BackendLabel
}

export interface ValidateLossResult {
  readonly backendLabel: BackendLabel
  /** Real ACP spawns: 1 when `backendLabel === 'acp'`, else 0. */
  readonly nSpawns: number
  /** The Mock baseline response (= the task intent). */
  readonly baselineResponse: string
  /** The candidate response — the REAL agent text when `backendLabel === 'acp'`. */
  readonly candidateResponse: string
  readonly readings: LossReading[]
  /** Convenience: the headline (`min_chars`) reading's delta. */
  readonly headlineDelta: number
  readonly disclosure: string
}

const DISCLOSURE =
  'baseline=Mock vs candidate=real proves the loss RESPONDS to a real agent (the ' +
  'previously-missing empirical link): a rule-judged held-out task moves under a ' +
  'real backend where it is constant under Mock. It is NOT a real-vs-real ' +
  'non-regression decision — that requires a second real spawn (out of scope).'

/**
 * Drive the candidate backend ONCE (capturing its response), the baseline backend
 * once, and score the single candidate response two ways. Deterministic given its
 * inputs; constructs no real-agent backend and performs no I/O.
 */
export async function validateLoss(
  input: ValidateLossInput = {},
): Promise<ValidateLossResult> {
  const task = input.task ?? HEADLINE_TASK
  const baselineBackend = input.baselineBackend ?? new MockBackend()
  const candidateBackend = input.candidateBackend ?? new MockBackend()
  const backendLabel = input.backendLabel ?? 'mock'

  // The ONLY (potentially real) attempt — exactly one candidate response.
  const candidate = await replayOne(candidateBackend, task)
  const baseline = await replayOne(baselineBackend, task)

  const readings = scoreLossReadings(baseline.response, candidate.response)
  const headline = readings.find((r) => r.headline)

  return {
    backendLabel,
    nSpawns: backendLabel === 'acp' ? 1 : 0,
    baselineResponse: baseline.response,
    candidateResponse: candidate.response,
    readings,
    headlineDelta: headline?.delta ?? 0,
    disclosure: DISCLOSURE,
  }
}
