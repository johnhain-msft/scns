import { describe, it, expect, vi } from 'vitest'
import {
  dispatchResearch,
  type FetchLike,
  type HttpResponseLike,
} from '../../../src/cli/research-command.js'

function res(status: number, body: unknown): HttpResponseLike {
  return { status, text: async () => JSON.stringify(body) }
}

/** A fetch that returns canned responses per endpoint, recording calls. */
function makeFetch(handlers: Record<string, HttpResponseLike>): {
  fetch: FetchLike
  calls: { url: string; body: unknown }[]
} {
  const calls: { url: string; body: unknown }[] = []
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    const key = Object.keys(handlers).find((k) => url.endsWith(k))
    if (!key) throw new Error(`no handler for ${url}`)
    return handlers[key]!
  }
  return { fetch: fetchFn, calls }
}

describe('dispatchResearch — on-demand researcher orchestration', () => {
  it('creates team → task → spawns a scns-researcher and returns the ids', async () => {
    const { fetch, calls } = makeFetch({
      '/api/teams': res(201, { id: 'research-abc123', name: 'research-abc123' }),
      '/api/tasks': res(201, { id: 42, subject: 'why does X stall?' }),
      '/api/tasks/42/spawn': res(201, { session_id: 'sess-9', team_id: 'research-abc123', task_id: 42 }),
    })

    const result = await dispatchResearch(
      { question: 'why does X stall?', brokerUrl: 'http://localhost:3456', workingDir: '/repo' },
      { fetch, genId: () => 'abc123' },
    )

    expect(result).toEqual({ teamId: 'research-abc123', taskId: 42, sessionId: 'sess-9' })
    // team named from the id; task carries the question; spawn uses the canonical role.
    expect(calls[0]!.url).toBe('http://localhost:3456/api/teams')
    expect(calls[0]!.body).toMatchObject({ name: 'research-abc123' })
    expect(calls[1]!.body).toMatchObject({ team_id: 'research-abc123', subject: 'why does X stall?' })
    expect(calls[2]!.url).toBe('http://localhost:3456/api/tasks/42/spawn')
    expect(calls[2]!.body).toMatchObject({ role: 'scns-researcher', launch_method: 'acp', working_dir: '/repo' })
  })

  it('trims a trailing slash from the broker url', async () => {
    const { fetch, calls } = makeFetch({
      '/api/teams': res(201, { id: 't1' }),
      '/api/tasks': res(201, { id: 1 }),
      '/api/tasks/1/spawn': res(201, { session_id: 's1' }),
    })
    await dispatchResearch(
      { question: 'q', brokerUrl: 'http://localhost:3456/', },
      { fetch, genId: () => 'x' },
    )
    expect(calls[0]!.url).toBe('http://localhost:3456/api/teams')
  })

  it('rejects an empty question before any HTTP call', async () => {
    const fetch = vi.fn()
    await expect(
      dispatchResearch({ question: '   ', brokerUrl: 'http://localhost:3456' }, { fetch }),
    ).rejects.toThrow(/must not be empty/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('surfaces a broker error (non-2xx) with the endpoint and status', async () => {
    const { fetch } = makeFetch({
      '/api/teams': res(500, { error: 'boom' }),
    })
    await expect(
      dispatchResearch({ question: 'q', brokerUrl: 'http://localhost:3456' }, { fetch, genId: () => 'x' }),
    ).rejects.toThrow(/\/api\/teams failed \(HTTP 500\)/)
  })

  it('fails clearly if the spawn response lacks a session id', async () => {
    const { fetch } = makeFetch({
      '/api/teams': res(201, { id: 't1' }),
      '/api/tasks': res(201, { id: 1 }),
      '/api/tasks/1/spawn': res(201, { role: 'scns-researcher' }),
    })
    await expect(
      dispatchResearch({ question: 'q', brokerUrl: 'http://localhost:3456' }, { fetch, genId: () => 'x' }),
    ).rejects.toThrow(/no session_id/)
  })
})
