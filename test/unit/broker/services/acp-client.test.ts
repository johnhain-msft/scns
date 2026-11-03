import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter, Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import {
  createAcpClient,
  createDenyAllPermissionPolicy,
  type AcpClient,
  type AcpClientOptions,
  AcpError,
  AcpTimeoutError,
  AcpBusyError,
  AcpNotReadyError,
} from '../../../../src/broker/services/acp-client.js'

// ── Helpers ──────────────────────────────────────────────────────────────

function jsonRpcResponse(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'
}

function jsonRpcError(id: number, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'
}

function jsonRpcNotification(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'
}

/** Creates a mock child process with controllable stdin/stdout */
function createMockProcess(): {
  process: ChildProcess
  stdout: Readable
  stdin: Writable
  stdinData: string[]
  emit: (event: string, ...args: unknown[]) => void
} {
  const stdout = new Readable({ read() {} })
  const stdinData: string[] = []
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      stdinData.push(chunk.toString())
      callback()
    },
  })

  const proc = new EventEmitter() as unknown as ChildProcess
  Object.assign(proc, {
    stdout,
    stderr: new Readable({ read() {} }),
    stdin,
    pid: 12345,
    killed: false,
    kill: vi.fn(() => {
      ;(proc as { killed: boolean }).killed = true
      return true
    }),
  })

  return {
    process: proc,
    stdout,
    stdin,
    stdinData,
    emit: (event: string, ...args: unknown[]) => (proc as EventEmitter).emit(event, ...args),
  }
}

function createClientWithMock(
  opts?: Partial<AcpClientOptions>,
): {
  client: AcpClient
  mock: ReturnType<typeof createMockProcess>
  spawnFn: ReturnType<typeof vi.fn>
} {
  const mock = createMockProcess()
  const spawnFn = vi.fn().mockReturnValue(mock.process)
  const client = createAcpClient({
    spawnFn,
    initTimeoutMs: 500,
    promptTimeoutMs: 2000,
    ...opts,
  })
  return { client, mock, spawnFn }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('AcpClient', () => {
  describe('initialize()', () => {
    it('sends initialize JSON-RPC and resolves with capabilities', async () => {
      const { client, mock } = createClientWithMock()

      const initPromise = client.initialize()

      // Give the readline setup a tick
      await new Promise((r) => setTimeout(r, 10))

      // Client should have sent the initialize request
      expect(mock.stdinData.length).toBeGreaterThanOrEqual(1)
      const sent = JSON.parse(mock.stdinData[0]!)
      expect(sent.method).toBe('initialize')
      expect(sent.params.protocolVersion).toBe(1)
      expect(sent.params.clientInfo.name).toBe('scns')

      // Send back the response
      mock.stdout.push(
        jsonRpcResponse(sent.id, {
          protocolVersion: 1,
          agentCapabilities: {
            sessionCapabilities: { create: true, list: true, load: true },
          },
          agentInfo: { name: 'copilot', version: '1.0.0' },
        }),
      )

      const result = await initPromise
      expect(result.protocolVersion).toBe(1)
      expect(result.agentInfo.name).toBe('copilot')
    })

    it('rejects if the process exits before responding', async () => {
      const { client, mock } = createClientWithMock()

      const initPromise = client.initialize()
      await new Promise((r) => setTimeout(r, 10))

      mock.emit('exit', 1, null)

      await expect(initPromise).rejects.toThrow(AcpError)
    })

    it('rejects on timeout', async () => {
      const { client } = createClientWithMock({ initTimeoutMs: 50 })

      await expect(client.initialize()).rejects.toThrow(AcpTimeoutError)
    })

    it('rejects on JSON-RPC error response', async () => {
      const { client, mock } = createClientWithMock()

      const initPromise = client.initialize()
      await new Promise((r) => setTimeout(r, 10))

      const sent = JSON.parse(mock.stdinData[0]!)
      mock.stdout.push(jsonRpcError(sent.id, -32603, 'Validation failed'))

      await expect(initPromise).rejects.toThrow('Validation failed')
    })

    it('passes env vars to child process', async () => {
      const env = { SCNS_SESSION_ID: 'test-123', SCNS_TEAM_ID: 'team-abc' }
      const { spawnFn } = createClientWithMock({ env })

      // initialize starts the process — we don't need to await it
      void createAcpClient({ spawnFn, env, initTimeoutMs: 50 }).initialize().catch(() => {})
      await new Promise((r) => setTimeout(r, 10))

      expect(spawnFn).toHaveBeenCalled()
      const spawnOpts = spawnFn.mock.calls[0]![2]
      expect(spawnOpts.env).toMatchObject(env)
    })
  })

  describe('createSession()', () => {
    it('sends session/new and returns sessionId', async () => {
      const { client, mock } = createClientWithMock()

      // Initialize first
      const initP = client.initialize()
      await new Promise((r) => setTimeout(r, 10))
      const initReq = JSON.parse(mock.stdinData[0]!)
      mock.stdout.push(
        jsonRpcResponse(initReq.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP

      // Create session
      const sessionP = client.createSession('/tmp/test')
      await new Promise((r) => setTimeout(r, 10))

      const sessionReq = JSON.parse(mock.stdinData[1]!)
      expect(sessionReq.method).toBe('session/new')
      expect(sessionReq.params.cwd).toBe('/tmp/test')
      expect(sessionReq.params.mcpServers).toEqual([])

      mock.stdout.push(
        jsonRpcResponse(sessionReq.id, {
          sessionId: 'acp-session-42',
          models: { availableModels: ['claude-sonnet-4'] },
        }),
      )

      const result = await sessionP
      expect(result).toBe('acp-session-42')
    })

    it('rejects if not initialized', async () => {
      const { client } = createClientWithMock()

      await expect(client.createSession('/tmp')).rejects.toThrow(AcpNotReadyError)
    })
  })

  describe('sendPrompt()', () => {
    let client: AcpClient
    let mock: ReturnType<typeof createMockProcess>

    beforeEach(async () => {
      const setup = createClientWithMock()
      client = setup.client
      mock = setup.mock

      // Bootstrap: initialize + createSession
      const initP = client.initialize()
      await new Promise((r) => setTimeout(r, 10))
      const initReq = JSON.parse(mock.stdinData[0]!)
      mock.stdout.push(
        jsonRpcResponse(initReq.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP

      const sessP = client.createSession('/tmp')
      await new Promise((r) => setTimeout(r, 10))
      const sessReq = JSON.parse(mock.stdinData[1]!)
      mock.stdout.push(jsonRpcResponse(sessReq.id, { sessionId: 'sess-1' }))
      await sessP
    })

    it('sends session/prompt and returns result', async () => {
      const promptP = client.sendPrompt('sess-1', 'Hello')
      await new Promise((r) => setTimeout(r, 10))

      const promptReq = JSON.parse(mock.stdinData[2]!)
      expect(promptReq.method).toBe('session/prompt')
      expect(promptReq.params.sessionId).toBe('sess-1')
      expect(promptReq.params.prompt).toEqual([{ type: 'text', text: 'Hello' }])

      // Simulate streaming chunks
      mock.stdout.push(
        jsonRpcNotification('session/update', {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hi' },
          },
        }),
      )
      mock.stdout.push(
        jsonRpcNotification('session/update', {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' there!' },
          },
        }),
      )

      // Send the final response
      mock.stdout.push(jsonRpcResponse(promptReq.id, { stopReason: 'end_turn' }))

      const result = await promptP
      expect(result.stopReason).toBe('end_turn')
      expect(result.output).toBe('Hi there!')
    })

    it('rejects concurrent prompts with AcpBusyError', async () => {
      // Start first prompt (don't resolve it)
      const p1 = client.sendPrompt('sess-1', 'First')
      await new Promise((r) => setTimeout(r, 10))

      // Try second prompt while first is in-flight
      await expect(client.sendPrompt('sess-1', 'Second')).rejects.toThrow(AcpBusyError)

      // Resolve first prompt to clean up
      const req = JSON.parse(mock.stdinData[2]!)
      mock.stdout.push(jsonRpcResponse(req.id, { stopReason: 'end_turn' }))
      await p1
    })

    it('collects streaming chunks via onUpdate callback', async () => {
      const chunks: string[] = []
      client.onUpdate((update) => {
        if (update.update.sessionUpdate === 'agent_message_chunk') {
          chunks.push(update.update.content.text)
        }
      })

      const promptP = client.sendPrompt('sess-1', 'Test')
      await new Promise((r) => setTimeout(r, 10))

      const req = JSON.parse(mock.stdinData[2]!)

      mock.stdout.push(
        jsonRpcNotification('session/update', {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'chunk1' },
          },
        }),
      )
      mock.stdout.push(
        jsonRpcNotification('session/update', {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'chunk2' },
          },
        }),
      )

      mock.stdout.push(jsonRpcResponse(req.id, { stopReason: 'end_turn' }))
      await promptP

      expect(chunks).toEqual(['chunk1', 'chunk2'])
    })

    it('rejects on process exit during prompt', async () => {
      const promptP = client.sendPrompt('sess-1', 'Hello')
      await new Promise((r) => setTimeout(r, 10))

      mock.emit('exit', 1, null)

      await expect(promptP).rejects.toThrow(AcpError)
    })

    it('honors a short promptTimeoutMs option (13.12.23)', async () => {
      // Separate client with a 50ms prompt timeout so we can assert timeout
      // propagation without coupling to the default 30m value.
      const shortMock = createMockProcess()
      const shortSpawn = vi.fn().mockReturnValue(shortMock.process)
      const shortClient = createAcpClient({
        spawnFn: shortSpawn,
        initTimeoutMs: 500,
        promptTimeoutMs: 50,
      })

      const initP = shortClient.initialize()
      await new Promise((r) => setTimeout(r, 10))
      const initReq = JSON.parse(shortMock.stdinData[0]!)
      shortMock.stdout.push(
        jsonRpcResponse(initReq.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP
      const sessP = shortClient.createSession('/tmp')
      await new Promise((r) => setTimeout(r, 10))
      const sessReq = JSON.parse(shortMock.stdinData[1]!)
      shortMock.stdout.push(jsonRpcResponse(sessReq.id, { sessionId: 'sess-short' }))
      await sessP

      // Never send a response to the prompt — timeout should fire.
      await expect(shortClient.sendPrompt('sess-short', 'Hello')).rejects.toThrow(
        AcpTimeoutError,
      )
    })
  })

  describe('close()', () => {
    it('kills the child process and rejects pending requests', async () => {
      const { client, mock } = createClientWithMock()

      const initP = client.initialize()
      await new Promise((r) => setTimeout(r, 10))

      // Close while init is pending
      await client.close()

      expect(mock.process.kill).toHaveBeenCalledWith('SIGTERM')
      await expect(initP).rejects.toThrow(AcpError)
    })

    it('is safe to call multiple times', async () => {
      const { client, mock } = createClientWithMock()

      // Initialize first
      const initP = client.initialize()
      await new Promise((r) => setTimeout(r, 10))
      const initReq = JSON.parse(mock.stdinData[0]!)
      mock.stdout.push(
        jsonRpcResponse(initReq.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP

      await client.close()
      await client.close() // Second call should not throw
    })
  })

  describe('JSON-RPC framing', () => {
    it('handles partial lines (buffered chunks)', async () => {
      const { client, mock } = createClientWithMock()

      const initP = client.initialize()
      await new Promise((r) => setTimeout(r, 10))

      const req = JSON.parse(mock.stdinData[0]!)
      const fullResponse = jsonRpcResponse(req.id, {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'copilot', version: '1.0' },
      })

      // Send response in two chunks (split mid-JSON)
      const midpoint = Math.floor(fullResponse.length / 2)
      mock.stdout.push(fullResponse.slice(0, midpoint))
      await new Promise((r) => setTimeout(r, 5))
      mock.stdout.push(fullResponse.slice(midpoint))

      const result = await initP
      expect(result.protocolVersion).toBe(1)
    })

    it('handles multiple messages in one chunk', async () => {
      const { client, mock } = createClientWithMock()

      // Initialize
      const initP = client.initialize()
      await new Promise((r) => setTimeout(r, 10))
      const initReq = JSON.parse(mock.stdinData[0]!)
      mock.stdout.push(
        jsonRpcResponse(initReq.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP

      // Create session
      const sessP = client.createSession('/tmp')
      await new Promise((r) => setTimeout(r, 10))
      const sessReq = JSON.parse(mock.stdinData[1]!)

      // Send notification + response in single push
      const combined =
        jsonRpcNotification('session/update', {
          sessionId: 'x',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
        }) + jsonRpcResponse(sessReq.id, { sessionId: 'multi-msg-session' })

      mock.stdout.push(combined)

      const result = await sessP
      expect(result).toBe('multi-msg-session')
    })

    it('ignores non-JSON lines from stderr noise', async () => {
      const { client, mock } = createClientWithMock()

      const initP = client.initialize()
      await new Promise((r) => setTimeout(r, 10))

      const req = JSON.parse(mock.stdinData[0]!)

      // Push some non-JSON noise then the real response
      mock.stdout.push('WARNING: some random stderr noise\n')
      mock.stdout.push(
        jsonRpcResponse(req.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )

      const result = await initP
      expect(result.protocolVersion).toBe(1)
    })
  })

  describe('state management', () => {
    it('reports correct state transitions', async () => {
      const { client, mock } = createClientWithMock()

      expect(client.state).toBe('closed')

      const initP = client.initialize()
      expect(client.state).toBe('initializing')

      await new Promise((r) => setTimeout(r, 10))
      const req = JSON.parse(mock.stdinData[0]!)
      mock.stdout.push(
        jsonRpcResponse(req.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP

      expect(client.state).toBe('ready')

      await client.close()
      expect(client.state).toBe('closed')
    })

    it('transitions to failed on process crash', async () => {
      const { client, mock } = createClientWithMock()

      const initP = client.initialize()
      await new Promise((r) => setTimeout(r, 10))
      const req = JSON.parse(mock.stdinData[0]!)
      mock.stdout.push(
        jsonRpcResponse(req.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP

      expect(client.state).toBe('ready')

      mock.emit('exit', 1, null)
      await new Promise((r) => setTimeout(r, 10))

      expect(client.state).toBe('failed')
    })
  })

  describe('pid', () => {
    it('returns the child process PID', async () => {
      const { client } = createClientWithMock()

      // Before initialize, no process yet — pid may be null or the mock's 12345
      void client.initialize().catch(() => {})
      await new Promise((r) => setTimeout(r, 10))
      expect(client.pid).toBe(12345)
    })
  })

  describe('session/request_permission handling (Phase 13.12.21)', () => {
    async function bootstrap(opts?: Partial<AcpClientOptions>): Promise<{
      client: AcpClient
      mock: ReturnType<typeof createMockProcess>
    }> {
      const setup = createClientWithMock(opts)
      const initP = setup.client.initialize()
      await new Promise((r) => setTimeout(r, 10))
      const initReq = JSON.parse(setup.mock.stdinData[0]!)
      setup.mock.stdout.push(
        jsonRpcResponse(initReq.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP
      return { client: setup.client, mock: setup.mock }
    }

    function sendPermissionRequest(
      mock: ReturnType<typeof createMockProcess>,
      id: number,
      params: unknown,
    ): void {
      mock.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'session/request_permission',
          params,
        }) + '\n',
      )
    }

    async function readLastStdinJson(
      mock: ReturnType<typeof createMockProcess>,
    ): Promise<Record<string, unknown>> {
      await new Promise((r) => setTimeout(r, 20))
      const last = mock.stdinData[mock.stdinData.length - 1]!
      return JSON.parse(last) as Record<string, unknown>
    }

    it('auto-approves edit kind by selecting allow_always', async () => {
      const { mock } = await bootstrap()
      sendPermissionRequest(mock, 999, {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 'tc-1', title: 'Edit README', kind: 'edit' },
        options: [
          { optionId: 'allow-once', kind: 'allow_once' },
          { optionId: 'allow-always', kind: 'allow_always' },
          { optionId: 'reject-once', kind: 'reject_once' },
        ],
      })
      const reply = await readLastStdinJson(mock)
      expect(reply.id).toBe(999)
      expect(reply.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-always' },
      })
    })

    it('falls back to first allow_* option when allow_always missing', async () => {
      const { mock } = await bootstrap()
      sendPermissionRequest(mock, 1000, {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 'tc-2', title: 'Run tests', kind: 'execute' },
        options: [
          { optionId: 'reject-once', kind: 'reject_once' },
          { optionId: 'allow-once', kind: 'allow_once' },
        ],
      })
      const reply = await readLastStdinJson(mock)
      expect(reply.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      })
    })

    it('rejects delete kind without allowDestructive flag', async () => {
      const { mock } = await bootstrap()
      sendPermissionRequest(mock, 1001, {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 'tc-3', title: 'Remove file', kind: 'delete' },
        options: [
          { optionId: 'allow-always', kind: 'allow_always' },
          { optionId: 'reject-once', kind: 'reject_once' },
        ],
      })
      const reply = await readLastStdinJson(mock)
      expect(reply.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'reject-once' },
      })
    })

    it('allows delete kind when allowDestructive policy provided', async () => {
      const { mock } = await bootstrap({
        permissionPolicy: (
          await import('../../../../src/broker/services/acp-client.js')
        ).createDefaultPermissionPolicy({ allowDestructive: true }),
      })
      sendPermissionRequest(mock, 1002, {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 'tc-4', title: 'Remove file', kind: 'delete' },
        options: [
          { optionId: 'allow-always', kind: 'allow_always' },
          { optionId: 'reject-once', kind: 'reject_once' },
        ],
      })
      const reply = await readLastStdinJson(mock)
      expect(reply.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-always' },
      })
    })

    it('invokes onPermissionDecision callback with structured entry', async () => {
      const decisions: unknown[] = []
      const { mock } = await bootstrap({
        onPermissionDecision: (e) => decisions.push(e),
      })
      sendPermissionRequest(mock, 1003, {
        sessionId: 'sess-xyz',
        toolCall: { toolCallId: 'tc-5', title: 'Write file', kind: 'edit' },
        options: [{ optionId: 'allow-always', kind: 'allow_always' }],
      })
      await readLastStdinJson(mock)
      expect(decisions).toHaveLength(1)
      const d = decisions[0] as {
        sessionId: string
        toolCallId: string
        kind: string
        decision: { outcome: string; optionId?: string }
      }
      expect(d.sessionId).toBe('sess-xyz')
      expect(d.toolCallId).toBe('tc-5')
      expect(d.kind).toBe('edit')
      expect(d.decision).toEqual({ outcome: 'selected', optionId: 'allow-always' })
    })

    it('returns method-not-found for unknown request methods', async () => {
      const { mock } = await bootstrap()
      mock.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2000,
          method: 'session/made_up_thing',
          params: {},
        }) + '\n',
      )
      const reply = await readLastStdinJson(mock)
      expect(reply.id).toBe(2000)
      expect((reply.error as { code: number }).code).toBe(-32601)
    })

    it('round-trips a permission request during an in-flight prompt (integration)', async () => {
      const { client, mock } = await bootstrap()

      // Create session
      const sessP = client.createSession('/tmp')
      await new Promise((r) => setTimeout(r, 10))
      const sessReq = JSON.parse(mock.stdinData[1]!)
      mock.stdout.push(jsonRpcResponse(sessReq.id, { sessionId: 'sess-1' }))
      await sessP

      // Start a prompt
      const promptP = client.sendPrompt('sess-1', 'Edit README')
      await new Promise((r) => setTimeout(r, 10))
      const promptReq = JSON.parse(mock.stdinData[2]!)

      // Agent asks permission mid-prompt
      sendPermissionRequest(mock, 9001, {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 'tc-edit', title: 'Write README.md', kind: 'edit' },
        options: [
          { optionId: 'allow-once', kind: 'allow_once' },
          { optionId: 'allow-always', kind: 'allow_always' },
          { optionId: 'reject-once', kind: 'reject_once' },
        ],
      })
      await new Promise((r) => setTimeout(r, 20))

      // Client must have written a JSON-RPC response for id 9001
      const permReply = JSON.parse(mock.stdinData[mock.stdinData.length - 1]!)
      expect(permReply.jsonrpc).toBe('2.0')
      expect(permReply.id).toBe(9001)
      expect(permReply.result.outcome.outcome).toBe('selected')
      expect(permReply.result.outcome.optionId).toBe('allow-always')

      // Agent then emits tool_call update and completes the prompt
      mock.stdout.push(
        jsonRpcNotification('session/update', {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-edit',
            status: 'completed',
          },
        }),
      )
      mock.stdout.push(jsonRpcResponse(promptReq.id, { stopReason: 'end_turn' }))
      const result = await promptP
      expect(result.stopReason).toBe('end_turn')
    })
  })

  describe('createSession() — MCP server params shape', () => {
    it('passes mcpServers through to session/new exactly as provided', async () => {
      const { client, mock } = createClientWithMock()

      const initP = client.initialize()
      await new Promise((r) => setTimeout(r, 10))
      const initReq = JSON.parse(mock.stdinData[0]!)
      mock.stdout.push(
        jsonRpcResponse(initReq.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP

      const mcpServers = [
        {
          name: 'session-broker',
          type: 'http' as const,
          url: 'http://localhost:3456/mcp',
          headers: [],
        },
      ]
      const sessionP = client.createSession('/tmp/test', mcpServers)
      await new Promise((r) => setTimeout(r, 10))

      const sessionReq = JSON.parse(mock.stdinData[1]!)
      expect(sessionReq.method).toBe('session/new')
      expect(sessionReq.params.mcpServers).toEqual(mcpServers)
      // Copilot CLI validates this exact schema (type/url/headers); previous
      // wrong shape ({name, uri}) was rejected with JSON-RPC -32602.
      expect(sessionReq.params.mcpServers[0]).toMatchObject({
        name: 'session-broker',
        type: 'http',
        url: 'http://localhost:3456/mcp',
        headers: [],
      })

      mock.stdout.push(jsonRpcResponse(sessionReq.id, { sessionId: 'sess-mcp-1' }))
      await sessionP
    })
  })

  describe('spawnProcess() — Phase 1.5 step 4 --allow-all-tools flag', () => {
    // Empirically verified probe (2026-05-26, raw JSONL at
    // /tmp/allow-all-stdout.txt) on Copilot CLI 1.0.54: under `--acp`,
    // session-mode RPCs (`session/set_mode`, `session/set_config_option`,
    // `currentModeId` in `session/new`) are all blocked or silently
    // ignored, but `--allow-all-tools` as a process arg suppresses every
    // `session/request_permission` RPC on destructive operations. These
    // tests pin that the option translates to the correct argv shape.
    it('omits --allow-all-tools by default (gated behavior preserved)', () => {
      const mock = createMockProcess()
      const spawnFn = vi.fn().mockReturnValue(mock.process)
      createAcpClient({ spawnFn, initTimeoutMs: 500 }).initialize().catch(() => undefined)

      const [cmd, args] = spawnFn.mock.calls[0]!
      expect(cmd).toBe('copilot')
      expect(args).toEqual(['--acp'])
      expect((args as string[]).includes('--allow-all-tools')).toBe(false)
    })

    it('omits --allow-all-tools when allowAllTools is false', () => {
      const mock = createMockProcess()
      const spawnFn = vi.fn().mockReturnValue(mock.process)
      createAcpClient({ spawnFn, initTimeoutMs: 500, allowAllTools: false })
        .initialize()
        .catch(() => undefined)

      const [, args] = spawnFn.mock.calls[0]!
      expect((args as string[]).includes('--allow-all-tools')).toBe(false)
    })

    it('appends --allow-all-tools when allowAllTools is true', () => {
      const mock = createMockProcess()
      const spawnFn = vi.fn().mockReturnValue(mock.process)
      createAcpClient({ spawnFn, initTimeoutMs: 500, allowAllTools: true })
        .initialize()
        .catch(() => undefined)

      const [, args] = spawnFn.mock.calls[0]!
      expect(args).toEqual(['--acp', '--allow-all-tools'])
    })

    it('combines --model and --allow-all-tools in argv', () => {
      const mock = createMockProcess()
      const spawnFn = vi.fn().mockReturnValue(mock.process)
      createAcpClient({
        spawnFn,
        initTimeoutMs: 500,
        model: 'claude-sonnet-4',
        allowAllTools: true,
      })
        .initialize()
        .catch(() => undefined)

      const [, args] = spawnFn.mock.calls[0]!
      const argv = args as string[]
      expect(argv).toContain('--acp')
      expect(argv).toContain('--model')
      expect(argv).toContain('claude-sonnet-4')
      expect(argv).toContain('--allow-all-tools')
      // --acp must always be first arg.
      expect(argv[0]).toBe('--acp')
    })
  })

  describe('getAvailableCommands() — Phase 1.5 step 2 catalog capture', () => {
    async function bootstrappedClient(): Promise<{
      client: AcpClient
      mock: ReturnType<typeof createMockProcess>
      sessionId: string
    }> {
      const { client, mock } = createClientWithMock()
      const initP = client.initialize()
      await new Promise((r) => setTimeout(r, 10))
      const initReq = JSON.parse(mock.stdinData[0]!)
      mock.stdout.push(
        jsonRpcResponse(initReq.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP
      const sessP = client.createSession('/tmp')
      await new Promise((r) => setTimeout(r, 10))
      const sessReq = JSON.parse(mock.stdinData[1]!)
      mock.stdout.push(jsonRpcResponse(sessReq.id, { sessionId: 'sess-cat-1' }))
      await sessP
      return { client, mock, sessionId: 'sess-cat-1' }
    }

    it('returns null before any catalog notification arrives', async () => {
      const { client, sessionId } = await bootstrappedClient()
      expect(client.getAvailableCommands(sessionId)).toBeNull()
    })

    it('captures available_commands_update and exposes it', async () => {
      const { client, mock, sessionId } = await bootstrappedClient()
      const initialCmds = [
        { name: 'commit', description: 'Commit changes' },
        { name: 'handoff', description: 'Save session state' },
      ]
      mock.stdout.push(
        jsonRpcNotification('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: initialCmds,
          },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))

      const captured = client.getAvailableCommands(sessionId)
      expect(captured).not.toBeNull()
      expect(captured).toEqual(initialCmds)
    })

    it('latest update wins (2x fire on bootstrap)', async () => {
      const { client, mock, sessionId } = await bootstrappedClient()

      // First fire — pre-MCP-registration catalog.
      mock.stdout.push(
        jsonRpcNotification('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'commit' }],
          },
        }),
      )
      // Second fire — post-MCP-registration catalog (additional skill).
      mock.stdout.push(
        jsonRpcNotification('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'commit' }, { name: 'quality-gate' }],
          },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))

      const captured = client.getAvailableCommands(sessionId)
      expect(captured).toEqual([{ name: 'commit' }, { name: 'quality-gate' }])
    })

    it('isolates catalogs per ACP session id', async () => {
      const { client, mock } = await bootstrappedClient()

      mock.stdout.push(
        jsonRpcNotification('session/update', {
          sessionId: 'sess-A',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'plan' }],
          },
        }),
      )
      mock.stdout.push(
        jsonRpcNotification('session/update', {
          sessionId: 'sess-B',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'mcp' }, { name: 'handoff' }],
          },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))

      expect(client.getAvailableCommands('sess-A')).toEqual([{ name: 'plan' }])
      expect(client.getAvailableCommands('sess-B')).toEqual([
        { name: 'mcp' },
        { name: 'handoff' },
      ])
      expect(client.getAvailableCommands('unknown')).toBeNull()
    })

    it('clears captured catalogs on close()', async () => {
      const { client, mock, sessionId } = await bootstrappedClient()
      mock.stdout.push(
        jsonRpcNotification('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'commit' }],
          },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))
      expect(client.getAvailableCommands(sessionId)).not.toBeNull()

      await client.close()
      expect(client.getAvailableCommands(sessionId)).toBeNull()
    })

    it('does not crash on agent_message_chunk without content (defensive)', async () => {
      const { client, mock, sessionId } = await bootstrappedClient()
      // Some agent_message_chunk fires (e.g., empty signaling chunk) may omit
      // `content`. The accumulator must not throw.
      mock.stdout.push(
        jsonRpcNotification('session/update', {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk' },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))
      // Reaching here without an unhandled throw is the assertion.
      expect(client.getAvailableCommands(sessionId)).toBeNull()
    })
  })

  describe('cancelSession() — Phase 1.5 step 3 (session/cancel notification)', () => {
    async function bootstrappedWithSession(opts?: Partial<AcpClientOptions>): Promise<{
      client: AcpClient
      mock: ReturnType<typeof createMockProcess>
      sessionId: string
    }> {
      const setup = createClientWithMock(opts)
      const initP = setup.client.initialize()
      await new Promise((r) => setTimeout(r, 10))
      const initReq = JSON.parse(setup.mock.stdinData[0]!)
      setup.mock.stdout.push(
        jsonRpcResponse(initReq.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP
      const sessP = setup.client.createSession('/tmp')
      await new Promise((r) => setTimeout(r, 10))
      const sessReq = JSON.parse(setup.mock.stdinData[1]!)
      setup.mock.stdout.push(jsonRpcResponse(sessReq.id, { sessionId: 'sess-cancel-1' }))
      await sessP
      return { client: setup.client, mock: setup.mock, sessionId: 'sess-cancel-1' }
    }

    it('writes the ACP-spec wire format (notification — no id, method=session/cancel)', async () => {
      const { client, mock, sessionId } = await bootstrappedWithSession()
      const stdinBefore = mock.stdinData.length

      client.cancelSession(sessionId)
      await new Promise((r) => setTimeout(r, 5))

      expect(mock.stdinData.length).toBe(stdinBefore + 1)
      const sent = JSON.parse(mock.stdinData[mock.stdinData.length - 1]!) as Record<string, unknown>
      expect(sent.jsonrpc).toBe('2.0')
      expect(sent.method).toBe('session/cancel')
      expect(sent.params).toEqual({ sessionId })
      // Notification — must NOT carry an id (per JSON-RPC + ACP spec).
      expect(sent.id).toBeUndefined()
    })

    it('is a no-op when the underlying process is gone', async () => {
      const { client, mock, sessionId } = await bootstrappedWithSession()

      // Simulate process exit; cancelSession should not attempt to write.
      mock.emit('exit', 0, null)
      await new Promise((r) => setTimeout(r, 5))

      const stdinBefore = mock.stdinData.length
      expect(() => client.cancelSession(sessionId)).not.toThrow()
      await new Promise((r) => setTimeout(r, 5))
      expect(mock.stdinData.length).toBe(stdinBefore)
    })

    it('lets sendPrompt resolve with stopReason="cancelled" when agent acks the cancel', async () => {
      const { client, mock, sessionId } = await bootstrappedWithSession()

      const promptP = client.sendPrompt(sessionId, 'Do a long thing')
      await new Promise((r) => setTimeout(r, 10))
      const promptReq = JSON.parse(mock.stdinData[2]!)

      // Operator-side cancel — emit session/cancel via the public API.
      client.cancelSession(sessionId)
      await new Promise((r) => setTimeout(r, 5))

      // Agent acks per spec: resolves the session/prompt with stopReason='cancelled'.
      mock.stdout.push(jsonRpcResponse(promptReq.id, { stopReason: 'cancelled' }))

      const result = await promptP
      expect(result.stopReason).toBe('cancelled')
      // Verify the cancel notification was the second-to-last write
      // (before the prompt result arrived from the agent).
      const cancelMsg = mock.stdinData
        .map((s) => {
          try {
            return JSON.parse(s) as { method?: string }
          } catch {
            return {}
          }
        })
        .find((m) => m.method === 'session/cancel')
      expect(cancelMsg).toBeTruthy()
    })

    it('is safe to call when no prompt is in flight (idle session)', async () => {
      const { client, mock, sessionId } = await bootstrappedWithSession()

      // No prompt active — cancel is still emitted (agent ignores for unknown turns).
      // We assert it does not throw and does not corrupt subsequent prompts.
      expect(() => client.cancelSession(sessionId)).not.toThrow()
      await new Promise((r) => setTimeout(r, 5))

      // Subsequent prompt should still work.
      const promptP = client.sendPrompt(sessionId, 'after-cancel')
      await new Promise((r) => setTimeout(r, 10))
      const promptReq = JSON.parse(mock.stdinData[mock.stdinData.length - 1]!)
      expect(promptReq.method).toBe('session/prompt')
      mock.stdout.push(jsonRpcResponse(promptReq.id, { stopReason: 'end_turn' }))
      await promptP
    })
  })

  describe('close() — graceful cancellation (Phase 1.5 step 3)', () => {
    async function bootstrappedWithSession(opts?: Partial<AcpClientOptions>): Promise<{
      client: AcpClient
      mock: ReturnType<typeof createMockProcess>
      sessionId: string
    }> {
      const setup = createClientWithMock(opts)
      const initP = setup.client.initialize()
      await new Promise((r) => setTimeout(r, 10))
      const initReq = JSON.parse(setup.mock.stdinData[0]!)
      setup.mock.stdout.push(
        jsonRpcResponse(initReq.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP
      const sessP = setup.client.createSession('/tmp')
      await new Promise((r) => setTimeout(r, 10))
      const sessReq = JSON.parse(setup.mock.stdinData[1]!)
      setup.mock.stdout.push(jsonRpcResponse(sessReq.id, { sessionId: 'sess-close-1' }))
      await sessP
      return { client: setup.client, mock: setup.mock, sessionId: 'sess-close-1' }
    }

    it('sends session/cancel BEFORE SIGTERM when a prompt is in flight', async () => {
      const { client, mock, sessionId } = await bootstrappedWithSession({ closeGraceMs: 100 })

      // Start a prompt; do NOT resolve it.
      const promptP = client.sendPrompt(sessionId, 'long')
      await new Promise((r) => setTimeout(r, 10))

      // Close while prompt is in flight. Don't await yet — observe ordering.
      const closeP = client.close()

      // Give close() a tick to write the cancel notification.
      await new Promise((r) => setTimeout(r, 10))

      // Wire ordering: cancel notification must arrive before kill is called.
      const cancelIndex = mock.stdinData.findIndex((s) => {
        try {
          return (JSON.parse(s) as { method?: string }).method === 'session/cancel'
        } catch {
          return false
        }
      })
      expect(cancelIndex).toBeGreaterThanOrEqual(0)
      // Process should NOT yet be killed during the grace window.
      expect(mock.process.kill).not.toHaveBeenCalled()

      // Let grace window expire; close() proceeds to SIGTERM.
      await closeP
      expect(mock.process.kill).toHaveBeenCalledWith('SIGTERM')

      // sendPrompt's promise must have settled (rejected from rejectAllPending).
      await expect(promptP).rejects.toThrow(AcpError)
    })

    it('resolves the grace window early when agent acks with stopReason="cancelled"', async () => {
      // 5s grace would slow the test if it had to wait for timeout. We
      // make the agent ack quickly and assert close() returns well under
      // the grace window.
      const { client, mock, sessionId } = await bootstrappedWithSession({ closeGraceMs: 5_000 })

      const promptP = client.sendPrompt(sessionId, 'long')
      await new Promise((r) => setTimeout(r, 10))
      const promptReq = JSON.parse(mock.stdinData[2]!)

      const closeStart = Date.now()
      const closeP = client.close()

      // Give close() a tick to emit cancel, then have the agent ack.
      await new Promise((r) => setTimeout(r, 20))
      mock.stdout.push(jsonRpcResponse(promptReq.id, { stopReason: 'cancelled' }))

      await closeP
      const elapsed = Date.now() - closeStart
      expect(elapsed).toBeLessThan(500)
      expect(mock.process.kill).toHaveBeenCalledWith('SIGTERM')

      const promptResult = await promptP
      expect(promptResult.stopReason).toBe('cancelled')
    })

    it('falls through to SIGTERM after closeGraceMs even if agent never acks', async () => {
      const { client, mock, sessionId } = await bootstrappedWithSession({ closeGraceMs: 60 })

      const promptP = client.sendPrompt(sessionId, 'long')
      await new Promise((r) => setTimeout(r, 10))

      const start = Date.now()
      await client.close()
      const elapsed = Date.now() - start

      // Should have waited approximately the grace window.
      expect(elapsed).toBeGreaterThanOrEqual(50)
      expect(elapsed).toBeLessThan(500)
      expect(mock.process.kill).toHaveBeenCalledWith('SIGTERM')

      await expect(promptP).rejects.toThrow(AcpError)
    })

    it('does NOT send session/cancel when no prompt is in flight (fast path)', async () => {
      const { client, mock } = await bootstrappedWithSession({ closeGraceMs: 5_000 })

      // No prompt — close immediately.
      const start = Date.now()
      await client.close()
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(50)

      const cancelSent = mock.stdinData.some((s) => {
        try {
          return (JSON.parse(s) as { method?: string }).method === 'session/cancel'
        } catch {
          return false
        }
      })
      expect(cancelSent).toBe(false)
      expect(mock.process.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('skips the graceful phase entirely when closeGraceMs=0 (opt-out)', async () => {
      const { client, mock, sessionId } = await bootstrappedWithSession({ closeGraceMs: 0 })

      const promptP = client.sendPrompt(sessionId, 'long')
      await new Promise((r) => setTimeout(r, 10))

      const start = Date.now()
      await client.close()
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(50)

      const cancelSent = mock.stdinData.some((s) => {
        try {
          return (JSON.parse(s) as { method?: string }).method === 'session/cancel'
        } catch {
          return false
        }
      })
      expect(cancelSent).toBe(false)
      expect(mock.process.kill).toHaveBeenCalledWith('SIGTERM')
      await expect(promptP).rejects.toThrow(AcpError)
    })
  })

  describe('timings — Phase 1.5 step 5 cold-start probe', () => {
    it('starts with all marks null on a fresh client', () => {
      const { client } = createClientWithMock()
      const t = client.timings
      expect(t.processSpawnStartedAt).toBeNull()
      expect(t.initializeResolvedAt).toBeNull()
      expect(t.sessionNewStartedAt).toBeNull()
      expect(t.sessionNewResolvedAt).toBeNull()
    })

    it('sets processSpawnStartedAt before the initialize RPC is sent', async () => {
      const { client, mock } = createClientWithMock()
      const before = Date.now()

      const initP = client.initialize()
      // After the spawn but before the response: spawn mark should be set,
      // resolve mark should still be null.
      await new Promise((r) => setTimeout(r, 5))
      const midT = client.timings
      expect(midT.processSpawnStartedAt).not.toBeNull()
      expect(midT.processSpawnStartedAt!).toBeGreaterThanOrEqual(before)
      expect(midT.initializeResolvedAt).toBeNull()

      // Resolve initialize.
      const initReq = JSON.parse(mock.stdinData[0]!)
      mock.stdout.push(
        jsonRpcResponse(initReq.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP

      const t = client.timings
      expect(t.initializeResolvedAt).not.toBeNull()
      expect(t.initializeResolvedAt!).toBeGreaterThanOrEqual(t.processSpawnStartedAt!)
      // session/new marks untouched — only initialize ran.
      expect(t.sessionNewStartedAt).toBeNull()
      expect(t.sessionNewResolvedAt).toBeNull()
    })

    it('sets sessionNew marks across createSession and preserves initialize marks', async () => {
      const { client, mock } = createClientWithMock()

      // Bootstrap initialize.
      const initP = client.initialize()
      await new Promise((r) => setTimeout(r, 5))
      const initReq = JSON.parse(mock.stdinData[0]!)
      mock.stdout.push(
        jsonRpcResponse(initReq.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP

      const initMarks = client.timings

      // createSession.
      const sessionP = client.createSession('/tmp/cwd')
      await new Promise((r) => setTimeout(r, 5))
      // After send-out but before resolve, started should be set, resolved null.
      const midT = client.timings
      expect(midT.sessionNewStartedAt).not.toBeNull()
      expect(midT.sessionNewStartedAt!).toBeGreaterThanOrEqual(initMarks.initializeResolvedAt!)
      expect(midT.sessionNewResolvedAt).toBeNull()

      const sessionReq = JSON.parse(mock.stdinData[1]!)
      mock.stdout.push(
        jsonRpcResponse(sessionReq.id, { sessionId: 'acp-sess-1', models: {} }),
      )
      await sessionP

      const finalT = client.timings
      expect(finalT.sessionNewResolvedAt).not.toBeNull()
      expect(finalT.sessionNewResolvedAt!).toBeGreaterThanOrEqual(finalT.sessionNewStartedAt!)
      // The initialize marks must be preserved across createSession (a
      // post-hoc consumer needs both segments to compute cold_start_ms).
      expect(finalT.processSpawnStartedAt).toBe(initMarks.processSpawnStartedAt)
      expect(finalT.initializeResolvedAt).toBe(initMarks.initializeResolvedAt)
    })

    it('exposes a monotonic snapshot: spawn ≤ initialize ≤ sessionNewStarted ≤ sessionNewResolved', async () => {
      const { client, mock } = createClientWithMock()

      const initP = client.initialize()
      await new Promise((r) => setTimeout(r, 5))
      const initReq = JSON.parse(mock.stdinData[0]!)
      mock.stdout.push(
        jsonRpcResponse(initReq.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP

      const sessionP = client.createSession('/tmp/cwd')
      await new Promise((r) => setTimeout(r, 5))
      const sessionReq = JSON.parse(mock.stdinData[1]!)
      mock.stdout.push(
        jsonRpcResponse(sessionReq.id, { sessionId: 'acp-sess-1', models: {} }),
      )
      await sessionP

      const t = client.timings
      expect(t.processSpawnStartedAt).not.toBeNull()
      expect(t.initializeResolvedAt).not.toBeNull()
      expect(t.sessionNewStartedAt).not.toBeNull()
      expect(t.sessionNewResolvedAt).not.toBeNull()
      expect(t.processSpawnStartedAt!).toBeLessThanOrEqual(t.initializeResolvedAt!)
      expect(t.initializeResolvedAt!).toBeLessThanOrEqual(t.sessionNewStartedAt!)
      expect(t.sessionNewStartedAt!).toBeLessThanOrEqual(t.sessionNewResolvedAt!)
    })

    it('snapshot returned by `timings` getter is a fresh object (not a live reference)', () => {
      // Guards against accidental mutation through the returned object.
      const { client } = createClientWithMock()
      const snap1 = client.timings
      const snap2 = client.timings
      // Two separate snapshots should be value-equal but reference-distinct,
      // so callers can safely retain a snapshot for later comparison.
      expect(snap1).toEqual(snap2)
      expect(snap1).not.toBe(snap2)
    })

    it('resets initialize marks on a fresh initialize() call', async () => {
      const { client, mock } = createClientWithMock()

      // First initialize.
      const initP1 = client.initialize()
      await new Promise((r) => setTimeout(r, 5))
      const initReq1 = JSON.parse(mock.stdinData[0]!)
      mock.stdout.push(
        jsonRpcResponse(initReq1.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP1
      const t1 = client.timings
      expect(t1.initializeResolvedAt).not.toBeNull()

      // Sleep a hair so a fresh Date.now() is guaranteed strictly greater.
      await new Promise((r) => setTimeout(r, 5))

      // Second initialize — marks must reset and re-populate from the new
      // attempt, not carry stale values from the first.
      const initP2 = client.initialize()
      await new Promise((r) => setTimeout(r, 5))
      const midT = client.timings
      // Resolved mark must be cleared between spawn-start and re-resolve.
      expect(midT.initializeResolvedAt).toBeNull()
      // Spawn-start mark must be updated to the new spawn moment.
      expect(midT.processSpawnStartedAt!).toBeGreaterThanOrEqual(t1.processSpawnStartedAt!)

      const initReq2 = JSON.parse(mock.stdinData[1]!)
      mock.stdout.push(
        jsonRpcResponse(initReq2.id, {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: 'copilot', version: '1.0' },
        }),
      )
      await initP2
      const t2 = client.timings
      expect(t2.initializeResolvedAt!).toBeGreaterThanOrEqual(t1.initializeResolvedAt!)
    })
  })
})

describe('createDenyAllPermissionPolicy', () => {
  const opts = [
    { optionId: 'allow-once', kind: 'allow_once' },
    { optionId: 'allow-always', kind: 'allow_always' },
    { optionId: 'reject-once', kind: 'reject_once' },
  ]

  it('rejects execute (never auto-allows command-running) by selecting reject_once', () => {
    const policy = createDenyAllPermissionPolicy()
    const decision = policy.decide({
      sessionId: 's',
      toolCall: { toolCallId: 't', title: 'Run the full test suite', kind: 'execute' },
      options: opts,
    })
    expect(decision).toEqual({ outcome: 'selected', optionId: 'reject-once' })
  })

  it.each(['read', 'edit', 'search', 'fetch', 'think', 'other', 'delete', 'move'])(
    'rejects %s kind too (deny-all, not just destructive)',
    (kind) => {
      const decision = createDenyAllPermissionPolicy().decide({
        sessionId: 's',
        toolCall: { toolCallId: 't', title: 'x', kind },
        options: opts,
      })
      expect(decision).toEqual({ outcome: 'selected', optionId: 'reject-once' })
    },
  )

  it('falls back to any reject_* option when reject_once is absent', () => {
    const decision = createDenyAllPermissionPolicy().decide({
      sessionId: 's',
      toolCall: { toolCallId: 't', title: 'x', kind: 'execute' },
      options: [
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'reject-always', kind: 'reject_always' },
      ],
    })
    expect(decision).toEqual({ outcome: 'selected', optionId: 'reject-always' })
  })

  it('cancels when the agent offers no reject option at all', () => {
    const decision = createDenyAllPermissionPolicy().decide({
      sessionId: 's',
      toolCall: { toolCallId: 't', title: 'x', kind: 'execute' },
      options: [{ optionId: 'allow-always', kind: 'allow_always' }],
    })
    expect(decision).toEqual({ outcome: 'cancelled' })
  })
})

// ── T057 [US5] (specs/001-learning-memory-loop) — ASYNC human-in-the-loop permission path ────────
describe('T057 — humanPermission: async human-in-the-loop with pending tracking + cancel resolution', () => {
  async function bootstrapHuman(opts?: Partial<AcpClientOptions>) {
    const setup = createClientWithMock(opts)
    const initP = setup.client.initialize()
    await new Promise((r) => setTimeout(r, 10))
    const initReq = JSON.parse(setup.mock.stdinData[0]!)
    setup.mock.stdout.push(
      jsonRpcResponse(initReq.id, {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'copilot', version: '1.0' },
      }),
    )
    await initP
    return setup
  }

  const PERM_PARAMS = {
    sessionId: 'sess-h',
    toolCall: { toolCallId: 'tc-h', title: 'Ask the human', kind: 'other' },
    options: [
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ],
  }

  function pushPermission(mock: ReturnType<typeof createMockProcess>, id: number): void {
    mock.stdout.push(
      JSON.stringify({ jsonrpc: '2.0', id, method: 'session/request_permission', params: PERM_PARAMS }) +
        '\n',
    )
  }

  it('POSITIVE: the reply WAITS for the human and carries the human decision; the exchange is logged', async () => {
    let resolveHuman!: (o: { outcome: 'selected'; optionId: string }) => void
    const decisions: unknown[] = []
    const { mock } = await bootstrapHuman({
      humanPermission: () =>
        new Promise((res) => {
          resolveHuman = res
        }),
      onPermissionDecision: (e) => decisions.push(e),
    })
    const before = mock.stdinData.length
    pushPermission(mock, 2001)
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.stdinData.length).toBe(before) // still PENDING — nothing auto-decided
    resolveHuman({ outcome: 'selected', optionId: 'allow-once' })
    await new Promise((r) => setTimeout(r, 20))
    const reply = JSON.parse(mock.stdinData[mock.stdinData.length - 1]!)
    expect(reply.id).toBe(2001)
    expect(reply.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    expect(decisions).toHaveLength(1) // the human exchange lands in the audit/decision log
  })

  it('NEGATIVE (fail-safe): a rejecting human channel cancels the request, never throws', async () => {
    const { mock } = await bootstrapHuman({
      humanPermission: () => Promise.reject(new Error('human channel down')),
    })
    pushPermission(mock, 2002)
    await new Promise((r) => setTimeout(r, 30))
    const reply = JSON.parse(mock.stdinData[mock.stdinData.length - 1]!)
    expect(reply.id).toBe(2002)
    expect(reply.result).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('ACP contract: cancelSession resolves every PENDING human request with cancelled', async () => {
    const { client, mock } = await bootstrapHuman({
      humanPermission: () => new Promise(() => {}), // never resolves — the human walked away
    })
    pushPermission(mock, 2003)
    await new Promise((r) => setTimeout(r, 20))
    client.cancelSession('sess-h')
    await new Promise((r) => setTimeout(r, 20))
    const replies = mock.stdinData.map((s) => JSON.parse(s)).filter((m) => m.id === 2003)
    expect(replies).toHaveLength(1)
    expect(replies[0].result).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('NEGATIVE control: without humanPermission the synchronous policy path is byte-identical', async () => {
    const { mock } = await bootstrapHuman()
    pushPermission(mock, 2004)
    await new Promise((r) => setTimeout(r, 20))
    const reply = JSON.parse(mock.stdinData[mock.stdinData.length - 1]!)
    expect(reply.id).toBe(2004)
    expect(reply.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  })
})
