/**
 * GATE Part B (transport) — the real clarifying-question generator: ONE isolated, bounded, deny-all
 * (think-only) `copilot --acp` session that reads the under-specified prompt and returns a single
 * informative clarifying question. Mirrors `fact-extractor-acp.ts` / `createAcpCausalProvider` exactly:
 *   - ISOLATION: the session `cwd` is a caller-supplied isolated dir (required) — NEVER the live
 *     checkout. Question generation reads ONLY the prompt text; it needs no repo access.
 *   - DENY-ALL: a deny-all permission policy forces a text-only turn — the agent can NEVER run a tool
 *     (no `npm install` + vitest blowing the budget). Elicitation is inference-only.
 *   - BOUNDED: a wall-clock `attemptTimeoutMs` races the round-trip; the client is ALWAYS `close()`d.
 *     Any spawn/timeout/parse failure degrades to '' (do no harm — a failed ask never breaks the
 *     briefing, it just skips the clarifying question).
 *   - INJECTABLE: the client factory is injectable so unit tests never spawn a real process.
 *
 * The generation is designed to run OFF the hot briefing path (fire-and-forget from the live wiring),
 * because an ACP spawn takes seconds and the extension /context budget is ~1.5s.
 */

import { createAcpClient, createDenyAllPermissionPolicy } from '../broker/services/acp-client.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpPermissionPolicy,
} from '../broker/services/acp-client.js'
import { logger } from '../shared/logger.js'
import {
  buildClarifyingQuestionPrompt,
  parseClarifyingQuestion,
  GATE_QUESTION_SYSTEM_PROMPT,
  type ClarifyingQuestionRequest,
  type GateQuestionProvider,
} from './gate-question.js'

const log = logger.child({ module: 'gate-question-acp' })

/**
 * Default wall-clock budget for one clarifying-question round-trip. A single deny-all text-only turn is
 * far cheaper than fact extraction over a batch, but a `copilot --acp` spawn still has multi-second
 * startup; 60s absorbs the variance while keeping a bounded ceiling (fire-and-forget, never on the hot path).
 */
export const DEFAULT_GATE_QUESTION_TIMEOUT_MS = 60_000

export interface AcpGateQuestionOptions {
  /** Isolated working dir for the ACP session — NEVER the live checkout. */
  readonly cwd: string
  readonly model?: string
  readonly env?: Record<string, string>
  readonly initTimeoutMs?: number
  readonly promptTimeoutMs?: number
  /** Overall wall-clock guard. Default {@link DEFAULT_GATE_QUESTION_TIMEOUT_MS}. */
  readonly attemptTimeoutMs?: number
  /** Injectable client factory (CI-safe). Default {@link createAcpClient}. */
  readonly createClient?: (opts: AcpClientOptions) => AcpClient
  /** Override the deny-all policy (elicitation keeps deny-all — think only, never act). */
  readonly permissionPolicy?: AcpPermissionPolicy
}

/**
 * The real GATE question provider: ONE isolated, bounded, deny-all Copilot ACP session that generates a
 * single informative clarifying question. Fail-safe to '' on any error. The client factory is injectable
 * so tests never spawn a real process.
 */
export function createAcpGateQuestionProvider(opts: AcpGateQuestionOptions): GateQuestionProvider {
  if (!opts.cwd || opts.cwd.trim() === '') {
    throw new Error('createAcpGateQuestionProvider requires an isolated cwd (never the live checkout)')
  }
  const createClient = opts.createClient ?? createAcpClient
  const permissionPolicy = opts.permissionPolicy ?? createDenyAllPermissionPolicy()
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_GATE_QUESTION_TIMEOUT_MS

  return {
    async generate(req: ClarifyingQuestionRequest): Promise<string> {
      if (!req.taskDescription || req.taskDescription.trim() === '') return ''
      const clientOpts: AcpClientOptions = {
        cwd: opts.cwd,
        allowAllTools: false,
        permissionPolicy,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.initTimeoutMs !== undefined ? { initTimeoutMs: opts.initTimeoutMs } : {}),
        ...(opts.promptTimeoutMs !== undefined ? { promptTimeoutMs: opts.promptTimeoutMs } : {}),
      }
      const prompt = `${GATE_QUESTION_SYSTEM_PROMPT}\n\n${buildClarifyingQuestionPrompt(req)}`
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
            () => reject(new Error(`gate question timed out after ${attemptTimeoutMs}ms`)),
            attemptTimeoutMs,
          )
        })
        const raw = await Promise.race([run, timeout])
        return parseClarifyingQuestion(raw)
      } catch (err) {
        log.warn({ err: String(err) }, 'gate question generator threw; asking nothing (do no harm)')
        return ''
      } finally {
        if (timer) clearTimeout(timer)
        await client.close().catch(() => {})
      }
    },
  }
}
