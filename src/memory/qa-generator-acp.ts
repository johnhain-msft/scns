/**
 * Real ACP transport for the App C.2 Query-Adaptive QA generator (env-gated; a `copilot --acp` spawn).
 *
 * The production transport for {@link QaGenerator}: ONE isolated, bounded, deny-all (think-only)
 * Copilot ACP session that answers a question from retrieved context on the App C.2 prompt. MIRRORS
 * `createAcpFactExtractor` / `createAcpJudge`:
 *   - ISOLATION: `cwd` is a caller-supplied isolated dir (required) — NEVER the live checkout.
 *   - EPHEMERAL: a fresh session per call, ALWAYS `close()`d in a `finally`.
 *   - DENY-ALL: a deny-all policy forces a text-only turn so the agent can NEVER run a tool (e.g.
 *     `npm install` + vitest) and blow the timeout (repo memory: deny-all + a small `attemptTimeoutMs`
 *     is REQUIRED). Answering is inference-only.
 *   - BOUNDED: a wall-clock `attemptTimeoutMs` races the round-trip; on any spawn/timeout/parse failure
 *     the result carries `error:true` so the harness DROPS it from aggregation (never scores a failed
 *     spawn as a genuine abstain).
 *   - INJECTABLE: the client factory is injectable so unit tests never spawn a real process.
 *
 * The generator + the judge are SEPARATE ephemeral spawns (the generator sees the context; the judge is
 * blind). Default model = the session model; override via `opts.model`. Default-OFF: nothing runs unless
 * a caller constructs the provider (the harness does so only when `SCNS_QA_GENERATOR` is truthy).
 */

import { createAcpClient, createDenyAllPermissionPolicy } from '../broker/services/acp-client.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpPermissionPolicy,
} from '../broker/services/acp-client.js'
import { logger } from '../shared/logger.js'
import {
  ADAPTIVE_QA_SYSTEM_PROMPT,
  buildQaUserPrompt,
  parseQaResponse,
  type QaGenerationRequest,
  type QaGenerationResult,
  type QaGenerator,
} from './qa-generator.js'

const log = logger.child({ module: 'qa-generator-acp' })

/** Env opt-in (default-OFF) for the QA generator — a HARD-STOP `copilot --acp` spawn. */
export const GEN_ENV = 'SCNS_QA_GENERATOR'
/** Env override for the generator model (default = the session model). Held CONSTANT across configs (R4). */
export const GEN_MODEL_ENV = 'SCNS_QA_MODEL'

/** Default wall-clock budget for one answer. Bounded like the judge; absorbs cold-start + latency variance. */
export const DEFAULT_GEN_ATTEMPT_TIMEOUT_MS = 120_000

export function isQaGeneratorEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[GEN_ENV]
  if (v === undefined) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

export interface AcpQaGeneratorOptions {
  /** Isolated working dir for the ACP session — NEVER the live checkout. */
  readonly cwd: string
  /** Generator model. Omit for the session model; held CONSTANT across configs for R4. */
  readonly model?: string
  readonly env?: Record<string, string>
  readonly initTimeoutMs?: number
  readonly promptTimeoutMs?: number
  /** Overall wall-clock guard. Default {@link DEFAULT_GEN_ATTEMPT_TIMEOUT_MS}. */
  readonly attemptTimeoutMs?: number
  /** Injectable client factory (CI-safe). Default {@link createAcpClient}. */
  readonly createClient?: (opts: AcpClientOptions) => AcpClient
  /** Override the deny-all policy (the generator keeps deny-all — think only). */
  readonly permissionPolicy?: AcpPermissionPolicy
}

/**
 * The real QA generator: ONE isolated, bounded, deny-all (think-only) Copilot ACP session that answers
 * one question from retrieved context on the App C.2 prompt. The client factory is injectable so tests
 * never spawn a real process.
 */
export function createAcpQaGenerator(opts: AcpQaGeneratorOptions): QaGenerator {
  if (!opts.cwd || opts.cwd.trim() === '') {
    throw new Error('createAcpQaGenerator requires an isolated cwd (never the live checkout)')
  }
  const createClient = opts.createClient ?? createAcpClient
  const permissionPolicy = opts.permissionPolicy ?? createDenyAllPermissionPolicy()
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_GEN_ATTEMPT_TIMEOUT_MS

  return {
    async generate(req: QaGenerationRequest): Promise<QaGenerationResult> {
      const clientOpts: AcpClientOptions = {
        cwd: opts.cwd,
        allowAllTools: false,
        permissionPolicy,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.initTimeoutMs !== undefined ? { initTimeoutMs: opts.initTimeoutMs } : {}),
        ...(opts.promptTimeoutMs !== undefined ? { promptTimeoutMs: opts.promptTimeoutMs } : {}),
      }
      const prompt = `${ADAPTIVE_QA_SYSTEM_PROMPT}\n\n${buildQaUserPrompt(req)}`
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
            () => reject(new Error(`qa generation timed out after ${attemptTimeoutMs}ms`)),
            attemptTimeoutMs,
          )
        })
        const raw = await Promise.race([run, timeout])
        return parseQaResponse(raw)
      } catch (err) {
        log.warn({ err: String(err) }, 'qa generator threw; error result (do no harm — dropped from aggregation)')
        return { answer: '', notFound: true, error: true }
      } finally {
        if (timer) clearTimeout(timer)
        await client.close().catch(() => {})
      }
    },
  }
}
