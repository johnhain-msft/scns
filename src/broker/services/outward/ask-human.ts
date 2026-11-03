/**
 * T055 [US5] (specs/001-learning-memory-loop) — the `ask_human` outward action (FR-019, SC-011).
 *
 * The SAFEST first outward action: deliver a clarifying question to the HUMAN through an injected
 * channel — no egress, no spend, no external contact of any kind. Every attempt is routed through
 * the single `safetyKernel.check` chokepoint so it is AUDITED (allow AND deny land in the
 * hash-chained kernel_audit). With the shipped empty (deny-all) allowlist this action is ALLOWED —
 * asking the human is internal — while all egress stays blocked.
 *
 * The delivery channel is dependency-injected: the broker wires it to the async human-in-the-loop
 * permission surface (see acp-client `humanPermission`); tests inject a spy. A broken channel fails
 * SAFE (allowed:false, never a throw).
 */
import type { SafetyKernel } from '../safety-kernel/safety-kernel.js'

export const ASK_HUMAN_MAX_CHARS = 2000

export interface AskHumanInput {
  readonly question: string
}

export interface AskHumanResult {
  readonly allowed: boolean
  /** Channel-assigned id for the pending question (present iff delivered). */
  readonly questionId?: string
  readonly detail: string
}

export interface AskHumanDeps {
  readonly kernel: SafetyKernel
  /** Deliver the question to the human; returns a channel-assigned question id. */
  readonly deliver: (question: string) => string
}

export interface AskHumanHandler {
  askHuman(input: AskHumanInput): AskHumanResult
}

export function createAskHumanHandler(deps: AskHumanDeps): AskHumanHandler {
  return {
    askHuman(input: AskHumanInput): AskHumanResult {
      const question = typeof input.question === 'string' ? input.question.trim() : ''
      if (question.length === 0 || question.length > ASK_HUMAN_MAX_CHARS) {
        return {
          allowed: false,
          detail: `question must be 1..${ASK_HUMAN_MAX_CHARS} chars (got ${question.length})`,
        }
      }
      // THE chokepoint — audited allow/deny. ask_human carries no URL/command, so the runtime
      // gates (spend → egress) pass it as an internal tool call; the audit row is the point.
      const decision = deps.kernel.check({
        kind: 'tool_call',
        tool: { kind: 'other', title: `ask_human: ${question.slice(0, 80)}` },
      })
      if (!decision.allow) {
        return { allowed: false, detail: `kernel denied: ${decision.detail}` }
      }
      try {
        const questionId = deps.deliver(question)
        return { allowed: true, questionId, detail: 'question delivered to the human channel' }
      } catch (e) {
        return {
          allowed: false,
          detail: `delivery channel failed: ${e instanceof Error ? e.message : String(e)}`,
        }
      }
    },
  }
}
