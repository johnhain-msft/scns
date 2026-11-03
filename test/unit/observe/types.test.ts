import { describe, it, expect } from 'vitest'
import {
  ObservationType,
  ObservationSchema,
  ObserverConfigSchema,
  PrivacyConfigSchema,
} from '../../../src/observe/types.js'

describe('ObservationType', () => {
  it('contains all expected observation types', () => {
    expect(ObservationType.ActiveApp).toBe('active-app')
    expect(ObservationType.FileChange).toBe('file-change')
    expect(ObservationType.GitActivity).toBe('git-activity')
    expect(ObservationType.TerminalHistory).toBe('terminal-history')
    expect(ObservationType.BrowserTab).toBe('browser-tab')
    expect(ObservationType.SessionHook).toBe('session-hook')
  })

  it('has exactly 7 types', () => {
    expect(Object.keys(ObservationType)).toHaveLength(7)
  })
})

describe('ObservationSchema', () => {
  const validObservation = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'active-app' as const,
    timestamp: '2025-01-15T10:30:00Z',
    source: 'Chrome',
    content: 'Switched to Chrome — "GitHub - scns"',
    tags: ['app:chrome', 'category:browsing'],
  }

  it('parses a valid observation', () => {
    const result = ObservationSchema.parse(validObservation)
    expect(result.id).toBe(validObservation.id)
    expect(result.type).toBe('active-app')
    expect(result.source).toBe('Chrome')
    expect(result.tags).toEqual(['app:chrome', 'category:browsing'])
    expect(result.metadata).toBeUndefined()
  })

  it('accepts optional metadata', () => {
    const result = ObservationSchema.parse({
      ...validObservation,
      metadata: { windowId: 42, title: 'Some tab' },
    })
    expect(result.metadata).toEqual({ windowId: 42, title: 'Some tab' })
  })

  it('rejects missing required fields', () => {
    expect(() => ObservationSchema.parse({})).toThrow()
    expect(() => ObservationSchema.parse({ id: '550e8400-e29b-41d4-a716-446655440000' })).toThrow()
  })

  it('rejects non-uuid id', () => {
    expect(() => ObservationSchema.parse({ ...validObservation, id: 'not-a-uuid' })).toThrow()
  })

  it('rejects invalid ObservationType', () => {
    expect(() => ObservationSchema.parse({ ...validObservation, type: 'invalid-type' })).toThrow()
  })

  it('rejects invalid timestamp format', () => {
    expect(() =>
      ObservationSchema.parse({ ...validObservation, timestamp: 'not-a-date' }),
    ).toThrow()
  })

  it('accepts all valid observation types', () => {
    for (const type of Object.values(ObservationType)) {
      const result = ObservationSchema.parse({ ...validObservation, type })
      expect(result.type).toBe(type)
    }
  })

  it('requires tags to be an array of strings', () => {
    expect(() => ObservationSchema.parse({ ...validObservation, tags: 'not-an-array' })).toThrow()
    expect(() => ObservationSchema.parse({ ...validObservation, tags: [123] })).toThrow()
  })
})

describe('ObserverConfigSchema', () => {
  it('applies default values for empty object', () => {
    const result = ObserverConfigSchema.parse({})
    expect(result.enabled).toBe(true)
    expect(result.optIn).toBe(false)
    expect(result.intervalMs).toBeUndefined()
    expect(result.directories).toBeUndefined()
    expect(result.repos).toBeUndefined()
  })

  it('respects explicit enabled=false', () => {
    const result = ObserverConfigSchema.parse({ enabled: false })
    expect(result.enabled).toBe(false)
  })

  it('accepts valid intervalMs', () => {
    const result = ObserverConfigSchema.parse({ intervalMs: 5000 })
    expect(result.intervalMs).toBe(5000)
  })

  it('rejects intervalMs below minimum', () => {
    expect(() => ObserverConfigSchema.parse({ intervalMs: 500 })).toThrow()
  })

  it('accepts directories array', () => {
    const result = ObserverConfigSchema.parse({ directories: ['/home/user/project'] })
    expect(result.directories).toEqual(['/home/user/project'])
  })

  it('accepts repos array', () => {
    const result = ObserverConfigSchema.parse({ repos: ['/repo1', '/repo2'] })
    expect(result.repos).toEqual(['/repo1', '/repo2'])
  })

  it('accepts optIn flag', () => {
    const result = ObserverConfigSchema.parse({ optIn: true })
    expect(result.optIn).toBe(true)
  })
})

describe('PrivacyConfigSchema', () => {
  it('applies default values for empty object', () => {
    const result = PrivacyConfigSchema.parse({})
    expect(result.excludeApps).toEqual([])
    expect(result.excludePaths).toEqual([])
    expect(result.excludeUrls).toEqual([])
    expect(result.sanitizeSecrets).toBe(true)
    expect(result.terminalHistoryOptIn).toBe(false)
    expect(result.browserTabsOptIn).toBe(false)
  })

  it('accepts exclude patterns', () => {
    const result = PrivacyConfigSchema.parse({
      excludeApps: ['1Password', 'Keychain*'],
      excludePaths: ['**/.env', '**/secrets/**'],
      excludeUrls: ['*bank*', '*password*'],
    })
    expect(result.excludeApps).toEqual(['1Password', 'Keychain*'])
    expect(result.excludePaths).toEqual(['**/.env', '**/secrets/**'])
    expect(result.excludeUrls).toEqual(['*bank*', '*password*'])
  })

  it('accepts privacy opt-in flags', () => {
    const result = PrivacyConfigSchema.parse({
      terminalHistoryOptIn: true,
      browserTabsOptIn: true,
    })
    expect(result.terminalHistoryOptIn).toBe(true)
    expect(result.browserTabsOptIn).toBe(true)
  })

  it('accepts sanitizeSecrets override', () => {
    const result = PrivacyConfigSchema.parse({ sanitizeSecrets: false })
    expect(result.sanitizeSecrets).toBe(false)
  })
})
