import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  TOOL_DEFINITIONS,
  createToolHandlers,
  toSdkTools,
} from '../../../src/copilot-extension/tool-definitions.js'

describe('tool-definitions', () => {
  describe('TOOL_DEFINITIONS', () => {
    it('defines 21 tools', () => {
      expect(TOOL_DEFINITIONS).toHaveLength(21)
    })

    it('all tools have unique names', () => {
      const names = TOOL_DEFINITIONS.map((t) => t.name)
      expect(new Set(names).size).toBe(names.length)
    })

    it('all tools have scns_ prefix', () => {
      for (const tool of TOOL_DEFINITIONS) {
        expect(tool.name).toMatch(/^scns_/)
      }
    })

    it('all tools have description and parameters', () => {
      for (const tool of TOOL_DEFINITIONS) {
        expect(tool.description.length).toBeGreaterThan(10)
        expect(tool.parameters.type).toBe('object')
      }
    })

    it('scns_memory_search requires query', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'scns_memory_search')!
      expect(tool.parameters.required).toContain('query')
    })

    it('scns_memory_store requires key and value', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'scns_memory_store')!
      expect(tool.parameters.required).toContain('key')
      expect(tool.parameters.required).toContain('value')
    })

    it('scns_suggestions has optional status param', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'scns_suggestions')!
      expect(tool.parameters.properties['status']).toBeDefined()
      expect(tool.parameters.required).toBeUndefined()
    })

    it('scns_status has no required params', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'scns_status')!
      expect(tool.parameters.required).toBeUndefined()
    })

    // ── New team tool definitions ──────────────────────────────

    it('scns_send_message requires sender_id and content', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'scns_send_message')!
      expect(tool).toBeDefined()
      expect(tool.parameters.required).toContain('sender_id')
      expect(tool.parameters.required).toContain('content')
      expect(tool.parameters.properties['receiver_id']).toBeDefined()
    })

    it('scns_read_messages requires receiver_id', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'scns_read_messages')!
      expect(tool).toBeDefined()
      expect(tool.parameters.required).toContain('receiver_id')
      expect(tool.parameters.properties['unread_only']).toBeDefined()
    })

    it('scns_team_status requires team_id', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'scns_team_status')!
      expect(tool).toBeDefined()
      expect(tool.parameters.required).toContain('team_id')
    })

    it('scns_declare_intent requires session_id and file', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'scns_declare_intent')!
      expect(tool).toBeDefined()
      expect(tool.parameters.required).toContain('session_id')
      expect(tool.parameters.required).toContain('file')
      expect(tool.parameters.properties['operation']).toBeDefined()
    })

    it('scns_release_intent requires session_id and file', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'scns_release_intent')!
      expect(tool).toBeDefined()
      expect(tool.parameters.required).toContain('session_id')
      expect(tool.parameters.required).toContain('file')
    })

    it('scns_set_state requires key and value', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'scns_set_state')!
      expect(tool).toBeDefined()
      expect(tool.parameters.required).toContain('key')
      expect(tool.parameters.required).toContain('value')
      expect(tool.parameters.properties['session_id']).toBeDefined()
    })

    it('scns_get_state requires key', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'scns_get_state')!
      expect(tool).toBeDefined()
      expect(tool.parameters.required).toContain('key')
    })

    it('scns_report_progress requires sender_id and progress', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'scns_report_progress')!
      expect(tool).toBeDefined()
      expect(tool.parameters.required).toContain('sender_id')
      expect(tool.parameters.required).toContain('progress')
    })

    it('scns_memory_delete requires path', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'scns_memory_delete')!
      expect(tool).toBeDefined()
      expect(tool.parameters.required).toContain('path')
      // Destructiveness must be opt-in at the schema level, not a default.
      expect(tool.parameters.properties['apply']).toBeDefined()
      expect(tool.description).toMatch(/preview/i)
    })

    it('scns_heartbeat requires session_id', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'scns_heartbeat')!
      expect(tool).toBeDefined()
      expect(tool.parameters.required).toContain('session_id')
    })
  })

  describe('createToolHandlers', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch')
    })

    afterEach(() => {
      fetchSpy.mockRestore()
    })

    it('creates handlers for all 21 tools', () => {
      const tools = createToolHandlers('http://localhost:3456')
      expect(tools).toHaveLength(21)
      for (const tool of tools) {
        expect(typeof tool.handler).toBe('function')
      }
    })

    it('scns_memory_search calls /api/memory/search', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ content: 'test memory' }] }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const searchTool = tools.find((t) => t.definition.name === 'scns_memory_search')!
      const result = await searchTool.handler({ query: 'authentication', top_k: 3 })

      const parsed = JSON.parse(result)
      expect(parsed.results).toBeDefined()
      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/memory/search?q=authentication&top_k=3')
    })

    it('scns_memory_store calls /api/memory/store', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ stored: true, key: 'test-fact' }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const storeTool = tools.find((t) => t.definition.name === 'scns_memory_store')!
      await storeTool.handler({ key: 'test-fact', value: 'Use JWT for auth' })

      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/memory/store')
      const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
      expect(body.key).toBe('test-fact')
      expect(body.value).toBe('Use JWT for auth')
    })

    it('scns_memory_delete previews by default and only applies when asked', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ applied: false }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const deleteTool = tools.find((t) => t.definition.name === 'scns_memory_delete')!

      await deleteTool.handler({ path: 'negative/abc.md' })
      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/memory/delete')
      const preview = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
      expect(preview.path).toBe('negative/abc.md')
      expect(preview.apply).toBe(false)
      expect(preview.hard).toBe(false)
      expect(preview.allow_pinned).toBe(false)

      await deleteTool.handler({ path: 'negative/abc.md', apply: true, hard: true })
      const applied = JSON.parse(fetchSpy.mock.calls[1]![1]?.body as string)
      expect(applied.apply).toBe(true)
      expect(applied.hard).toBe(true)
    })

    it('scns_suggestions calls /api/suggestions', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ suggestions: [] }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const sugTool = tools.find((t) => t.definition.name === 'scns_suggestions')!
      await sugTool.handler({ status: 'approved' })

      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/suggestions?status=approved')
    })

    it('scns_status calls both /api/observers and /api/autonomy', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ state: 'running', observers: [] }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ level: 0, label: 'Observer' }), { status: 200 }),
        )

      const tools = createToolHandlers('http://localhost:3456')
      const statusTool = tools.find((t) => t.definition.name === 'scns_status')!
      const result = await statusTool.handler({})

      const parsed = JSON.parse(result)
      expect(parsed.observers).toBeDefined()
      expect(parsed.autonomy).toBeDefined()
    })

    it('returns error JSON when broker is unavailable', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const tools = createToolHandlers('http://localhost:9999')
      const searchTool = tools.find((t) => t.definition.name === 'scns_memory_search')!
      const result = await searchTool.handler({ query: 'test' })

      const parsed = JSON.parse(result)
      expect(parsed.error).toBeDefined()
      expect(parsed.available).toBe(false)
    })

    it('returns error JSON on HTTP error', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))

      const tools = createToolHandlers('http://localhost:3456')
      const searchTool = tools.find((t) => t.definition.name === 'scns_memory_search')!
      const result = await searchTool.handler({ query: 'test' })

      const parsed = JSON.parse(result)
      expect(parsed.error).toContain('HTTP 500')
    })

    it('uses custom timeout', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }))

      const tools = createToolHandlers('http://localhost:3456', 1000)
      const searchTool = tools.find((t) => t.definition.name === 'scns_memory_search')!
      await searchTool.handler({ query: 'test' })

      const options = fetchSpy.mock.calls[0]![1] as RequestInit
      expect(options.signal).toBeDefined()
    })

    // ── New team tool handler tests ──────────────────────────────

    it('scns_send_message POSTs to /api/messages', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ sent: true }), { status: 200 }))

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_send_message')!
      const result = await tool.handler({ sender_id: 'agent-1', content: 'hello team' })

      const parsed = JSON.parse(result)
      expect(parsed.sent).toBe(true)
      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/messages')
      const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
      expect(body.sender_id).toBe('agent-1')
      expect(body.content).toBe('hello team')
    })

    it('scns_send_message includes receiver_id when provided', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ sent: true }), { status: 200 }))

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_send_message')!
      await tool.handler({ sender_id: 'agent-1', receiver_id: 'agent-2', content: 'direct msg' })

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
      expect(body.receiver_id).toBe('agent-2')
    })

    it('scns_send_message omits receiver_id when not provided', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ sent: true }), { status: 200 }))

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_send_message')!
      await tool.handler({ sender_id: 'agent-1', content: 'broadcast' })

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
      expect(body.receiver_id).toBeUndefined()
    })

    it('scns_send_message returns error on failure', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_send_message')!
      const result = await tool.handler({ sender_id: 'agent-1', content: 'hello' })

      const parsed = JSON.parse(result)
      expect(parsed.error).toBeDefined()
    })

    it('scns_read_messages GETs /api/messages/:receiverId', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ content: 'hi' }] }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_read_messages')!
      const result = await tool.handler({ receiver_id: 'agent-1' })

      const parsed = JSON.parse(result)
      expect(parsed.messages).toBeDefined()
      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/messages/agent-1')
    })

    it('scns_read_messages appends unread_only query param', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_read_messages')!
      await tool.handler({ receiver_id: 'agent-1', unread_only: true })

      expect(fetchSpy.mock.calls[0]![0]).toContain('unread_only=true')
    })

    it('scns_team_status GETs /api/teams/:teamId', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ team: 'alpha', members: [] }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_team_status')!
      const result = await tool.handler({ team_id: 'team-alpha' })

      const parsed = JSON.parse(result)
      expect(parsed.team).toBe('alpha')
      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/teams/team-alpha')
    })

    it('scns_declare_intent POSTs to /api/declare_intent', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ declared: true }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_declare_intent')!
      await tool.handler({ session_id: 's1', file: 'src/main.ts', operation: 'edit' })

      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/declare_intent')
      const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
      expect(body.session_id).toBe('s1')
      expect(body.file).toBe('src/main.ts')
      expect(body.operation).toBe('edit')
    })

    it('scns_declare_intent omits operation when not provided', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ declared: true }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_declare_intent')!
      await tool.handler({ session_id: 's1', file: 'src/main.ts' })

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
      expect(body.operation).toBeUndefined()
    })

    it('scns_release_intent POSTs to /api/release_intent', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ released: true }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_release_intent')!
      await tool.handler({ session_id: 's1', file: 'src/main.ts' })

      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/release_intent')
      const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
      expect(body.session_id).toBe('s1')
      expect(body.file).toBe('src/main.ts')
    })

    it('scns_set_state POSTs to /api/state', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ stored: true }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_set_state')!
      await tool.handler({ key: 'phase', value: 'testing', session_id: 's1' })

      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/state')
      const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
      expect(body.key).toBe('phase')
      expect(body.value).toBe('testing')
      expect(body.session_id).toBe('s1')
    })

    it('scns_set_state omits session_id when not provided', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ stored: true }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_set_state')!
      await tool.handler({ key: 'phase', value: 'testing' })

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
      expect(body.session_id).toBeUndefined()
    })

    it('scns_get_state GETs /api/state/:key', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ key: 'phase', value: 'testing' }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_get_state')!
      const result = await tool.handler({ key: 'phase' })

      const parsed = JSON.parse(result)
      expect(parsed.value).toBe('testing')
      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/state/phase')
    })

    it('scns_report_progress sends team-scoped messages', async () => {
      // First call: fetch teams to find sender's team
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ teams: [{ id: 'team-1', name: 'Alpha' }] }), { status: 200 }),
      )
      // Second call: fetch team members
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ members: [{ session_id: 'agent-1' }, { session_id: 'agent-2' }] }),
          { status: 200 },
        ),
      )
      // Third call: send direct message to agent-2
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ sent: true }), { status: 201 }))

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_report_progress')!
      const result = await tool.handler({ sender_id: 'agent-1', progress: '50% complete' })

      const parsed = JSON.parse(result)
      expect(parsed.sent).toBe(true)
      expect(parsed.team_id).toBe('team-1')
    })

    it('scns_heartbeat POSTs to /api/heartbeat', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_heartbeat')!
      await tool.handler({ session_id: 's1' })

      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/heartbeat')
      const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
      expect(body.session_id).toBe('s1')
    })

    it('scns_list_teams calls GET /api/teams', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ teams: [{ id: 't1', name: 'Alpha' }] }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_list_teams')!
      const result = await tool.handler({})

      const parsed = JSON.parse(result)
      expect(parsed.teams).toHaveLength(1)
      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/teams?status=active')
    })

    it('scns_list_intents calls GET /api/intents', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ intents: [] }), { status: 200 }))

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_list_intents')!
      const result = await tool.handler({ file: 'src/index.ts' })

      const parsed = JSON.parse(result)
      expect(parsed.intents).toEqual([])
      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/intents?file=src%2Findex.ts')
    })

    it('scns_create_task POSTs to /api/tasks', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1, subject: 'Fix bug', team_id: 't1' }), { status: 201 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_create_task')!
      const result = await tool.handler({
        team_id: 't1',
        subject: 'Fix bug',
        description: 'Fix the auth bug',
      })

      const parsed = JSON.parse(result)
      expect(parsed.subject).toBe('Fix bug')
      const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
      expect(body.team_id).toBe('t1')
      expect(body.subject).toBe('Fix bug')
      expect(body.description).toBe('Fix the auth bug')
    })

    it('scns_list_tasks calls GET /api/tasks with team_id', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ tasks: [{ id: 1, subject: 'Task 1' }] }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_list_tasks')!
      const result = await tool.handler({ team_id: 't1', status: 'working' })

      const parsed = JSON.parse(result)
      expect(parsed.tasks).toHaveLength(1)
      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/tasks?team_id=t1&status=working')
    })

    it('scns_update_task PATCHes /api/tasks/:id', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 5, status: 'completed' }), { status: 200 }),
      )

      const tools = createToolHandlers('http://localhost:3456')
      const tool = tools.find((t) => t.definition.name === 'scns_update_task')!
      const result = await tool.handler({ task_id: 5, status: 'completed' })

      const parsed = JSON.parse(result)
      expect(parsed.status).toBe('completed')
      expect(fetchSpy.mock.calls[0]![0]).toContain('/api/tasks/5')
      expect(fetchSpy.mock.calls[0]![1]?.method).toBe('PATCH')
    })
  })

  describe('toSdkTools', () => {
    it('produces tools with name, description, parameters, and handler', () => {
      const tools = toSdkTools('http://localhost:3456')

      expect(tools).toHaveLength(21)
      for (const tool of tools) {
        expect(tool.name).toMatch(/^scns_/)
        expect(tool.description).toBeDefined()
        expect(tool.parameters).toBeDefined()
        expect(typeof tool.handler).toBe('function')
      }
    })
  })
})
