/**
 * Cross-Tool Digest — unit tests.
 * Tests generation of cross-tool session digests.
 */

import { describe, it, expect } from 'vitest'
import {
  generateCrossToolDigest,
  type _CrossToolDigest,
} from '../../../../src/observe/cross-source/digest.js'
import type { CrossSourceEvent } from '../../../../src/observe/cross-source/correlator.js'

function makeEvent(overrides: Partial<CrossSourceEvent> = {}): CrossSourceEvent {
  return {
    source: 'copilot-cli',
    timestamp: '2025-01-15T10:00:00.000Z',
    eventType: 'session',
    tags: [],
    ...overrides,
  }
}

const DEFAULT_PERIOD = {
  start: '2025-01-15T00:00:00.000Z',
  end: '2025-01-15T23:59:59.000Z',
}

describe('generateCrossToolDigest', () => {
  it('handles no events', () => {
    const digest = generateCrossToolDigest([], DEFAULT_PERIOD)
    expect(digest.totalEvents).toBe(0)
    expect(digest.sources).toEqual([])
    expect(digest.patterns).toEqual([])
    expect(digest.summary).toBeTruthy()
    expect(digest.generatedAt).toBeTruthy()
    expect(digest.period).toEqual(DEFAULT_PERIOD)
  })

  it('handles single source events', () => {
    const events = [
      makeEvent({ source: 'copilot-cli', timestamp: '2025-01-15T10:00:00.000Z' }),
      makeEvent({ source: 'copilot-cli', timestamp: '2025-01-15T11:00:00.000Z' }),
    ]
    const digest = generateCrossToolDigest(events, DEFAULT_PERIOD)
    expect(digest.totalEvents).toBe(2)
    expect(digest.sources).toEqual(['copilot-cli'])
    // Single source = no cross-source patterns
    expect(digest.patterns).toEqual([])
  })

  it('includes multiple sources', () => {
    const events = [
      makeEvent({ source: 'copilot-cli', timestamp: '2025-01-15T10:00:00.000Z' }),
      makeEvent({ source: 'claude-code', timestamp: '2025-01-15T11:00:00.000Z' }),
      makeEvent({ source: 'chronicle', timestamp: '2025-01-15T12:00:00.000Z' }),
    ]
    const digest = generateCrossToolDigest(events, DEFAULT_PERIOD)
    expect(digest.sources).toContain('copilot-cli')
    expect(digest.sources).toContain('claude-code')
    expect(digest.sources).toContain('chronicle')
    expect(digest.sources).toHaveLength(3)
  })

  it('detects patterns across multiple sources', () => {
    const events = [
      // Tool switching pattern: copilot → claude-code → copilot
      makeEvent({
        source: 'copilot-cli',
        timestamp: '2025-01-15T10:00:00.000Z',
        eventType: 'session',
      }),
      makeEvent({ source: 'claude-code', timestamp: '2025-01-15T10:10:00.000Z', eventType: 'session' }),
      makeEvent({
        source: 'copilot-cli',
        timestamp: '2025-01-15T10:20:00.000Z',
        eventType: 'session',
      }),
    ]
    const digest = generateCrossToolDigest(events, DEFAULT_PERIOD)
    expect(digest.patterns.length).toBeGreaterThan(0)
  })

  it('summary is non-empty markdown', () => {
    const events = [
      makeEvent({ source: 'copilot-cli', timestamp: '2025-01-15T10:00:00.000Z' }),
      makeEvent({ source: 'claude-code', timestamp: '2025-01-15T11:00:00.000Z' }),
    ]
    const digest = generateCrossToolDigest(events, DEFAULT_PERIOD)
    expect(digest.summary.length).toBeGreaterThan(0)
    // Should contain markdown formatting
    expect(digest.summary).toContain('#')
  })

  it('period is preserved in output', () => {
    const period = {
      start: '2025-01-10T00:00:00.000Z',
      end: '2025-01-17T00:00:00.000Z',
    }
    const digest = generateCrossToolDigest([], period)
    expect(digest.period).toEqual(period)
  })

  it('generatedAt is a valid ISO timestamp', () => {
    const digest = generateCrossToolDigest([], DEFAULT_PERIOD)
    expect(() => new Date(digest.generatedAt)).not.toThrow()
    expect(new Date(digest.generatedAt).toISOString()).toBe(digest.generatedAt)
  })

  it('includes event count per source in summary', () => {
    const events = [
      makeEvent({ source: 'copilot-cli' }),
      makeEvent({ source: 'copilot-cli' }),
      makeEvent({ source: 'claude-code' }),
    ]
    const digest = generateCrossToolDigest(events, DEFAULT_PERIOD)
    expect(digest.summary).toContain('copilot-cli')
    expect(digest.summary).toContain('claude-code')
  })
})
