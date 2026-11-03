import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CronPreview } from '@/components/cron-preview'

describe('CronPreview', () => {
  it.each([
    ['* * * * *', 'Every minute'],
    ['*/5 * * * *', 'Every 5 minutes'],
    ['*/30 * * * *', 'Every 30 minutes'],
    ['0 3 * * *', 'Daily at 3:00 AM'],
    ['0 4 * * *', 'Daily at 4:00 AM'],
    ['0 0 * * *', 'Daily at 12:00 AM'],
    ['0 12 * * *', 'Daily at 12:00 PM'],
    ['0 15 * * *', 'Daily at 3:00 PM'],
  ])('converts 5-field cron "%s" to "%s"', (expression, expected) => {
    render(<CronPreview expression={expression} />)
    expect(screen.getByText(expected)).toBeInTheDocument()
  })

  it.each([
    ['*/10 * * * * *', 'Every 10 seconds'],
    ['*/30 * * * * *', 'Every 30 seconds'],
    ['0 */5 * * * *', 'Every 5 minutes'],
  ])('converts 6-field cron "%s" to "%s"', (expression, expected) => {
    render(<CronPreview expression={expression} />)
    expect(screen.getByText(expected)).toBeInTheDocument()
  })

  it('shows raw cron for complex expressions', () => {
    render(<CronPreview expression="0 0 1,15 * *" />)
    expect(screen.getByText('0 0 1,15 * *')).toBeInTheDocument()
  })

  it('always shows the raw expression', () => {
    render(<CronPreview expression="*/5 * * * *" />)
    expect(screen.getByText('*/5 * * * *')).toBeInTheDocument()
  })
})
