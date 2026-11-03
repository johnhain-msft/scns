/**
 * Transport for proposal triage — ONE isolated, bounded, deny-all `copilot --acp` session.
 *
 * Mirrors `gate-question-acp.ts` exactly (isolated cwd, deny-all so the turn is text-only, wall-clock
 * bounded, injectable client factory). Two jobs, deliberately separate:
 *
 *   - {@link createAcpOverlapChecker} answers the NEUTRAL overlap question. It is asked before any
 *     prose exists and is never told which answer is wanted.
 *   - {@link createAcpElaborationWriter} writes the "what it would do" paragraph — and is only ever
 *     called for a proposal already established as non-duplicate. That ordering is the whole point:
 *     a model asked to justify uniqueness will produce a justification whether or not one is true.
 *
 * Both fail SAFE: any spawn/timeout/parse failure degrades to unverified/no-prose. A transport
 * outage must never auto-reject a proposal or invent a novelty claim.
 */

import { createAcpClient, createDenyAllPermissionPolicy } from '../broker/services/acp-client.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpPermissionPolicy,
} from '../broker/services/acp-client.js'
import { logger } from '../shared/logger.js'
import type { NeutralOverlapChecker } from './proposal-triage.js'
import type { ElaborationWriter } from './proposal-triage-run.js'
import type { Suggestion } from './types.js'

const log = logger.child({ module: 'proposal-triage-acp' })

export const DEFAULT_TRIAGE_TIMEOUT_MS = 60_000

export interface AcpTriageOptions {
  /** Isolated working dir for the ACP session — NEVER the live checkout. */
  readonly cwd: string
  readonly model?: string
  readonly env?: Record<string, string>
  readonly initTimeoutMs?: number
  readonly promptTimeoutMs?: number
  readonly attemptTimeoutMs?: number
  /** Injectable client factory (CI-safe). Default {@link createAcpClient}. */
  readonly createClient?: (opts: AcpClientOptions) => AcpClient
  readonly permissionPolicy?: AcpPermissionPolicy
}

async function askOnce(opts: AcpTriageOptions, prompt: string, label: string): Promise<string> {
  const createClient = opts.createClient ?? createAcpClient
  const permissionPolicy = opts.permissionPolicy ?? createDenyAllPermissionPolicy()
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_TRIAGE_TIMEOUT_MS
  const clientOpts: AcpClientOptions = {
    cwd: opts.cwd,
    allowAllTools: false,
    permissionPolicy,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.initTimeoutMs !== undefined ? { initTimeoutMs: opts.initTimeoutMs } : {}),
    ...(opts.promptTimeoutMs !== undefined ? { promptTimeoutMs: opts.promptTimeoutMs } : {}),
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
        () => reject(new Error(`${label} timed out after ${attemptTimeoutMs}ms`)),
        attemptTimeoutMs,
      )
    })
    return await Promise.race([run, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    await client.close().catch(() => {})
  }
}

/** Answers the neutral overlap question. Throws on failure so triage records `unverified`. */
export function createAcpOverlapChecker(opts: AcpTriageOptions): NeutralOverlapChecker {
  if (!opts.cwd || opts.cwd.trim() === '') {
    throw new Error('createAcpOverlapChecker requires an isolated cwd (never the live checkout)')
  }
  return async (question: string): Promise<string> => askOnce(opts, question, 'overlap check')
}

const ELABORATION_PROMPT = [
  'Describe, in at most three sentences, what the following proposed capability would DO once built.',
  'Write plainly for someone deciding whether to approve it.',
  'State the concrete behaviour and when it would trigger. Do not argue for it, do not praise it,',
  'and do not claim it is novel or unique — that has already been decided elsewhere.',
  'Reply with the description only.',
].join('\n')

/** Writes the "what it would do" paragraph. Degrades to '' — the skeleton stands without it. */
export function createAcpElaborationWriter(opts: AcpTriageOptions): ElaborationWriter {
  if (!opts.cwd || opts.cwd.trim() === '') {
    throw new Error('createAcpElaborationWriter requires an isolated cwd (never the live checkout)')
  }
  return async (suggestion: Suggestion): Promise<string> => {
    const prompt = [
      ELABORATION_PROMPT,
      '',
      `TITLE: ${suggestion.title}`,
      `TYPE: ${suggestion.type}`,
      `OBSERVED PATTERN: ${suggestion.description}`,
    ].join('\n')
    try {
      const raw = await askOnce(opts, prompt, 'elaboration')
      return typeof raw === 'string' ? raw.trim().slice(0, 800) : ''
    } catch (err) {
      log.warn({ err: String(err) }, 'elaboration failed; falling back to the skeleton spec')
      return ''
    }
  }
}
