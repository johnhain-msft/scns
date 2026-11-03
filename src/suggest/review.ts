/**
 * Review workflow — manages approve/reject flow for suggestions.
 */

import type { Suggestion, SuggestionStatus } from './types.js'
import { SuggestionStatus as Status } from './types.js'
import type { createSuggestionStore } from './suggestion-store.js'
import type { createExecutor, ImplementationPlan, ExecutionResult } from './executor.js'
import { ScnsError } from '../shared/errors.js'
import { isHumanReason, parseReviewReason } from './review-reason.js'
import { recordDecisionRationale } from '../memory/decision-rationale.js'
import type { Vault } from '../memory/vault.js'

export interface ReviewDeps {
  readonly store: ReturnType<typeof createSuggestionStore>
  readonly executor: ReturnType<typeof createExecutor>
  /**
   * Optional vault for capturing John's reasoning (FR-046a / T128b).
   *
   * OPTIONAL, and deliberately so: capture is additive. This path's job is to record a DECISION,
   * and a missing vault must never turn a legitimate approval into a failure — losing the words is
   * bad, losing the decision would be worse. When absent, behaviour is exactly what it was before.
   */
  readonly vault?: Vault
}

export interface ReviewResult {
  readonly success: boolean
  readonly suggestion: Suggestion | null
  readonly plan?: ImplementationPlan
  readonly execution?: ExecutionResult
  readonly error?: string
  /**
   * Capture failures, for the caller to show the human (FR-053).
   *
   * Returned rather than logged: this path is driven from a terminal, and a rationale that failed
   * to save must be said to his face while he can still do something about it. Present ONLY when
   * something went wrong, so `undefined` is the successful case.
   */
  readonly rationaleWarnings?: readonly string[]
}

export interface SuggestionSummary {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly confidence: number
  readonly evidenceCount: number
  readonly createdAt: string
  readonly tags: readonly string[]
}

function toSummary(s: Suggestion): SuggestionSummary {
  return {
    id: s.id,
    type: s.type,
    title: s.title,
    confidence: s.confidence,
    evidenceCount: s.evidence.length,
    createdAt: s.createdAt,
    tags: s.tags,
  }
}

/**
 * Carry capture failures out on an exception.
 *
 * `captureRationale`'s warnings normally ride home on `ReviewResult.rationaleWarnings`, but the
 * auto-execute path can throw, and a throw returns no result. A stack trace is loud without being
 * informative: it does not say "your reasoning was not saved". Attaching them keeps FR-053's
 * promise — that a capture failure is always SAID — on the one path that had no return value.
 */
export interface RationaleWarningCarrier {
  readonly rationaleWarnings?: readonly string[]
}

function attachRationaleWarnings(err: unknown, warnings: readonly string[]): unknown {
  if (warnings.length === 0 || !(err instanceof Error)) return err
  Object.defineProperty(err, 'rationaleWarnings', {
    value: warnings,
    enumerable: true,
    configurable: true,
  })
  return err
}

/** Create a review workflow for managing suggestion approvals */
export function createReviewWorkflow(deps: ReviewDeps) {
  const { store, executor, vault } = deps

  /**
   * Capture John's own words before the auto-execute path can transition the suggestion again.
   *
   * Called BEFORE `executor.execute`, not after: the erasure this fixes happened at review.ts:98,
   * where a successful auto-execute transitions to `implemented` with no reason. Capturing first
   * means the words are already durable on disk no matter what the executor does next — including
   * throwing.
   *
   * Machine reasons are ignored here by design (FR-048). Only a `human:<code>:<text>` reason is
   * his; filing a quality-gate string under `author: 'human'` would train the learner on its own
   * output and label it John's judgement.
   */
  function captureRationale(
    suggestion: Suggestion,
    reason: string | undefined,
    reviewVerdict: 'approve' | 'reject',
  ): readonly string[] {
    if (!vault || !isHumanReason(reason)) return []
    const parsed = parseReviewReason(reason!)
    if (!parsed || parsed.text === '') return []
    const res = recordDecisionRationale(
      { vault },
      {
        suggestionId: suggestion.id,
        title: suggestion.title,
        text: parsed.text,
        code: parsed.code,
        author: 'human',
        reviewVerdict,
        suggestionStatus: suggestion.status,
      },
    )
    return res.errors
  }

  function approve(id: string, reason?: string): ReviewResult {
    const suggestion = store.get(id)
    if (!suggestion) {
      return { success: false, suggestion: null, error: `Suggestion ${id} not found` }
    }

    if (suggestion.status !== Status.Pending) {
      return {
        success: false,
        suggestion: null,
        error: `Suggestion ${id} is not pending (status: ${suggestion.status})`,
      }
    }

    const updated = store.updateStatus(id, Status.Approved as SuggestionStatus, reason, undefined, {
      reviewVerdict: 'approve',
    })
    const warnings = captureRationale(suggestion, reason, 'approve')
    const warn = warnings.length > 0 ? { rationaleWarnings: warnings } : {}

    // Some types are deliberately un-plannable: `workflow` is a human process and `arm-promotion`
    // is a decision about what the human is served. Both throw NEEDS_HUMAN from `generatePlan`.
    // That throw used to escape `approve()` entirely and take the caller down with it — the brain's
    // own promoter guards against it (cli.ts), but this workflow, which is the path a human uses,
    // did not. Approving such a proposal is a legitimate act, so it is recorded and then routed to
    // the terminal `needs-human` status instead of crashing.
    let plan: ImplementationPlan
    try {
      plan = executor.generatePlan(updated!)
    } catch (err) {
      if (err instanceof ScnsError && err.code === 'NEEDS_HUMAN') {
        // FR-050c: the safety-gate refusal is the MACHINE's, not a second decision by John.
        store.updateStatus(id, Status.NeedsHuman as SuggestionStatus, reason, undefined, {
          author: 'machine',
        })
        return { success: true, suggestion: store.get(id), error: err.message, ...warn }
      }
      // FR-053 residual: an unexpected throw must not swallow the fact that his reasoning failed to
      // persist. A stack trace is loud but it does not say "your words were lost", so the warnings
      // ride along on the error for the CLI to print beside the failure.
      throw attachRationaleWarnings(err, warnings)
    }

    if (executor.canAutoExecute()) {
      let execution: ReturnType<typeof executor.execute>
      try {
        execution = executor.execute(plan, updated!)
      } catch (err) {
        throw attachRationaleWarnings(err, warnings)
      }
      // Phase 13.12.18: gate rejection → terminal status.
      if (execution.gateDecision && !execution.gateDecision.ok) {
        const terminal: SuggestionStatus =
          execution.gateDecision.status === 'needs-human'
            ? (Status.NeedsHuman as SuggestionStatus)
            : (Status.Rejected as SuggestionStatus)
        // FR-050c: an executor gate refusal is the machine's verdict. When `terminal` is
        // `rejected` this is exactly the shape that erased John's `approve` on 65a914f4.
        store.updateStatus(id, terminal, execution.gateDecision.reason, undefined, {
          author: 'machine',
        })
        const final = store.get(id)
        return { success: false, suggestion: final, plan, execution, error: execution.gateDecision.reason, ...warn }
      }
      if (execution.success) {
        // The auto-execute transition — a machine consequence of his approval, not a new one.
        store.updateStatus(id, Status.Implemented as SuggestionStatus, undefined, undefined, {
          author: 'machine',
        })
        const implemented = store.get(id)
        return { success: true, suggestion: implemented, plan, execution, ...warn }
      }
      return { success: true, suggestion: updated, plan, execution, ...warn }
    }

    return { success: true, suggestion: updated, plan, ...warn }
  }

  function reject(id: string, reason: string): ReviewResult {
    const suggestion = store.get(id)
    if (!suggestion) {
      return { success: false, suggestion: null, error: `Suggestion ${id} not found` }
    }

    if (suggestion.status !== Status.Pending) {
      return {
        success: false,
        suggestion: null,
        error: `Suggestion ${id} is not pending (status: ${suggestion.status})`,
      }
    }

    const updated = store.updateStatus(id, Status.Rejected as SuggestionStatus, reason, undefined, {
      reviewVerdict: 'reject',
    })
    const warnings = captureRationale(suggestion, reason, 'reject')
    return {
      success: true,
      suggestion: updated,
      ...(warnings.length > 0 ? { rationaleWarnings: warnings } : {}),
    }
  }

  function getSummary(id: string): SuggestionSummary | null {
    const suggestion = store.get(id)
    if (!suggestion) return null
    return toSummary(suggestion)
  }

  function listPending(typeFilter?: string): readonly SuggestionSummary[] {
    const pending = store.list(Status.Pending as SuggestionStatus)
    const filtered = typeFilter ? pending.filter((s) => s.type === typeFilter) : pending
    return filtered.map(toSummary).sort((a, b) => b.confidence - a.confidence)
  }

  function previewPlan(id: string): ImplementationPlan | null {
    const suggestion = store.get(id)
    if (!suggestion) return null
    return executor.generatePlan(suggestion)
  }

  return { approve, reject, getSummary, listPending, previewPlan }
}
