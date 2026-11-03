import { describe, it, expect } from 'vitest'
import { convertRelativeDates, parseRelativeDate } from '../../../src/dream/date-utils.js'

/** Fixed reference date for deterministic tests */
const REF = new Date('2026-04-05T12:00:00Z')

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

describe('convertRelativeDates', () => {
  it('"today" → today\'s date', () => {
    const result = convertRelativeDates('Met today for lunch', REF)
    expect(result).toContain('2026-04-05')
    expect(result).not.toContain('today')
  })

  it('"yesterday" → yesterday\'s date', () => {
    const result = convertRelativeDates('Discussed yesterday in meeting', REF)
    expect(result).toContain('2026-04-04')
    expect(result).not.toContain('yesterday')
  })

  it('"3 days ago" → correct date', () => {
    const result = convertRelativeDates('Deployed 3 days ago', REF)
    expect(result).toContain('2026-04-02')
  })

  it('"last week" → 7 days ago', () => {
    const result = convertRelativeDates('Released last week', REF)
    expect(result).toContain('2026-03-29')
  })

  it('"last month" → 30 days ago', () => {
    const result = convertRelativeDates('Started last month', REF)
    expect(result).toContain('2026-03-06')
  })

  it('"a few days ago" → 3 days ago', () => {
    const result = convertRelativeDates('Fixed a few days ago', REF)
    expect(result).toContain('2026-04-02')
  })

  it('mixed content with dates → only dates converted', () => {
    const input = 'Met today and discussed what happened 2 days ago. The code is fine.'
    const result = convertRelativeDates(input, REF)
    expect(result).toContain('2026-04-05')
    expect(result).toContain('2026-04-03')
    expect(result).toContain('The code is fine.')
  })

  it('no relative dates → unchanged', () => {
    const input = 'This is normal content without any dates.'
    const result = convertRelativeDates(input, REF)
    expect(result).toBe(input)
  })

  it('custom reference date → correct computation', () => {
    const customRef = new Date('2025-01-15T12:00:00Z')
    const result = convertRelativeDates('Fixed yesterday', customRef)
    expect(result).toContain('2025-01-14')
  })
})

describe('parseRelativeDate', () => {
  it('valid expression → Date', () => {
    const result = parseRelativeDate('yesterday', REF)
    expect(result).toBeInstanceOf(Date)
    expect(isoDate(result!)).toBe('2026-04-04')
  })

  it('non-relative text → null', () => {
    const result = parseRelativeDate('some random text', REF)
    expect(result).toBeNull()
  })
})
