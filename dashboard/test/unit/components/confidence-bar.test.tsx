import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConfidenceBar } from '@/components/confidence-bar'

describe('ConfidenceBar', () => {
  it('renders with correct aria attributes', () => {
    render(<ConfidenceBar value={0.92} />)

    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '92')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    expect(bar).toHaveAttribute('aria-label', 'Confidence: 92%')
  })

  it('displays percentage text', () => {
    render(<ConfidenceBar value={0.78} />)
    expect(screen.getByText('78%')).toBeInTheDocument()
  })

  it('handles zero value', () => {
    render(<ConfidenceBar value={0} />)
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByText('0%')).toBeInTheDocument()
  })

  it('handles full value', () => {
    render(<ConfidenceBar value={1} />)
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('rounds decimal percentages', () => {
    render(<ConfidenceBar value={0.456} />)
    expect(screen.getByText('46%')).toBeInTheDocument()
  })
})
