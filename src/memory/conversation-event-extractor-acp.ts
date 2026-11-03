/**
 * WS-2 Phase B3 — real ACP conversation event extractor (env-gated; a HARD-STOP `copilot --acp` spawn).
 *
 * The production transport for {@link ConversationEventExtractor}: ONE isolated, bounded, deny-all
 * (think-only) Copilot ACP session that reads one conversation SESSION (its speakers + turns) and
 * returns parsed decision→observation→outcome events. Mirrors `createAcpFactExtractor` /
 * `createAcpCausalProvider` exactly:
 *   - ISOLATION: the session `cwd` is a caller-supplied isolated dir (required) — NEVER the live
 *     checkout. The extractor reads nothing from and writes nothing to the repo.
 *   - DENY-ALL: a deny-all permission policy forces a text-only turn — the agent can NEVER run a
 *     tool (e.g. `npm install` + the full vitest suite) and blow the timeout.
 *   - BOUNDED: a wall-clock `attemptTimeoutMs` guard races the round-trip; the client is ALWAYS
 *     `close()`d in a `finally`. Any spawn/timeout/parse failure degrades to "no events" (do no
 *     harm: a failed extraction skips enrichment, never corrupts the index).
 *   - INJECTABLE: the client factory is injectable so unit tests never spawn a real process.
 *
 * Default-OFF: nothing here runs unless a caller explicitly constructs the provider (the measurement
 * harness does so only when `SCNS_CONVERSATION_EVENTS` is truthy AND it owns the spawn).
 */

import { createAcpClient, createDenyAllPermissionPolicy } from '../broker/services/acp-client.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpPermissionPolicy,
} from '../broker/services/acp-client.js'
import { logger } from '../shared/logger.js'
import {
  buildConversationEventUserPrompt,
  parseConversationEventResponse,
  CONVERSATION_EVENT_SYSTEM_PROMPT,
  type ConversationEpisodeInput,
  type ConversationEventExtractor,
  type ExtractedConversationEvent,
} from './conversation-event-extractor.js'

const log = logger.child({ module: 'conversation-event-extractor-acp' })

/** Env opt-in (default-OFF) for conversation event extraction — a HARD-STOP `copilot --acp` spawn. */
export const CONVERSATION_EVENT_ACP_ENV = 'SCNS_CONVERSATION_EVENTS'

/** Default wall-clock budget for one session's extraction round-trip (aligned with fact extraction). */
export const DEFAULT_CONVERSATION_EVENT_ATTEMPT_TIMEOUT_MS = 240_000

export function isConversationEventExtractEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env[CONVERSATION_EVENT_ACP_ENV]
  if (v === undefined) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

export interface AcpConversationEventExtractorOptions {
  /** Isolated working dir for the ACP session — NEVER the live checkout. */
  readonly cwd: string
  readonly model?: string
  readonly env?: Record<string, string>
  readonly initTimeoutMs?: number
  readonly promptTimeoutMs?: number
  /** Overall wall-clock guard. Default {@link DEFAULT_CONVERSATION_EVENT_ATTEMPT_TIMEOUT_MS}. */
  readonly attemptTimeoutMs?: number
  /** Injectable client factory (CI-safe). Default {@link createAcpClient}. */
  readonly createClient?: (opts: AcpClientOptions) => AcpClient
  /** Override the deny-all policy (extraction keeps deny-all — think only). */
  readonly permissionPolicy?: AcpPermissionPolicy
}

/**
 * The real conversation event extractor: ONE isolated, bounded, deny-all Copilot ACP session per
 * conversation session. The client factory is injectable so tests never spawn a real process.
 */
export function createAcpConversationEventExtractor(
  opts: AcpConversationEventExtractorOptions,
): ConversationEventExtractor {
  if (!opts.cwd || opts.cwd.trim() === '') {
    throw new Error(
      'createAcpConversationEventExtractor requires an isolated cwd (never the live checkout)',
    )
  }
  const createClient = opts.createClient ?? createAcpClient
  const permissionPolicy = opts.permissionPolicy ?? createDenyAllPermissionPolicy()
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_CONVERSATION_EVENT_ATTEMPT_TIMEOUT_MS

  return {
    async extract(episode: ConversationEpisodeInput): Promise<readonly ExtractedConversationEvent[]> {
      if (episode.turns.length === 0) return []
      const clientOpts: AcpClientOptions = {
        cwd: opts.cwd,
        allowAllTools: false,
        permissionPolicy,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.initTimeoutMs !== undefined ? { initTimeoutMs: opts.initTimeoutMs } : {}),
        ...(opts.promptTimeoutMs !== undefined ? { promptTimeoutMs: opts.promptTimeoutMs } : {}),
      }
      const prompt = `${CONVERSATION_EVENT_SYSTEM_PROMPT}\n\n${buildConversationEventUserPrompt(episode)}`
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
            () => reject(new Error(`conversation event extraction timed out after ${attemptTimeoutMs}ms`)),
            attemptTimeoutMs,
          )
        })
        const raw = await Promise.race([run, timeout])
        return parseConversationEventResponse(raw)
      } catch (err) {
        log.warn({ err: String(err) }, 'conversation event extractor threw; extracting no events (do no harm)')
        return []
      } finally {
        if (timer) clearTimeout(timer)
        await client.close().catch(() => {})
      }
    },
  }
}
