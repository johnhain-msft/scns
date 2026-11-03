/**
 * Negative-memory critic — orchestrator.
 *
 * Runs the heuristic prefilter then the (optional) LLM critic, persists
 * verdicts back to the vault, and returns a summary.
 *
 * Sequencing in the dream daemon:
 *   recordDreamRun → runNegativeMemoryCritic → applyNegativeMemories
 *
 * The applicator filters on `criticVerdict.status === 'keep'` (or pinned, or
 * legacy-grace-period). Memories that the critic suppresses stay in the
 * vault for audit but never reach copilot-instructions.md.
 */

import type { Vault } from './vault.js'
import type {
  NegativeMemory,
  CriticVerdict,
  CriticStatus,
} from './negative-memory-types.js'
import { createNegativeMemoryStore } from './negative-memory-store.js'
import {
  judgeMemoriesHeuristic,
  type HeuristicVerdict,
} from './negative-memory-critic-heuristics.js'
import {
  NULL_LLM_CRITIC_PROVIDER,
  isNullProvider,
  type LlmCriticProvider,
  type LlmVerdict,
} from './negative-memory-critic-llm.js'
import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'negative-memory-critic' })

export interface RunCriticOptions {
  readonly vault: Vault
  /** LLM provider; defaults to NULL provider (heuristic-only). */
  readonly llmProvider?: LlmCriticProvider
  /** Re-judge memories whose verdict is older than this. Default: never re-judge. */
  readonly forceReReview?: boolean
  /** Per-call cap on memories sent to the LLM. */
  readonly maxLlmBatch?: number
  /** Don't write verdicts back to vault — used by `--dry-run` CLI. */
  readonly dryRun?: boolean
}

export interface CriticRunResult {
  readonly totalCandidates: number
  readonly heuristicSuppressed: number
  readonly heuristicKept: number
  readonly llmJudged: number
  readonly llmSuppressed: number
  readonly llmKept: number
  readonly llmRevised: number
  readonly skippedAlreadyReviewed: number
  readonly verdicts: ReadonlyMap<string, CriticVerdict>
}

/** True if a memory's existing verdict is current (no need to re-judge). */
function verdictIsCurrent(m: NegativeMemory): boolean {
  const v = m.criticVerdict
  if (!v) return false
  const memMtime = m.updatedAt ?? m.createdAt
  // Verdict is current iff reviewedAt >= memMtime
  return v.reviewedAt >= memMtime
}

export async function runNegativeMemoryCritic(
  opts: RunCriticOptions,
): Promise<CriticRunResult> {
  const {
    vault,
    llmProvider = NULL_LLM_CRITIC_PROVIDER,
    forceReReview = false,
    maxLlmBatch = 50,
    dryRun = false,
  } = opts
  const store = createNegativeMemoryStore(vault)
  const all = store.list({ limit: 10_000 })
  const reviewedAt = new Date().toISOString()

  const verdicts = new Map<string, CriticVerdict>()
  let heuristicSuppressed = 0
  let heuristicKept = 0
  let llmSuppressed = 0
  let llmKept = 0
  let llmRevised = 0
  let skippedAlreadyReviewed = 0

  // Filter to memories that need (re-)review
  const needsReview: NegativeMemory[] = []
  for (const m of all) {
    if (!forceReReview && verdictIsCurrent(m)) {
      skippedAlreadyReviewed++
      // Carry forward existing verdict so the result map is complete.
      if (m.criticVerdict) verdicts.set(m.id, m.criticVerdict)
      continue
    }
    needsReview.push(m)
  }

  if (needsReview.length === 0) {
    log.info({ skipped: skippedAlreadyReviewed }, 'critic: nothing to review')
    return {
      totalCandidates: all.length,
      heuristicSuppressed: 0,
      heuristicKept: 0,
      llmJudged: 0,
      llmSuppressed: 0,
      llmKept: 0,
      llmRevised: 0,
      skippedAlreadyReviewed,
      verdicts,
    }
  }

  // 1. Heuristic pass
  const hVerdicts: ReadonlyMap<string, HeuristicVerdict> =
    judgeMemoriesHeuristic(needsReview)
  const undecided: NegativeMemory[] = []

  for (const m of needsReview) {
    const h = hVerdicts.get(m.id)
    if (!h) continue
    if (h.status === 'suppress') {
      const v = mkVerdict('suppress', h.rationale, 'heuristic', reviewedAt, m)
      verdicts.set(m.id, v)
      heuristicSuppressed++
      if (!dryRun) store.updateVerdict(m.id, v)
    } else if (h.status === 'keep') {
      // Heuristic-keep is currently only emitted for `pinned`; pinned bypass is
      // recorded so the applicator sees a verdict.
      const v = mkVerdict('keep', h.rationale, 'heuristic', reviewedAt, m)
      verdicts.set(m.id, v)
      heuristicKept++
      if (!dryRun) store.updateVerdict(m.id, v)
    } else {
      undecided.push(m)
    }
  }

  // 2. LLM pass
  let llmVerdicts: readonly LlmVerdict[] = []
  if (undecided.length > 0) {
    const batch = undecided.slice(0, maxLlmBatch)
    try {
      llmVerdicts = await llmProvider.judge({ memories: batch })
    } catch (err) {
      log.warn({ err: String(err) }, 'critic: LLM provider threw, defaulting all to keep')
      llmVerdicts = batch.map((m) => ({
        id: m.id,
        status: 'keep' as const,
        rationale: 'LLM provider error (defaulted to keep)',
      }))
    }

    const llmById = new Map(llmVerdicts.map((v) => [v.id, v]))
    for (const m of undecided) {
      const lv =
        llmById.get(m.id) ??
        ({
          id: m.id,
          status: 'keep' as CriticStatus,
          rationale: 'beyond LLM batch cap (defaulted to keep)',
        } as LlmVerdict)

      const v = mkVerdict(lv.status, lv.rationale, 'llm', reviewedAt, m, lv.revisedRule)
      verdicts.set(m.id, v)
      if (lv.status === 'keep') llmKept++
      else if (lv.status === 'suppress') llmSuppressed++
      else if (lv.status === 'revise') llmRevised++
      if (!dryRun) store.updateVerdict(m.id, v)
    }
  }

  log.info(
    {
      total: all.length,
      heuristicSuppressed,
      heuristicKept,
      llmJudged: undecided.length,
      llmKept,
      llmSuppressed,
      llmRevised,
      skipped: skippedAlreadyReviewed,
      providerNull: isNullProvider(llmProvider),
      dryRun,
    },
    'critic: pass complete',
  )

  return {
    totalCandidates: all.length,
    heuristicSuppressed,
    heuristicKept,
    llmJudged: undecided.length,
    llmSuppressed,
    llmKept,
    llmRevised,
    skippedAlreadyReviewed,
    verdicts,
  }
}

function mkVerdict(
  status: CriticStatus,
  rationale: string,
  source: 'heuristic' | 'llm',
  reviewedAt: string,
  prev: NegativeMemory,
  revisedRule?: string,
): CriticVerdict {
  const consecutive =
    status === 'suppress' ? (prev.criticVerdict?.consecutiveSuppressCount ?? 0) + 1 : 0
  return {
    status,
    rationale,
    source,
    reviewedAt,
    ...(revisedRule ? { revisedRule } : {}),
    ...(consecutive > 0 ? { consecutiveSuppressCount: consecutive } : {}),
  }
}
