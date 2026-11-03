import { ChildProcess, spawn as nodeSpawn, spawnSync } from 'node:child_process'
import type { SpawnOptionsWithoutStdio } from 'node:child_process'
import { createInterface } from 'node:readline'
import { logger } from '../../shared/logger.js'
import type { AcpSessionStateType } from '../types.js'

// ── Error types ──────────────────────────────────────────────────────────

export class AcpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpError'
  }
}

export class AcpTimeoutError extends AcpError {
  constructor(method: string, timeoutMs: number) {
    super(`ACP ${method} timed out after ${timeoutMs}ms`)
    this.name = 'AcpTimeoutError'
  }
}

export class AcpBusyError extends AcpError {
  constructor(sessionId: string) {
    super(`ACP session ${sessionId} is already processing a prompt`)
    this.name = 'AcpBusyError'
  }
}

export class AcpNotReadyError extends AcpError {
  constructor() {
    super('ACP client is not initialized — call initialize() first')
    this.name = 'AcpNotReadyError'
  }
}

// ── Types ────────────────────────────────────────────────────────────────

export interface AcpInitResult {
  readonly protocolVersion: number
  readonly agentCapabilities: Record<string, unknown>
  readonly agentInfo: { name: string; version: string }
}

/**
 * Phase 1.5 step 5 — cold-start timing probe. Captures `Date.now()` epoch
 * marks at four observable points in the ACP bootstrap so callers can
 * measure where the typical 3–5s cold-start cost actually lives. Used by
 * agent-spawner to emit the `agent_acp_timing` event after each successful
 * spawn, and (eventually) by an `AcpPool` service to decide what to warm.
 *
 * Semantics:
 *   - `processSpawnStartedAt` — set inside `initialize()` *immediately
 *     before* the `copilot --acp` subprocess is spawned. Becomes non-null
 *     once spawn has been attempted, regardless of outcome.
 *   - `initializeResolvedAt`  — set inside `initialize()` *after* the
 *     `initialize` JSON-RPC round-trip resolves and the client state
 *     transitions to `'ready'`. The delta `initializeResolvedAt -
 *     processSpawnStartedAt` measures process-spawn + Node bootstrap +
 *     Copilot CLI startup + initialize RPC latency.
 *   - `sessionNewStartedAt`   — set inside `createSession()` *before* the
 *     `session/new` request is sent.
 *   - `sessionNewResolvedAt`  — set inside `createSession()` *after* the
 *     `session/new` response resolves. The delta `sessionNewResolvedAt -
 *     sessionNewStartedAt` measures session/new + the bootstrap stream
 *     (twin `available_commands_update` fires, MCP registration, etc).
 *
 * All marks are `null` until set; once set, they persist until the next
 * call to the corresponding method (`initialize()` resets the initialize
 * marks; `createSession()` resets the session/new marks). This means
 * repeated calls reflect the most recent attempt — which matches the
 * single-session usage in `agent-spawner.ts`.
 */
export interface AcpClientTimings {
  readonly processSpawnStartedAt: number | null
  readonly initializeResolvedAt: number | null
  readonly sessionNewStartedAt: number | null
  readonly sessionNewResolvedAt: number | null
}

export interface AcpPromptResult {
  readonly stopReason: string
  readonly output: string
}

export interface AcpSessionUpdate {
  readonly sessionId: string
  readonly update: {
    readonly sessionUpdate: string
    // `content` is only present on chunk-style updates (`agent_message_chunk`,
    // `user_message_chunk`, `agent_thought_chunk`). Other update kinds —
    // `available_commands_update`, `tool_call`, `tool_call_update`,
    // `config_option_update`, etc. — carry different shapes. Keep this
    // optional so handlers can defensively narrow by `sessionUpdate`.
    readonly content?: { readonly type: string; readonly text: string }
    // Pass-through for kind-specific fields (availableCommands, toolCallId,
    // status, rawInput, etc.) — handlers narrow on `sessionUpdate`.
    readonly [key: string]: unknown
  }
}

/**
 * Single entry in `available_commands_update.availableCommands`. Carries
 * Copilot CLI slash commands and skills (e.g., `commit`, `handoff`,
 * `quality-gate`). Phase 1.5 step-2 probe confirmed that broker MCP tools
 * do NOT appear here — they only surface as `tool_call` notifications
 * (namespaced `<server-name>-<tool-name>`) when actually invoked.
 */
export interface AcpAvailableCommand {
  readonly name: string
  readonly description?: string
  readonly input?: {
    readonly hint?: string
    readonly required?: boolean
    readonly completion?: string
    readonly preserveMultilineInput?: boolean
  }
}

export interface AcpMcpServer {
  readonly name: string
  /**
   * Transport type. Copilot CLI accepts `'http'` for HTTP-based MCP servers
   * (and `'sse'` for SSE), and validates this discriminator strictly — passing
   * a server without `type` returns JSON-RPC -32602 "Invalid params". The
   * broker's session-broker MCP runs as HTTP, so default to `'http'`.
   */
  readonly type: 'http' | 'sse'
  /** Endpoint URL (e.g., `http://localhost:3456/mcp`). */
  readonly url: string
  /**
   * Optional HTTP headers to attach on each tool invocation. Required by
   * Copilot CLI's params schema — must be present, may be empty.
   */
  readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>
}

// ── Permission handling (Phase 13.12.21) ─────────────────────────────────
//
// Per ACP spec (https://agentclientprotocol.com/protocol/tool-calls#requesting-permission)
// the agent MAY call session/request_permission before executing a tool. Our
// client must answer this RPC or the agent stalls. The policy below lets the
// caller customize which tool kinds get auto-approved.

export interface AcpPermissionOption {
  readonly optionId: string
  /** Per spec: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' */
  readonly kind: string
  readonly name?: string
}

export interface AcpToolCall {
  readonly toolCallId?: string
  readonly title?: string
  readonly kind?: string
  readonly status?: string
  readonly content?: unknown
  readonly rawInput?: unknown
}

export interface AcpRequestPermissionParams {
  readonly sessionId: string
  readonly toolCall: AcpToolCall
  readonly options: ReadonlyArray<AcpPermissionOption>
}

export type AcpPermissionOutcome =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' }

export interface AcpPermissionPolicy {
  decide(params: AcpRequestPermissionParams): AcpPermissionOutcome
}

/** Tool kinds that are auto-approved by the default policy. */
const DEFAULT_SAFE_KINDS: ReadonlySet<string> = new Set([
  'read',
  'edit',
  'execute',
  'search',
  'fetch',
  'think',
  'other',
])

/** Tool kinds the default policy refuses unless SCNS_ACP_ALLOW_DESTRUCTIVE=1. */
const DESTRUCTIVE_KINDS: ReadonlySet<string> = new Set(['delete', 'move'])

/**
 * Default allow-always-safe-kinds policy. Matches the SAFE set against the
 * incoming tool call, picks the first `allow_always` option if offered,
 * otherwise the first option whose kind starts with `allow_`, otherwise
 * falls back to a `reject_*` option or 'cancelled'.
 */
export function createDefaultPermissionPolicy(options?: {
  readonly allowDestructive?: boolean
}): AcpPermissionPolicy {
  const allowDestructive = options?.allowDestructive ?? false
  return {
    decide(params) {
      const kind = params.toolCall.kind ?? 'other'
      const isDestructive = DESTRUCTIVE_KINDS.has(kind)
      const isSafe = DEFAULT_SAFE_KINDS.has(kind)
      const shouldAllow = isSafe || (isDestructive && allowDestructive)

      if (shouldAllow) {
        const preferred =
          params.options.find((o) => o.kind === 'allow_always') ??
          params.options.find((o) => o.kind.startsWith('allow_'))
        if (preferred) return { outcome: 'selected', optionId: preferred.optionId }
      }
      // Fall through: reject if we have a reject_* option, else cancel.
      const reject =
        params.options.find((o) => o.kind === 'reject_once') ??
        params.options.find((o) => o.kind.startsWith('reject_'))
      if (reject) return { outcome: 'selected', optionId: reject.optionId }
      return { outcome: 'cancelled' }
    },
  }
}

/**
 * Deny-all permission policy: refuses EVERY tool-permission request (selects a
 * `reject_*` option if the agent offers one, else cancels). Forces a bounded,
 * text-only agent turn. Used by the gated negative-memory live writer
 * (`defaultMakeBackend`) so the autonomous daily self-edit agent can NEVER run
 * commands (e.g. `npm install` / the full vitest suite) in its throwaway worktree —
 * the failure mode observed in wedge C phase-c attempt 1 — and the gate only ever
 * judges the agent's plain-text response.
 */
export function createDenyAllPermissionPolicy(): AcpPermissionPolicy {
  return {
    decide(params) {
      const reject =
        params.options.find((o) => o.kind === 'reject_once') ??
        params.options.find((o) => o.kind.startsWith('reject_'))
      return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' }
    },
  }
}

/** Callback invoked after a permission decision, for structured logging. */
export interface AcpPermissionLogEntry {
  readonly timestamp: string
  readonly sessionId: string
  readonly toolCallId: string | null
  readonly title: string | null
  readonly kind: string | null
  readonly decision: AcpPermissionOutcome
}

export interface AcpClientOptions {
  readonly cwd?: string
  readonly model?: string
  readonly env?: Record<string, string>
  readonly initTimeoutMs?: number
  readonly promptTimeoutMs?: number
  readonly spawnFn?: typeof nodeSpawn
  /**
   * Reap the spawned ACP process tree on close() before SIGTERM. Defaults to
   * {@link killWindowsProcessTree} for real OS ChildProcess instances.
   */
  readonly killProcessTree?: (pid: number) => void
  /** Fires once when the underlying ACP process exits for any reason (including external kill). */
  readonly onProcessExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void
  /**
   * Policy for answering session/request_permission RPCs. If unset, defaults
   * to allow-safe-kinds (see createDefaultPermissionPolicy).
   */
  readonly permissionPolicy?: AcpPermissionPolicy
  /** Called after each permission decision with structured info (for JSONL log capture). */
  readonly onPermissionDecision?: (entry: AcpPermissionLogEntry) => void
  /**
   * T057 [US5] (specs/001-learning-memory-loop) — ASYNC human-in-the-loop permission path. When
   * set, `session/request_permission` is answered by the HUMAN through this channel instead of the
   * synchronous policy: the request stays PENDING until the promise settles; a rejection fails safe
   * to `cancelled`; `cancelSession()` resolves every pending request with `cancelled` first (the
   * ACP contract). Every exchange still flows through `onPermissionDecision` for the audit trail.
   */
  readonly humanPermission?: (params: AcpRequestPermissionParams) => Promise<AcpPermissionOutcome>
  /**
   * Phase 1.5 step 3 — how long `close()` waits for the agent to ack an
   * outstanding prompt with `stopReason:'cancelled'` (after sending
   * `session/cancel`) before falling through to SIGTERM. Default 2000ms.
   * Set to 0 to skip the graceful phase entirely. Per ACP spec
   * (https://agentclientprotocol.com/protocol/prompt-turn#cancellation),
   * a cooperating agent responds quickly — most of the window goes to
   * letting the agent flush its in-flight tool call + per-session JSONL.
   */
  readonly closeGraceMs?: number
  /**
   * Phase 1.5 step 4 — when true, spawn the Copilot CLI with the
   * `--allow-all-tools` flag, which suppresses all
   * `session/request_permission` RPCs (operator-less autonomy).
   *
   * Empirically verified (probe 2026-05-26, session
   * 7b985363-81c3-4d58-a749-3e1e85f940a5) on Copilot CLI 1.0.54: under
   * `--acp`, the ACP-level session-mode RPCs (`session/set_mode`,
   * `session/set_config_option`, `currentModeId` in `session/new`) are all
   * blocked or silently ignored, but `--allow-all-tools` as a process
   * arg suppresses every permission RPC on destructive operations. This
   * matches the documented semantic of the agent's Autopilot mode
   * ("Autonomous mode that enables allow-all and runs until task
   * completion") which is otherwise unreachable from ACP.
   *
   * Default false (gated by operator). Set to true for roles that need
   * full autonomy (e.g., scns-dev, scns-qa); leave false for orchestrator
   * roles that should plan, not act unilaterally (scns-manager).
   *
   * Note: this deliberately does NOT pass `--allow-all-paths` — the
   * worktree boundary (per Phase 13.12.x team-worktree-manager) remains
   * the isolation mechanism, and we want dev/qa unable to read files
   * outside their assigned worktree.
   */
  readonly allowAllTools?: boolean
}

export interface AcpClient {
  initialize(): Promise<AcpInitResult>
  createSession(cwd: string, mcpServers?: AcpMcpServer[]): Promise<string>
  sendPrompt(sessionId: string, prompt: string): Promise<AcpPromptResult>
  onUpdate(handler: (update: AcpSessionUpdate) => void): void
  /**
   * Phase 1.5 step 2 — returns the latest `available_commands_update`
   * catalog seen for this ACP session, or `null` if no catalog has
   * arrived yet. Captures Copilot CLI slash commands + skills (NOT
   * broker MCP tools — those only surface in `tool_call` notifications
   * when invoked). Useful for diagnostics + future bootstrap-health
   * signaling. The catalog fires twice per session bootstrap (initial,
   * then after MCP registration completes); the latest fire wins.
   */
  getAvailableCommands(sessionId: string): ReadonlyArray<AcpAvailableCommand> | null
  /**
   * Phase 1.5 step 3 — send the ACP-spec `session/cancel` notification for
   * `sessionId`. Fire-and-forget: per spec the agent acks by resolving the
   * in-flight `session/prompt` with `stopReason:'cancelled'`. Safe to call
   * when no prompt is in flight (the agent simply ignores the notification)
   * and when the underlying process is already gone (no-op). Idempotent.
   *
   * Most callers don't need this directly — `close()` invokes it internally
   * before SIGTERM for graceful shutdown. Exposed for future warm-pool /
   * external-abort scenarios where a specific session should be cancelled
   * without tearing down the whole client.
   */
  cancelSession(sessionId: string): void
  close(): Promise<void>
  readonly state: AcpSessionStateType
  readonly pid: number | null
  /**
   * Phase 1.5 step 5 — snapshot of the cold-start timing marks. See
   * `AcpClientTimings` for semantics. A fresh client (or a client that has
   * not yet been initialized) returns all-null marks.
   */
  readonly timings: AcpClientTimings
}

// ── JSON-RPC types ───────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: unknown
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

// ── Implementation ───────────────────────────────────────────────────────

/**
 * Reap a spawned ACP process and all of its descendants on Windows (`taskkill /T /F`).
 * Node's `ChildProcess.kill('SIGTERM')` on Windows terminates only the root PID,
 * leaving wrapper-spawned `copilot.exe` / `git.exe` children orphaned.
 */
export function killWindowsProcessTree(
  pid: number,
  platform: NodeJS.Platform = globalThis.process.platform,
  runSync: typeof spawnSync = spawnSync,
): void {
  if (platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return
  runSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    timeout: 5_000,
    windowsHide: true,
  })
}

export function createAcpClient(options?: AcpClientOptions): AcpClient {
  const log = logger.child({ module: 'acp-client' })
  const initTimeoutMs = options?.initTimeoutMs ?? 30_000
  const promptTimeoutMs = options?.promptTimeoutMs ?? 300_000
  const closeGraceMs = options?.closeGraceMs ?? 2_000
  const spawnFn = options?.spawnFn ?? nodeSpawn

  let process: ChildProcess | null = null
  let nextId = 1
  let currentState: AcpSessionStateType = 'closed'
  let promptingSessionId: string | null = null
  let outputBuffer = ''
  // Phase 1.5 step 3 — true after the child process emits 'exit' or
  // 'error', or after close() runs to completion. In Node's ChildProcess
  // semantics, `process.killed` is set ONLY by an explicit `.kill()`
  // call — a natural exit (e.g., agent self-terminates after handshake)
  // leaves `killed === false` and `stdin` still defined, so guards based
  // on those alone allow writes to a dead pipe. This flag closes that
  // gap for cancelSession + future post-exit operations.
  let processExited = false
  // Phase 1.5 step 3 — handle to the in-flight `session/prompt` resolution
  // promise. Set in `sendPrompt` before `await`, cleared in the finally
  // block. Allows `close()` to await the agent's `stopReason:'cancelled'`
  // ack (or any other resolution) without holding a reference inside
  // sendPrompt's caller. `null` whenever no prompt is in flight.
  let activePromptPromise: Promise<unknown> | null = null

  // Phase 1.5 step 5 — cold-start timing marks. See AcpClientTimings for
  // semantics. Reset to null on the next call to initialize/createSession
  // so the snapshot always reflects the most-recent attempt.
  let tProcessSpawnStarted: number | null = null
  let tInitializeResolved: number | null = null
  let tSessionNewStarted: number | null = null
  let tSessionNewResolved: number | null = null

  const pendingRequests = new Map<number, PendingRequest>()
  const updateHandlers: ((update: AcpSessionUpdate) => void)[] = []
  // Phase 1.5 step 2 — per-session catalog capture. Latest non-empty fire wins
  // (the bootstrap sequence emits `available_commands_update` twice: initial,
  // then again after MCP registration completes). Empty arrays are stored too
  // so getAvailableCommands() can distinguish "no catalog seen" (null) from
  // "catalog seen but empty" (empty array).
  const availableCommandsBySession = new Map<string, AcpAvailableCommand[]>()
  const permissionPolicy = options?.permissionPolicy ?? createDefaultPermissionPolicy()
  const onPermissionDecision = options?.onPermissionDecision
  const humanPermission = options?.humanPermission
  /** T057 — pending async permission requests, resolvable exactly once (cancel resolves them all). */
  const pendingHumanPermissions = new Map<number, (o: AcpPermissionOutcome) => void>()

  function setState(s: AcpSessionStateType): void {
    currentState = s
  }

  function writeRaw(obj: unknown): void {
    if (!process || process.killed || !process.stdin) return
    try {
      process.stdin.write(JSON.stringify(obj) + '\n')
    } catch (err) {
      log.warn({ err }, 'Failed to write to ACP stdin')
    }
  }

  function handleRequestPermission(id: number, params: AcpRequestPermissionParams): void {
    const toolCallId = params?.toolCall?.toolCallId ?? null
    const title = params?.toolCall?.title ?? null
    const kind = params?.toolCall?.kind ?? null

    const respond = (decision: AcpPermissionOutcome): void => {
      log.info(
        {
          sessionId: params?.sessionId,
          toolCallId,
          title,
          kind,
          decision,
        },
        'ACP permission request',
      )
      if (onPermissionDecision) {
        try {
          onPermissionDecision({
            timestamp: new Date().toISOString(),
            sessionId: params?.sessionId ?? '',
            toolCallId,
            title,
            kind,
            decision,
          })
        } catch (err) {
          log.warn({ err }, 'onPermissionDecision handler threw')
        }
      }
      writeRaw({ jsonrpc: '2.0', id, result: { outcome: decision } })
    }

    // T057 [US5] — ASYNC human-in-the-loop path: the request stays PENDING until the human settles
    // it (or cancelSession resolves it with `cancelled`, per the ACP contract). Resolve-once.
    if (humanPermission) {
      let settled = false
      const settle = (decision: AcpPermissionOutcome): void => {
        if (settled) return
        settled = true
        pendingHumanPermissions.delete(id)
        respond(decision)
      }
      pendingHumanPermissions.set(id, settle)
      humanPermission(params).then(settle, (err) => {
        log.warn({ err, toolCallId, kind }, 'humanPermission channel failed — cancelling request')
        settle({ outcome: 'cancelled' })
      })
      return
    }

    let decision: AcpPermissionOutcome
    try {
      decision = permissionPolicy.decide(params)
    } catch (err) {
      log.warn({ err, toolCallId, kind }, 'Permission policy threw — cancelling request')
      decision = { outcome: 'cancelled' }
    }
    respond(decision)
    return

    // The SYNCHRONOUS policy path decides and replies in the same tick, so it leaves no pending
    // window. The ASYNC humanPermission path above DOES: its pending ids live in
    // `pendingHumanPermissions` and are resolved with `{outcome:'cancelled'}` by `cancelSession()`
    // (the ACP contract: the Client MUST respond to all pending permission requests on cancel).
  }

  /**
   * Phase 1.5 step 3 — implementation of `cancelSession`. Writes the ACP
   * `session/cancel` notification (no id, no response). Safe when the
   * process is unavailable. The agent acks by resolving the in-flight
   * `session/prompt` with `stopReason:'cancelled'`; that resolution flows
   * through the normal response path (`handleLine` → pendingRequests).
   */
  function cancelSessionImpl(sessionId: string): void {
    // T057 [US5] — ACP contract: resolve every PENDING async permission request with `cancelled`
    // BEFORE the cancel notification (and regardless of process health — the settle path is guarded).
    for (const settle of [...pendingHumanPermissions.values()]) {
      settle({ outcome: 'cancelled' })
    }
    if (!process || process.killed || processExited || !process.stdin) {
      log.debug({ sessionId }, 'cancelSession: process unavailable, skipping')
      return
    }
    log.info({ sessionId }, 'ACP session/cancel notification sent')
    writeRaw({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
  }

  function send(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!process || process.killed || !process.stdin) {
        reject(new AcpError('ACP process is not running'))
        return
      }

      const id = nextId++
      const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
      const line = JSON.stringify(request) + '\n'

      const timer = setTimeout(() => {
        pendingRequests.delete(id)
        reject(new AcpTimeoutError(method, timeoutMs))
      }, timeoutMs)

      pendingRequests.set(id, { resolve, reject, timer })

      try {
        process.stdin.write(line)
      } catch (err) {
        clearTimeout(timer)
        pendingRequests.delete(id)
        reject(new AcpError(`Failed to write to ACP process: ${err}`))
      }
    })
  }

  function handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let msg: {
      jsonrpc?: string
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: { code: number; message: string }
    }
    try {
      msg = JSON.parse(trimmed)
    } catch {
      log.debug({ line: trimmed.slice(0, 200) }, 'Ignoring non-JSON line from ACP')
      return
    }

    if (msg.jsonrpc !== '2.0') {
      log.debug({ msg }, 'Ignoring non-JSON-RPC message')
      return
    }

    // Notification (no id) — route to update handlers
    if (msg.id === undefined && msg.method) {
      if (msg.method === 'session/update') {
        const update = msg.params as AcpSessionUpdate
        const kind = update?.update?.sessionUpdate
        if (kind === 'agent_message_chunk') {
          // Defensive: only some agent_message_chunk fires carry `content`.
          const text = update.update.content?.text
          if (typeof text === 'string') outputBuffer += text
        } else if (kind === 'available_commands_update') {
          // Phase 1.5 step 2 — capture latest catalog per ACP session.
          const sid = update.sessionId
          const rawCmds = (update.update as { availableCommands?: unknown }).availableCommands
          if (sid && Array.isArray(rawCmds)) {
            availableCommandsBySession.set(sid, rawCmds as AcpAvailableCommand[])
          }
        }
        for (const handler of updateHandlers) {
          try {
            handler(update)
          } catch (err) {
            log.warn({ err }, 'Update handler threw')
          }
        }
      }
      return
    }

    // Request from agent (has both id AND method) — must respond.
    if (msg.id !== undefined && msg.method) {
      if (msg.method === 'session/request_permission') {
        handleRequestPermission(msg.id, msg.params as AcpRequestPermissionParams)
        return
      }
      // Unknown method — return JSON-RPC method-not-found so the agent
      // doesn't stall waiting for a response.
      log.warn({ method: msg.method, id: msg.id }, 'Unhandled ACP request method')
      writeRaw({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      })
      return
    }

    // Response (has id, no method) — resolve pending request
    if (msg.id !== undefined) {
      const pending = pendingRequests.get(msg.id)
      if (!pending) {
        log.debug({ id: msg.id }, 'Received response for unknown request id')
        return
      }
      pendingRequests.delete(msg.id)
      clearTimeout(pending.timer)

      if (msg.error) {
        pending.reject(new AcpError(`ACP error ${msg.error.code}: ${msg.error.message}`))
      } else {
        pending.resolve(msg.result)
      }
    }
  }

  function rejectAllPending(error: Error): void {
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(error)
      pendingRequests.delete(id)
    }
  }

  function spawnProcess(): void {
    processExited = false
    const args = ['--acp']
    if (options?.model) {
      args.push('--model', options.model)
    }
    if (options?.allowAllTools === true) {
      args.push('--allow-all-tools')
    }

    const spawnOpts: SpawnOptionsWithoutStdio = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...globalThis.process.env, ...(options?.env ?? {}) },
      cwd: options?.cwd,
      windowsHide: true,
    }

    // Phase 1.5 step 5 — capture the mark *before* the spawnFn invocation
    // so the delta to `initialize` resolution captures the full
    // process-spawn + Node + Copilot CLI bootstrap cost.
    tProcessSpawnStarted = Date.now()
    process = spawnFn('copilot', args, spawnOpts) as ChildProcess

    if (!process.stdout) {
      throw new AcpError('Failed to get stdout from ACP process')
    }

    // Line-delimited JSON parser using readline (handles buffering/partial lines)
    const rl = createInterface({ input: process.stdout })
    rl.on('line', handleLine)

    process.on('exit', (code, signal) => {
      log.info({ code, signal }, 'ACP process exited')
      processExited = true
      if (currentState !== 'closed') {
        setState('failed')
      }
      rejectAllPending(new AcpError(`ACP process exited (code=${code}, signal=${signal})`))
      promptingSessionId = null
      if (options?.onProcessExit) {
        try {
          options.onProcessExit({ code, signal })
        } catch (err) {
          log.warn({ err }, 'onProcessExit handler threw')
        }
      }
    })

    process.on('error', (err) => {
      log.error({ err }, 'ACP process error')
      processExited = true
      setState('failed')
      rejectAllPending(new AcpError(`ACP process error: ${err.message}`))
    })
  }

  return {
    get state(): AcpSessionStateType {
      return currentState
    },

    get pid(): number | null {
      return process?.pid ?? null
    },

    get timings(): AcpClientTimings {
      return {
        processSpawnStartedAt: tProcessSpawnStarted,
        initializeResolvedAt: tInitializeResolved,
        sessionNewStartedAt: tSessionNewStarted,
        sessionNewResolvedAt: tSessionNewResolved,
      }
    },

    async initialize(): Promise<AcpInitResult> {
      // Phase 1.5 step 5 — reset the initialize timing marks. spawnProcess
      // will set processSpawnStartedAt; the post-RPC line below sets
      // initializeResolvedAt. Reset session-new marks too so repeated
      // initialize calls (caller-driven retries) give a coherent snapshot.
      tProcessSpawnStarted = null
      tInitializeResolved = null
      tSessionNewStarted = null
      tSessionNewResolved = null

      setState('initializing')
      spawnProcess()

      try {
        const result = (await send(
          'initialize',
          {
            protocolVersion: 1,
            capabilities: {},
            clientInfo: { name: 'scns', version: '0.1.0' },
          },
          initTimeoutMs,
        )) as AcpInitResult

        setState('ready')
        tInitializeResolved = Date.now()
        log.info({ agentInfo: result.agentInfo }, 'ACP client initialized')
        return result
      } catch (err) {
        if (currentState !== 'closed') {
          setState('failed')
        }
        throw err
      }
    },

    async createSession(cwd: string, mcpServers?: AcpMcpServer[]): Promise<string> {
      if (currentState !== 'ready') {
        throw new AcpNotReadyError()
      }

      // Phase 1.5 step 5 — mark *before* the request lands in flight so the
      // delta to `sessionNewResolvedAt` captures the full session/new
      // bootstrap cost (twin `available_commands_update` fires, MCP
      // registration, config_option_update, etc).
      tSessionNewStarted = Date.now()
      const result = (await send(
        'session/new',
        { cwd, mcpServers: mcpServers ?? [] },
        initTimeoutMs,
      )) as { sessionId: string }
      tSessionNewResolved = Date.now()

      return result.sessionId
    },

    async sendPrompt(sessionId: string, prompt: string): Promise<AcpPromptResult> {
      if (promptingSessionId !== null) {
        throw new AcpBusyError(sessionId)
      }

      if (currentState !== 'ready') {
        throw new AcpNotReadyError()
      }

      promptingSessionId = sessionId
      outputBuffer = ''
      setState('prompting')

      // Phase 1.5 step 3 — capture the send() promise BEFORE awaiting so
      // close() can race it against `closeGraceMs` while session/cancel
      // is in flight. We don't await `send()` inline (the cancel grace
      // logic in close() depends on observing this exact handle).
      const sendPromise = send(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: prompt }] },
        promptTimeoutMs,
      ) as Promise<{ stopReason: string }>
      activePromptPromise = sendPromise

      try {
        const result = await sendPromise

        return { stopReason: result.stopReason, output: outputBuffer }
      } finally {
        activePromptPromise = null
        promptingSessionId = null
        // Only restore to ready if we're still in prompting state
        // (process crash may have set it to 'failed')
        if ((currentState as string) === 'prompting') {
          setState('ready')
        }
      }
    },

    onUpdate(handler: (update: AcpSessionUpdate) => void): void {
      updateHandlers.push(handler)
    },

    getAvailableCommands(sessionId: string): ReadonlyArray<AcpAvailableCommand> | null {
      return availableCommandsBySession.get(sessionId) ?? null
    },

    cancelSession(sessionId: string): void {
      cancelSessionImpl(sessionId)
    },

    async close(): Promise<void> {
      if (currentState === 'closed') return

      // Phase 1.5 step 3 — graceful cancellation phase. Per ACP spec
      // (https://agentclientprotocol.com/protocol/prompt-turn#cancellation),
      // the Client sends `session/cancel` and the Agent MUST resolve the
      // original `session/prompt` with `stopReason:'cancelled'` after
      // aborting in-flight tool calls + flushing pending updates. Wait up
      // to `closeGraceMs` for that ack so the agent can finish writing
      // its per-session JSONL (~/.copilot/session-state/<id>/events.jsonl)
      // and any in-flight tool call cleanly before we SIGTERM it.
      //
      // Skipped (fast path) when: no prompt in flight, no process, the
      // process is already killed, or `closeGraceMs === 0` (opt-out).
      const promptToAwait = activePromptPromise
      const sessionToCancel = promptingSessionId
      if (
        closeGraceMs > 0 &&
        promptToAwait !== null &&
        sessionToCancel !== null &&
        process !== null &&
        !process.killed
      ) {
        try {
          cancelSessionImpl(sessionToCancel)
        } catch (err) {
          log.warn({ err, sessionId: sessionToCancel }, 'close(): cancelSession threw')
        }
        // Swallow rejection — the prompt may reject (e.g., AcpError on
        // process exit during the grace window). Either resolution path
        // signals "agent done", which is what we want before SIGTERM.
        await Promise.race([
          promptToAwait.catch(() => undefined),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, closeGraceMs)
            // Best-effort unref so a long grace doesn't block a test
            // runner's event loop after close() returns.
            timer.unref?.()
          }),
        ])
      }

      setState('closed')
      rejectAllPending(new AcpError('ACP client closed'))

      if (process && !process.killed) {
        if (
          !processExited &&
          typeof process.pid === 'number' &&
          process.pid > 0 &&
          (options?.killProcessTree !== undefined || process instanceof ChildProcess)
        ) {
          try {
            ;(options?.killProcessTree ?? killWindowsProcessTree)(process.pid)
          } catch (err) {
            log.warn({ err, pid: process.pid }, 'close(): killProcessTree failed')
          }
        }
        process.kill('SIGTERM')
      }

      process = null
      promptingSessionId = null
      activePromptPromise = null
      outputBuffer = ''
      availableCommandsBySession.clear()
    },
  }
}
