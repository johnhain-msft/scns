import { describe, it, expect } from 'vitest'
import { createChronicleDedup } from '../../../../src/observe/plugins/chronicle-dedup.js'
import type { ChronicleEntry } from '../../../../src/observe/plugins/chronicle-reader.js'

function makeEntry(overrides: Partial<ChronicleEntry> = {}): ChronicleEntry {
  return {
    sessionId: 'sess-1',
    timestamp: '2024-01-15T10:00:00.000Z',
    type: 'session-start',
    content: 'Session started',
    ...overrides,
  }
}

describe('createChronicleDedup', () => {
  it('returns a dedup tracker with initial empty state', () => {
    const dedup = createChronicleDedup()
    const state = dedup.getState()
    expect(state.knownSessionIds.size).toBe(0)
    expect(state.knownTraceIds.size).toBe(0)
  })

  describe('isDuplicate', () => {
    it('returns false for unknown entries', () => {
      const dedup = createChronicleDedup()
      const entry = makeEntry()
      expect(dedup.isDuplicate(entry, new Set())).toBe(false)
    })

    it('returns true when sessionId is in otelSessionIds', () => {
      const dedup = createChronicleDedup()
      const entry = makeEntry({ sessionId: 'otel-session-42' })
      const otelIds = new Set(['otel-session-42'])
      expect(dedup.isDuplicate(entry, otelIds)).toBe(true)
    })

    it('returns true for entries already marked as known', () => {
      const dedup = createChronicleDedup()
      const entry = makeEntry({
        sessionId: 'known-1',
        type: 'summary',
        timestamp: '2024-01-15T10:05:00.000Z',
      })
      dedup.addKnown(entry)
      expect(dedup.isDuplicate(entry, new Set())).toBe(true)
    })

    it('returns false for different entry from same session', () => {
      const dedup = createChronicleDedup()
      const entry1 = makeEntry({ sessionId: 'sess-1', type: 'session-start' })
      const entry2 = makeEntry({ sessionId: 'sess-1', type: 'session-end' })
      dedup.addKnown(entry1)
      expect(dedup.isDuplicate(entry2, new Set())).toBe(false)
    })

    it('deduplicates by entry identity (sessionId + type + timestamp)', () => {
      const dedup = createChronicleDedup()
      const entry = makeEntry({
        sessionId: 'sess-A',
        type: 'summary',
        timestamp: '2024-01-15T12:00:00.000Z',
      })
      dedup.addKnown(entry)

      // Same identity = duplicate
      const same = makeEntry({
        sessionId: 'sess-A',
        type: 'summary',
        timestamp: '2024-01-15T12:00:00.000Z',
        content: 'different content',
      })
      expect(dedup.isDuplicate(same, new Set())).toBe(true)

      // Different timestamp = not duplicate
      const different = makeEntry({
        sessionId: 'sess-A',
        type: 'summary',
        timestamp: '2024-01-15T12:01:00.000Z',
      })
      expect(dedup.isDuplicate(different, new Set())).toBe(false)
    })
  })

  describe('addKnown', () => {
    it('tracks new entries', () => {
      const dedup = createChronicleDedup()
      dedup.addKnown(makeEntry({ sessionId: 'sess-1' }))
      const state = dedup.getState()
      expect(state.knownSessionIds.has('sess-1')).toBe(true)
    })

    it('tracks entry keys for dedup', () => {
      const dedup = createChronicleDedup()
      const entry = makeEntry({
        sessionId: 'sess-2',
        type: 'session-end',
        timestamp: '2024-01-15T11:00:00.000Z',
      })
      dedup.addKnown(entry)
      expect(dedup.isDuplicate(entry, new Set())).toBe(true)
    })
  })

  describe('getState', () => {
    it('returns current state snapshot', () => {
      const dedup = createChronicleDedup()
      dedup.addKnown(makeEntry({ sessionId: 'a' }))
      dedup.addKnown(makeEntry({ sessionId: 'b' }))
      const state = dedup.getState()
      expect(state.knownSessionIds.size).toBe(2)
      expect(state.knownSessionIds.has('a')).toBe(true)
      expect(state.knownSessionIds.has('b')).toBe(true)
    })

    it('addKnown with traceId tracks trace IDs', () => {
      const dedup = createChronicleDedup()
      dedup.addKnown(makeEntry({ metadata: { traceId: 'trace-abc' } }))
      const state = dedup.getState()
      expect(state.knownTraceIds.has('trace-abc')).toBe(true)
    })
  })
})
