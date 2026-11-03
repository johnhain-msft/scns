/**
 * SCNS selfopt — Phase 1 first wedge: staging + non-regression gate around the
 * negative-memory edit path (the smallest TrainableArtifact).
 *
 * The negative-memory applicator rewrites `.github/copilot-instructions.md` in
 * place with no behavioural check — repo issue #5. This module wraps a single
 * candidate "don't" rule with a measured gate:
 *
 *   1. Copy the live instructions file into an ISOLATED temp dir (read the live
 *      file read-only; never write it).
 *   2. Score the val split twice under the deterministic MockBackend — once with
 *      the current rule set as guidance (baseline), once with the candidate rule
 *      added (candidate) — reusing Phase-0 `computeBaseline`.
 *   3. ADOPT iff the candidate does not regress (cand >= baseline - eps). A tie /
 *      non-regressing guardrail rule is accepted on purpose; `evaluateGate`'s
 *      strict-improve verdict is kept only as an informational sub-signal.
 *   4. On reject: push a rejection-buffer entry, write nothing. On accept:
 *      back up the temp file BEFORE adopting, then splice the new managed block
 *      into the TEMP copy only.
 *
 * HARD isolation invariant: every write path is under the mkdtemp dir. The live
 * `.github/copilot-instructions.md` is only ever read.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  buildManagedBlock,
  extractManagedBlock,
} from '../memory/negative-memory-applicator.js'
import { computeBaseline } from './baseline.js'
import { evaluateGate } from './gate.js'
import { MockBackend } from './replay.js'
import type { ReplayBackend } from './replay.js'
import type { GateAction, GateMetric, TaskRecord, TaskSplit } from './types.js'

/** Default non-regression tolerance — guards float noise, not real regressions. */
export const DEFAULT_NONREGRESSION_EPSILON = 1e-9

export interface StageNegativeRuleInput {
  /** The candidate "don't" rule text being gated. */
  readonly candidateRule: string
  /** Rules already in the managed block (the baseline guidance set). */
  readonly currentRules?: readonly string[]
  /** The gate set — val-split TaskRecords (rule-judged tasks measure the rule). */
  readonly valTasks: readonly TaskRecord[]
  /** Live instructions file copied (read-only) into the temp dir. */
  readonly sourceInstructionsPath: string
  /** Which split in `valTasks` forms the gate set. Default 'val'. */
  readonly split?: TaskSplit
  /** Non-regression tolerance. Default {@link DEFAULT_NONREGRESSION_EPSILON}. */
  readonly epsilon?: number
  /** Metric projecting (hard, soft) to one score. Default 'hard'. */
  readonly metric?: GateMetric
  readonly mixedWeight?: number
  /** Replay backend. Default a deterministic, offline MockBackend. */
  readonly backend?: ReplayBackend
}

export type StageDecision = 'accept' | 'reject'

/** One rejected candidate, retained so the caller can audit/learn from misses. */
export interface RejectionBufferEntry {
  readonly rule: string
  readonly baselineScore: number
  readonly candidateScore: number
  readonly reason: string
}

export interface StageNegativeRuleResult {
  readonly decision: StageDecision
  readonly baselineScore: number
  readonly candidateScore: number
  /** evaluateGate's strict-improve label — informational only, not the policy. */
  readonly strictGateAction: GateAction
  /** Isolated temp dir holding the staged copy. Caller owns cleanup. */
  readonly tempDir: string
  /** Staged instructions file inside {@link tempDir}. */
  readonly tempInstructionsPath: string
  /** Backup written before adopt; null when rejected. */
  readonly backupPath: string | null
  /** True iff the temp file was rewritten with the candidate block. */
  readonly adopted: boolean
  /** Rejected candidates (length 1 on reject, 0 on accept). */
  readonly rejectionBuffer: readonly RejectionBufferEntry[]
}

/** Enforce the isolation invariant: a write target MUST live under tempDir. */
function assertUnderTemp(target: string, tempDir: string): void {
  const root = resolve(tempDir)
  const full = resolve(target)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`refusing to write outside temp dir: ${full} (temp root ${root})`)
  }
}

/** Splice a freshly built managed block into existing content (temp file only). */
function spliceManagedBlock(content: string, newBlock: string): string {
  if (content === '') return newBlock + '\n'
  const { before, after } = extractManagedBlock(content)
  const needsSep = !(before.endsWith('\n') || before === '')
  return before + (needsSep ? '\n' : '') + newBlock + after
}

/**
 * Stage one candidate negative-memory rule, score it against the val split, and
 * adopt it onto an isolated temp copy iff it does not regress.
 */
export async function stageAndGateNegativeRule(
  input: StageNegativeRuleInput,
): Promise<StageNegativeRuleResult> {
  const {
    candidateRule,
    currentRules = [],
    valTasks,
    sourceInstructionsPath,
    split = 'val',
    epsilon = DEFAULT_NONREGRESSION_EPSILON,
    metric = 'hard',
    mixedWeight = 0.5,
    backend = new MockBackend(),
  } = input

  if (!existsSync(sourceInstructionsPath)) {
    throw new Error(`source instructions file not found: ${sourceInstructionsPath}`)
  }

  // Isolate: copy the LIVE file (read-only) into a fresh temp dir. From here on
  // every mutation targets the temp copy; the live file is never written.
  const tempDir = mkdtempSync(join(tmpdir(), 'scns-negmem-stage-'))
  const tempInstructionsPath = join(tempDir, 'copilot-instructions.md')
  assertUnderTemp(tempInstructionsPath, tempDir)
  copyFileSync(sourceInstructionsPath, tempInstructionsPath)

  // Score the gate set twice under the deterministic backend: the rule text is
  // the guidance the agent "reads". Baseline = current rules; candidate = current
  // rules + the new rule. computeBaseline filters to `split` and aggregates.
  const baselineMemory = currentRules.join('\n')
  const candidateMemory = [...currentRules, candidateRule].join('\n')

  const baseline = await computeBaseline(valTasks, {
    split,
    backend,
    memory: baselineMemory,
    metric,
    mixedWeight,
  })
  const candidate = await computeBaseline(valTasks, {
    split,
    backend,
    memory: candidateMemory,
    metric,
    mixedWeight,
  })

  const baselineScore = baseline.score
  const candidateScore = candidate.score

  // Informational only: the strict-improve verdict (accept iff cand > baseline).
  // The adopt policy below is intentionally non-regression, not strict.
  const strictGateAction = evaluateGate({
    candidateSkill: candidateRule,
    candHard: candidate.hard,
    candSoft: candidate.soft,
    currentSkill: 'current',
    currentScore: baselineScore,
    bestSkill: 'current',
    bestScore: baselineScore,
    bestStep: 0,
    globalStep: 1,
    metric,
    mixedWeight,
  }).action

  const regressed = candidateScore < baselineScore - epsilon

  if (regressed) {
    return {
      decision: 'reject',
      baselineScore,
      candidateScore,
      strictGateAction,
      tempDir,
      tempInstructionsPath,
      backupPath: null,
      adopted: false,
      rejectionBuffer: [
        {
          rule: candidateRule,
          baselineScore,
          candidateScore,
          reason: `candidate regressed val score: ${candidateScore} < ${baselineScore} - eps(${epsilon})`,
        },
      ],
    }
  }

  // Non-regressing: adopt on the temp copy. Back up BEFORE writing.
  const backupPath = `${tempInstructionsPath}.bak`
  assertUnderTemp(backupPath, tempDir)
  copyFileSync(tempInstructionsPath, backupPath)

  const newBlock = buildManagedBlock([...currentRules, candidateRule])
  const existing = readFileSync(tempInstructionsPath, 'utf-8')
  const finalContent = spliceManagedBlock(existing, newBlock)
  assertUnderTemp(tempInstructionsPath, tempDir)
  writeFileSync(tempInstructionsPath, finalContent, 'utf-8')

  return {
    decision: 'accept',
    baselineScore,
    candidateScore,
    strictGateAction,
    tempDir,
    tempInstructionsPath,
    backupPath,
    adopted: true,
    rejectionBuffer: [],
  }
}
