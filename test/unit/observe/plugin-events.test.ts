import { describe, it, expect } from 'vitest'
import type { ObservationEvent } from '../../../src/observe/plugin-events.js'
import { toObservation } from '../../../src/observe/plugin-events.js'
import { ObservationSchema } from '../../../src/observe/types.js'

function createTestEvent(overrides?: Partial<ObservationEvent>): ObservationEvent {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    source: 'test-plugin',
    type: 'file.created',
    timestamp: '2025-01-15T10:30:00Z',
    payload: { path: '/src/index.ts', size: 1024 },
    tags: ['source:test-plugin', 'type:file.created'],
    ...overrides,
  }
}

describe('ObservationEvent', () => {
  it('can be created with all required fields', () => {
    const event = createTestEvent()
    expect(event.id).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(event.source).toBe('test-plugin')
    expect(event.type).toBe('file.created')
    expect(event.timestamp).toBe('2025-01-15T10:30:00Z')
    expect(event.payload).toEqual({ path: '/src/index.ts', size: 1024 })
    expect(event.tags).toEqual(['source:test-plugin', 'type:file.created'])
  })

  it('accepts empty payload', () => {
    const event = createTestEvent({ payload: {} })
    expect(event.payload).toEqual({})
  })

  it('accepts empty tags array', () => {
    const event = createTestEvent({ tags: [] })
    expect(event.tags).toEqual([])
  })

  it('supports complex nested payloads', () => {
    const event = createTestEvent({
      payload: {
        nested: { deep: { value: 42 } },
        items: [1, 2, 3],
        flag: true,
      },
    })
    expect(event.payload).toEqual({
      nested: { deep: { value: 42 } },
      items: [1, 2, 3],
      flag: true,
    })
  })
})

describe('toObservation', () => {
  it('converts an ObservationEvent to a valid Observation', () => {
    const event = createTestEvent()
    const obs = toObservation(event, 'file-change')

    expect(obs.id).toBe(event.id)
    expect(obs.type).toBe('file-change')
    expect(obs.timestamp).toBe(event.timestamp)
    expect(obs.source).toBe(event.source)
    expect(obs.tags).toEqual(event.tags)
    expect(obs.content).toContain('/src/index.ts')
  })

  it('produces an observation that passes ObservationSchema', () => {
    const event = createTestEvent()
    const obs = toObservation(event, 'file-change')
    const result = ObservationSchema.safeParse(obs)
    expect(result.success).toBe(true)
  })

  it('stores the event type in metadata', () => {
    const event = createTestEvent({ type: 'commit.pushed' })
    const obs = toObservation(event, 'git-activity')
    expect(obs.metadata?.eventType).toBe('commit.pushed')
  })

  it('preserves payload in metadata', () => {
    const event = createTestEvent({ payload: { branch: 'main' } })
    const obs = toObservation(event, 'git-activity')
    expect(obs.metadata?.payload).toEqual({ branch: 'main' })
  })

  it('handles empty tags', () => {
    const event = createTestEvent({ tags: [] })
    const obs = toObservation(event, 'session-hook')
    expect(obs.tags).toEqual([])
  })

  it('handles empty payload gracefully', () => {
    const event = createTestEvent({ payload: {} })
    const obs = toObservation(event, 'active-app')
    expect(obs.content).toBeTruthy()
  })

  it('works with all valid observation types', () => {
    const types = [
      'active-app',
      'file-change',
      'git-activity',
      'terminal-history',
      'browser-tab',
      'session-hook',
    ] as const

    for (const type of types) {
      const event = createTestEvent()
      const obs = toObservation(event, type)
      expect(obs.type).toBe(type)
      const result = ObservationSchema.safeParse(obs)
      expect(result.success).toBe(true)
    }
  })

  it('safely handles payload that would fail naive JSON.stringify', () => {
    // undefined values are stripped by JSON.stringify but should not throw
    const event = createTestEvent({
      payload: { a: undefined as unknown as string, b: 'ok' },
    })
    const obs = toObservation(event, 'session-hook')
    expect(obs.content).toBeTruthy()
  })
})
