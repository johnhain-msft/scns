/**
 * SCNS selfopt — Phase 1 wedge 2: the gated applicator path.
 *
 * The live applicator (`applyNegativeMemories`, negative-memory-applicator.ts)
 * rewrites `.github/copilot-instructions.md` with a blind `writeFileSync` and no
 * behavioural check (repo issue #5). This wrapper replaces that blind write with
 * a measured, per-rule gate:
 *
 *   for each candidate "don't" rule:
 *     1. stage + score it against an in-memory val split via
 *        `stageAndGateNegativeRule` (Phase-1 wedge 1 — deterministic MockBackend,
 *        non-regression policy `cand >= baseline - eps`);
 *     2. on ACCEPT: back up the REAL target file FIRST, then splice the grown
 *        managed block onto it;
 *     3. on REJECT: write NOTHING, record the miss in a rejection buffer.
 *
 * Accepts are incremental: each candidate is judged against the set already
 * adopted in this run, so the val score only ever moves the right direction.
 *
 * HARD isolation invariant: every write target MUST resolve under `projectRoot`
 * (`assertUnderRoot`). Demos drive this against a `mkdtemp` projectRoot holding a
 * fixture `copilot-instructions.md`; the live repo file is never a target here.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { stageAndGateNegativeRule } from '../selfopt/staging.js'
import type { RejectionBufferEntry } from '../selfopt/staging.js'
import type { ReplayBackend } from '../selfopt/replay.js'
import type { GateMetric, TaskRecord, TaskSplit } from '../selfopt/types.js'
import { buildManagedBlock, extractManagedBlock } from './negative-memory-applicator.js'

/** Path of the managed instructions file, relative to a projectRoot. */
export const TARGET_FILE = '.github/copilot-instructions.md'

export interface GatedApplyInput {
  /** Project root holding `.github/copilot-instructions.md` (a temp dir in demos). */
  readonly projectRoot: string
  /** Candidate "don't" rules to gate, in priority order. */
  readonly candidateRules: readonly string[]
  /** Val-split TaskRecords forming the gate set (rule-judged fixtures). */
  readonly valTasks: readonly TaskRecord[]
  /** Rules already in the managed block (baseline guidance). Default none. */
  readonly currentRules?: readonly string[]
  /** Which split in `valTasks` is the gate set. Default 'val'. */
  readonly split?: TaskSplit
  /** Non-regression tolerance forwarded to the gate. */
  readonly epsilon?: number
  /** Metric projecting (hard, soft) to one score. Default 'hard'. */
  readonly metric?: GateMetric
  readonly mixedWeight?: number
  /** Replay backend. Default the gate's deterministic MockBackend. */
  readonly backend?: ReplayBackend
  /**
   * Directory for the per-accept `.bak.N` backups. Default: beside the target
   * (under `projectRoot`). Inject a dir OUTSIDE the work tree (Q3) so adopting a
   * live-root target leaves NO untracked `.bak.N` in the repo. Only the backup
   * write is relocated/relaxed — the TARGET write stays asserted under root.
   */
  readonly backupDir?: string
}

/** One accepted candidate, with the scores that cleared the gate. */
export interface GatedAdoption {
  readonly rule: string
  readonly baselineScore: number
  readonly candidateScore: number
  /** Backup of the target written immediately before this adopt. */
  readonly backupPath: string
}

export interface GatedApplyResult {
  /** Absolute path of the gated target file. */
  readonly targetFile: string
  /** Candidates that cleared the gate and were spliced onto the target. */
  readonly adopted: readonly GatedAdoption[]
  /** Candidates that regressed the val split — written nowhere. */
  readonly rejections: readonly RejectionBufferEntry[]
  /** Every backup created (one per accept), in order. */
  readonly backups: readonly string[]
  /** Final rule set after this run (currentRules + adopted). */
  readonly finalRules: readonly string[]
}

/** Enforce the isolation invariant: a write target MUST live under `root`. */
export function assertUnderRoot(target: string, root: string): void {
  const base = resolve(root)
  const full = resolve(target)
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`refusing to write outside projectRoot: ${full} (root ${base})`)
  }
}

/** Splice a freshly built managed block into existing file content. */
function spliceManagedBlock(content: string, newBlock: string): string {
  if (content === '') return newBlock + '\n'
  const { before, after } = extractManagedBlock(content)
  const needsSep = !(before.endsWith('\n') || before === '')
  return before + (needsSep ? '\n' : '') + newBlock + after
}

/**
 * Gate each candidate rule, adopting it onto the real target file ONLY when it
 * does not regress the val split — backup first, reject otherwise.
 */
export async function gatedApplyNegativeMemories(
  input: GatedApplyInput,
): Promise<GatedApplyResult> {
  const { projectRoot, candidateRules, valTasks, currentRules = [] } = input

  const root = resolve(projectRoot)
  const targetPath = join(root, TARGET_FILE)
  assertUnderRoot(targetPath, root)
  if (!existsSync(targetPath)) {
    throw new Error(`target instructions file not found: ${targetPath}`)
  }

  // Where the per-accept backups land. Default: beside the target (under root).
  // An injected backupDir (Q3) relocates them OUTSIDE the work tree; ensure it
  // exists and assert each backup under it rather than under projectRoot.
  const backupRoot = input.backupDir ? resolve(input.backupDir) : null
  if (backupRoot) mkdirSync(backupRoot, { recursive: true })

  const adoptedRules: string[] = [...currentRules]
  const adopted: GatedAdoption[] = []
  const rejections: RejectionBufferEntry[] = []
  const backups: string[] = []

  for (const candidateRule of candidateRules) {
    const result = await stageAndGateNegativeRule({
      candidateRule,
      currentRules: adoptedRules,
      valTasks,
      sourceInstructionsPath: targetPath,
      ...(input.split ? { split: input.split } : {}),
      ...(input.epsilon !== undefined ? { epsilon: input.epsilon } : {}),
      ...(input.metric ? { metric: input.metric } : {}),
      ...(input.mixedWeight !== undefined ? { mixedWeight: input.mixedWeight } : {}),
      ...(input.backend ? { backend: input.backend } : {}),
    })
    // The gate stages onto its OWN throwaway temp; we only consume its verdict.
    rmSync(result.tempDir, { recursive: true, force: true })

    if (result.decision === 'reject') {
      rejections.push(...result.rejectionBuffer)
      continue
    }

    // Accept: back up the REAL target BEFORE writing, then splice + adopt.
    // One distinct, ordered backup per accept (index = #adopts so far) so every
    // accept's pre-write state is preserved — the 0th holds the pristine original.
    // Backups go under backupRoot when injected (Q3), else beside the target.
    const backupPath = backupRoot
      ? join(backupRoot, `${basename(targetPath)}.bak.${adopted.length}`)
      : `${targetPath}.bak.${adopted.length}`
    assertUnderRoot(backupPath, backupRoot ?? root)
    copyFileSync(targetPath, backupPath)
    backups.push(backupPath)

    const newBlock = buildManagedBlock([...adoptedRules, candidateRule])
    const existing = readFileSync(targetPath, 'utf-8')
    const finalContent = spliceManagedBlock(existing, newBlock)
    assertUnderRoot(targetPath, root)
    writeFileSync(targetPath, finalContent, 'utf-8')

    adoptedRules.push(candidateRule)
    adopted.push({
      rule: candidateRule,
      baselineScore: result.baselineScore,
      candidateScore: result.candidateScore,
      backupPath,
    })
  }

  return {
    targetFile: targetPath,
    adopted,
    rejections,
    backups,
    finalRules: adoptedRules,
  }
}
