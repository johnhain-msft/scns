import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Sidebar } from '@/components/sidebar'

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}))

describe('Sidebar', () => {
  it('renders all navigation links', () => {
    render(<Sidebar />)

    const expectedLabels = [
      'Overview', 'Orchestrator', 'Sessions', 'Teams', 'Tasks', 'Suggestions',
      'Scheduler', 'Memory', 'Dream', 'Observers', 'Autonomy',
      'Cost', 'Traces', 'Metrics', 'OTel Settings',
    ]

    for (const label of expectedLabels) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toBeInTheDocument()
    }
  })

  it('active link is highlighted', () => {
    render(<Sidebar />)
    const overviewLink = screen.getByRole('link', { name: /Overview/ })
    expect(overviewLink).toHaveAttribute('aria-current', 'page')
  })

  it('all links have correct href values', () => {
    render(<Sidebar />)

    const expectedHrefs: Record<string, string> = {
      'Overview': '/',
      'Orchestrator': '/orchestrator',
      'Sessions': '/sessions',
      'Teams': '/teams',
      'Tasks': '/tasks',
      'Suggestions': '/suggestions',
      'Scheduler': '/scheduler',
      'Memory': '/memory',
      'Dream': '/dream',
      'Observers': '/observers',
      'Autonomy': '/autonomy',
      'Cost': '/cost',
      'Traces': '/traces',
      'Metrics': '/metrics',
      'OTel Settings': '/settings/otel',
    }

    for (const [label, href] of Object.entries(expectedHrefs)) {
      const link = screen.getByRole('link', { name: new RegExp(label) })
      expect(link).toHaveAttribute('href', href)
    }
  })

  it('sidebar is keyboard navigable (links are focusable)', () => {
    render(<Sidebar />)
    const links = screen.getAllByRole('link')
    for (const link of links) {
      expect(link.tabIndex).not.toBe(-1)
    }
  })

  it('all links have accessible labels', () => {
    render(<Sidebar />)
    const links = screen.getAllByRole('link')
    for (const link of links) {
      expect(link).toHaveAccessibleName()
    }
  })

  it('renders SCNS branding', () => {
    render(<Sidebar />)
    expect(screen.getByText('SCNS')).toBeInTheDocument()
  })

  it('uses nav landmark', () => {
    render(<Sidebar />)
    expect(screen.getByRole('navigation')).toBeInTheDocument()
  })
})
