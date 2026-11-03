/**
 * Real ACP fact extractor (env-gated; a HARD-STOP `copilot --acp` spawn).
 *
 * The production transport for {@link LlmFactExtractor}: ONE isolated, bounded, deny-all
 * (think-only) Copilot ACP session that reads a batch of related passages and returns parsed
 * relational fact nodes. Mirrors `createAcpCausalProvider` / `AcpReplayBackend` exactly:
 *   - ISOLATION: the session `cwd` is a caller-supplied isolated dir (required) — NEVER the live
 *     checkout. The extractor reads nothing from and writes nothing to the repo.
 *   - DENY-ALL: a deny-all permission policy forces a text-only turn — the agent can NEVER run a
 *     tool (e.g. `npm install` + the full vitest suite) and blow the timeout (the wedge-C / acp
 *     replay-proofs failure mode). Extraction is inference-only, not an agent that runs tools.
 *   - BOUNDED: a wall-clock `attemptTimeoutMs` guard races the round-trip; the client is ALWAYS
 *     `close()`d in a `finally`. Any spawn/timeout/parse failure degrades to "no facts" (do no
 *     harm: a failed extraction must never corrupt the index, only skip enrichment).
 *   - INJECTABLE: the client factory is injectable so unit tests never spawn a real process.
 *
 * Default-OFF: nothing here runs unless a caller explicitly constructs the provider (the CLI does
 * so only when `SCNS_EXTRACT_FACTS` is truthy AND it owns the spawn).
 */

import { createAcpClient, createDenyAllPermissionPolicy } from '../broker/services/acp-client.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpPermissionPolicy,
} from '../broker/services/acp-client.js'
import { logger } from '../shared/logger.js'
import {
  buildFactExtractionUserPrompt,
  parseFactExtractionResponse,
  FACT_EXTRACTION_SYSTEM_PROMPT,
  type ExtractedFact,
  type FactExtractionRequest,
  type FactSourceChunk,
  type LlmFactExtractor,
} from './fact-extractor-provider.js'

const log = logger.child({ module: 'fact-extractor-acp' })

/** Env opt-in (default-OFF) for fact extraction at ingest — a HARD-STOP `copilot --acp` spawn. */
export const FACT_EXTRACT_ENV = 'SCNS_EXTRACT_FACTS'

/**
 * Default wall-clock budget for one fact-extraction round-trip. EVIDENCE-BASED (D3): a real deny-all
 * `copilot --acp` extraction over the default 8-passage batch was measured at ~47–142 s on a copy of
 * the live vault — the latency is noisy and a 120 s ceiling caused timeouts (0 facts) on slower
 * responses, so the default is raised to 240 s to absorb the variance with margin. Tunable per call.
 */
export const DEFAULT_FACT_ATTEMPT_TIMEOUT_MS = 240_000

export function isFactExtractEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[FACT_EXTRACT_ENV]
  if (v === undefined) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

export interface AcpFactExtractorOptions {
  /** Isolated working dir for the ACP session — NEVER the live checkout. */
  readonly cwd: string
  readonly model?: string
  readonly env?: Record<string, string>
  readonly initTimeoutMs?: number
  readonly promptTimeoutMs?: number
  /** Overall wall-clock guard. Default {@link DEFAULT_FACT_ATTEMPT_TIMEOUT_MS}. */
  readonly attemptTimeoutMs?: number
  /** Injectable client factory (CI-safe). Default {@link createAcpClient}. */
  readonly createClient?: (opts: AcpClientOptions) => AcpClient
  /** Override the deny-all policy (extraction keeps deny-all — think only). */
  readonly permissionPolicy?: AcpPermissionPolicy
}

/**
 * The real fact extractor: ONE isolated, bounded, deny-all (think-only) Copilot ACP session that
 * extracts relational fact nodes from a batch of passages. The client factory is injectable so
 * tests never spawn a real process.
 */
export function createAcpFactExtractor(opts: AcpFactExtractorOptions): LlmFactExtractor {
  if (!opts.cwd || opts.cwd.trim() === '') {
    throw new Error('createAcpFactExtractor requires an isolated cwd (never the live checkout)')
  }
  const createClient = opts.createClient ?? createAcpClient
  const permissionPolicy = opts.permissionPolicy ?? createDenyAllPermissionPolicy()
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_FACT_ATTEMPT_TIMEOUT_MS

  return {
    async extract({ chunks }: FactExtractionRequest): Promise<readonly ExtractedFact[]> {
      if (chunks.length === 0) return []
      const clientOpts: AcpClientOptions = {
        cwd: opts.cwd,
        allowAllTools: false,
        permissionPolicy,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.initTimeoutMs !== undefined ? { initTimeoutMs: opts.initTimeoutMs } : {}),
        ...(opts.promptTimeoutMs !== undefined ? { promptTimeoutMs: opts.promptTimeoutMs } : {}),
      }
      const prompt = `${FACT_EXTRACTION_SYSTEM_PROMPT}\n\n${buildFactExtractionUserPrompt({ chunks })}`
      const validIds = chunks.map((c: FactSourceChunk) => c.id)
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
            () => reject(new Error(`fact extraction timed out after ${attemptTimeoutMs}ms`)),
            attemptTimeoutMs,
          )
        })
        const raw = await Promise.race([run, timeout])
        return parseFactExtractionResponse(raw, validIds)
      } catch (err) {
        log.warn({ err: String(err) }, 'fact extractor threw; extracting no facts (do no harm)')
        return []
      } finally {
        if (timer) clearTimeout(timer)
        await client.close().catch(() => {})
      }
    },
  }
}
