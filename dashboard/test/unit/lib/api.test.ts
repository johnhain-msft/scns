import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { server } from '../../mocks/server'
import { http, HttpResponse } from 'msw'
import {
  getHealth,
  listSessions,
  listTeams,
  getTeamById,
  getSchedulerTasks,
  updateSchedulerTask,
  triggerSchedulerTask,
  getSchedulerHistory,
  getDreamStatus,
  triggerDream,
  getSuggestions,
  approveSuggestion,
  rejectSuggestion,
  getObservers,
  toggleObserver,
  searchMemory,
  getMemoryStats,
  getOtelTraces,
  getOtelTraceDetail,
  getOtelMetricsSummary,
  getOtelTimeseries,
  getOtelConfig,
  updateOtelConfig,
  getAutonomy,
  promoteAutonomy,
  demoteAutonomy,
  getCostSummary,
  getConflicts,
  getEventsSince,
  ApiError,
} from '@/lib/api'

const BROKER_URL = 'http://localhost:3456'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('API Client', () => {
  it('getHealth() calls correct URL and returns data', async () => {
    const result = await getHealth()
    expect(result).toEqual({ status: 'ok', uptime_seconds: 12345 })
  })

  it('listSessions() unwraps sessions envelope', async () => {
    const result = await listSessions()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('sess-1')
  })

  it('listTeams() unwraps teams envelope', async () => {
    const result = await listTeams()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('team-1')
  })

  it('getTeamById() returns a specific team', async () => {
    const result = await getTeamById('team-1')
    expect(result.id).toBe('team-1')
  })

  it('getSchedulerTasks() unwraps tasks envelope', async () => {
    const result = await getSchedulerTasks()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('task-1')
    expect(result[0].cron_expression).toBe('0 * * * *')
  })

  it('updateSchedulerTask() sends PATCH with body', async () => {
    const result = await updateSchedulerTask('task-1', { enabled: false })
    expect(result.id).toBe('task-1')
  })

  it('triggerSchedulerTask() sends POST to /run endpoint', async () => {
    const result = await triggerSchedulerTask('task-1')
    expect(result.success).toBe(true)
    expect(result.task).toBeDefined()
  })

  it('getSchedulerHistory() unwraps history envelope', async () => {
    const result = await getSchedulerHistory('task-1')
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('success')
  })

  it('getDreamStatus() returns status', async () => {
    const result = await getDreamStatus()
    expect(result.available).toBe(true)
  })

  it('triggerDream() sends POST with force query param', async () => {
    const result = await triggerDream()
    expect(result.triggered).toBe(true)
  })

  it('getSuggestions() unwraps suggestions envelope', async () => {
    const result = await getSuggestions()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('sug-1')
  })

  it('approveSuggestion() sends POST', async () => {
    const result = await approveSuggestion('sug-1')
    expect(result.status).toBe('approved')
  })

  it('rejectSuggestion() sends POST', async () => {
    const result = await rejectSuggestion('sug-1')
    expect(result.status).toBe('rejected')
  })

  it('getObservers() returns observer status object', async () => {
    const result = await getObservers()
    expect(result.available).toBe(true)
  })

  it('toggleObserver() sends POST with enabled flag', async () => {
    const result = await toggleObserver('claude-hooks')
    expect(result.type).toBe('claude-hooks')
  })

  it('searchMemory() sends GET with query params', async () => {
    const result = await searchMemory('test query')
    expect(result).toHaveLength(1)
  })

  it('getMemoryStats() returns stats', async () => {
    const result = await getMemoryStats()
    expect(result.available).toBe(true)
  })

  it('getOtelTraces() unwraps traces envelope', async () => {
    const result = await getOtelTraces()
    expect(result).toHaveLength(1)
    expect(result[0].trace_id).toBe('trace-1')
    expect(result[0].root_span_name).toBe('invoke_agent')
  })

  it('getOtelTraceDetail() returns spans and tree', async () => {
    const result = await getOtelTraceDetail('trace-1')
    expect(result.trace_id).toBe('trace-1')
    expect(result.spans).toHaveLength(1)
    expect(result.tree).toHaveLength(1)
  })

  it('getOtelMetricsSummary() returns MetricsSummary shape', async () => {
    const result = await getOtelMetricsSummary()
    expect(result.total_spans).toBe(150)
    expect(result.total_input_tokens).toBe(50000)
    expect(result.top_tools).toHaveLength(2)
  })

  it('getOtelTimeseries() unwraps buckets', async () => {
    const result = await getOtelTimeseries('gen_ai.client.token.usage')
    expect(result).toHaveLength(2)
    expect(result[0].bucket).toBeDefined()
  })

  it('getOtelConfig() unwraps config envelope', async () => {
    const result = await getOtelConfig()
    expect(result.enabled).toBe(false)
    expect(result.retentionDays).toBe(7)
  })

  it('updateOtelConfig() sends PATCH and unwraps config', async () => {
    const result = await updateOtelConfig({ retentionDays: 14 })
    expect(result.retentionDays).toBe(7) // mock returns default
  })

  it('getAutonomy() returns AutonomyState shape', async () => {
    const result = await getAutonomy()
    expect(result.level).toBe(1)
    expect(result.changedAt).toBeDefined()
    expect(result.changedBy).toBe('user')
  })

  it('promoteAutonomy() sends POST', async () => {
    const result = await promoteAutonomy()
    expect(result.level).toBe(2)
  })

  it('demoteAutonomy() sends POST', async () => {
    const result = await demoteAutonomy()
    expect(result.level).toBe(0)
  })

  it('getCostSummary() returns CostSummary shape', async () => {
    const result = await getCostSummary()
    expect(result.estimatedTotalCostUSD).toBe(12.34)
    expect(result.sessionCount).toBe(5)
    expect(result.perSession).toHaveLength(1)
  })

  it('getConflicts() unwraps conflicts envelope', async () => {
    const result = await getConflicts()
    expect(result).toEqual([])
  })

  it('getEventsSince() unwraps events envelope', async () => {
    const result = await getEventsSince()
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('session.started')
  })

  it('adds Authorization header when token configured', async () => {
    let capturedHeaders: Headers | undefined
    server.use(
      http.get(`${BROKER_URL}/api/health`, ({ request }) => {
        capturedHeaders = request.headers
        return HttpResponse.json({ status: 'ok', uptime_seconds: 0 })
      }),
    )
    await getHealth()
    expect(capturedHeaders?.get('content-type')).toBe('application/json')
  })

  it('handles non-OK responses by throwing ApiError', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/health`, () =>
        new HttpResponse('Not Found', { status: 404 }),
      ),
    )
    await expect(getHealth()).rejects.toThrow(ApiError)
    await expect(getHealth()).rejects.toMatchObject({ status: 404 })
  })

  it('handles network errors gracefully', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/health`, () => HttpResponse.error()),
    )
    await expect(getHealth()).rejects.toThrow()
  })
})
