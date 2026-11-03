import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { renderWithProviders } from '../../helpers/render'
import { checkA11y } from '../../helpers/a11y'
import OrchestratorPage from '@/app/orchestrator/page'

const BROKER_URL = 'http://localhost:3456'

const mockOverview = {
  teams: [
    {
      id: 'team-orchestrator-1',
      name: 'Alpha',
      status: 'active',
      created_at: '2026-04-17T00:00:00Z',
      members: [
        {
          session_id: 'sess-1',
          name: 'dev-one',
          role: 'dev',
          agent_type: 'scns-dev',
          status: 'working',
          joined_at: '2026-04-17T00:00:00Z',
          last_heartbeat: new Date().toISOString(),
          session_status: 'active',
        },
      ],
    },
  ],
  suggestions: [
    {
      id: 'sugg-1',
      title: 'Extract auth helper',
      type: 'skill',
      status: 'pending',
      confidence: 0.82,
    },
  ],
  verdicts: [
    {
      id: 1,
      event_type: 'quality_gate_verdict',
      session_id: null,
      payload: JSON.stringify({ verdict: 'pass', teamId: 'team-orchestrator-1', reason: 'All green' }),
      created_at: new Date().toISOString(),
    },
  ],
  completions: [
    {
      id: 2,
      event_type: 'team_completed',
      session_id: null,
      payload: JSON.stringify({
        teamId: 'team-orchestrator-1',
        outcome: 'completed',
        stagedDiff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-foo\n+bar',
      }),
      created_at: new Date().toISOString(),
    },
  ],
  messages: [
    {
      id: 'msg-1',
      sender_id: 'sess-1',
      receiver_id: 'sess-2',
      team_id: 'team-orchestrator-1',
      content: 'Shipping the branch',
      created_at: new Date().toISOString(),
    },
  ],
  scalingDecisions: [
    {
      id: 1,
      task_signature: 'sig:aaaa',
      task_snippet: 'add rate limit to broker',
      hint_shape: 'team',
      chosen_shape: 'solo',
      roles: [],
      reasoning: 'override team→solo: 3/3 solo runs succeeded',
      history_count: 3,
      source_suggestion_id: 'sugg-7',
      created_at: new Date().toISOString(),
      outcome_success: 1,
      outcome_quality: 0.92,
    },
  ],
}

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('OrchestratorPage', () => {
  beforeEach(() => {
    server.use(
      http.get(`${BROKER_URL}/api/orchestrator/overview`, () => HttpResponse.json(mockOverview)),
    )
  })

  it('renders Orchestrator heading', () => {
    renderWithProviders(<OrchestratorPage />)
    expect(screen.getByRole('heading', { level: 1, name: /orchestrator/i })).toBeInTheDocument()
  })

  it('shows all five panel headings', async () => {
    renderWithProviders(<OrchestratorPage />)
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /active teams/i })).toBeInTheDocument()
    })
    expect(screen.getByRole('heading', { name: /suggestions in-flight/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /quality gate verdicts/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /team completions/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /recent messages/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /scaling decisions/i })).toBeInTheDocument()
  })

  it('renders scaling decision with reasoning and override badge', async () => {
    renderWithProviders(<OrchestratorPage />)
    await waitFor(() => {
      expect(screen.getByText(/add rate limit to broker/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/override team.*solo/i)).toBeInTheDocument()
    expect(screen.getByText(/overrode hint: team/i)).toBeInTheDocument()
  })

  it('renders team with members', async () => {
    renderWithProviders(<OrchestratorPage />)
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument()
    })
    expect(screen.getByText(/dev-one/)).toBeInTheDocument()
  })

  it('renders pending suggestion with confidence', async () => {
    renderWithProviders(<OrchestratorPage />)
    await waitFor(() => {
      expect(screen.getByText('Extract auth helper')).toBeInTheDocument()
    })
    expect(screen.getByText(/confidence 82%/i)).toBeInTheDocument()
  })

  it('renders PASS badge for passing verdict', async () => {
    renderWithProviders(<OrchestratorPage />)
    await waitFor(() => {
      expect(screen.getByText('PASS')).toBeInTheDocument()
    })
    expect(screen.getByText(/all green/i)).toBeInTheDocument()
  })

  it('renders staged diff preview for team completion', async () => {
    renderWithProviders(<OrchestratorPage />)
    await waitFor(() => {
      expect(screen.getByText(/diff --git/)).toBeInTheDocument()
    })
  })

  it('shows empty states when panels have no data', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/orchestrator/overview`, () =>
        HttpResponse.json({
          teams: [],
          suggestions: [],
          verdicts: [],
          completions: [],
          messages: [],
          scalingDecisions: [],
        }),
      ),
    )
    renderWithProviders(<OrchestratorPage />)
    await waitFor(() => {
      expect(screen.getByText(/no active teams/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/no suggestions in-flight/i)).toBeInTheDocument()
    expect(screen.getByText(/no quality gate verdicts/i)).toBeInTheDocument()
    expect(screen.getByText(/no team completions/i)).toBeInTheDocument()
    expect(screen.getByText(/no recent messages/i)).toBeInTheDocument()
    expect(screen.getByText(/no scaling decisions recorded yet/i)).toBeInTheDocument()
  })

  it('shows error banner when API fails', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/orchestrator/overview`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )
    renderWithProviders(<OrchestratorPage />)
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/failed to load/i)
    })
  })

  it('has no axe-core violations', async () => {
    const { container } = renderWithProviders(<OrchestratorPage />)
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument()
    })
    const violations = await checkA11y(container)
    expect(violations).toEqual([])
  })
})
