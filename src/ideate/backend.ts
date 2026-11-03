/**
 * D1 — the default ideation backend: ONE isolated, bounded, text-only Copilot
 * ACP session that returns the agent's raw response for parsing.
 *
 * Safety hardening (identical recipe to wedge C's gated negative-memory writer):
 *   - ISOLATION: the session `cwd` is a caller-supplied isolated dir, NEVER the
 *     live checkout. The backend reads/writes nothing in the real repo.
 *   - DENY-ALL: a {@link createDenyAllPermissionPolicy} default + `allowAllTools:false`
 *     means the agent can NEVER run a command or edit a file — it can only think
 *     and answer. (User-confirmed D1 isolation model: all signals are injected
 *     into the prompt; the agent does not explore.)
 *   - BOUNDED: a wall-clock guard races the round-trip so a wedged client can't
 *     hang the caller; the client is ALWAYS `close()`d in a `finally`.
 *   - FAIL-LOUD: spawn / timeout / prompt failures THROW (an empty string would
 *     be indistinguishable from "the agent had no ideas").
 *
 * The client factory is injectable so unit tests never spawn a real process.
 */

import { createAcpClient, createDenyAllPermissionPolicy } from '../broker/services/acp-client.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpPermissionPolicy,
  AcpPermissionLogEntry,
} from '../broker/services/acp-client.js'

/** Default wall-clock budget for one ideation round-trip. */
export const DEFAULT_IDEATION_ATTEMPT_TIMEOUT_MS = 180_000

/** A pluggable ideation engine: prompt in, raw agent text out. */
export interface IdeationBackend {
  ideate(prompt: string): Promise<string>
}

export interface DefaultIdeationBackendOptions {
  /** Isolated working dir for the ACP session — NEVER the live checkout. */
  readonly cwd: string
  readonly model?: string
  readonly env?: Record<string, string>
  readonly initTimeoutMs?: number
  readonly promptTimeoutMs?: number
  /** Overall wall-clock guard. Default {@link DEFAULT_IDEATION_ATTEMPT_TIMEOUT_MS}. */
  readonly attemptTimeoutMs?: number
  /** Injectable client factory (CI-safe). Default {@link createAcpClient}. */
  readonly createClient?: (opts: AcpClientOptions) => AcpClient
  /** Override the default deny-all policy (e.g. read-only) — D1 keeps deny-all. */
  readonly permissionPolicy?: AcpPermissionPolicy
  readonly onPermissionDecision?: (entry: AcpPermissionLogEntry) => void
}

export function createDefaultIdeationBackend(
  opts: DefaultIdeationBackendOptions,
): IdeationBackend {
  if (!opts.cwd || opts.cwd.trim() === '') {
    throw new Error(
      'createDefaultIdeationBackend requires an isolated cwd (never the live checkout)',
    )
  }
  const createClient = opts.createClient ?? createAcpClient
  const permissionPolicy = opts.permissionPolicy ?? createDenyAllPermissionPolicy()
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_IDEATION_ATTEMPT_TIMEOUT_MS

  return {
    async ideate(prompt: string): Promise<string> {
      const clientOpts: AcpClientOptions = {
        cwd: opts.cwd,
        allowAllTools: false,
        permissionPolicy,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.initTimeoutMs !== undefined ? { initTimeoutMs: opts.initTimeoutMs } : {}),
        ...(opts.promptTimeoutMs !== undefined ? { promptTimeoutMs: opts.promptTimeoutMs } : {}),
        ...(opts.onPermissionDecision ? { onPermissionDecision: opts.onPermissionDecision } : {}),
      }

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
            () => reject(new Error(`ideation attempt timed out after ${attemptTimeoutMs}ms`)),
            attemptTimeoutMs,
          )
        })

        return await Promise.race([run, timeout])
      } finally {
        if (timer) clearTimeout(timer)
        await client.close().catch(() => {})
      }
    },
  }
}
