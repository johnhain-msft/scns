/**
 * Real ACP transport for the session-aware pruning evaluator (#73).
 *
 * Mirrors `judge-acp.ts` and `fact-extractor-acp.ts` exactly, for the same reasons:
 *   - **ISOLATION**: `cwd` is a caller-supplied isolated dir, never the live checkout.
 *   - **DENY-ALL**: a deny-all permission policy forces a text-only turn. The evaluator reads
 *     evidence and returns JSON; it is never an agent that can edit a file or run a tool. That is
 *     the whole point of the provider/guard split — the model proposes, deterministic code decides.
 *   - **BOUNDED**: a wall-clock timeout races the round-trip and the client is always closed.
 *   - **DO NO HARM**: any spawn, timeout or parse failure returns NO proposals, which the
 *     evaluator turns into `uncertain`. A broken transport can never cause a deletion, and it can
 *     never be mistaken for agreement either.
 *   - **INJECTABLE**: the client factory is injectable so tests never spawn a real process.
 */

import { createAcpClient, createDenyAllPermissionPolicy } from '../broker/services/acp-client.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpPermissionPolicy,
} from '../broker/services/acp-client.js'
import {
  buildPruningPrompt,
  parsePruningResponse,
  type PruningAssessmentRequest,
  type PruningProvider,
  type ProviderProposal,
} from './pruning-evaluator.js'
import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'pruning-evaluator-acp' })

/** Env override for the evaluator model (default = the session model, i.e. no `--model`). */
export const PRUNING_MODEL_ENV = 'SCNS_PRUNE_MODEL'

/**
 * Wall-clock budget for one assessment. Reading an evidence block plus a page of candidates is a
 * single text turn; 180 s absorbs cold start and hosted latency variance while keeping a runaway
 * spawn bounded.
 */
export const DEFAULT_PRUNING_ATTEMPT_TIMEOUT_MS = 180_000

/** Candidates per ACP round-trip. Keeps the prompt inside a reliable latency envelope. */
export const DEFAULT_PRUNING_BATCH_SIZE = 12

export interface AcpPruningEvaluatorOptions {
  /** Isolated working dir for the ACP session — NEVER the live checkout. */
  readonly cwd: string
  readonly model?: string
  readonly env?: Record<string, string>
  readonly initTimeoutMs?: number
  readonly promptTimeoutMs?: number
  readonly attemptTimeoutMs?: number
  readonly batchSize?: number
  readonly createClient?: (opts: AcpClientOptions) => AcpClient
  readonly permissionPolicy?: AcpPermissionPolicy
}

export function createAcpPruningEvaluator(
  opts: AcpPruningEvaluatorOptions,
): PruningProvider {
  if (!opts.cwd || opts.cwd.trim() === '') {
    throw new Error('createAcpPruningEvaluator requires an isolated cwd (never the live checkout)')
  }
  const createClient = opts.createClient ?? createAcpClient
  const permissionPolicy = opts.permissionPolicy ?? createDenyAllPermissionPolicy()
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_PRUNING_ATTEMPT_TIMEOUT_MS
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_PRUNING_BATCH_SIZE)

  async function assessBatch(req: PruningAssessmentRequest): Promise<readonly ProviderProposal[]> {
    const clientOpts: AcpClientOptions = {
      cwd: opts.cwd,
      allowAllTools: false,
      permissionPolicy,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.initTimeoutMs !== undefined ? { initTimeoutMs: opts.initTimeoutMs } : {}),
      ...(opts.promptTimeoutMs !== undefined ? { promptTimeoutMs: opts.promptTimeoutMs } : {}),
    }
    const prompt = buildPruningPrompt(req)
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
          () => reject(new Error(`pruning evaluator timed out after ${attemptTimeoutMs}ms`)),
          attemptTimeoutMs,
        )
      })
      const raw = await Promise.race([run, timeout])
      return parsePruningResponse(raw)
    } catch (err) {
      // No proposals ⇒ every candidate in this batch becomes `uncertain`. Do no harm.
      log.warn(
        { err: String(err) },
        'pruning evaluator batch failed — candidates will be reported uncertain',
      )
      return []
    } finally {
      if (timer) clearTimeout(timer)
      await client.close().catch(() => {})
    }
  }

  return {
    async assess(req: PruningAssessmentRequest): Promise<readonly ProviderProposal[]> {
      const out: ProviderProposal[] = []
      for (let i = 0; i < req.candidates.length; i += batchSize) {
        const batch = req.candidates.slice(i, i + batchSize)
        out.push(...(await assessBatch({ candidates: batch, snapshot: req.snapshot })))
      }
      return out
    },
  }
}
