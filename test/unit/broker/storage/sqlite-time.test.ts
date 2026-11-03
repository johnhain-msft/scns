import { describe, it, expect } from 'vitest'
import { toSqliteDateTime } from '../../../../src/broker/storage/sqlite-time.js'

describe('toSqliteDateTime', () => {
  it('converts an ISO-8601 UTC timestamp to SQLite datetime format', () => {
    expect(toSqliteDateTime('2026-03-15T11:00:00.000Z')).toBe('2026-03-15 11:00:00')
  })

  it('drops milliseconds rather than rounding them', () => {
    expect(toSqliteDateTime('2026-03-15T11:00:00.999Z')).toBe('2026-03-15 11:00:00')
  })

  it('normalizes a non-UTC offset to UTC', () => {
    expect(toSqliteDateTime('2026-03-15T08:00:00.000-03:00')).toBe('2026-03-15 11:00:00')
  })

  it('is idempotent for values already in SQLite format', () => {
    const stored = '2026-03-15 11:00:00'
    expect(toSqliteDateTime(stored)).toBe(stored)
    expect(toSqliteDateTime(toSqliteDateTime(stored))).toBe(stored)
  })

  it('does not reinterpret a stored value as local time', () => {
    // `Date.parse('2026-03-15 11:00:00')` reads local time; short-circuiting
    // on the stored format is what keeps this from shifting by the UTC offset.
    expect(toSqliteDateTime('2026-07-15 11:00:00')).toBe('2026-07-15 11:00:00')
  })

  it('trims surrounding whitespace', () => {
    expect(toSqliteDateTime('  2026-03-15T11:00:00Z  ')).toBe('2026-03-15 11:00:00')
  })

  it('returns unparseable input unchanged instead of inventing an instant', () => {
    expect(toSqliteDateTime('not-a-timestamp')).toBe('not-a-timestamp')
  })

  it('orders correctly against stored values (the original defect)', () => {
    const cutoff = toSqliteDateTime('2026-03-15T11:00:00.000Z')
    // Same calendar date, one hour after the cutoff — dropped before the fix
    // because ' ' (0x20) sorts below 'T' (0x54) at offset 10.
    expect('2026-03-15 12:00:00' >= cutoff).toBe(true)
    expect('2026-03-15 10:00:00' >= cutoff).toBe(false)
    expect('2026-03-14 12:00:00' >= cutoff).toBe(false)
  })
})
