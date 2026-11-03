/**
 * T036/T037 [US3] (specs/001-learning-memory-loop) — the evidence arbiter's routing-policy record.
 *
 * FR-026: behavioral promotion is decided by the AUTOMATED arbiter on a certified gate pass — no
 * per-promotion human approval. FR-027: the arbiter is strictly bounded — it may never touch a
 * safety/guardrail file, spend, or contact anything off-list. Both are enforced HERE, structurally:
 *
 *  - {@link commitRoutingPolicy} refuses any commit whose evidence is not a full certification
 *    (HCOPE lower bound > 0, controls passing with MEASURED coverage, σ recorded, det×2) and any
 *    target path that is a guardrail file — so an uncertified or unbounded "promotion" cannot exist
 *    on disk, no matter who calls this.
 *  - {@link readCommittedRoutingPolicy} fails CLOSED: missing, corrupt, or uncertified records read
 *    as null and the incumbent hybrid stands (SC-006: 0 flips on assumption).
 *
 * The live consumer is the cli answer seam: a committed arm becomes the default lever; explicit
 * SCNS_* envs still win (human override is always available). During arbiter bring-up the harness
 * runs SHADOW/advisory (research.md D5): it emits the decision + evidence without enacting unless
 * SCNS_ARBITER_ENACT=1 — and enactment still requires the det×2-certified evidence to pass HERE.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ROUTER_ARMS, type RouterArm } from './arm-router.js'
import {
  SAFETY_KERNEL_DIR_PREFIX,
  SAFETY_ALLOWLIST_PATH,
} from '../broker/services/safety-kernel/protected-paths.js'

/** The grounding evidence a promotion must carry (Δ, σ, controls, cost, HCOPE, determinism). */
export interface RoutingPolicyEvidence {
  /** Mean answer-accuracy delta (candidate − incumbent) on the held-out gate. */
  readonly deltaAcc: number
  /** Judge test-retest σ the delta was measured against (must be > 0 — a ruler is required). */
  readonly sigma: number
  /** HCOPE one-sided lower bound on the value delta — must be > 0 (a certified gain, not a point estimate). */
  readonly hcopeLowerBound: number
  /** Positive AND negative controls passed. */
  readonly controlsPass: boolean
  /** Both-graded negative-control pairs behind the verdict — 0 ⇒ unmeasured ⇒ never certifiable. */
  readonly negControlN: number
  /** Mean context-token delta (candidate − incumbent): ≤ 0 satisfies equal-or-lower cost. */
  readonly meanTokensDelta: number
  /** Identical-verdict runs — must be ≥ 2 (the det×2 requirement). */
  readonly deterministicRuns: number
  /** Which gate produced this (e.g. 'arm-frontier-accuracy'). */
  readonly gate: string
  /** True iff graded on the held-out split. */
  readonly heldOut: boolean
}

export interface RoutingPolicyCommit {
  readonly arm: RouterArm
  readonly committedAt: string
  readonly evidence: RoutingPolicyEvidence
}

export interface CommitResult {
  readonly committed: boolean
  readonly reason?: string
}

function certificationFailure(e: RoutingPolicyEvidence): string | null {
  if (!(e.hcopeLowerBound > 0))
    return `hcopeLowerBound ${e.hcopeLowerBound} ≤ 0 — no certified gain`
  if (e.controlsPass !== true) return 'controls not passing'
  if (!(e.negControlN > 0)) return 'negative controls unmeasured (n=0)'
  if (!(e.sigma > 0)) return 'no σ recorded — a win needs a ruler'
  if (!(e.deterministicRuns >= 2))
    return `deterministicRuns ${e.deterministicRuns} < 2 (det×2 required)`
  if (!(e.meanTokensDelta <= 0))
    return `meanTokensDelta ${e.meanTokensDelta} > 0 — not equal-or-lower cost`
  return null
}

function isGuardrailPath(p: string): boolean {
  const norm = resolve(p).replace(/\\/g, '/')
  return (
    norm.includes(`/${SAFETY_KERNEL_DIR_PREFIX}`) ||
    norm.endsWith(`/${SAFETY_ALLOWLIST_PATH}`) ||
    p === SAFETY_ALLOWLIST_PATH ||
    p.startsWith(SAFETY_KERNEL_DIR_PREFIX)
  )
}

/**
 * Enact a certified routing promotion by writing the policy record. Refuses (returns
 * `{committed:false, reason}`) on any uncertified evidence, unknown arm, or guardrail target path —
 * refusal writes NOTHING.
 */
export function commitRoutingPolicy(path: string, commit: RoutingPolicyCommit): CommitResult {
  if (isGuardrailPath(path)) {
    return {
      committed: false,
      reason: `refused: ${path} is a safety/guardrail path — human-owned, never writable by the arbiter (FR-027)`,
    }
  }
  if (!(ROUTER_ARMS as readonly string[]).includes(commit.arm)) {
    return { committed: false, reason: `unknown arm ${JSON.stringify(commit.arm)}` }
  }
  const failure = certificationFailure(commit.evidence)
  if (failure) return { committed: false, reason: `uncertified: ${failure}` }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(commit, null, 2)}\n`)
    return { committed: true }
  } catch (e) {
    return {
      committed: false,
      reason: `write failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/**
 * Read the committed routing policy. FAILS CLOSED: a missing, corrupt, malformed, or UNCERTIFIED
 * record reads as null — the incumbent hybrid stands on any doubt.
 */
export function readCommittedRoutingPolicy(path: string): RoutingPolicyCommit | null {
  try {
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf8')) as RoutingPolicyCommit
    if (!raw || typeof raw !== 'object') return null
    if (!(ROUTER_ARMS as readonly string[]).includes(raw.arm)) return null
    if (!raw.evidence || typeof raw.evidence !== 'object') return null
    if (certificationFailure(raw.evidence) !== null) return null
    return raw
  } catch {
    return null
  }
}
