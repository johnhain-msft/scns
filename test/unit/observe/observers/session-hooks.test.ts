import { describe, it, expect, vi } from 'vitest'
import {
  createSessionHookHandler,
  type SessionEventData,
  type SessionHookHandlerOptions,
} from '../../../../src/observe/observers/session-hooks.js'
import { createDailyLogWriter } from '../../../../src/observe/daily-log-writer.js'
import type { ObserverConfig } from '../../../../src/observe/types.js'

function makeOptions(
  overrides: Partial<SessionHookHandlerOptions> = {},
): SessionHookHandlerOptions {
  const config: ObserverConfig = { enabled: true, optIn: false }
  return {
    logWriter: createDailyLogWriter({ appendDailyLog: vi.fn() }),
    config,
    ...overrides,
  }
}

function makeEvent(overrides: Partial<SessionEventData> = {}): SessionEventData {
  return {
    event: 'session-start',
    sessionId: 'sess-abc-123',
    timestamp: '2025-01-15T10:00:00Z',
    ...overrides,
  }
}

describe('SessionHookHandler', () => {
  it('has correct type and name', () => {
    const handler = createSessionHookHandler(makeOptions())
    expect(handler.type).toBe('session-hook')
    expect(handler.name).toBe('session-hook')
  })

  it('handleEvent session-start creates correct observation', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(makeEvent({ event: 'session-start', sessionId: 'sess-1' }))

    expect(obs.type).toBe('session-hook')
    expect(obs.source).toBe('session-start')
    expect(obs.content).toContain('Session sess-1 started')
  })

  it('handleEvent session-end creates correct observation with duration', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'session-end',
        sessionId: 'sess-2',
        metadata: { durationMs: 300000 },
      }),
    )

    expect(obs.type).toBe('session-hook')
    expect(obs.source).toBe('session-end')
    expect(obs.content).toContain('Session sess-2 ended')
    expect(obs.metadata).toEqual(expect.objectContaining({ durationMs: 300000 }))
  })

  it('handleEvent tool-use creates observation with tool name', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'tool-use',
        tool: 'bash',
      }),
    )

    expect(obs.type).toBe('session-hook')
    expect(obs.source).toBe('tool-use')
    expect(obs.content).toContain('Tool used: bash')
  })

  it('handleEvent pre-compact creates observation', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(makeEvent({ event: 'pre-compact' }))

    expect(obs.type).toBe('session-hook')
    expect(obs.source).toBe('pre-compact')
    expect(obs.content).toContain('Session compacting (context rotation)')
  })

  it('tags include event type and session-id where present', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'session-start',
        sessionId: 'sess-xyz',
      }),
    )

    expect(obs.tags).toEqual(expect.arrayContaining([expect.stringContaining('session-start')]))
    expect(obs.tags).toEqual(expect.arrayContaining([expect.stringContaining('sess-xyz')]))
  })

  it('metadata preserved in observation', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'session-start',
        metadata: { context: 'test-run', branch: 'main' },
      }),
    )

    expect(obs.metadata).toEqual(
      expect.objectContaining({
        context: 'test-run',
        branch: 'main',
      }),
    )
  })

  it('generateClaudeHookScript returns valid bash for session-start', () => {
    const handler = createSessionHookHandler(makeOptions())
    const script = handler.generateClaudeHookScript('session-start', 'http://localhost:3000')

    expect(script).toContain('#!/bin/bash')
    expect(script).toContain('session-start')
    expect(script).toContain('http://localhost:3000')
    expect(script).toContain('curl')
    expect(script).toContain('CLAUDE_SESSION_ID')
  })

  it('generateClaudeHookScript returns valid bash for session-end', () => {
    const handler = createSessionHookHandler(makeOptions())
    const script = handler.generateClaudeHookScript('session-end', 'http://localhost:3000')

    expect(script).toContain('session-end')
    expect(script).toContain('curl')
  })

  it('generateClaudeHookScript returns valid bash for tool-use', () => {
    const handler = createSessionHookHandler(makeOptions())
    const script = handler.generateClaudeHookScript('tool-use', 'http://localhost:3000')

    expect(script).toContain('tool-use')
  })

  it('generateClaudeHookScript returns valid bash for pre-compact', () => {
    const handler = createSessionHookHandler(makeOptions())
    const script = handler.generateClaudeHookScript('pre-compact', 'http://localhost:3000')

    expect(script).toContain('pre-compact')
  })

  it('generateClaudeHookScript includes broker URL', () => {
    const handler = createSessionHookHandler(makeOptions())
    const script = handler.generateClaudeHookScript(
      'session-start',
      'https://broker.example.com:8443',
    )

    expect(script).toContain('https://broker.example.com:8443/api/hooks/session-start')
  })

  it('generateCopilotHookScript returns valid bash', () => {
    const handler = createSessionHookHandler(makeOptions())
    const script = handler.generateCopilotHookScript('session-start', 'http://localhost:3000')

    expect(script).toContain('#!/bin/bash')
    expect(script).toContain('session-start')
    expect(script).toContain('curl')
    expect(script).toContain('http://localhost:3000')
  })

  it('generateCopilotHookScript uses different env vars than Claude', () => {
    const handler = createSessionHookHandler(makeOptions())
    const claudeScript = handler.generateClaudeHookScript('session-start', 'http://localhost:3000')
    const copilotScript = handler.generateCopilotHookScript(
      'session-start',
      'http://localhost:3000',
    )

    expect(claudeScript).toContain('CLAUDE_SESSION_ID')
    expect(copilotScript).toContain('COPILOT_SESSION_ID')
    expect(copilotScript).not.toContain('CLAUDE_SESSION_ID')
  })

  it('start() sets isRunning to true', () => {
    const handler = createSessionHookHandler(makeOptions())
    expect(handler.isRunning()).toBe(false)
    handler.start()
    expect(handler.isRunning()).toBe(true)
  })

  it('stop() sets isRunning to false', () => {
    const handler = createSessionHookHandler(makeOptions())
    handler.start()
    expect(handler.isRunning()).toBe(true)
    handler.stop()
    expect(handler.isRunning()).toBe(false)
  })

  it('getRegisteredEvents() returns all 8 events', () => {
    const handler = createSessionHookHandler(makeOptions())
    const events = handler.getRegisteredEvents()

    expect(events).toHaveLength(8)
    expect(events).toContain('session-start')
    expect(events).toContain('session-end')
    expect(events).toContain('tool-use')
    expect(events).toContain('pre-compact')
    expect(events).toContain('user-prompt')
    expect(events).toContain('error')
    expect(events).toContain('pre-tool-use')
    expect(events).toContain('post-tool-use')
  })

  it('observation written to daily log on handleEvent', () => {
    const appendDailyLog = vi.fn()
    const logWriter = createDailyLogWriter({ appendDailyLog })
    const handler = createSessionHookHandler(makeOptions({ logWriter }))

    handler.handleEvent(makeEvent())
    expect(appendDailyLog).toHaveBeenCalled()
  })

  it('missing sessionId handled gracefully', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'session-start',
        sessionId: undefined,
      }),
    )

    expect(obs.type).toBe('session-hook')
    expect(obs.content).toContain('Session')
    expect(obs.content).toContain('started')
  })

  it('missing metadata handled gracefully', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'session-end',
        metadata: undefined,
      }),
    )

    expect(obs.type).toBe('session-hook')
    expect(obs.content).toContain('ended')
  })

  it('collapses a multi-line prompt preview to one physical log line', () => {
    // The daily log is parsed line-by-line downstream (dream extraction, tiered
    // consolidation). A preview with embedded newlines splits a prompt's
    // authorship markers from its content — a machine dispatch brief's
    // "must NOT…" sentence would land on an unmarked continuation line and be
    // harvested as a bare human prohibition.
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'user-prompt',
        metadata: {
          prompt:
            'You are slidesmith. Short DELTA pass.\nScope is TWO rows - you must NOT touch slides.',
        },
      }),
    )

    expect(obs.content).toBe(
      'User prompt: You are slidesmith. Short DELTA pass. Scope is TWO rows - you must NOT touch slides.',
    )
    expect(obs.content).not.toContain('\n')
  })

  // ── Enriched payload tests ──────────────────────────────────────

  it('buildContent with mcpServer shows MCP tool info', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'tool-use',
        tool: 'search_code',
        mcpServer: 'github-mcp-server',
      }),
    )

    expect(obs.content).toBe('MCP tool used: github-mcp-server/search_code')
  })

  it('buildContent with skillName shows skill info', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'tool-use',
        skillName: 'quality-gate',
      }),
    )

    expect(obs.content).toBe('Skill invoked: quality-gate')
  })

  it('buildContent mcpServer takes precedence over skillName', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'tool-use',
        tool: 'list_files',
        mcpServer: 'fs-server',
        skillName: 'explore',
      }),
    )

    expect(obs.content).toBe('MCP tool used: fs-server/list_files')
  })

  it('buildContent with tokenUsage shows token counts', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'session-end',
        sessionId: 'abc',
        tokenUsage: { input: 45231, output: 12456 },
      }),
    )

    expect(obs.content).toBe('Session abc ended (45,231 in / 12,456 out tokens)')
  })

  it('buildContent with errorMessage shows error', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'session-end',
        sessionId: 'abc',
        errorMessage: 'rate limit exceeded',
      }),
    )

    expect(obs.content).toBe('Session abc ended with error: rate limit exceeded')
  })

  it('buildContent with both errorMessage and tokenUsage shows both', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'session-end',
        sessionId: 'abc',
        errorMessage: 'timeout',
        tokenUsage: { input: 1000, output: 500 },
      }),
    )

    expect(obs.content).toContain('with error: timeout')
    expect(obs.content).toContain('(1,000 in / 500 out tokens)')
  })

  it('buildEventTags includes model tag', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'session-start',
        model: 'claude-opus-4.6',
      }),
    )

    expect(obs.tags).toContain('model:claude-opus-4.6')
  })

  it('buildEventTags includes mcp tag', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'tool-use',
        mcpServer: 'github-mcp-server',
      }),
    )

    expect(obs.tags).toContain('mcp:github-mcp-server')
  })

  it('buildEventTags includes skill tag', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'tool-use',
        skillName: 'quality-gate',
      }),
    )

    expect(obs.tags).toContain('skill:quality-gate')
  })

  it('buildEventTags includes trace tag', () => {
    const handler = createSessionHookHandler(makeOptions())
    const obs = handler.handleEvent(
      makeEvent({
        event: 'session-start',
        traceId: 'abc123def456',
      }),
    )

    expect(obs.tags).toContain('trace:abc123def456')
  })

  it('hook script comments mention enriched payload fields', () => {
    const handler = createSessionHookHandler(makeOptions())
    const script = handler.generateClaudeHookScript('tool-use', 'http://localhost:3000')

    expect(script).toContain('model')
    expect(script).toContain('toolArgs')
    expect(script).toContain('mcpServer')
    expect(script).toContain('tokenUsage')
  })

  it('copilot hook script comments mention enriched payload fields', () => {
    const handler = createSessionHookHandler(makeOptions())
    const script = handler.generateCopilotHookScript('session-end', 'http://localhost:3000')

    expect(script).toContain('model')
    expect(script).toContain('skillName')
    expect(script).toContain('errorMessage')
  })
})
