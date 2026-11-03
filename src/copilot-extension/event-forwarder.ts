/**
 * Event Forwarder — formats Copilot CLI hook/event data and forwards to the SCNS broker.
 *
 * All calls are fire-and-forget with 500ms timeouts. Never throws.
 */

/** Copilot hook event types mapped to broker session event types */
const HOOK_EVENT_MAP: Readonly<Record<string, string>> = {
  onSessionStart: 'session-start',
  onSessionEnd: 'session-end',
  onPreToolUse: 'pre-tool-use',
  onPostToolUse: 'post-tool-use',
  onUserPromptSubmitted: 'user-prompt',
  onErrorOccurred: 'error',
} as const

/** Hook input from Copilot SDK */
export interface CopilotHookInput {
  readonly timestamp?: number
  readonly cwd?: string
  readonly prompt?: string
  readonly toolName?: string
  readonly toolArgs?: unknown
  readonly toolResult?: { readonly resultType?: string; readonly textResultForLlm?: string }
  readonly source?: string
  readonly reason?: string
  readonly error?: string
  readonly errorContext?: string
  readonly recoverable?: boolean
  readonly initialPrompt?: string
  readonly finalMessage?: string
  readonly permissionDecision?: string
}

/** Copilot SDK event data */
export interface CopilotEventData {
  readonly type: string
  readonly data: Record<string, unknown>
}

/** Broker-compatible session hook payload */
export interface BrokerHookPayload {
  readonly event: string
  readonly sessionId?: string
  readonly tool?: string
  readonly timestamp: string
  readonly metadata?: Record<string, unknown>
  readonly toolArgs?: string
  readonly toolResult?: string
  readonly errorMessage?: string
}

export interface ForwarderConfig {
  readonly brokerUrl: string
  readonly timeoutMs?: number
  readonly sessionId?: string
}

/** Format a Copilot hook call into a broker payload */
export function formatHookPayload(
  hookName: string,
  input: CopilotHookInput,
  sessionId?: string,
): BrokerHookPayload {
  const event = HOOK_EVENT_MAP[hookName] ?? 'tool-use'
  const timestamp = input.timestamp
    ? new Date(input.timestamp).toISOString()
    : new Date().toISOString()

  const payload: BrokerHookPayload = {
    event,
    sessionId,
    timestamp,
    tool: input.toolName,
    toolArgs: input.toolArgs ? JSON.stringify(input.toolArgs) : undefined,
    toolResult: input.toolResult?.textResultForLlm,
    errorMessage: input.error,
    metadata: {
      hookName,
      cwd: input.cwd,
      prompt: input.prompt ? input.prompt.slice(0, 500) : undefined,
      source: input.source,
      reason: input.reason,
      errorContext: input.errorContext,
      recoverable: input.recoverable,
    },
  }

  return payload
}

/** Format a Copilot event into a broker payload */
export function formatEventPayload(event: CopilotEventData, sessionId?: string): BrokerHookPayload {
  const timestamp = new Date().toISOString()

  return {
    event: mapEventType(event.type),
    sessionId,
    timestamp,
    tool: (event.data['toolName'] as string) ?? undefined,
    metadata: {
      eventType: event.type,
      ...event.data,
    },
  }
}

/** Map SDK event type strings to valid broker SessionEventType values. */
function mapEventType(eventType: string): string {
  switch (eventType) {
    case 'tool-call':
    case 'tool-use':
      return 'tool-use'
    case 'model-response':
    case 'model-completion':
      return 'tool-use'
    case 'model-request':
      return 'tool-use'
    case 'error':
    case 'error-occurred':
      return 'error'
    case 'session-start':
      return 'session-start'
    case 'session-end':
      return 'session-end'
    case 'user-prompt':
    case 'prompt-submitted':
      return 'user-prompt'
    case 'pre-compact':
      return 'pre-compact'
    case 'pre-tool-use':
      return 'pre-tool-use'
    case 'post-tool-use':
      return 'post-tool-use'
    default:
      return 'tool-use'
  }
}

/** Forward a payload to the SCNS broker. Fire-and-forget, never throws. */
export async function forwardToBroker(
  payload: BrokerHookPayload,
  config: ForwarderConfig,
): Promise<boolean> {
  const timeoutMs = config.timeoutMs ?? 500
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${config.brokerUrl}/api/hooks/${payload.event}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export interface EventForwarderApi {
  forwardHook(hookName: string, input: CopilotHookInput): Promise<boolean>
  forwardEvent(event: CopilotEventData): Promise<boolean>
}

/** Create a reusable event forwarder bound to a broker config */
export function createEventForwarder(config: ForwarderConfig): EventForwarderApi {
  async function forwardHook(hookName: string, input: CopilotHookInput): Promise<boolean> {
    const payload = formatHookPayload(hookName, input, config.sessionId)
    return forwardToBroker(payload, config)
  }

  async function forwardEvent(event: CopilotEventData): Promise<boolean> {
    const payload = formatEventPayload(event, config.sessionId)
    return forwardToBroker(payload, config)
  }

  return { forwardHook, forwardEvent }
}
