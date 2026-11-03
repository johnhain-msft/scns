import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import axe from 'axe-core'
import type { ReactNode } from 'react'

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/suggestions',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

const mockPendingSuggestions = [
  {
    id: 'sug-1',
    title: 'Add rate limiting skill',
    description: 'Create a skill for handling API rate limits',
    type: 'skill',
    confidence: 0.92,
    status: 'pending',
    evidence: ['Observed 15 rate limit errors in last 24h', 'Pattern matches known skill gap'],
  },
  {
    id: 'sug-2',
    title: 'Automate log rotation',
    description: 'Set up automated log rotation workflow',
    type: 'automation',
    confidence: 0.78,
    status: 'pending',
    evidence: ['Log files growing unbounded'],
  },
  {
    id: 'sug-3',
    title: 'Deploy monitoring agent',
    description: 'Add a monitoring agent for system health',
    type: 'agent',
    confidence: 0.65,
    status: 'pending',
    evidence: [],
  },
]

const mockApprovedSuggestions = [
  {
    id: 'sug-4',
    title: 'Workflow optimization',
    description: 'Optimize the CI/CD workflow',
    type: 'workflow',
    confidence: 0.88,
    status: 'approved',
    evidence: ['Build times increased 30%'],
  },
]

const mockRejectedSuggestions = [
  {
    id: 'sug-5',
    title: 'Add MCP server',
    description: 'Connect to external MCP server',
    type: 'mcp',
    confidence: 0.45,
    status: 'rejected',
    evidence: [],
  },
]

const mockImplementedSuggestions = [
  {
    id: 'sug-6',
    title: 'Cache optimization',
    description: 'Implemented memory cache layer',
    type: 'skill',
    confidence: 0.95,
    status: 'implemented',
    evidence: ['Cache hit rate improved to 95%'],
  },
]

const mockBlockedAutonomySuggestions = [
  {
    id: 'sug-7',
    title: 'Deploy automation script',
    description: 'Runs deploy.sh on schedule',
    type: 'automation',
    confidence: 0.9,
    status: 'blocked-autonomy',
    evidence: [],
    blockedMetadata: {
      requiredLevel: 3,
      blockedAt: '2026-04-17T12:00:00Z',
    },
  },
]

// Phase 13.12.9 — failed-suggestion fixture
const mockFailedSuggestions = [
  {
    id: 'sug-9-failed',
    title: 'Broken automation',
    description: 'Consistently failing automation',
    type: 'automation',
    confidence: 0.6,
    status: 'failed',
    evidence: [],
    attemptCount: 5,
    lastError: 'RunCommand skipped at autonomy level 2',
    lastAttemptAt: '2026-04-18T10:00:00Z',
    nextRetryAt: null,
  },
]

// Phase 13.12.16 fixtures
const mockNeedsHumanSuggestions = [
  {
    id: 'sug-10-needs-human',
    title: 'Ambiguous workflow',
    description: 'Needs human judgement call',
    type: 'workflow',
    confidence: 0.7,
    status: 'needs-human',
    evidence: [],
    reviewReason: 'blocked by unclear requirements',
  },
]

// Mock API module with vi.hoisted for proper hoisting
const {
  mockGetSuggestions,
  mockApproveSuggestion,
  mockRejectSuggestion,
  mockRetrySuggestion,
  mockDeleteSuggestion,
  mockRepromoteSuggestion,
} = vi.hoisted(() => ({
  mockGetSuggestions: vi.fn(),
  mockApproveSuggestion: vi.fn(),
  mockRejectSuggestion: vi.fn(),
  mockRetrySuggestion: vi.fn(),
  mockDeleteSuggestion: vi.fn(),
  mockRepromoteSuggestion: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  getSuggestions: mockGetSuggestions,
  approveSuggestion: mockApproveSuggestion,
  rejectSuggestion: mockRejectSuggestion,
  retrySuggestion: mockRetrySuggestion,
  deleteSuggestion: mockDeleteSuggestion,
  repromoteSuggestion: mockRepromoteSuggestion,
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

function setupDefaultMocks() {
  mockGetSuggestions.mockImplementation((status?: string) => {
    switch (status) {
      case 'approved':
        return Promise.resolve(mockApprovedSuggestions)
      case 'rejected':
        return Promise.resolve(mockRejectedSuggestions)
      case 'implemented':
        return Promise.resolve(mockImplementedSuggestions)
      case 'blocked-autonomy':
        return Promise.resolve(mockBlockedAutonomySuggestions)
      case 'failed':
        return Promise.resolve(mockFailedSuggestions)
      case 'needs-human':
        return Promise.resolve(mockNeedsHumanSuggestions)
      default:
        return Promise.resolve(mockPendingSuggestions)
    }
  })
  mockApproveSuggestion.mockImplementation((id: string) =>
    Promise.resolve({ id, status: 'approved' }),
  )
  mockRejectSuggestion.mockImplementation((id: string) =>
    Promise.resolve({ id, status: 'rejected' }),
  )
  mockRetrySuggestion.mockImplementation((id: string) =>
    Promise.resolve({ success: true, suggestion: { id, status: 'approved', attemptCount: 0 } }),
  )
  mockDeleteSuggestion.mockImplementation((id: string) => Promise.resolve({ success: true, id }))
  mockRepromoteSuggestion.mockImplementation((id: string) =>
    Promise.resolve({ success: true, suggestion: { id, status: 'pending' } }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  setupDefaultMocks()
})

async function renderSuggestionsPage() {
  const { default: SuggestionsPage } = await import('@/app/suggestions/page')
  return render(<SuggestionsPage />, { wrapper: createWrapper() })
}

describe('SuggestionsPage', () => {
  it('renders "Suggestions" heading', async () => {
    await renderSuggestionsPage()
    expect(screen.getByRole('heading', { name: /suggestions/i })).toBeInTheDocument()
  })

  it('shows tabbed interface: Pending, Approved, Rejected, Implemented', async () => {
    await renderSuggestionsPage()

    expect(screen.getByRole('tab', { name: /pending/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /approved/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /rejected/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /implemented/i })).toBeInTheDocument()
  })

  it('default tab is "Pending"', async () => {
    await renderSuggestionsPage()

    const pendingTab = screen.getByRole('tab', { name: /pending/i })
    expect(pendingTab).toHaveAttribute('aria-selected', 'true')
  })

  it('switching tabs calls API with correct status filter', async () => {
    await renderSuggestionsPage()
    const user = userEvent.setup()

    await waitFor(() => {
      expect(screen.getByText('Add rate limiting skill')).toBeInTheDocument()
    })

    const approvedTab = screen.getByRole('tab', { name: /approved/i })
    await user.click(approvedTab)

    await waitFor(() => {
      expect(mockGetSuggestions).toHaveBeenCalledWith('approved')
    })
  })

  it('each suggestion card shows: type icon, title, confidence score', async () => {
    await renderSuggestionsPage()

    await waitFor(() => {
      expect(screen.getByText('Add rate limiting skill')).toBeInTheDocument()
    })

    // Type icons
    expect(screen.getByText('⚡')).toBeInTheDocument()
    expect(screen.getByText('🤖')).toBeInTheDocument()
    expect(screen.getByText('🧠')).toBeInTheDocument()

    // Confidence scores
    expect(screen.getByText('92%')).toBeInTheDocument()
    expect(screen.getByText('78%')).toBeInTheDocument()
    expect(screen.getByText('65%')).toBeInTheDocument()
  })

  it('confidence score shown as progress bar with percentage', async () => {
    await renderSuggestionsPage()

    await waitFor(() => {
      expect(screen.getByText('Add rate limiting skill')).toBeInTheDocument()
    })

    const progressBars = screen.getAllByRole('progressbar')
    expect(progressBars.length).toBeGreaterThanOrEqual(3)

    const firstBar = progressBars[0]
    expect(firstBar).toHaveAttribute('aria-valuenow', '92')
    expect(firstBar).toHaveAttribute('aria-valuemin', '0')
    expect(firstBar).toHaveAttribute('aria-valuemax', '100')
  })

  it('pending tab shows Approve and Reject buttons', async () => {
    await renderSuggestionsPage()

    await waitFor(() => {
      expect(screen.getByText('Add rate limiting skill')).toBeInTheDocument()
    })

    const approveButtons = screen.getAllByRole('button', { name: /approve/i })
    const rejectButtons = screen.getAllByRole('button', { name: /reject/i })
    expect(approveButtons.length).toBe(mockPendingSuggestions.length)
    expect(rejectButtons.length).toBe(mockPendingSuggestions.length)
  })

  it('approve button calls approveSuggestion API', async () => {
    await renderSuggestionsPage()
    const user = userEvent.setup()

    await waitFor(() => {
      expect(screen.getByText('Add rate limiting skill')).toBeInTheDocument()
    })

    const approveButtons = screen.getAllByRole('button', { name: /approve/i })
    await user.click(approveButtons[0])

    await waitFor(() => {
      expect(mockApproveSuggestion).toHaveBeenCalledWith('sug-1')
    })
  })

  it('reject button calls rejectSuggestion API', async () => {
    await renderSuggestionsPage()
    const user = userEvent.setup()

    await waitFor(() => {
      expect(screen.getByText('Add rate limiting skill')).toBeInTheDocument()
    })

    const rejectButtons = screen.getAllByRole('button', { name: /reject/i })
    await user.click(rejectButtons[0])

    await waitFor(() => {
      expect(mockRejectSuggestion).toHaveBeenCalledWith('sug-1')
    })
  })

  it('approved/rejected/implemented tabs do not show action buttons', async () => {
    await renderSuggestionsPage()
    const user = userEvent.setup()

    await waitFor(() => {
      expect(screen.getByText('Add rate limiting skill')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('tab', { name: /approved/i }))

    await waitFor(() => {
      expect(screen.getByText('Workflow optimization')).toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument()
  })

  it('type filter dropdown filters by suggestion type', async () => {
    await renderSuggestionsPage()
    const user = userEvent.setup()

    await waitFor(() => {
      expect(screen.getByText('Add rate limiting skill')).toBeInTheDocument()
    })

    expect(screen.getByText('Automate log rotation')).toBeInTheDocument()
    expect(screen.getByText('Deploy monitoring agent')).toBeInTheDocument()

    const filterSelect = screen.getByRole('combobox', { name: /filter by type/i })
    await user.selectOptions(filterSelect, 'skill')

    expect(screen.getByText('Add rate limiting skill')).toBeInTheDocument()
    expect(screen.queryByText('Automate log rotation')).not.toBeInTheDocument()
    expect(screen.queryByText('Deploy monitoring agent')).not.toBeInTheDocument()
  })

  it('type filter dropdown has one option per SuggestionType enum value + "All types" (13.12.7)', async () => {
    await renderSuggestionsPage()

    const filterSelect = screen.getByRole('combobox', { name: /filter by type/i }) as HTMLSelectElement
    const values = Array.from(filterSelect.options).map((o) => o.value)

    // "all" + all 12 backend enum values
    const expected = [
      'all',
      'skill',
      'agent',
      'mcp',
      'automation',
      'workflow',
      'prompt',
      'extension',
      'lsp',
      'github-action',
      'agentic-workflow',
      'instruction',
      'tag-proposal',
    ]
    expect(values.sort()).toEqual(expected.sort())
  })

  it('shows empty state per tab when no suggestions', async () => {
    mockGetSuggestions.mockResolvedValue([])
    await renderSuggestionsPage()

    await waitFor(() => {
      expect(screen.getByText(/no.*suggestions/i)).toBeInTheDocument()
    })
  })

  it('shows loading state', async () => {
    mockGetSuggestions.mockReturnValue(new Promise(() => {})) // never resolves
    await renderSuggestionsPage()
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('tab roles are correct (tablist, tab, tabpanel)', async () => {
    await renderSuggestionsPage()

    expect(screen.getByRole('tablist')).toBeInTheDocument()
    expect(screen.getAllByRole('tab').length).toBe(7)
    expect(screen.getByRole('tabpanel')).toBeInTheDocument()
  })

  it('aria-selected on active tab', async () => {
    await renderSuggestionsPage()
    const user = userEvent.setup()

    const pendingTab = screen.getByRole('tab', { name: /pending/i })
    const approvedTab = screen.getByRole('tab', { name: /approved/i })

    expect(pendingTab).toHaveAttribute('aria-selected', 'true')
    expect(approvedTab).toHaveAttribute('aria-selected', 'false')

    await user.click(approvedTab)

    expect(pendingTab).toHaveAttribute('aria-selected', 'false')
    expect(approvedTab).toHaveAttribute('aria-selected', 'true')
  })

  it('buttons have descriptive labels', async () => {
    await renderSuggestionsPage()

    await waitFor(() => {
      expect(screen.getByText('Add rate limiting skill')).toBeInTheDocument()
    })

    const buttons = screen.getAllByRole('button')
    for (const button of buttons) {
      expect(button).toHaveAccessibleName()
    }
  })

  it('confidence bar has aria-valuenow/min/max', async () => {
    await renderSuggestionsPage()

    await waitFor(() => {
      expect(screen.getByText('Add rate limiting skill')).toBeInTheDocument()
    })

    const progressBars = screen.getAllByRole('progressbar')
    for (const bar of progressBars) {
      expect(bar).toHaveAttribute('aria-valuenow')
      expect(bar).toHaveAttribute('aria-valuemin', '0')
      expect(bar).toHaveAttribute('aria-valuemax', '100')
    }
  })

  it('shows "not available" message when suggestion system unavailable', async () => {
    mockGetSuggestions.mockRejectedValue(new Error('Service unavailable'))
    await renderSuggestionsPage()

    await waitFor(() => {
      expect(screen.getByText(/not available/i)).toBeInTheDocument()
    })
  })

  it('renders evidence objects with source and detail (not [object Object])', async () => {
    const evidenceObjectSuggestion = [
      {
        id: 'sug-ev-1',
        title: 'Suggestion with real evidence shape',
        description: 'Evidence comes back from API as objects',
        type: 'skill',
        confidence: 0.9,
        status: 'pending',
        evidence: [
          {
            source: 'otel',
            detail: 'observed 12 rate-limit errors',
            observedAt: '2026-04-17T10:00:00Z',
            weight: 0.8,
          },
          {
            source: 'memory',
            detail: 'pattern matches prior incident',
            observedAt: '2026-04-17T10:05:00Z',
            weight: 0.6,
          },
        ],
      },
    ]
    mockGetSuggestions.mockResolvedValue(evidenceObjectSuggestion)

    await renderSuggestionsPage()

    await waitFor(() => {
      expect(screen.getByText('Suggestion with real evidence shape')).toBeInTheDocument()
    })

    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument()
    expect(screen.getByText(/otel/)).toBeInTheDocument()
    expect(screen.getByText(/observed 12 rate-limit errors/)).toBeInTheDocument()
    expect(screen.getByText(/memory/)).toBeInTheDocument()
    expect(screen.getByText(/pattern matches prior incident/)).toBeInTheDocument()
  })

  it('page has no axe-core violations', async () => {
    const { container } = await renderSuggestionsPage()

    await waitFor(() => {
      expect(screen.getByText('Add rate limiting skill')).toBeInTheDocument()
    })

    const results = await axe.run(container)
    expect(results.violations).toEqual([])
  })

  // ── Phase 13.12.2: blocked-autonomy surface ──────────────────────

  it('13.12.2: shows Blocked tab and renders "Needs L{N}" badge with blockedMetadata', async () => {
    await renderSuggestionsPage()
    const user = userEvent.setup()

    const blockedTab = screen.getByRole('tab', { name: /blocked/i })
    expect(blockedTab).toBeInTheDocument()

    await user.click(blockedTab)

    await waitFor(() => {
      expect(mockGetSuggestions).toHaveBeenCalledWith('blocked-autonomy')
    })

    await waitFor(() => {
      expect(screen.getByText('Deploy automation script')).toBeInTheDocument()
    })

    // Badge present + labels the required level.
    const badge = screen.getByLabelText(/needs autonomy level 3/i)
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveTextContent('Needs L3')
  })

  // ── Phase 13.12.9: failed-suggestion recovery surface ────────────

  it('13.12.9: Failed tab renders attemptCount, lastError, and a retry button', async () => {
    await renderSuggestionsPage()
    const user = userEvent.setup()

    const failedTab = screen.getByRole('tab', { name: /failed/i })
    expect(failedTab).toBeInTheDocument()

    await user.click(failedTab)

    await waitFor(() => {
      expect(mockGetSuggestions).toHaveBeenCalledWith('failed')
    })

    await waitFor(() => {
      expect(screen.getByText('Broken automation')).toBeInTheDocument()
    })

    expect(screen.getByTestId('attempt-count')).toHaveTextContent('5')
    expect(screen.getByTestId('last-error')).toHaveTextContent('RunCommand skipped')
    expect(screen.getByTestId('retry-button')).toBeInTheDocument()
  })

  it('13.12.9: clicking Retry calls retrySuggestion with the id', async () => {
    await renderSuggestionsPage()
    const user = userEvent.setup()

    const failedTab = screen.getByRole('tab', { name: /failed/i })
    await user.click(failedTab)

    await waitFor(() => {
      expect(screen.getByTestId('retry-button')).toBeInTheDocument()
    })

    await user.click(screen.getByTestId('retry-button'))

    await waitFor(() => {
      expect(mockRetrySuggestion).toHaveBeenCalledWith('sug-9-failed')
    })
  })

  it('13.12.9: clicking Delete on a failed item calls deleteSuggestion', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      await renderSuggestionsPage()
      const user = userEvent.setup()

      const failedTab = screen.getByRole('tab', { name: /failed/i })
      await user.click(failedTab)

      await waitFor(() => {
        expect(screen.getByTestId('delete-button')).toBeInTheDocument()
      })

      await user.click(screen.getByTestId('delete-button'))

      await waitFor(() => {
        expect(mockDeleteSuggestion).toHaveBeenCalledWith('sug-9-failed')
      })
    } finally {
      confirmSpy.mockRestore()
    }
  })

  // ── Phase 13.12.16 ─────────────────────────────────────────────

  it('13.12.16: shows a Needs Human tab', async () => {
    await renderSuggestionsPage()
    expect(screen.getByRole('tab', { name: /needs human/i })).toBeInTheDocument()
  })

  it('13.12.16: clicking Repromote on a needs-human item calls repromoteSuggestion', async () => {
    await renderSuggestionsPage()
    const user = userEvent.setup()

    await user.click(screen.getByRole('tab', { name: /needs human/i }))

    await waitFor(() => {
      expect(screen.getByTestId('repromote-button')).toBeInTheDocument()
    })
    await user.click(screen.getByTestId('repromote-button'))

    await waitFor(() => {
      expect(mockRepromoteSuggestion).toHaveBeenCalledWith('sug-10-needs-human')
    })
  })

  it('13.12.16: delete on a needs-human item prompts and fires deleteSuggestion', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      await renderSuggestionsPage()
      const user = userEvent.setup()

      await user.click(screen.getByRole('tab', { name: /needs human/i }))
      await waitFor(() => {
        expect(screen.getByTestId('delete-button')).toBeInTheDocument()
      })
      await user.click(screen.getByTestId('delete-button'))

      await waitFor(() => {
        expect(confirmSpy).toHaveBeenCalled()
        expect(mockDeleteSuggestion).toHaveBeenCalledWith('sug-10-needs-human')
      })
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('13.12.16: cancelling the confirm dialog does NOT call deleteSuggestion', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      await renderSuggestionsPage()
      const user = userEvent.setup()

      await user.click(screen.getByRole('tab', { name: /rejected/i }))
      await waitFor(() => {
        expect(screen.getByTestId('delete-button')).toBeInTheDocument()
      })
      await user.click(screen.getByTestId('delete-button'))

      expect(confirmSpy).toHaveBeenCalled()
      expect(mockDeleteSuggestion).not.toHaveBeenCalled()
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('13.12.16: rejected items expose a Delete button (non-pending rows are deletable)', async () => {
    await renderSuggestionsPage()
    const user = userEvent.setup()

    await user.click(screen.getByRole('tab', { name: /rejected/i }))
    await waitFor(() => {
      expect(screen.getByTestId('delete-button')).toBeInTheDocument()
    })
  })
})
