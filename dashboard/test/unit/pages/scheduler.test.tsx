import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import axe from 'axe-core'
import type { ReactNode } from 'react'

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/scheduler',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

const mockTasks = [
  {
    id: 'task-1',
    name: 'Memory Consolidation',
    description: 'Consolidate memories periodically',
    category: 'cron' as const,
    cron_expression: '*/5 * * * *',
    enabled: true,
    last_run_at: '2024-06-15T10:30:00Z',
    next_run_at: '2024-06-15T10:35:00Z',
    run_count: 10,
    last_status: 'success' as const,
    config_json: '{}',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-06-15T10:30:00Z',
  },
  {
    id: 'task-2',
    name: 'Log Cleanup',
    description: 'Clean up old log files',
    category: 'cron' as const,
    cron_expression: '0 3 * * *',
    enabled: false,
    last_run_at: '2024-06-14T03:00:00Z',
    next_run_at: null,
    run_count: 5,
    last_status: 'failure' as const,
    config_json: '{}',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-06-14T03:00:00Z',
  },
  {
    id: 'task-3',
    name: 'Health Check',
    description: 'Check system health',
    category: 'on-demand' as const,
    cron_expression: '* * * * *',
    enabled: true,
    last_run_at: null,
    next_run_at: null,
    run_count: 0,
    last_status: null,
    config_json: '{}',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
]

const mockHistory = [
  { id: 1, task_id: 'task-1', status: 'success', started_at: '2024-06-15T10:30:00Z', finished_at: '2024-06-15T10:30:01Z', duration_ms: 1200, error_message: null, created_at: '2024-06-15T10:30:00Z' },
  { id: 2, task_id: 'task-1', status: 'success', started_at: '2024-06-15T10:25:00Z', finished_at: '2024-06-15T10:25:01Z', duration_ms: 980, error_message: null, created_at: '2024-06-15T10:25:00Z' },
  { id: 3, task_id: 'task-1', status: 'failure', started_at: '2024-06-15T10:20:00Z', finished_at: '2024-06-15T10:20:05Z', duration_ms: 5000, error_message: 'Timeout', created_at: '2024-06-15T10:20:00Z' },
]

// Mock API module
const {
  mockGetSchedulerTasks,
  mockUpdateSchedulerTask,
  mockTriggerSchedulerTask,
  mockGetSchedulerHistory,
} = vi.hoisted(() => ({
  mockGetSchedulerTasks: vi.fn(),
  mockUpdateSchedulerTask: vi.fn(),
  mockTriggerSchedulerTask: vi.fn(),
  mockGetSchedulerHistory: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  getSchedulerTasks: mockGetSchedulerTasks,
  updateSchedulerTask: mockUpdateSchedulerTask,
  triggerSchedulerTask: mockTriggerSchedulerTask,
  getSchedulerHistory: mockGetSchedulerHistory,
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

beforeEach(() => {
  mockGetSchedulerTasks.mockResolvedValue(mockTasks)
  mockUpdateSchedulerTask.mockImplementation((id: string, updates: Record<string, unknown>) =>
    Promise.resolve({ ...mockTasks.find((t) => t.id === id), ...updates }),
  )
  mockTriggerSchedulerTask.mockImplementation((id: string) =>
    Promise.resolve({ id, triggered: true }),
  )
  mockGetSchedulerHistory.mockResolvedValue(mockHistory)
})

// Lazy import to avoid module resolution before mocks are set up
async function renderSchedulerPage() {
  const { default: SchedulerPage } = await import('@/app/scheduler/page')
  return render(<SchedulerPage />, { wrapper: createWrapper() })
}

describe('SchedulerPage', () => {
  it('renders "Scheduler" heading', async () => {
    await renderSchedulerPage()

    expect(screen.getByRole('heading', { name: /scheduler/i })).toBeInTheDocument()
  })

  it('shows task table with correct columns', async () => {
    await renderSchedulerPage()

    await waitFor(() => {
      expect(screen.getByText('Memory Consolidation')).toBeInTheDocument()
    })

    const columnHeaders = ['Name', 'Category', 'Schedule', 'Status', 'Last Run', 'Actions']
    for (const header of columnHeaders) {
      const th = screen.getByRole('columnheader', { name: new RegExp(header, 'i') })
      expect(th).toBeInTheDocument()
      expect(th).toHaveAttribute('scope', 'col')
    }
  })

  it('shows toggle switch for each task (enabled/disabled)', async () => {
    await renderSchedulerPage()

    await waitFor(() => {
      expect(screen.getByText('Memory Consolidation')).toBeInTheDocument()
    })

    const switches = screen.getAllByRole('switch')
    expect(switches.length).toBeGreaterThanOrEqual(mockTasks.length)
  })

  it('toggle changes call updateSchedulerTask API', async () => {
    await renderSchedulerPage()
    const user = userEvent.setup()

    await waitFor(() => {
      expect(screen.getByText('Memory Consolidation')).toBeInTheDocument()
    })

    const switches = screen.getAllByRole('switch')
    await user.click(switches[0])

    await waitFor(() => {
      expect(mockUpdateSchedulerTask).toHaveBeenCalledWith('task-1', { enabled: false })
    })
  })

  it('shows cron expression with human-readable preview', async () => {
    await renderSchedulerPage()

    await waitFor(() => {
      expect(screen.getByText('Memory Consolidation')).toBeInTheDocument()
    })

    expect(screen.getByText(/every 5 minutes/i)).toBeInTheDocument()
    expect(screen.getByText(/daily at 3:00 am/i)).toBeInTheDocument()
    expect(screen.getByText(/every minute/i)).toBeInTheDocument()
  })

  it('shows "Run Now" button for each task', async () => {
    await renderSchedulerPage()

    await waitFor(() => {
      expect(screen.getByText('Memory Consolidation')).toBeInTheDocument()
    })

    const runButtons = screen.getAllByRole('button', { name: /run now/i })
    expect(runButtons.length).toBe(mockTasks.length)
  })

  it('Run Now triggers triggerSchedulerTask API', async () => {
    await renderSchedulerPage()
    const user = userEvent.setup()

    await waitFor(() => {
      expect(screen.getByText('Memory Consolidation')).toBeInTheDocument()
    })

    const runButtons = screen.getAllByRole('button', { name: /run now/i })
    await user.click(runButtons[0])

    await waitFor(() => {
      expect(mockTriggerSchedulerTask).toHaveBeenCalledWith('task-1')
    })
  })

  it('shows last run time and status badge', async () => {
    await renderSchedulerPage()

    await waitFor(() => {
      expect(screen.getByText('Memory Consolidation')).toBeInTheDocument()
    })

    expect(screen.getByText(/success/i)).toBeInTheDocument()
    expect(screen.getByText(/failure/i)).toBeInTheDocument()
  })

  it('shows loading state', async () => {
    mockGetSchedulerTasks.mockReturnValue(new Promise(() => {})) // never resolves
    await renderSchedulerPage()
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('shows task run history when task row is expanded', async () => {
    await renderSchedulerPage()
    const user = userEvent.setup()

    await waitFor(() => {
      expect(screen.getByText('Memory Consolidation')).toBeInTheDocument()
    })

    const expandButton = screen.getAllByRole('button', { name: /show history/i })[0]
    await user.click(expandButton)

    await waitFor(() => {
      expect(screen.getByText('1')).toBeInTheDocument()
    })
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('category badge differentiates cron vs on-demand', async () => {
    await renderSchedulerPage()

    await waitFor(() => {
      expect(screen.getByText('Memory Consolidation')).toBeInTheDocument()
    })

    const cronBadges = screen.getAllByText(/^cron$/i)
    expect(cronBadges.length).toBeGreaterThanOrEqual(1)

    expect(screen.getByText(/on-demand/i)).toBeInTheDocument()
  })

  it('disabled tasks shown with muted styling', async () => {
    await renderSchedulerPage()

    await waitFor(() => {
      expect(screen.getByText('Log Cleanup')).toBeInTheDocument()
    })

    const logCleanupRow = screen.getByText('Log Cleanup').closest('tr')
    expect(logCleanupRow).toHaveAttribute('data-disabled', 'true')
  })

  it('toggle has proper aria-checked state', async () => {
    await renderSchedulerPage()

    await waitFor(() => {
      expect(screen.getByText('Memory Consolidation')).toBeInTheDocument()
    })

    const switches = screen.getAllByRole('switch')
    // task-1 is enabled, task-2 is disabled, task-3 is enabled
    expect(switches[0]).toHaveAttribute('aria-checked', 'true')
    expect(switches[1]).toHaveAttribute('aria-checked', 'false')
    expect(switches[2]).toHaveAttribute('aria-checked', 'true')
  })

  it('all buttons have accessible labels', async () => {
    await renderSchedulerPage()

    await waitFor(() => {
      expect(screen.getByText('Memory Consolidation')).toBeInTheDocument()
    })

    const buttons = screen.getAllByRole('button')
    for (const button of buttons) {
      expect(button).toHaveAccessibleName()
    }
  })

  it('page has no axe-core violations', async () => {
    const { container } = await renderSchedulerPage()

    await waitFor(() => {
      expect(screen.getByText('Memory Consolidation')).toBeInTheDocument()
    })

    const results = await axe.run(container)
    expect(results.violations).toEqual([])
  })
})
