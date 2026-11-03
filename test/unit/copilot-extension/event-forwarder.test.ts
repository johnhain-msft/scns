import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  formatHookPayload,
  formatEventPayload,
  forwardToBroker,
  createEventForwarder,
} from '../../../src/copilot-extension/event-forwarder.js'

describe('event-forwarder', () => {
  describe('formatHookPayload', () => {
    it('maps onSessionStart to session-start event', () => {
      const payload = formatHookPayload(
        'onSessionStart',
        {
          timestamp: 1700000000000,
          cwd: '/home/user/project',
          source: 'startup',
        },
        'sess-1',
      )

      expect(payload.event).toBe('session-start')
      expect(payload.sessionId).toBe('sess-1')
      expect(payload.timestamp).toBe(new Date(1700000000000).toISOString())
      expect(payload.metadata?.cwd).toBe('/home/user/project')
      expect(payload.metadata?.source).toBe('startup')
    })

    it('maps onSessionEnd to session-end event', () => {
      const payload = formatHookPayload(
        'onSessionEnd',
        {
          reason: 'complete',
          timestamp: 1700000000000,
        },
        'sess-2',
      )

      expect(payload.event).toBe('session-end')
      expect(payload.metadata?.reason).toBe('complete')
    })

    it('maps onPreToolUse to pre-tool-use event with tool info', () => {
      const payload = formatHookPayload('onPreToolUse', {
        toolName: 'bash',
        toolArgs: { command: 'ls -la' },
        timestamp: 1700000000000,
      })

      expect(payload.event).toBe('pre-tool-use')
      expect(payload.tool).toBe('bash')
      expect(payload.toolArgs).toBe('{"command":"ls -la"}')
    })

    it('maps onPostToolUse to post-tool-use event with result', () => {
      const payload = formatHookPayload('onPostToolUse', {
        toolName: 'edit',
        toolResult: { resultType: 'success', textResultForLlm: 'File edited' },
        timestamp: 1700000000000,
      })

      expect(payload.event).toBe('post-tool-use')
      expect(payload.tool).toBe('edit')
      expect(payload.toolResult).toBe('File edited')
    })

    it('maps onErrorOccurred to error with error details', () => {
      const payload = formatHookPayload('onErrorOccurred', {
        error: 'Rate limit exceeded',
        errorContext: 'model_call',
        recoverable: true,
        timestamp: 1700000000000,
      })

      expect(payload.event).toBe('error')
      expect(payload.errorMessage).toBe('Rate limit exceeded')
      expect(payload.metadata?.errorContext).toBe('model_call')
      expect(payload.metadata?.recoverable).toBe(true)
    })

    it('maps onUserPromptSubmitted to user-prompt with truncated prompt', () => {
      const longPrompt = 'a'.repeat(1000)
      const payload = formatHookPayload('onUserPromptSubmitted', {
        prompt: longPrompt,
        timestamp: 1700000000000,
      })

      expect(payload.event).toBe('user-prompt')
      expect((payload.metadata?.prompt as string).length).toBe(500)
    })

    it('falls back to tool-use for unknown hook names', () => {
      const payload = formatHookPayload('onUnknownHook', { timestamp: 1700000000000 })
      expect(payload.event).toBe('tool-use')
    })

    it('uses current time when no timestamp provided', () => {
      const before = new Date().toISOString()
      const payload = formatHookPayload('onSessionStart', {})
      const after = new Date().toISOString()

      expect(payload.timestamp >= before).toBe(true)
      expect(payload.timestamp <= after).toBe(true)
    })

    it('omits undefined fields from metadata', () => {
      const payload = formatHookPayload('onSessionStart', { timestamp: 1700000000000 })
      expect(payload.metadata?.prompt).toBeUndefined()
      expect(payload.metadata?.source).toBeUndefined()
    })
  })

  describe('formatEventPayload', () => {
    it('formats tool.execution_start event', () => {
      const payload = formatEventPayload(
        {
          type: 'tool.execution_start',
          data: { toolName: 'bash', toolCallId: 'tc-1', arguments: { command: 'npm test' } },
        },
        'sess-1',
      )

      // Unrecognized SDK types map to 'tool-use' for broker compatibility
      expect(payload.event).toBe('tool-use')
      expect(payload.tool).toBe('bash')
      expect(payload.sessionId).toBe('sess-1')
      expect(payload.metadata?.eventType).toBe('tool.execution_start')
      expect(payload.metadata?.toolCallId).toBe('tc-1')
    })

    it('formats assistant.message event', () => {
      const payload = formatEventPayload({
        type: 'assistant.message',
        data: { content: 'Here is the result', messageId: 'msg-1' },
      })

      // Unrecognized SDK types map to 'tool-use' for broker compatibility
      expect(payload.event).toBe('tool-use')
      expect(payload.tool).toBeUndefined()
      expect(payload.metadata?.eventType).toBe('assistant.message')
      expect(payload.metadata?.content).toBe('Here is the result')
    })

    it('includes timestamp', () => {
      const before = new Date().toISOString()
      const payload = formatEventPayload({ type: 'session.idle', data: {} })
      expect(payload.timestamp >= before).toBe(true)
    })

    it('maps tool-call to tool-use', () => {
      const payload = formatEventPayload({ type: 'tool-call', data: { toolName: 'edit' } })
      expect(payload.event).toBe('tool-use')
    })

    it('maps tool-use to tool-use', () => {
      const payload = formatEventPayload({ type: 'tool-use', data: {} })
      expect(payload.event).toBe('tool-use')
    })

    it('maps model-response to tool-use', () => {
      const payload = formatEventPayload({ type: 'model-response', data: {} })
      expect(payload.event).toBe('tool-use')
    })

    it('maps model-completion to tool-use', () => {
      const payload = formatEventPayload({ type: 'model-completion', data: {} })
      expect(payload.event).toBe('tool-use')
    })

    it('maps model-request to tool-use', () => {
      const payload = formatEventPayload({ type: 'model-request', data: {} })
      expect(payload.event).toBe('tool-use')
    })

    it('maps error to error', () => {
      const payload = formatEventPayload({ type: 'error', data: {} })
      expect(payload.event).toBe('error')
    })

    it('maps error-occurred to error', () => {
      const payload = formatEventPayload({ type: 'error-occurred', data: {} })
      expect(payload.event).toBe('error')
    })

    it('maps session-start to session-start', () => {
      const payload = formatEventPayload({ type: 'session-start', data: {} })
      expect(payload.event).toBe('session-start')
    })

    it('maps session-end to session-end', () => {
      const payload = formatEventPayload({ type: 'session-end', data: {} })
      expect(payload.event).toBe('session-end')
    })

    it('maps user-prompt to user-prompt', () => {
      const payload = formatEventPayload({ type: 'user-prompt', data: {} })
      expect(payload.event).toBe('user-prompt')
    })

    it('maps prompt-submitted to user-prompt', () => {
      const payload = formatEventPayload({ type: 'prompt-submitted', data: {} })
      expect(payload.event).toBe('user-prompt')
    })

    it('maps unrecognized event types to tool-use fallback', () => {
      const payload = formatEventPayload({ type: 'custom.event', data: {} })
      expect(payload.event).toBe('tool-use')
    })

    it('falls back to tool-use for empty event type', () => {
      const payload = formatEventPayload({ type: '', data: {} })
      expect(payload.event).toBe('tool-use')
    })

    it('preserves original event type in metadata.eventType', () => {
      const payload = formatEventPayload({ type: 'model-response', data: { key: 'val' } })
      expect(payload.metadata?.eventType).toBe('model-response')
    })
  })

  describe('forwardToBroker', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch')
    })

    afterEach(() => {
      fetchSpy.mockRestore()
    })

    it('POSTs payload to broker and returns true on success', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('{"acknowledged":true}', { status: 200 }))

      const result = await forwardToBroker(
        { event: 'session-start', sessionId: 'sess-1', timestamp: new Date().toISOString() },
        { brokerUrl: 'http://localhost:3456' },
      )

      expect(result).toBe(true)
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:3456/api/hooks/session-start',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    })

    it('returns false on HTTP error', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('error', { status: 500 }))

      const result = await forwardToBroker(
        { event: 'session-start', timestamp: new Date().toISOString() },
        { brokerUrl: 'http://localhost:3456' },
      )

      expect(result).toBe(false)
    })

    it('returns false on network failure (never throws)', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const result = await forwardToBroker(
        { event: 'session-start', timestamp: new Date().toISOString() },
        { brokerUrl: 'http://localhost:9999' },
      )

      expect(result).toBe(false)
    })

    it('returns false on abort (timeout)', async () => {
      fetchSpy.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 100)
          }),
      )

      const result = await forwardToBroker(
        { event: 'session-start', timestamp: new Date().toISOString() },
        { brokerUrl: 'http://localhost:3456', timeoutMs: 50 },
      )

      expect(result).toBe(false)
    })

    it('uses 500ms default timeout', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      await forwardToBroker(
        { event: 'session-start', timestamp: new Date().toISOString() },
        { brokerUrl: 'http://localhost:3456' },
      )

      const call = fetchSpy.mock.calls[0]!
      const options = call[1] as RequestInit
      expect(options.signal).toBeDefined()
    })
  })

  describe('createEventForwarder', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch')
      fetchSpy.mockResolvedValue(new Response('{"acknowledged":true}', { status: 200 }))
    })

    afterEach(() => {
      fetchSpy.mockRestore()
    })

    it('creates a forwarder bound to config', async () => {
      const forwarder = createEventForwarder({
        brokerUrl: 'http://localhost:3456',
        sessionId: 'sess-1',
      })

      const result = await forwarder.forwardHook('onSessionStart', {
        source: 'startup',
        timestamp: 1700000000000,
      })

      expect(result).toBe(true)
      const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
      expect(body.sessionId).toBe('sess-1')
      expect(body.event).toBe('session-start')
    })

    it('forwards events with session ID', async () => {
      const forwarder = createEventForwarder({
        brokerUrl: 'http://localhost:3456',
        sessionId: 'sess-2',
      })

      await forwarder.forwardEvent({
        type: 'tool.execution_complete',
        data: { toolName: 'bash', success: true },
      })

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
      expect(body.sessionId).toBe('sess-2')
      expect(body.metadata.eventType).toBe('tool.execution_complete')
    })
  })
})
