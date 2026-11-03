/**
 * SCNS selfopt — Phase-1 wedge 3: shadow gated negative-memory eval.
 *
 * OPT-IN, default-OFF. When enabled, the dream daemon runs the gated applicator
 * (per-rule non-regression gate) WITHOUT ever targeting the live
 * `.github/copilot-instructions.md`. Candidate rules are derived from the SAME
 * vault helper the blind applicator uses (`deriveEligibleRules`); the gate runs
 * inside a throwaway `mkdtemp` shadow projectRoot seeded with an in-memory COPY
 * of the live file's content. Nothing is written back to the live root and the
 * temp dir is removed after the run.
 *
 * Measurement-only: it logs what the gate WOULD adopt/reject with zero live
 * mutation. The live blind `applyNegativeMemories` path is left untouched, and
 * the in-memory val split is a fixture (NO real broker mining — separate wedge).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import type { Vault } from '../memory/vault.js'
import { deriveEligibleRules } from '../memory/negative-memory-applicator.js'
import {
  gatedApplyNegativeMemories,
  TARGET_FILE,
} from '../memory/gated-negative-memory-applicator.js'
import type { GatedAdoption } from '../memory/gated-negative-memory-applicator.js'
import type { RejectionBufferEntry } from '../selfopt/staging.js'
import { computeBaseline } from '../selfopt/baseline.js'
import { MockBackend } from '../selfopt/replay.js'
import type { ReplayBackend } from '../selfopt/replay.js'
import type { RuleCheck, TaskRecord, TaskSplit } from '../selfopt/types.js'
import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'shadow-negative-memory-eval' })

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** Build one rule-judged val TaskRecord (the MockBackend response is scored locally). */
function ruleTask(id: string, intent: string, checks: readonly RuleCheck[]): TaskRecord {
  return {
    id,
    project: 'scns',
    intent,
    contextExcerpt: '',
    attemptedSolution: '',
    outcome: 'mixed',
    referenceKind: 'rule',
    reference: '',
    recordedScore: null,
    judge: { kind: 'rule', checks: [...checks] },
    tags: ['shadow'],
    sourceSessions: [],
    split: 'val',
    origin: 'real',
    derivedFrom: '',
  }
}

/**
 * Default in-memory gate set (NO broker mining). `shadow_len` caps response
 * length so an overlong harmful rule regresses; `shadow_anchor` is a stable
 * anchor that passes regardless of the rule text.
 */
export const DEFAULT_SHADOW_VAL_TASKS: readonly TaskRecord[] = [
  ruleTask('shadow_len', 'Summarize the diff', [{ op: 'max_chars', arg: 160 }]),
  ruleTask('shadow_anchor', 'Verify the change works', [{ op: 'contains', arg: 'verify' }]),
]

export interface ShadowEvalInput {
  readonly vault: Vault
  /** Live project root — read-only seed source; NEVER a gated write target. */
  readonly projectRoot: string
  /** Override the in-memory gate set (defaults to {@link DEFAULT_SHADOW_VAL_TASKS}). */
  readonly valTasks?: readonly TaskRecord[]
  readonly minConfidence?: number
  readonly allowUnjudged?: boolean
  /**
   * Parent directory for the throwaway shadow root. Defaults to the OS temp
   * dir, which is what production uses.
   *
   * Tests point this at a test-owned directory. The cleanup assertions used
   * to scan `os.tmpdir()` for `scns-negmem-shadow-*`, which is process-wide:
   * vitest runs files in parallel workers, so a CONCURRENT worker mid-eval
   * made `expect(shadowTempDirs()).toHaveLength(0)` fail on a run that was
   * perfectly correct (#54 item 1 — observed in 2 of 4 full-suite runs,
   * 2/2 green in isolation, and not Windows-specific). Scoping the parent
   * dir per test makes the same assertion exclusive to the call under test,
   * so it still catches a real leak without racing anyone.
   */
  readonly shadowTempRoot?: string
  /**
   * Replay backend forwarded to the gate. Default is the gate's deterministic
   * MockBackend; nothing here constructs a real-agent backend.
   */
  readonly backend?: ReplayBackend
  /**
   * REAL mined recorded val tasks (origin 'real', referenceKind 'recorded').
   * Scored into {@link ShadowEvalResult.report} as a held-out MEASUREMENT — never
   * a gate: a recorded task's score is constant under any backend, so it cannot
   * move an adopt/reject decision.
   */
  readonly reportTasks?: readonly TaskRecord[]
  /** Label for the report's backend, set by the caller (never by spawning). Default 'mock'. */
  readonly backendLabel?: 'mock' | 'acp'
}

/**
 * Held-out MEASUREMENT over real mined recorded val tasks. Reproduces SCNS's own
 * measured historical performance (and cost) for the val split; it is reported,
 * NEVER gated — recorded scoring ignores the agent's response text.
 */
export interface ShadowMeasurementReport {
  readonly nTasks: number
  readonly split: TaskSplit
  readonly score: number
  readonly hard: number
  readonly soft: number
  readonly meanTokens: number
  readonly meanLatencyMs: number
  /** Which backend produced the report. Set by the caller, never by spawning. */
  readonly backendLabel: 'mock' | 'acp'
  readonly perTask: ReadonlyArray<{ readonly id: string; readonly hard: number; readonly soft: number }>
  /** Plain-language note that recorded scoring ignores agent output. */
  readonly disclosure: string
}

export interface ShadowEvalResult {
  /** True iff the gated applicator actually ran in a shadow dir. */
  readonly ran: boolean
  /** Why the run was skipped (when `ran === false`). */
  readonly skipReason?: string
  /** The throwaway shadow root used (already removed); null when skipped. */
  readonly shadowRoot: string | null
  readonly candidateCount: number
  readonly adopted: readonly GatedAdoption[]
  readonly rejections: readonly RejectionBufferEntry[]
  readonly backups: readonly string[]
  /** sha256 of the live seed content copied into the shadow dir; null when skipped. */
  readonly seedSha256: string | null
  /**
   * Held-out MEASUREMENT over real mined recorded val tasks (never gates). null
   * when no `reportTasks` were provided.
   */
  readonly report: ShadowMeasurementReport | null
}

/**
 * Compute the held-out measurement report over the provided real mined recorded
 * val tasks, if any. Returns null when no `reportTasks` were given. The report is
 * informational only — it never influences the gate's adopt/reject decisions.
 */
async function computeShadowReport(
  input: ShadowEvalInput,
): Promise<ShadowMeasurementReport | null> {
  const reportTasks = input.reportTasks
  if (!reportTasks || reportTasks.length === 0) return null

  const backend = input.backend ?? new MockBackend()
  const b = await computeBaseline(reportTasks, { split: 'val', backend, metric: 'hard' })

  return {
    nTasks: b.nTasks,
    split: b.split,
    score: b.score,
    hard: b.hard,
    soft: b.soft,
    meanTokens: b.meanTokens,
    meanLatencyMs: b.meanLatencyMs,
    backendLabel: input.backendLabel ?? 'mock',
    perTask: b.perTask,
    disclosure:
      'Recorded-kind tasks are scored from their historical quality-gate label; ' +
      'the agent/Mock response text is ignored. This report measures held-out ' +
      'performance and cost only — it never gates adopt/reject.',
  }
}

/**
 * Run the gated applicator against a throwaway COPY of the live instructions
 * file. The live `projectRoot` is only ever READ; the gate writes exclusively
 * under a fresh `mkdtemp` shadow root, which is removed before returning.
 */
export async function runShadowNegativeMemoryEval(
  input: ShadowEvalInput,
): Promise<ShadowEvalResult> {
  const { vault, projectRoot, valTasks = DEFAULT_SHADOW_VAL_TASKS } = input

  // Independent held-out MEASUREMENT over real mined recorded val tasks. This is
  // computed regardless of whether the gate runs and NEVER affects adopt/reject.
  const report = await computeShadowReport(input)

  const { rules: candidateRules } = deriveEligibleRules(vault, {
    ...(input.minConfidence !== undefined ? { minConfidence: input.minConfidence } : {}),
    ...(input.allowUnjudged !== undefined ? { allowUnjudged: input.allowUnjudged } : {}),
  })

  const skipped = (skipReason: string): ShadowEvalResult => ({
    ran: false,
    skipReason,
    shadowRoot: null,
    candidateCount: candidateRules.length,
    adopted: [],
    rejections: [],
    backups: [],
    seedSha256: null,
    report,
  })

  if (candidateRules.length === 0) return skipped('no-candidate-rules')

  // Read the LIVE file read-only — we seed a COPY, never write back to it.
  const liveTarget = join(projectRoot, TARGET_FILE)
  if (!existsSync(liveTarget)) return skipped('no-live-instructions-file')
  const seedContent = readFileSync(liveTarget, 'utf-8')
  const seedSha256 = sha256(seedContent)

  // Fresh shadow projectRoot seeded with an in-memory COPY of the live content.
  const shadowRoot = mkdtempSync(join(input.shadowTempRoot ?? tmpdir(), 'scns-negmem-shadow-'))
  try {
    const shadowTarget = join(shadowRoot, TARGET_FILE)
    mkdirSync(dirname(shadowTarget), { recursive: true })
    writeFileSync(shadowTarget, seedContent, 'utf-8')

    const result = await gatedApplyNegativeMemories({
      projectRoot: shadowRoot,
      candidateRules,
      valTasks,
      ...(input.backend ? { backend: input.backend } : {}),
    })

    log.info(
      {
        candidateCount: candidateRules.length,
        adopted: result.adopted.length,
        rejected: result.rejections.length,
        backups: result.backups.length,
        shadowRoot,
        adoptedRules: result.adopted.map((a) => a.rule),
        rejectedRules: result.rejections.map((r) => r.rule),
      },
      'Dream: shadow gated negative-memory eval complete (no live mutation)',
    )

    return {
      ran: true,
      shadowRoot,
      candidateCount: candidateRules.length,
      adopted: result.adopted,
      rejections: result.rejections,
      backups: result.backups,
      seedSha256,
      report,
    }
  } finally {
    rmSync(shadowRoot, { recursive: true, force: true })
  }
}
