/**
 * D1 — the ideation runner: the advisory cycle that turns real signals into
 * novel proposals in the review inbox.
 *
 *   gather signals → build prompt → backend.ideate (ONE isolated ACP session)
 *   → parse → write to the inbox (status:'new')
 *
 * It is DEFAULT-OFF: `opts.enabled` must be explicitly true (the CLI derives it
 * from `SCNS_IDEATION=1`). It is ADVISORY: proposals land in the inbox for human
 * review and are NEVER auto-spawned in D1. A backend failure writes NOTHING and
 * is surfaced as a structured result (the partial output of a half-failed spawn
 * must never pollute the inbox).
 */

import { gatherIdeationSignals } from './signals.js'
import { buildIdeationPrompt } from './prompt.js'
import { parseIdeationResponse } from './parse.js'
import { logger } from '../shared/logger.js'
import type { IdeationSignalSources } from './signals.js'
import type { IdeationBackend } from './backend.js'
import type { IdeationInbox } from './inbox.js'
import type { IdeationRecord } from './types.js'

/** How many proposals to request when the caller doesn't specify. */
export const DEFAULT_IDEATION_K = 5

export interface RunIdeationDeps {
  readonly sources: IdeationSignalSources
  readonly backend: IdeationBackend
  readonly inbox: IdeationInbox
  /** Recorded on each inbox record (best-effort provenance). */
  readonly model?: string
  /** Provenance stamp for written records. Default 'llm-ideation'. */
  readonly source?: 'llm-ideation' | 'synth-ideation'
}

export interface RunIdeationOptions {
  /** DEFAULT-OFF gate. The runner no-ops unless this is explicitly true. */
  readonly enabled: boolean
  /** Number of proposals to request. Default {@link DEFAULT_IDEATION_K}. */
  readonly k?: number
  /** Cap on parsed proposals. Default = `k`. */
  readonly maxProposals?: number
}

export interface RunIdeationResult {
  readonly ran: boolean
  readonly skipReason?: string
  readonly error?: string
  /** Proposals requested (k). */
  readonly requested: number
  /** Valid proposals parsed from the agent response. */
  readonly received: number
  /** Malformed entries dropped during parsing. */
  readonly dropped: number
  /** Records actually written to the inbox. */
  readonly written: readonly IdeationRecord[]
  /** Length of the prompt the agent received (diagnostics). */
  readonly promptChars: number
  /** The agent's full raw response (''. when not run) — for diagnostics. */
  readonly raw: string
}

export async function runIdeation(
  deps: RunIdeationDeps,
  opts: RunIdeationOptions,
): Promise<RunIdeationResult> {
  const k = opts.k ?? DEFAULT_IDEATION_K
  const max = opts.maxProposals ?? k

  if (!opts.enabled) {
    return {
      ran: false,
      skipReason: 'disabled',
      requested: 0,
      received: 0,
      dropped: 0,
      written: [],
      promptChars: 0,
      raw: '',
    }
  }

  const signals = gatherIdeationSignals(deps.sources)
  const prompt = buildIdeationPrompt(signals, { k })

  let raw: string
  try {
    raw = await deps.backend.ideate(prompt)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ err: message }, 'ideation: backend failed — writing nothing')
    return {
      ran: false,
      skipReason: 'backend-error',
      error: message,
      requested: k,
      received: 0,
      dropped: 0,
      written: [],
      promptChars: prompt.length,
      raw: '',
    }
  }

  const parsed = parseIdeationResponse(raw, { max })
  const written =
    parsed.proposals.length > 0
      ? deps.inbox.append(parsed.proposals, {
          model: deps.model,
          ...(deps.source ? { source: deps.source } : {}),
        })
      : []

  logger.info(
    { requested: k, received: parsed.proposals.length, dropped: parsed.dropped, written: written.length },
    'ideation: cycle complete',
  )

  return {
    ran: true,
    requested: k,
    received: parsed.proposals.length,
    dropped: parsed.dropped,
    written,
    promptChars: prompt.length,
    raw,
  }
}

/**
 * DEFAULT-OFF master gate. Ideation runs only when `SCNS_IDEATION=1` — any other
 * value (unset, '0', 'true', …) is OFF. The real ACP spawn is gated separately
 * by the CLI's `--spawn` flag so even an enabled feature stays dry-run by default.
 */
export function ideationEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env.SCNS_IDEATION === '1'
}

/**
 * DEFAULT-OFF gate for the deterministic synthesizer backend. Unlike the ACP path
 * this needs no spawn/network, but it is still opt-in via `SCNS_IDEATE_SYNTH=1` and
 * still requires `--spawn` to write — so the default remains a dry run.
 */
export function synthEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env.SCNS_IDEATE_SYNTH === '1'
}

/**
 * DEFAULT-OFF gate for memory-derived open gaps. When `SCNS_IDEATE_MEMGAPS=1`, the
 * CLI replaces the static seed gaps with gaps derived from recurring negmem themes
 * and failed outcomes (the seeds are kept as a base). Read-only; advisory.
 */
export function memGapsEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env.SCNS_IDEATE_MEMGAPS === '1'
}
