/**
 * Human-feedback → brain-task bridge (W5.3, hardened per blind-review
 * finding 1). A HUMAN-origin negative-feedback report becomes a High task in
 * the self-issue pipeline. The signal key is derived from the RULE TEXT (not
 * a per-report UUID) so repeated identical feedback dedupes against the live
 * queue instead of minting an unbounded stream of High tasks.
 */

import { createHash } from 'node:crypto'
import { DecisionPriority } from './state-types.js'

export interface HumanFeedbackMemory {
  readonly id: string
  readonly dontRule: string
  readonly category: string
  readonly recommendedTarget: string
}

export interface HumanFeedbackBridgeDeps {
  readonly addTask: (
    description: string,
    priority: DecisionPriority,
    signalKey: string,
  ) => string | null
  readonly hasQueuedSignal: (signalKey: string) => boolean
  readonly requestWake: () => void
}

/** Deterministic on the rule text so identical repeats share one signal. */
export function humanFeedbackSignalKey(dontRule: string): string {
  const digest = createHash('sha256').update(dontRule.trim().toLowerCase()).digest('hex')
  return `human-feedback:${digest.slice(0, 12)}`
}

export function createHumanFeedbackTaskBridge(deps: HumanFeedbackBridgeDeps) {
  return (mem: HumanFeedbackMemory): string | null => {
    const signalKey = humanFeedbackSignalKey(mem.dontRule)
    if (deps.hasQueuedSignal(signalKey)) return null
    const taskId = deps.addTask(
      `Address human negative feedback: ${mem.dontRule}\n` +
        `Category: ${mem.category}; recommended target: ${mem.recommendedTarget}.\n` +
        `Memory: ${mem.id}. Investigate the complaint, fix the cause, and verify ` +
        `the behavior no longer occurs.`,
      DecisionPriority.High,
      signalKey,
    )
    if (taskId) deps.requestWake()
    return taskId
  }
}
