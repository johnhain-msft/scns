import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { renderWithProviders } from '../../helpers/render'
import { checkA11y } from '../../helpers/a11y'
import MemoryPage from '@/app/memory/page'

const BROKER_URL = 'http://localhost:3456'

const mockStats = {
  totalFiles: 25,
  indexedChunks: 100,
  rootDir: '/home/.scns/memory',
}

const mockSearchResults = [
  { chunkId: 1, filePath: 'src/auth/login.ts', content: 'Authentication handler for user login', score: 0.95, vectorScore: 0.9, keywordScore: 0.85 },
  { chunkId: 2, filePath: 'src/utils/hash.ts', content: 'Password hashing utility', score: 0.82, vectorScore: 0.8, keywordScore: 0.7 },
]

const mockLessons: { id: string; content: string; type: string; confidence: number; source: string; createdAt: string }[] = [
  { id: 'l-1', content: 'Always follow TDD', type: 'process', confidence: 0.9, source: 'daily', createdAt: '2025-01-01' },
  { id: 'l-2', content: 'Run manual tests', type: 'process', confidence: 0.8, source: 'daily', createdAt: '2025-01-02' },
]

const mockArchived: { originalPath: string; archivedAt: string; reason: string; rejectionNote?: string }[] = []

const mockTiers = {
  daily: { count: 5, totalBytes: 2048 },
  weekly: { count: 2, totalBytes: 4096 },
  monthly: { count: 1, totalBytes: 8192 },
  archive: { count: 3, totalBytes: 1024 },
  embeddingStatus: { ready: true, totalChunks: 100, embeddedChunks: 80 },
}

const mockFiles: { path: string; sizeBytes: number; modifiedAt: string; preview?: string }[] = []

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

async function navigateToSearchTab(user: ReturnType<typeof userEvent.setup>) {
  const searchTab = screen.getByRole('button', { name: /🔍 search/i })
  await user.click(searchTab)
  await waitFor(() => {
    expect(screen.getByLabelText(/search memories/i)).toBeInTheDocument()
  })
}

describe('MemoryPage', () => {
  beforeEach(() => {
    server.use(
      http.get(`${BROKER_URL}/api/memory/stats`, () => HttpResponse.json(mockStats)),
      http.get(`${BROKER_URL}/api/memory/search`, () => HttpResponse.json({ results: mockSearchResults })),
      http.get(`${BROKER_URL}/api/memory/lessons`, () => HttpResponse.json({ lessons: mockLessons })),
      http.get(`${BROKER_URL}/api/memory/archive`, () => HttpResponse.json({ entries: mockArchived })),
      http.get(`${BROKER_URL}/api/memory/tiers`, () => HttpResponse.json(mockTiers)),
      http.get(`${BROKER_URL}/api/memory/files`, () => HttpResponse.json({ files: mockFiles })),
    )
  })

  it('renders "Memory" heading', async () => {
    renderWithProviders(<MemoryPage />)
    expect(screen.getByRole('heading', { name: /memory/i, level: 1 })).toBeInTheDocument()
  })

  it('shows tab navigation with Lessons, Archive, Tiers, Search tabs', () => {
    renderWithProviders(<MemoryPage />)
    expect(screen.getByRole('button', { name: /lessons/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /archive/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /tiers/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument()
  })

  it('shows lessons tab by default with lesson entries', async () => {
    renderWithProviders(<MemoryPage />)
    await waitFor(() => {
      expect(screen.getByText('Always follow TDD')).toBeInTheDocument()
    })
    expect(screen.getByText('Run manual tests')).toBeInTheDocument()
  })

  it('search tab shows search input with label', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MemoryPage />)
    await navigateToSearchTab(user)
    expect(screen.getByLabelText(/search memories/i)).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('search button triggers searchMemory API', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MemoryPage />)
    await navigateToSearchTab(user)
    const input = screen.getByLabelText(/search memories/i)
    await user.type(input, 'login')
    const searchBtn = screen.getByRole('button', { name: /^search$/i })
    await user.click(searchBtn)
    await waitFor(() => {
      expect(screen.getByText(/authentication handler/i)).toBeInTheDocument()
    })
  })

  it('results show file path, content preview, relevance score', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MemoryPage />)
    await navigateToSearchTab(user)
    const input = screen.getByLabelText(/search memories/i)
    await user.type(input, 'login')
    await user.click(screen.getByRole('button', { name: /^search$/i }))
    await waitFor(() => {
      expect(screen.getByText('src/auth/login.ts')).toBeInTheDocument()
    })
    expect(screen.getByText(/authentication handler/i)).toBeInTheDocument()
    expect(screen.getByText(/0\.9500/)).toBeInTheDocument()
  })

  it('shows "No results" when empty', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/memory/search`, () =>
        HttpResponse.json([]),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(<MemoryPage />)
    await navigateToSearchTab(user)
    const input = screen.getByLabelText(/search memories/i)
    await user.type(input, 'nonexistent')
    await user.click(screen.getByRole('button', { name: /^search$/i }))
    await waitFor(() => {
      expect(screen.getByText(/no results/i)).toBeInTheDocument()
    })
  })

  it('shows vault stats sidebar', async () => {
    renderWithProviders(<MemoryPage />)
    await waitFor(() => {
      expect(screen.getByText('Vault Stats')).toBeInTheDocument()
    })
  })

  it('search input has visible label', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MemoryPage />)
    await navigateToSearchTab(user)
    const label = screen.getByText(/search memories/i)
    expect(label.tagName).toBe('LABEL')
  })

  it('search results list uses proper list semantics', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MemoryPage />)
    await navigateToSearchTab(user)
    await user.type(screen.getByLabelText(/search memories/i), 'login')
    await user.click(screen.getByRole('button', { name: /^search$/i }))
    await waitFor(() => {
      expect(screen.getByRole('list')).toBeInTheDocument()
    })
    const items = screen.getAllByRole('listitem')
    expect(items.length).toBe(2)
  })

  it('shows "not available" when memory system unavailable', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/memory/stats`, () =>
        new HttpResponse('Service Unavailable', { status: 503 }),
      ),
    )
    renderWithProviders(<MemoryPage />)
    await waitFor(() => {
      expect(screen.getByText(/not available/i)).toBeInTheDocument()
    })
  })

  it('has no axe-core violations', async () => {
    const { container } = renderWithProviders(<MemoryPage />)
    await waitFor(() => {
      expect(screen.getByText('Vault Stats')).toBeInTheDocument()
    })
    const violations = await checkA11y(container)
    expect(violations).toEqual([])
  })
})
