/**
 * Session hook handler — processes lifecycle events from Claude Code / Copilot sessions.
 */

import { randomUUID } from 'node:crypto'
import type { Observer, ObserverState } from '../observer.js'
import { ObservationType, type Observation, type ObserverConfig } from '../types.js'
import type { createDailyLogWriter } from '../daily-log-writer.js'
import { buildTags } from '../tags.js'

export type SessionEvent =
  | 'session-start'
  | 'session-end'
  | 'tool-use'
  | 'pre-compact'
  | 'user-prompt'
  | 'error'
  | 'pre-tool-use'
  | 'post-tool-use'

const ALL_EVENTS: readonly SessionEvent[] = [
  'session-start',
  'session-end',
  'tool-use',
  'pre-compact',
  'user-prompt',
  'error',
  'pre-tool-use',
  'post-tool-use',
] as const

export interface SessionEventData {
  readonly event: SessionEvent
  readonly sessionId?: string
  readonly tool?: string
  readonly timestamp: string
  readonly metadata?: Record<string, unknown>
  readonly model?: string
  readonly toolArgs?: string
  readonly toolResult?: string
  readonly mcpServer?: string
  readonly skillName?: string
  readonly exitCode?: number
  readonly errorMessage?: string
  readonly traceId?: string
  readonly tokenUsage?: {
    readonly input?: number
    readonly output?: number
  }
}

export interface SessionHookHandlerOptions {
  readonly logWriter: ReturnType<typeof createDailyLogWriter>
  readonly config: ObserverConfig
}

function formatTokenUsage(tokenUsage: {
  readonly input?: number
  readonly output?: number
}): string {
  const input = tokenUsage.input?.toLocaleString('en-US') ?? '?'
  const output = tokenUsage.output?.toLocaleString('en-US') ?? '?'
  return `(${input} in / ${output} out tokens)`
}

function buildContent(event: SessionEventData): string {
  const sessionLabel = event.sessionId ?? 'unknown'

  switch (event.event) {
    case 'session-start':
      return `Session ${sessionLabel} started`
    case 'session-end': {
      const parts = [`Session ${sessionLabel} ended`]
      if (event.errorMessage) {
        parts.push(`with error: ${event.errorMessage}`)
      }
      if (event.tokenUsage) {
        parts.push(formatTokenUsage(event.tokenUsage))
      }
      return parts.join(' ')
    }
    case 'tool-use': {
      if (event.mcpServer) {
        const toolName = event.tool ?? 'unknown'
        return `MCP tool used: ${event.mcpServer}/${toolName}`
      }
      if (event.skillName) {
        return `Skill invoked: ${event.skillName}`
      }
      return `Tool used: ${event.tool ?? 'unknown'}`
    }
    case 'pre-compact':
      return 'Session compacting (context rotation)'
    case 'user-prompt': {
      const raw = event.metadata?.['prompt'] as string | undefined
      // Collapse to one physical line BEFORE truncating. The daily log is parsed line-by-line
      // downstream (dream extraction, tiered consolidation), and a multi-line preview splits a
      // prompt's authorship markers from its content — a machine dispatch brief's "you must NOT…"
      // sentence would land on an unmarked continuation line and read as a bare human prohibition.
      const preview = raw?.replace(/\s+/g, ' ').trim()
      return `User prompt${preview ? `: ${preview.slice(0, 200)}` : ''}`
    }
    case 'error': {
      const ctx = event.metadata?.['errorContext'] as string | undefined
      return `Error${ctx ? ` (${ctx})` : ''}: ${event.errorMessage ?? 'unknown'}`
    }
    case 'pre-tool-use':
      return `Pre-tool: ${event.tool ?? 'unknown'}`
    case 'post-tool-use':
      return `Post-tool: ${event.tool ?? 'unknown'}`
  }
}

function buildEventTags(event: SessionEventData): string[] {
  const tags = buildTags(ObservationType.SessionHook, event.event)
  if (event.sessionId) {
    tags.push(`session-id:${event.sessionId}`)
  }
  if (event.tool) {
    tags.push(`tool:${event.tool}`)
  }
  if (event.model) {
    tags.push(`model:${event.model}`)
  }
  if (event.mcpServer) {
    tags.push(`mcp:${event.mcpServer}`)
  }
  if (event.skillName) {
    tags.push(`skill:${event.skillName}`)
  }
  if (event.traceId) {
    tags.push(`trace:${event.traceId}`)
  }
  return tags
}

export function createSessionHookHandler(options: SessionHookHandlerOptions): Observer & {
  handleEvent(event: SessionEventData): Observation
  generateClaudeHookScript(event: SessionEvent, brokerUrl: string): string
  generateCopilotHookScript(event: SessionEvent, brokerUrl: string): string
  getRegisteredEvents(): readonly SessionEvent[]
} {
  const { logWriter } = options
  let state: ObserverState = 'idle'

  function handleEvent(event: SessionEventData): Observation {
    const observation: Observation = {
      id: randomUUID(),
      type: ObservationType.SessionHook,
      timestamp: event.timestamp,
      source: event.event,
      content: buildContent(event),
      tags: buildEventTags(event),
      metadata: event.metadata,
    }
    logWriter.write(observation)
    return observation
  }

  function generateClaudeHookScript(event: SessionEvent, brokerUrl: string): string {
    return [
      '#!/bin/bash',
      `# SCNS session hook: ${event}`,
      '#',
      '# The broker accepts enriched payloads with optional fields:',
      '#   model, toolArgs, toolResult, mcpServer, skillName,',
      '#   exitCode, errorMessage, traceId, tokenUsage: { input, output }',
      '#',
      '# This script sends the fields available via environment variables.',
      `curl -s -X POST "${brokerUrl}/api/hooks/${event}" \\`,
      '  -H "Content-Type: application/json" \\',
      `  -d "{\\"event\\":\\"${event}\\",\\"sessionId\\":\\"$CLAUDE_SESSION_ID\\",\\"timestamp\\":\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\"}"`,
      '',
    ].join('\n')
  }

  function generateCopilotHookScript(event: SessionEvent, brokerUrl: string): string {
    return [
      '#!/bin/bash',
      `# SCNS session hook: ${event}`,
      '#',
      '# The broker accepts enriched payloads with optional fields:',
      '#   model, toolArgs, toolResult, mcpServer, skillName,',
      '#   exitCode, errorMessage, traceId, tokenUsage: { input, output }',
      '#',
      '# This script sends the fields available via environment variables.',
      `curl -s -X POST "${brokerUrl}/api/hooks/${event}" \\`,
      '  -H "Content-Type: application/json" \\',
      `  -d "{\\"event\\":\\"${event}\\",\\"sessionId\\":\\"$COPILOT_SESSION_ID\\",\\"timestamp\\":\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\"}"`,
      '',
    ].join('\n')
  }

  return {
    type: ObservationType.SessionHook,
    name: 'session-hook',

    start() {
      state = 'running'
    },

    stop() {
      state = 'idle'
    },

    isRunning() {
      return state === 'running'
    },

    handleEvent,
    generateClaudeHookScript,
    generateCopilotHookScript,
    getRegisteredEvents: () => ALL_EVENTS,
  }
}
