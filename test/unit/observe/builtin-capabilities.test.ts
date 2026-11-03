import { describe, it, expect } from 'vitest'
import {
  OBSERVER_CAPABILITIES,
  OBSERVER_DESCRIPTIONS,
} from '../../../src/observe/builtin-capabilities.js'

describe('OBSERVER_CAPABILITIES', () => {
  it('all known observer names have capability entries', () => {
    const expected = [
      'active-app',
      'browser-tab',
      'file-change',
      'git-activity',
      'terminal-history',
      'session-hook',
      'config-change-observer',
    ]

    for (const name of expected) {
      expect(OBSERVER_CAPABILITIES).toHaveProperty(name)
      expect(OBSERVER_CAPABILITIES[name]!.length).toBeGreaterThan(0)
    }
  })

  it('capabilities contain valid values', () => {
    const validCapabilities = new Set(['system', 'network', 'files', 'sessions', 'tools', 'custom'])

    for (const [_name, caps] of Object.entries(OBSERVER_CAPABILITIES)) {
      for (const cap of caps) {
        expect(validCapabilities.has(cap)).toBe(true)
      }
    }
  })

  it('active-app has system capability', () => {
    expect(OBSERVER_CAPABILITIES['active-app']).toContain('system')
  })

  it('browser-tab has network capability', () => {
    expect(OBSERVER_CAPABILITIES['browser-tab']).toContain('network')
  })

  it('file-change has files capability', () => {
    expect(OBSERVER_CAPABILITIES['file-change']).toContain('files')
  })

  it('git-activity has files capability', () => {
    expect(OBSERVER_CAPABILITIES['git-activity']).toContain('files')
  })

  it('terminal-history has system capability', () => {
    expect(OBSERVER_CAPABILITIES['terminal-history']).toContain('system')
  })

  it('session-hook has sessions capability', () => {
    expect(OBSERVER_CAPABILITIES['session-hook']).toContain('sessions')
  })

  it('config-change-observer has files capability', () => {
    expect(OBSERVER_CAPABILITIES['config-change-observer']).toContain('files')
  })
})

describe('OBSERVER_DESCRIPTIONS', () => {
  it('all known observer names have description entries', () => {
    const expected = [
      'active-app',
      'browser-tab',
      'file-change',
      'git-activity',
      'terminal-history',
      'session-hook',
      'config-change-observer',
    ]

    for (const name of expected) {
      expect(OBSERVER_DESCRIPTIONS).toHaveProperty(name)
      expect(OBSERVER_DESCRIPTIONS[name]!.length).toBeGreaterThan(0)
    }
  })

  it('descriptions are non-empty strings', () => {
    for (const [_name, desc] of Object.entries(OBSERVER_DESCRIPTIONS)) {
      expect(typeof desc).toBe('string')
      expect(desc.trim().length).toBeGreaterThan(0)
    }
  })
})
