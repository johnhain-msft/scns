/**
 * Cross-Source Correlator — unit tests.
 * Tests pattern detection across multiple observation sources.
 */

import { describe, it, expect } from 'vitest'
import {
  createCrossSourceCorrelator,
  type CrossSourceEvent,
  type _CrossSourcePattern,
} from '../../../../src/observe/cross-source/correlator.js'

function makeEvent(overrides: Partial<CrossSourceEvent> = {}): CrossSourceEvent {
  return {
    source: 'copilot-cli',
    timestamp: '2025-01-15T10:00:00.000Z',
    eventType: 'session',
    tags: [],
    ...overrides,
  }
}

describe('CrossSourceCorrelator', () => {
  describe('addEvents', () => {
    it('accumulates events from multiple calls', () => {
      const correlator = createCrossSourceCorrelator()
      correlator.addEvents([makeEvent()])
      correlator.addEvents([makeEvent({ source: 'claude-code' })])
      expect(correlator.getSourceCounts().get('copilot-cli')).toBe(1)
      expect(correlator.getSourceCounts().get('claude-code')).toBe(1)
    })

    it('handles empty event array', () => {
      const correlator = createCrossSourceCorrelator()
      correlator.addEvents([])
      expect(correlator.getSourceCounts().size).toBe(0)
    })
  })

  describe('getSourceCounts', () => {
    it('returns correct counts per source', () => {
      const correlator = createCrossSourceCorrelator()
      correlator.addEvents([
        makeEvent({ source: 'copilot-cli' }),
        makeEvent({ source: 'copilot-cli' }),
        makeEvent({ source: 'claude-code' }),
        makeEvent({ source: 'chronicle' }),
        makeEvent({ source: 'chronicle' }),
        makeEvent({ source: 'chronicle' }),
      ])
      const counts = correlator.getSourceCounts()
      expect(counts.get('copilot-cli')).toBe(2)
      expect(counts.get('claude-code')).toBe(1)
      expect(counts.get('chronicle')).toBe(3)
    })

    it('returns empty map when no events', () => {
      const correlator = createCrossSourceCorrelator()
      expect(correlator.getSourceCounts().size).toBe(0)
    })
  })

  describe('reset', () => {
    it('clears all accumulated state', () => {
      const correlator = createCrossSourceCorrelator()
      correlator.addEvents([makeEvent(), makeEvent({ source: 'claude-code' })])
      correlator.reset()
      expect(correlator.getSourceCounts().size).toBe(0)
      expect(correlator.detectPatterns()).toEqual([])
    })
  })

  describe('detectPatterns', () => {
    it('returns empty array with no events', () => {
      const correlator = createCrossSourceCorrelator()
      expect(correlator.detectPatterns()).toEqual([])
    })

    it('returns empty array with single-source events', () => {
      const correlator = createCrossSourceCorrelator()
      correlator.addEvents([
        makeEvent({ source: 'copilot-cli', timestamp: '2025-01-15T10:00:00.000Z' }),
        makeEvent({ source: 'copilot-cli', timestamp: '2025-01-15T10:05:00.000Z' }),
      ])
      // Single source cannot produce cross-source patterns
      expect(correlator.detectPatterns()).toEqual([])
    })

    it('detects tool switching pattern', () => {
      const correlator = createCrossSourceCorrelator()
      // User goes: copilot → claude-code → copilot
      correlator.addEvents([
        makeEvent({
          source: 'copilot-cli',
          timestamp: '2025-01-15T10:00:00.000Z',
          eventType: 'session',
        }),
        makeEvent({
          source: 'claude-code',
          timestamp: '2025-01-15T10:10:00.000Z',
          eventType: 'session',
        }),
        makeEvent({
          source: 'copilot-cli',
          timestamp: '2025-01-15T10:20:00.000Z',
          eventType: 'session',
        }),
      ])
      const patterns = correlator.detectPatterns()
      const toolSwitch = patterns.find((p) => p.name === 'tool-switching')
      expect(toolSwitch).toBeDefined()
      expect(toolSwitch!.sources).toContain('copilot-cli')
      expect(toolSwitch!.sources).toContain('claude-code')
      expect(toolSwitch!.confidence).toBeGreaterThan(0)
      expect(toolSwitch!.confidence).toBeLessThanOrEqual(1)
    })

    it('detects session handoff pattern (within 5 minutes)', () => {
      const correlator = createCrossSourceCorrelator()
      // Copilot session ends, Claude-Code session starts 3 minutes later
      correlator.addEvents([
        makeEvent({
          source: 'copilot-cli',
          timestamp: '2025-01-15T10:00:00.000Z',
          eventType: 'session-end',
        }),
        makeEvent({
          source: 'claude-code',
          timestamp: '2025-01-15T10:03:00.000Z',
          eventType: 'session-start',
        }),
      ])
      const patterns = correlator.detectPatterns()
      const handoff = patterns.find((p) => p.name === 'session-handoff')
      expect(handoff).toBeDefined()
      expect(handoff!.sources).toContain('copilot-cli')
      expect(handoff!.sources).toContain('claude-code')
      expect(handoff!.frequency).toBeGreaterThanOrEqual(1)
    })

    it('does NOT detect session handoff when gap > 5 minutes', () => {
      const correlator = createCrossSourceCorrelator()
      correlator.addEvents([
        makeEvent({
          source: 'copilot-cli',
          timestamp: '2025-01-15T10:00:00.000Z',
          eventType: 'session-end',
        }),
        makeEvent({
          source: 'claude-code',
          timestamp: '2025-01-15T10:10:00.000Z',
          eventType: 'session-start',
        }),
      ])
      const patterns = correlator.detectPatterns()
      const handoff = patterns.find((p) => p.name === 'session-handoff')
      expect(handoff).toBeUndefined()
    })

    it('detects time-based usage patterns', () => {
      const correlator = createCrossSourceCorrelator()
      // Morning copilot sessions (08:xx - 11:xx)
      correlator.addEvents([
        makeEvent({ source: 'copilot-cli', timestamp: '2025-01-13T08:30:00.000Z' }),
        makeEvent({ source: 'copilot-cli', timestamp: '2025-01-14T09:15:00.000Z' }),
        makeEvent({ source: 'copilot-cli', timestamp: '2025-01-15T10:00:00.000Z' }),
        // Evening claude-code sessions (18:xx - 21:xx)
        makeEvent({ source: 'claude-code', timestamp: '2025-01-13T19:00:00.000Z' }),
        makeEvent({ source: 'claude-code', timestamp: '2025-01-14T20:30:00.000Z' }),
        makeEvent({ source: 'claude-code', timestamp: '2025-01-15T18:45:00.000Z' }),
      ])
      const patterns = correlator.detectPatterns()
      const timeBased = patterns.find((p) => p.name === 'time-based-usage')
      expect(timeBased).toBeDefined()
      expect(timeBased!.description).toBeTruthy()
      expect(timeBased!.confidence).toBeGreaterThan(0)
    })

    it('all patterns have required fields', () => {
      const correlator = createCrossSourceCorrelator()
      correlator.addEvents([
        makeEvent({
          source: 'copilot-cli',
          timestamp: '2025-01-15T10:00:00.000Z',
          eventType: 'session',
        }),
        makeEvent({
          source: 'claude-code',
          timestamp: '2025-01-15T10:10:00.000Z',
          eventType: 'session',
        }),
        makeEvent({
          source: 'copilot-cli',
          timestamp: '2025-01-15T10:20:00.000Z',
          eventType: 'session',
        }),
      ])
      const patterns = correlator.detectPatterns()
      for (const pattern of patterns) {
        expect(pattern.id).toBeTruthy()
        expect(pattern.name).toBeTruthy()
        expect(pattern.description).toBeTruthy()
        expect(pattern.sources.length).toBeGreaterThan(0)
        expect(pattern.frequency).toBeGreaterThanOrEqual(1)
        expect(pattern.confidence).toBeGreaterThanOrEqual(0)
        expect(pattern.confidence).toBeLessThanOrEqual(1)
        expect(pattern.detectedAt).toBeTruthy()
      }
    })
  })
})
