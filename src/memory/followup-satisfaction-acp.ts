/**
 * The follow-up satisfaction reader (transport) — ONE isolated, bounded, deny-all (think-only)
 * `copilot --acp` session that names the discourse relationship between a served query and the human's
 * next turn. Mirrors `gate-question-acp.ts` exactly:
 *   - ISOLATION: the session `cwd` is a caller-supplied isolated dir (required) — NEVER the live
 *     checkout. Classification reads only two message texts; it needs no repo access.
 *   - DENY-ALL: a deny-all permission policy forces a text-only turn — the reader can NEVER run a tool.
 *   - BOUNDED: a wall-clock `attemptTimeoutMs` races the round-trip; the client is ALWAYS `close()`d.
 *     Any spawn/timeout/parse failure degrades to `null` ⇒ ABSTAIN. A failure is never a label.
 *   - INJECTABLE: the client factory is injectable so unit tests never spawn a real process.
 *
 * Runs OFF the hot briefing path (fire-and-forget from the live wiring): an ACP spawn takes seconds and
 * the extension /context budget is ~1.5s. Settling is a write to a PRIOR row, so it is never on the
 * critical path of the response the human is waiting for.
 */

import { createAcpClient, createDenyAllPermissionPolicy } from '../broker/services/acp-client.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpPermissionPolicy,
} from '../broker/services/acp-client.js'
import { logger } from '../shared/logger.js'
import {
  buildFollowupPrompt,
  parseFollowupVerdict,
  FOLLOWUP_SYSTEM_PROMPT,
  type FollowupClassificationRequest,
  type FollowupSatisfactionProvider,
  type FollowupVerdict,
} from './followup-satisfaction.js'

const log = logger.child({ module: 'followup-satisfaction-acp' })

/** Default wall-clock budget for one classification round-trip (one deny-all, text-only turn). */
export const DEFAULT_FOLLOWUP_TIMEOUT_MS = 60_000

/**
 * A stable substring of {@link FOLLOWUP_SYSTEM_PROMPT} used as a RECURSION GUARD: the reader's own
 * worker prompt must never itself be read as a human turn if it reaches the live /context path.
 */
export const FOLLOWUP_WORKER_SIGNATURE = 'You are a conversation analyst'

export interface AcpFollowupOptions {
  /** Isolated working dir for the ACP session — NEVER the live checkout. */
  readonly cwd: string
  readonly model?: string
  readonly env?: Record<string, string>
  readonly initTimeoutMs?: number
  readonly promptTimeoutMs?: number
  /** Overall wall-clock guard. Default {@link DEFAULT_FOLLOWUP_TIMEOUT_MS}. */
  readonly attemptTimeoutMs?: number
  /** Injectable client factory (CI-safe). Default {@link createAcpClient}. */
  readonly createClient?: (opts: AcpClientOptions) => AcpClient
  /** Override the deny-all policy (the reader keeps deny-all — think only, never act). */
  readonly permissionPolicy?: AcpPermissionPolicy
}

/**
 * The real follow-up satisfaction provider. Fail-safe to `null` (ABSTAIN) on any error, so a transport
 * problem can never become a settled reward label.
 */
export function createAcpFollowupProvider(opts: AcpFollowupOptions): FollowupSatisfactionProvider {
  if (!opts.cwd || opts.cwd.trim() === '') {
    throw new Error('createAcpFollowupProvider requires an isolated cwd (never the live checkout)')
  }
  const createClient = opts.createClient ?? createAcpClient
  const permissionPolicy = opts.permissionPolicy ?? createDenyAllPermissionPolicy()
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_FOLLOWUP_TIMEOUT_MS

  return {
    async classify(req: FollowupClassificationRequest): Promise<FollowupVerdict | null> {
      if (!req.priorQuery?.trim() || !req.nextTurn?.trim()) return null
      const clientOpts: AcpClientOptions = {
        cwd: opts.cwd,
        allowAllTools: false,
        permissionPolicy,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.initTimeoutMs !== undefined ? { initTimeoutMs: opts.initTimeoutMs } : {}),
        ...(opts.promptTimeoutMs !== undefined ? { promptTimeoutMs: opts.promptTimeoutMs } : {}),
      }
      const prompt = `${FOLLOWUP_SYSTEM_PROMPT}\n\n${buildFollowupPrompt(req)}`
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
            () => reject(new Error(`followup classification timed out after ${attemptTimeoutMs}ms`)),
            attemptTimeoutMs,
          )
        })
        return parseFollowupVerdict(await Promise.race([run, timeout]))
      } catch (err) {
        log.warn({ err: String(err) }, 'followup reader threw; abstaining (a failure is never a label)')
        return null
      } finally {
        if (timer) clearTimeout(timer)
        await client.close().catch(() => {})
      }
    },
  }
}
