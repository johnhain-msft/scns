/**
 * SCNS selfopt — Phase 1 wedge: AcpReplayBackend (real-agent replay).
 *
 * A `ReplayBackend` that scores a candidate by running it through ONE isolated
 * Copilot ACP session instead of the deterministic `MockBackend`. `replayOne`
 * is unchanged: it calls `attempt()` for the agent's final text, then scores via
 * the recorded/rule judge. For `recorded` tasks the text is ignored (the judge
 * uses `recordedScore`), so those tasks exercise only the spawn path; `rule`
 * tasks are measured against the agent's real output.
 *
 * Design invariants:
 *   - ISOLATION: the ACP session `cwd` is a caller-supplied isolated worktree /
 *     temp dir (required) — NEVER the live checkout. `process.env` is inherited
 *     by the underlying client (real HOME for Copilot auth), but the working dir
 *     is isolated. This backend reads nothing from and writes nothing to the live
 *     repo or `.github/copilot-instructions.md`.
 *   - DEPENDENCY INJECTION: the client is built through an injectable factory
 *     (`createClient`, default `createAcpClient`). Unit tests inject a fake
 *     `AcpClient` so the suite never spawns a real `copilot` process.
 *   - ROBUSTNESS: a wall-clock `attemptTimeoutMs` guard races the ACP round-trip
 *     so a wedged client can't hang the gate; the client is ALWAYS `close()`d in
 *     a `finally`; infrastructure failures (spawn / timeout / rejected prompt)
 *     are THROWN (an empty "low score" would be indistinguishable from a real
 *     capability regression and would corrupt the non-regression gate).
 *
 * This wedge changes ZERO default wiring: `MockBackend` stays the default in
 * baseline/staging/gated paths, and nothing here is wired into the dream daemon
 * or any live path.
 */
import { createAcpClient } from '../broker/services/acp-client.js'
import type { AcpClient, AcpClientOptions } from '../broker/services/acp-client.js'
import type { ReplayBackend } from './replay.js'
import type { TaskRecord } from './types.js'

/** Default wall-clock budget for one {@link AcpReplayBackend.attempt}. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 300_000

/**
 * The injected-guidance channel. Either a FIXED string (the wedge-A guidance case —
 * same `# Guidance` block for every task) or a per-task RESOLVER. The resolver lets
 * the injected context depend on the task (e.g. THE BRIDGE: run the real retrieval
 * path for the task's query and inject the retrieved memory), so the asymmetry can
 * measure MAGMA retrieval quality, not just a static guidance diff. A resolver may
 * be async (retrieval does I/O). `undefined` ⇒ the merge is a no-op (unchanged).
 */
export type InjectedMemoryProvider =
  | string
  | ((task: TaskRecord) => string | Promise<string>)

export interface AcpReplayBackendOptions {
  /** Isolated working dir for the ACP session — NEVER the live checkout. */
  readonly cwd: string
  /** Injectable client factory (CI-safe). Default {@link createAcpClient}. */
  readonly createClient?: (opts: AcpClientOptions) => AcpClient
  /** Extra env merged over `process.env` by the client. Optional. */
  readonly env?: Record<string, string>
  /** Model override forwarded to the client. */
  readonly model?: string
  /** ACP `initialize` timeout (ms), forwarded to the client. */
  readonly initTimeoutMs?: number
  /** ACP `session/prompt` timeout (ms), forwarded to the client. */
  readonly promptTimeoutMs?: number
  /** Overall wall-clock guard for one attempt. Default {@link DEFAULT_ATTEMPT_TIMEOUT_MS}. */
  readonly attemptTimeoutMs?: number
  /** Spawn the agent with `--allow-all-tools`. Default false (conservative). */
  readonly allowAllTools?: boolean
  /**
   * Fixed guidance prepended to every attempt's `memory` section (the `# Guidance`
   * block of {@link buildReplayPrompt}). This is the channel that makes a
   * deny-all backend pair ASYMMETRIC: a baseline backend carrying HEAD's guidance
   * and a candidate backend carrying the post-diff guidance produce genuinely
   * different agent responses the rule judges can score — the only real signal
   * once tools are denied (the cwd contents are invisible to the agent). When
   * undefined the merge is a no-op, so `attempt` is byte-for-byte unchanged.
   *
   * May also be a per-task RESOLVER ({@link InjectedMemoryProvider}) so the
   * injected context can depend on the task — THE BRIDGE injects the result of
   * running the real retrieval path for the task's query, turning the gate into a
   * MAGMA-retrieval-quality meter (baseline = HEAD retrieval, candidate = the
   * candidate's retrieval over the SAME vault).
   */
  readonly injectedMemory?: InjectedMemoryProvider
}

/** Merge fixed (construction-time) guidance with a per-attempt memory string. */
function mergeMemory(injected: string | undefined, perAttempt: string): string {
  return [injected, perAttempt]
    .map((s) => (s ?? '').trim())
    .filter((s) => s !== '')
    .join('\n\n')
}

/** Build the replay prompt from the candidate artifact + the task. */
export function buildReplayPrompt(task: TaskRecord, skill: string, memory: string): string {
  const sections: string[] = []
  if (skill.trim() !== '') sections.push(`# Skill\n${skill.trim()}`)
  if (memory.trim() !== '') sections.push(`# Guidance\n${memory.trim()}`)
  sections.push(`# Task\n${task.intent.trim()}`)
  if (task.contextExcerpt.trim() !== '') sections.push(`# Context\n${task.contextExcerpt.trim()}`)
  return sections.join('\n\n')
}

/**
 * A `ReplayBackend` backed by a real, isolated Copilot ACP session.
 */
export class AcpReplayBackend implements ReplayBackend {
  /** Resolved client factory — exposed so callers/tests can assert the wiring. */
  readonly createClient: (opts: AcpClientOptions) => AcpClient

  private readonly cwd: string
  private readonly env: Record<string, string> | undefined
  private readonly model: string | undefined
  private readonly initTimeoutMs: number | undefined
  private readonly promptTimeoutMs: number | undefined
  private readonly attemptTimeoutMs: number
  private readonly allowAllTools: boolean
  private readonly injectedMemory: InjectedMemoryProvider | undefined

  constructor(opts: AcpReplayBackendOptions) {
    if (!opts.cwd || opts.cwd.trim() === '') {
      throw new Error('AcpReplayBackend requires an isolated cwd (never the live checkout)')
    }
    this.cwd = opts.cwd
    this.createClient = opts.createClient ?? createAcpClient
    this.env = opts.env
    this.model = opts.model
    this.initTimeoutMs = opts.initTimeoutMs
    this.promptTimeoutMs = opts.promptTimeoutMs
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS
    this.allowAllTools = opts.allowAllTools ?? false
    this.injectedMemory = opts.injectedMemory
  }

  /**
   * Run one task through an isolated ACP session and return the agent's final
   * text. The client is always closed; spawn / timeout / prompt failures throw.
   */
  async attempt(task: TaskRecord, skill: string, memory: string): Promise<string> {
    // Resolve the injected guidance for THIS task (a fixed string, or the per-task
    // resolver THE BRIDGE uses to inject retrieved memory for the task's query).
    const injected =
      typeof this.injectedMemory === 'function'
        ? await this.injectedMemory(task)
        : this.injectedMemory
    const prompt = buildReplayPrompt(task, skill, mergeMemory(injected, memory))

    const clientOpts: AcpClientOptions = {
      cwd: this.cwd,
      allowAllTools: this.allowAllTools,
      ...(this.env ? { env: this.env } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.initTimeoutMs !== undefined ? { initTimeoutMs: this.initTimeoutMs } : {}),
      ...(this.promptTimeoutMs !== undefined ? { promptTimeoutMs: this.promptTimeoutMs } : {}),
    }

    const client = this.createClient(clientOpts)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const run = (async (): Promise<string> => {
        await client.initialize()
        const sessionId = await client.createSession(this.cwd)
        const result = await client.sendPrompt(sessionId, prompt)
        return result.output
      })()

      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `AcpReplayBackend.attempt timed out after ${this.attemptTimeoutMs}ms (task ${task.id})`,
              ),
            ),
          this.attemptTimeoutMs,
        )
      })

      return await Promise.race([run, timeout])
    } finally {
      if (timer) clearTimeout(timer)
      await client.close().catch(() => {})
    }
  }
}
