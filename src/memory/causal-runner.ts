/**
 * Causal-edge dream phase runner (M1.3, design-m1.md §5) — orchestration + gating.
 *
 * DEFAULT-OFF + do-no-harm, mirroring `gated-negative-memory-runner.ts`:
 *   - The provider defaults to {@link NULL_CAUSAL_PROVIDER} ⇒ zero edges, zero
 *     writes. M1.3 is inert until a real provider is explicitly supplied.
 *   - The REAL ACP provider is constructed ONLY when the env flag
 *     `SCNS_DREAM_CAUSAL_ACP` is truthy AND a `makeAcpProvider` factory is wired
 *     in — a HARD-STOP `copilot --acp` spawn the caller owns. Without both, the
 *     runner stays on the null provider and writes nothing.
 *   - Every collaborator is injectable so unit tests never spawn a process.
 *   - Writes ONLY to `memory_causal` (via the gated `persistCausalEdges`); NEVER
 *     to guardrail files (issue-#5 precedent).
 *
 * D4 EVIDENCE GATE (2026-06-30, measured on a read-only copy of the live vault): the chunk-level
 * temporal backbone ({@link buildCausalCandidates}) yields R=60 raw pairs that are mid-word
 * telemetry/log/sibling-record fragments, NOT narratable cause→effect events. A REAL deny-all
 * `copilot --acp` (claude-opus-4.8) judge over all 60 inferred only 2 edges, BOTH below the 0.7
 * confidence gate ⇒ persisted=0 ⇒ `memory_causal=0`. So causal is EVIDENCE-GATED inert, not merely
 * default-OFF. The fix for the FRAGMENT problem is the event-level source
 * ({@link buildOutcomeCausalCandidates} over `proposal_outcomes` decision→result history), now wired
 * in FIRST below — so the RE-ACTIVATION TRIGGER is purely DATA-driven: once ≥2 outcomes accumulate
 * for an entity (today: 1 row total ⇒ 0 pairs), real candidates form and a flip of
 * `SCNS_DREAM_CAUSAL` + `SCNS_DREAM_CAUSAL_ACP` populates `memory_causal` (count>0 ⇒ the WHY val task
 * goes live) — no further code change. See magma-loop-evidence/D4-RESULT.md.
 */

import type Database from 'better-sqlite3'
import { createAcpClient, createDenyAllPermissionPolicy } from '../broker/services/acp-client.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpPermissionPolicy,
} from '../broker/services/acp-client.js'
import { logger } from '../shared/logger.js'
import {
  NULL_CAUSAL_PROVIDER,
  isNullCausalProvider,
  buildCausalUserPrompt,
  parseCausalResponse,
  CAUSAL_SYSTEM_PROMPT,
  type CausalProvider,
  type CausalCandidate,
  type CausalEdge,
} from './causal-provider.js'
import {
  buildCausalCandidates,
  persistCausalEdges,
  materializeCausalEdges,
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MAX_EDGES,
} from './causal-edges.js'
import { buildOutcomeCausalCandidates } from './outcome-causal-candidates.js'
import { buildEventCausalCandidates } from './event-nodes.js'

const log = logger.child({ module: 'causal-runner' })

/**
 * Union two candidate lists, `primary` first, deduped on the `(causeKey,effectKey)` pair and
 * capped at `max`. Event-level (`proposal_outcomes` decision→result) candidates are the primary
 * source — they are genuine narratable events, whereas the chunk-level temporal backbone yields
 * telemetry/log fragments the conservative judge rejects (D4 finding: 60 chunk pairs → 0 edges).
 * Putting outcomes first means they survive the cap; chunk pairs only fill any remaining budget.
 */
function unionCandidates(
  primary: readonly CausalCandidate[],
  secondary: readonly CausalCandidate[],
  max: number,
): CausalCandidate[] {
  const out: CausalCandidate[] = []
  const seen = new Set<string>()
  for (const c of [...primary, ...secondary]) {
    const pair = `${c.causeKey}\u0000${c.effectKey}`
    if (seen.has(pair)) continue
    seen.add(pair)
    out.push(c)
    if (out.length >= max) break
  }
  return out
}

/** Env opt-in (default-OFF) for the real-agent causal provider — a HARD-STOP spawn. */
export const CAUSAL_ACP_ENV = 'SCNS_DREAM_CAUSAL_ACP'

/** Default wall-clock budget for one causal inference round-trip. */
export const DEFAULT_CAUSAL_ATTEMPT_TIMEOUT_MS = 180_000

/**
 * Default causal-judge batch size (research R3 / T025). Candidates are judged in ≤this-many-pair chunks —
 * one bounded deny-all session each — so the ingest can be un-capped without a single all-candidates prompt
 * blowing the wall (a ~161-pair union previously timed out ⇒ persisted 0). Table-6-agnostic; a transport knob.
 */
export const DEFAULT_CAUSAL_BATCH_SIZE = 20

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

export type CausalProviderLabel = 'null' | 'injected' | 'acp'

export interface CausalRunDeps {
  readonly db: Database.Database
  /** Inject a provider directly (tests). Wins over the env-gated factory. */
  readonly provider?: CausalProvider
  /** Environment to read the opt-in from. Default `process.env`. */
  readonly env?: Record<string, string | undefined>
  readonly minConfidence?: number
  readonly maxEdges?: number
  readonly maxCandidates?: number
  /**
   * Build the real ACP provider when {@link CAUSAL_ACP_ENV} is truthy. The caller
   * (dream-daemon/cli wiring) supplies this ONLY when it intends the HARD-STOP
   * spawn; absent ⇒ the env flag alone cannot trigger a real process.
   */
  readonly makeAcpProvider?: () => CausalProvider
}

export interface CausalRunResult {
  /** True iff the provider was invoked against candidates. */
  readonly ran: boolean
  readonly skipReason?: string
  readonly providerLabel: CausalProviderLabel
  readonly candidateCount: number
  /** Edges the provider proposed (pre-gate). */
  readonly inferred: number
  /** Edges actually written to `memory_causal`. */
  readonly persisted: number
  /** `memory_edges(edge_type='causal')` rows materialized so the beam can traverse them (WS-2b). */
  readonly materialized: number
  readonly rejectedLowConfidence: number
  readonly cappedOut: number
}

function resolveProvider(deps: CausalRunDeps): { provider: CausalProvider; label: CausalProviderLabel } {
  if (deps.provider) {
    return {
      provider: deps.provider,
      label: isNullCausalProvider(deps.provider) ? 'null' : 'injected',
    }
  }
  const env = deps.env ?? process.env
  if (isTruthy(env[CAUSAL_ACP_ENV]) && deps.makeAcpProvider) {
    return { provider: deps.makeAcpProvider(), label: 'acp' }
  }
  return { provider: NULL_CAUSAL_PROVIDER, label: 'null' }
}

function skip(reason: string, label: CausalProviderLabel, candidateCount = 0): CausalRunResult {
  return {
    ran: false,
    skipReason: reason,
    providerLabel: label,
    candidateCount,
    inferred: 0,
    persisted: 0,
    materialized: 0,
    rejectedLowConfidence: 0,
    cappedOut: 0,
  }
}

/**
 * Run one causal-edge inference pass. Default-OFF (null provider) ⇒ writes nothing.
 */
export async function runCausalEdgeInference(deps: CausalRunDeps): Promise<CausalRunResult> {
  const { provider, label } = resolveProvider(deps)
  if (isNullCausalProvider(provider)) return skip('null-provider', 'null')

  const maxCandidates = deps.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  // MAGMA WHY subspace draws from candidate sources in DESCENDING signal order, event-level FIRST:
  //   1. WS-1 EVENT NODES (broker decision→action→outcome nodes w/ real τ) — the richest narratable
  //      source (buildEventCausalCandidates; ~49 on the live-copy substrate). Empty unless the event
  //      substrate has been segmented (SCNS_EVENT_SEGMENTATION), so this is a no-op in a prod default.
  //   2. `proposal_outcomes` decision→result history.
  //   3. the chunk-level temporal backbone (telemetry fragments the conservative judge rejects — D4).
  // Event/outcome candidates come first so they survive the cap; chunk pairs only fill leftover budget.
  const eventCandidates = buildEventCausalCandidates(deps.db, { maxCandidates })
  const outcomeCandidates = buildOutcomeCausalCandidates(deps.db, { maxCandidates })
  const chunkCandidates = buildCausalCandidates(deps.db, { maxCandidates })
  const candidates = unionCandidates(
    eventCandidates,
    unionCandidates(outcomeCandidates, chunkCandidates, maxCandidates),
    maxCandidates,
  )
  if (candidates.length === 0) return skip('no-candidates', label)

  let edges
  try {
    edges = await provider.infer({ candidates })
  } catch (err) {
    log.warn({ err: String(err) }, 'causal provider threw; inferring no edges')
    return skip('provider-error', label, candidates.length)
  }

  const entityByPair = new Map<string, string>()
  for (const c of candidates) {
    if (c.entity) entityByPair.set(`${c.causeKey}\u0000${c.effectKey}`, c.entity)
  }

  const stats = persistCausalEdges(deps.db, edges, {
    minConfidence: deps.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    maxEdges: deps.maxEdges ?? DEFAULT_MAX_EDGES,
    provider: label,
    entityByPair,
  })

  // WS-2b: bridge the write/read split — materialize the (content-hash-keyed) memory_causal table
  // into chunk→chunk memory_edges(edge_type='causal') so the adaptive-traversal beam can actually
  // traverse the inferred edges. Rebuilds the full causal tier from the authoritative table each
  // pass (idempotent, re-chunk-safe); survives a later deterministic entity/temporal edge rebuild.
  const mat = materializeCausalEdges(deps.db)

  log.info(
    {
      providerLabel: label,
      candidateCount: candidates.length,
      inferred: edges.length,
      persisted: stats.persisted,
      materialized: mat.materialized,
      materializeUnresolved: mat.unresolved,
      rejectedLowConfidence: stats.rejectedLowConfidence,
      cappedOut: stats.cappedOut,
    },
    'causal: inference pass complete',
  )

  return {
    ran: true,
    providerLabel: label,
    candidateCount: candidates.length,
    inferred: edges.length,
    persisted: stats.persisted,
    materialized: mat.materialized,
    rejectedLowConfidence: stats.rejectedLowConfidence,
    cappedOut: stats.cappedOut,
  }
}

// ── Real ACP provider (env-gated; a HARD-STOP spawn) ─────────────────────────

export interface AcpCausalProviderOptions {
  /** Isolated working dir for the ACP session — NEVER the live checkout. */
  readonly cwd: string
  readonly model?: string
  readonly env?: Record<string, string>
  readonly initTimeoutMs?: number
  readonly promptTimeoutMs?: number
  /** Overall wall-clock guard. Default {@link DEFAULT_CAUSAL_ATTEMPT_TIMEOUT_MS}. */
  readonly attemptTimeoutMs?: number
  /** Judge candidates in ≤this-many-pair chunks (research R3 / T025). Default {@link DEFAULT_CAUSAL_BATCH_SIZE}. */
  readonly batchSize?: number
  /** Injectable client factory (CI-safe). Default {@link createAcpClient}. */
  readonly createClient?: (opts: AcpClientOptions) => AcpClient
  /** Override the deny-all policy (causal inference keeps deny-all — think only). */
  readonly permissionPolicy?: AcpPermissionPolicy
}

/**
 * The real causal provider: ONE isolated, bounded, deny-all (think-only) Copilot
 * ACP session that judges candidate pairs and returns parsed edges. Mirrors
 * `ideate/backend.ts`: isolated cwd required, the agent can never run a tool or
 * edit a file, the round-trip is wall-clock bounded, and the client is always
 * closed. The client factory is injectable so tests never spawn a real process.
 */
export function createAcpCausalProvider(opts: AcpCausalProviderOptions): CausalProvider {
  if (!opts.cwd || opts.cwd.trim() === '') {
    throw new Error('createAcpCausalProvider requires an isolated cwd (never the live checkout)')
  }
  const createClient = opts.createClient ?? createAcpClient
  const permissionPolicy = opts.permissionPolicy ?? createDenyAllPermissionPolicy()
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_CAUSAL_ATTEMPT_TIMEOUT_MS
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_CAUSAL_BATCH_SIZE)

  // Judge ONE ≤batchSize-pair batch in a single bounded, isolated, deny-all (think-only) session.
  const judgeBatch = async (batch: readonly CausalCandidate[]): Promise<readonly CausalEdge[]> => {
    const clientOpts: AcpClientOptions = {
      cwd: opts.cwd,
      allowAllTools: false,
      permissionPolicy,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.initTimeoutMs !== undefined ? { initTimeoutMs: opts.initTimeoutMs } : {}),
      ...(opts.promptTimeoutMs !== undefined ? { promptTimeoutMs: opts.promptTimeoutMs } : {}),
    }
    const prompt = `${CAUSAL_SYSTEM_PROMPT}\n\n${buildCausalUserPrompt({ candidates: batch })}`
    const client = createClient(clientOpts)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const run = (async (): Promise<string> => {
        await client.initialize()
        const sessionId = await client.createSession(opts.cwd)
        const result = await client.sendPrompt(sessionId, prompt)
        return result.output
      })()
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`causal inference timed out after ${attemptTimeoutMs}ms`)),
          attemptTimeoutMs,
        )
      })
      const raw = await Promise.race([run, timeout])
      return parseCausalResponse(raw, batch)
    } finally {
      if (timer) clearTimeout(timer)
      await client.close().catch(() => {})
    }
  }

  return {
    async infer({ candidates }: { candidates: readonly CausalCandidate[] }) {
      if (candidates.length === 0) return []
      // MAGMA Alg-3 consolidation (research R3 / T025): judge ALL candidates, chunked into ≤batchSize-pair
      // batches — one bounded deny-all session each, results unioned + deduped on (causeKey,effectKey).
      // A single all-candidates prompt blew the wall on a ~161-pair union (persisted 0); small batches make
      // un-capping the ingest wall-safe so the causal substrate can reach the R3 density floor.
      const out: CausalEdge[] = []
      const seen = new Set<string>()
      for (let i = 0; i < candidates.length; i += batchSize) {
        const edges = await judgeBatch(candidates.slice(i, i + batchSize))
        for (const e of edges) {
          const pair = `${e.causeKey}\u0000${e.effectKey}`
          if (seen.has(pair)) continue
          seen.add(pair)
          out.push(e)
        }
      }
      return out
    },
  }
}
