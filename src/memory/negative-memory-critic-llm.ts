/**
 * Negative-memory critic — LLM judge.
 *
 * The LLM critic is invoked by the orchestrator (see `negative-memory-critic.ts`)
 * for memories that the heuristic prefilter could not classify. It receives a
 * batch of candidates and returns a verdict per id.
 *
 * Design note: the actual LLM transport (ACP, claude-cli, mock) is injected
 * via `LlmCriticProvider`. This keeps the critic loop testable and lets the
 * dream daemon degrade gracefully when no provider is configured — the
 * "null provider" returns 'keep' for everything, matching the
 * "do no harm on transport failure" rule from the plan.
 */

import type { NegativeMemory, CriticStatus } from './negative-memory-types.js'
import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'negative-memory-critic-llm' })

export interface LlmVerdict {
  readonly id: string
  readonly status: CriticStatus
  readonly rationale: string
  /** Optional rewrite when status === 'revise'. */
  readonly revisedRule?: string
}

export interface LlmCriticRequest {
  readonly memories: readonly NegativeMemory[]
  readonly batchSize?: number
  readonly timeoutMs?: number
}

export interface LlmCriticProvider {
  judge(req: LlmCriticRequest): Promise<readonly LlmVerdict[]>
}

const DEFAULT_BATCH_SIZE = 25
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Null provider — returns 'keep' for every input. Used when no LLM transport
 * is wired up. Consumers can detect this via `isNullProvider(provider)`.
 */
export const NULL_LLM_CRITIC_PROVIDER: LlmCriticProvider = {
  async judge(req: LlmCriticRequest): Promise<readonly LlmVerdict[]> {
    return req.memories.map((m) => ({
      id: m.id,
      status: 'keep' as const,
      rationale: 'no LLM critic configured (null provider)',
    }))
  },
}

const NULL_MARKER = Symbol.for('scns.negativeMemoryCritic.nullProvider')
;(NULL_LLM_CRITIC_PROVIDER as unknown as Record<symbol, boolean>)[NULL_MARKER] = true

export function isNullProvider(p: LlmCriticProvider | undefined | null): boolean {
  if (!p) return true
  return Boolean((p as unknown as Record<symbol, boolean>)[NULL_MARKER])
}

// ── Prompt builder (used by real providers) ──────────────────────────────────

export const CRITIC_SYSTEM_PROMPT = `You are reviewing candidate "do not do this" rules
that an autonomous coding agent has captured from past experiences. The rules
will be appended to .github/copilot-instructions.md and read by every future
agent. Your job is to filter noise.

For each candidate rule, decide:
  - "keep"     — the rule is specific, actionable, generalizes beyond a single
                 incident, grounded in agent BEHAVIOR (not pipeline/gate
                 plumbing or transient infra failures), and a competent
                 engineer would want it in their instructions.
  - "suppress" — pipeline artifact, transient failure, vague platitude,
                 hyper-specific to one incident, or a system log line that
                 leaked in.
  - "revise"   — the underlying lesson is sound but the wording is poor;
                 supply "revisedRule" with a cleaner phrasing.

Return ONE JSON array. Each element: {"id": string, "status": "keep"|"suppress"|"revise",
"rationale": string (≤ 140 chars), "revisedRule"?: string }.

Only output the JSON array. No prose, no fences.`

export interface BuildPromptOptions {
  readonly memories: readonly NegativeMemory[]
}

export function buildCriticUserPrompt(opts: BuildPromptOptions): string {
  const lines = ['Candidate rules:', '']
  for (const m of opts.memories) {
    lines.push(`- id: ${m.id}`)
    lines.push(`  rule: ${JSON.stringify(m.dontRule)}`)
    if (m.originalText && m.originalText !== m.dontRule) {
      const ctx = m.originalText.slice(0, 240).replace(/\s+/g, ' ')
      lines.push(`  context: ${JSON.stringify(ctx)}`)
    }
    lines.push(`  source: ${m.source}`)
  }
  return lines.join('\n')
}

/**
 * Parse a JSON-array response from the LLM into structured verdicts. Any
 * unparseable response causes a fallback to "keep" for safety.
 */
export function parseCriticResponse(
  raw: string,
  expectedIds: readonly string[],
): readonly LlmVerdict[] {
  let parsed: unknown
  try {
    // Strip code fences if the LLM ignored instructions.
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
    parsed = JSON.parse(cleaned)
  } catch (err) {
    log.warn({ err: String(err) }, 'LLM critic response was not valid JSON; defaulting to keep')
    return expectedIds.map((id) => ({
      id,
      status: 'keep' as const,
      rationale: 'critic JSON parse failure (defaulted to keep)',
    }))
  }

  if (!Array.isArray(parsed)) {
    return expectedIds.map((id) => ({
      id,
      status: 'keep' as const,
      rationale: 'critic response was not an array (defaulted to keep)',
    }))
  }

  const byId = new Map<string, LlmVerdict>()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = typeof o['id'] === 'string' ? o['id'] : ''
    const status = o['status']
    if (!id || (status !== 'keep' && status !== 'suppress' && status !== 'revise')) continue
    const rationale = typeof o['rationale'] === 'string' ? o['rationale'].slice(0, 280) : ''
    const revisedRule =
      typeof o['revisedRule'] === 'string' ? o['revisedRule'].slice(0, 500) : undefined
    byId.set(id, {
      id,
      status,
      rationale,
      ...(revisedRule ? { revisedRule } : {}),
    })
  }

  // Fill gaps for any expected id the LLM omitted.
  return expectedIds.map(
    (id): LlmVerdict =>
      byId.get(id) ?? {
        id,
        status: 'keep' as const,
        rationale: 'critic omitted this id (defaulted to keep)',
      },
  )
}

export const LLM_CRITIC_DEFAULTS = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_TIMEOUT_MS,
} as const
