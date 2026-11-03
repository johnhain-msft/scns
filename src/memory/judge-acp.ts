/**
 * Real ACP transport for the App C.3 LLM-as-a-Judge (env-gated; a HARD-STOP `copilot --acp` spawn).
 *
 * The production transport for {@link JudgeProvider}: ONE isolated, bounded, deny-all (think-only)
 * Copilot ACP session that grades a candidate answer against a gold reference on the App C.3 semantic
 * rubric. MIRRORS `createAcpFactExtractor` exactly:
 *   - ISOLATION: `cwd` is a caller-supplied isolated dir (required) — NEVER the live checkout.
 *   - BLIND (R2 anti-self-grading): the judge is ALWAYS a SEPARATE, EPHEMERAL session, spun up and torn
 *     down per grade — it never shares the working/generator session's context or state, and its prompt
 *     carries ONLY {question, gold, candidate} (via `buildJudgeUserPrompt`), never the retrieved context.
 *   - DENY-ALL: a deny-all permission policy forces a text-only turn so the agent can NEVER run a tool
 *     (e.g. `npm install` + the full vitest suite) and blow the timeout (the wedge-C / acp-replay-proof
 *     failure mode; repo memory: deny-all + a small `attemptTimeoutMs` is REQUIRED). Grading is
 *     inference-only, not an agent that runs tools.
 *   - BOUNDED: a wall-clock `attemptTimeoutMs` races the round-trip; the client is ALWAYS `close()`d in a
 *     `finally`. Any spawn/timeout/parse failure degrades to the NULL sentinel score (do no harm: a flaky
 *     grade is DROPPED from accuracy aggregation, never counted as a real 0.0).
 *   - INJECTABLE: the client factory is injectable so unit tests never spawn a real process.
 *
 * Default judge model = the SESSION model (pass no `--model`); override via `opts.model` (the harness
 * resolves {@link JUDGE_MODEL_ENV} = `SCNS_JUDGE_MODEL`). Alternative transport: `copilot -p` headless.
 * Default-OFF: nothing runs unless a caller explicitly constructs the provider (the harness does so only
 * when `SCNS_LLM_JUDGE` is truthy).
 */

import { createAcpClient, createDenyAllPermissionPolicy } from '../broker/services/acp-client.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpPermissionPolicy,
} from '../broker/services/acp-client.js'
import { logger } from '../shared/logger.js'
import {
  buildJudgeUserPrompt,
  parseJudgeResponse,
  SEMANTIC_GRADER_SYSTEM_PROMPT,
  NULL_JUDGE_SCORE,
  type JudgeProvider,
  type JudgeRequest,
  type JudgeResult,
} from './judge-provider.js'

const log = logger.child({ module: 'judge-acp' })

/** Env opt-in (default-OFF) for the LLM-as-a-Judge ruler — a HARD-STOP `copilot --acp` spawn. */
export const JUDGE_ENV = 'SCNS_LLM_JUDGE'
/** Env override for the judge model (default = the session model, i.e. no `--model` passed). */
export const JUDGE_MODEL_ENV = 'SCNS_JUDGE_MODEL'

/**
 * Default wall-clock budget for one grade. Grading {question, gold, candidate} is a small text turn, so
 * a 120 s ceiling absorbs cold-start (~3–5 s) + hosted latency variance with margin while keeping a
 * runaway spawn bounded. Tunable per call.
 */
export const DEFAULT_JUDGE_ATTEMPT_TIMEOUT_MS = 120_000

export function isJudgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[JUDGE_ENV]
  if (v === undefined) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

export interface AcpJudgeOptions {
  /** Isolated working dir for the ACP session — NEVER the live checkout. */
  readonly cwd: string
  /** Judge model. Omit for the session model (the R2 default); harness resolves `SCNS_JUDGE_MODEL`. */
  readonly model?: string
  readonly env?: Record<string, string>
  readonly initTimeoutMs?: number
  readonly promptTimeoutMs?: number
  /** Overall wall-clock guard. Default {@link DEFAULT_JUDGE_ATTEMPT_TIMEOUT_MS}. */
  readonly attemptTimeoutMs?: number
  /** Injectable client factory (CI-safe). Default {@link createAcpClient}. */
  readonly createClient?: (opts: AcpClientOptions) => AcpClient
  /** Override the deny-all policy (the judge keeps deny-all — think only). */
  readonly permissionPolicy?: AcpPermissionPolicy
}

/**
 * The real judge: ONE isolated, bounded, deny-all (think-only) Copilot ACP session that grades one
 * {question, gold, candidate} on the App C.3 rubric. The client factory is injectable so tests never
 * spawn a real process.
 */
export function createAcpJudge(opts: AcpJudgeOptions): JudgeProvider {
  if (!opts.cwd || opts.cwd.trim() === '') {
    throw new Error('createAcpJudge requires an isolated cwd (never the live checkout)')
  }
  const createClient = opts.createClient ?? createAcpClient
  const permissionPolicy = opts.permissionPolicy ?? createDenyAllPermissionPolicy()
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_JUDGE_ATTEMPT_TIMEOUT_MS

  return {
    async judge(req: JudgeRequest): Promise<JudgeResult> {
      const clientOpts: AcpClientOptions = {
        cwd: opts.cwd,
        allowAllTools: false,
        permissionPolicy,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.initTimeoutMs !== undefined ? { initTimeoutMs: opts.initTimeoutMs } : {}),
        ...(opts.promptTimeoutMs !== undefined ? { promptTimeoutMs: opts.promptTimeoutMs } : {}),
      }
      const prompt = `${SEMANTIC_GRADER_SYSTEM_PROMPT}\n\n${buildJudgeUserPrompt(req)}`
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
            () => reject(new Error(`judge timed out after ${attemptTimeoutMs}ms`)),
            attemptTimeoutMs,
          )
        })
        const raw = await Promise.race([run, timeout])
        return parseJudgeResponse(raw)
      } catch (err) {
        log.warn({ err: String(err) }, 'judge threw; scoring as null (do no harm — dropped from aggregation)')
        return { score: NULL_JUDGE_SCORE, reasoning: `judge error: ${String(err)}` }
      } finally {
        if (timer) clearTimeout(timer)
        await client.close().catch(() => {})
      }
    },
  }
}
