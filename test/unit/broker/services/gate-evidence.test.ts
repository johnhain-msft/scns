/**
 * WS G — pure freshness helper unit tests.
 *
 * isStaleAgainstDispatch returns true only when there is at least one
 * staged-file mtime AND every mtime predates dispatchStartedAt. Empty
 * mtimes / unset dispatchStartedAt → false (defensive: never claim
 * staleness on no evidence).
 */
import { describe, it, expect } from 'vitest'
import { isStaleAgainstDispatch } from '../../../../src/broker/services/gate-evidence.js'

describe('isStaleAgainstDispatch', () => {
  const dispatch = new Date('2026-05-09T12:00:00Z')

  it('returns true when every staged file mtime predates dispatchStartedAt', () => {
    const mtimes = new Map<string, Date>([
      ['src/a.ts', new Date('2026-05-09T11:00:00Z')],
      ['src/b.ts', new Date('2026-05-09T10:30:00Z')],
    ])
    expect(isStaleAgainstDispatch({ stagedFileMtimes: mtimes, dispatchStartedAt: dispatch })).toBe(
      true,
    )
  })

  it('returns false when at least one staged file mtime is at-or-after dispatchStartedAt', () => {
    const mtimes = new Map<string, Date>([
      ['src/a.ts', new Date('2026-05-09T11:00:00Z')],
      ['src/b.ts', new Date('2026-05-09T12:05:00Z')],
    ])
    expect(isStaleAgainstDispatch({ stagedFileMtimes: mtimes, dispatchStartedAt: dispatch })).toBe(
      false,
    )
  })

  it('returns false on empty mtimes (no evidence — do not claim stale)', () => {
    expect(
      isStaleAgainstDispatch({
        stagedFileMtimes: new Map(),
        dispatchStartedAt: dispatch,
      }),
    ).toBe(false)
  })

  it('returns false when dispatchStartedAt is null/undefined', () => {
    const mtimes = new Map<string, Date>([['src/a.ts', new Date('2020-01-01T00:00:00Z')]])
    expect(isStaleAgainstDispatch({ stagedFileMtimes: mtimes })).toBe(false)
    expect(
      isStaleAgainstDispatch({ stagedFileMtimes: mtimes, dispatchStartedAt: null }),
    ).toBe(false)
  })

  it('treats numeric dispatchStartedAt (epoch ms) the same as Date', () => {
    const mtimes = new Map<string, Date>([['src/a.ts', new Date('2026-05-09T11:00:00Z')]])
    expect(
      isStaleAgainstDispatch({
        stagedFileMtimes: mtimes,
        dispatchStartedAt: dispatch.getTime(),
      }),
    ).toBe(true)
  })

  it('mtime exactly equal to dispatchStartedAt is NOT stale (boundary inclusive of dispatch)', () => {
    const mtimes = new Map<string, Date>([['src/a.ts', new Date(dispatch.getTime())]])
    expect(
      isStaleAgainstDispatch({ stagedFileMtimes: mtimes, dispatchStartedAt: dispatch }),
    ).toBe(false)
  })
})

// WS M (Phase 13.13.x) — strict dispatch_id attribution helper.
// Returns the subset of staged files whose mtime is at-or-after the
// dispatch start time. These are the only files that can be "attributed"
// to the dispatch: anything older was authored by an earlier session.
import { attributableStagedFiles } from '../../../../src/broker/services/gate-evidence.js'

describe('attributableStagedFiles', () => {
  const dispatch = new Date('2026-05-12T12:00:00Z')

  it('returns only entries with mtime at-or-after dispatchStartedAt', () => {
    const mtimes = new Map<string, Date>([
      ['src/old.ts', new Date('2026-05-12T11:00:00Z')],
      ['src/exact.ts', new Date(dispatch.getTime())],
      ['src/new.ts', new Date('2026-05-12T13:00:00Z')],
    ])
    const out = attributableStagedFiles(mtimes, dispatch)
    expect(Array.from(out.keys()).sort()).toEqual(['src/exact.ts', 'src/new.ts'])
  })

  it('returns full input map when dispatchStartedAt is null/undefined (no attribution evidence)', () => {
    const mtimes = new Map<string, Date>([
      ['src/a.ts', new Date('2020-01-01')],
      ['src/b.ts', new Date('2030-01-01')],
    ])
    expect(attributableStagedFiles(mtimes, null).size).toBe(2)
    expect(attributableStagedFiles(mtimes, undefined).size).toBe(2)
  })

  it('accepts numeric epoch ms for dispatchStartedAt', () => {
    const mtimes = new Map<string, Date>([
      ['src/old.ts', new Date('2026-05-12T11:00:00Z')],
      ['src/new.ts', new Date('2026-05-12T13:00:00Z')],
    ])
    const out = attributableStagedFiles(mtimes, dispatch.getTime())
    expect(Array.from(out.keys())).toEqual(['src/new.ts'])
  })
})
