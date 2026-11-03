/**
 * Issue #61 — Windows has no supervision root.
 *
 * `triggerSelfHeal` drains and `process.exit(1)`s on the assumption that a
 * supervisor (launchd `KeepAlive=true`) relaunches the process. On Windows
 * there is no such supervisor, so the exit is permanent: strictly worse than
 * having no self-heal at all. These tests pin the single fact the rest of the
 * fix hangs off — *is there anything here that will relaunch me?* — and the
 * arming decision derived from it.
 */

import { describe, it, expect } from 'vitest'
import {
  SUPERVISED_ENV,
  detectSupervision,
  decideSelfHealArming,
  describeSupervision,
} from '../../../../src/broker/services/supervision.js'

describe('detectSupervision', () => {
  it('reports launchd on darwin', () => {
    const s = detectSupervision({ platform: 'darwin', env: {} })
    expect(s.kind).toBe('launchd')
    expect(s.relaunches).toBe(true)
  })

  it('reports systemd on linux', () => {
    const s = detectSupervision({ platform: 'linux', env: {} })
    expect(s.kind).toBe('systemd')
    expect(s.relaunches).toBe(true)
  })

  it('reports NO supervision on win32 by default — the #61 defect', () => {
    const s = detectSupervision({ platform: 'win32', env: {} })
    expect(s.kind).toBe('none')
    expect(s.relaunches).toBe(false)
  })

  it('honours an explicit supervisor claim on win32', () => {
    const s = detectSupervision({ platform: 'win32', env: { [SUPERVISED_ENV]: '1' } })
    expect(s.kind).toBe('external-watchdog')
    expect(s.relaunches).toBe(true)
  })

  it('ignores a supervisor claim that is not exactly "1"', () => {
    for (const v of ['0', '', 'true', 'yes']) {
      expect(detectSupervision({ platform: 'win32', env: { [SUPERVISED_ENV]: v } }).kind).toBe(
        'none',
      )
    }
  })

  it('treats an unknown platform as unsupervised', () => {
    const s = detectSupervision({ platform: 'aix' as NodeJS.Platform, env: {} })
    expect(s.kind).toBe('none')
    expect(s.relaunches).toBe(false)
  })

  it('always carries a human-readable detail string', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(detectSupervision({ platform, env: {} }).detail).toMatch(/\S/)
    }
  })
})

describe('decideSelfHealArming', () => {
  it('arms on darwin (preserves pre-#61 behaviour)', () => {
    const d = decideSelfHealArming({ platform: 'darwin', env: {} })
    expect(d.armed).toBe(true)
    expect(d.reason).toBe('supervised')
  })

  it('arms on linux (preserves pre-#61 behaviour)', () => {
    expect(decideSelfHealArming({ platform: 'linux', env: {} }).armed).toBe(true)
  })

  it('REFUSES to arm on win32 with no relaunch substrate', () => {
    const d = decideSelfHealArming({ platform: 'win32', env: {} })
    expect(d.armed).toBe(false)
    expect(d.reason).toBe('no-relaunch-substrate')
    // The operator has to be told how to get a substrate, not just that it is absent.
    expect(d.detail).toContain('watchdog')
  })

  it('arms on win32 once a supervisor announces itself', () => {
    const d = decideSelfHealArming({ platform: 'win32', env: { [SUPERVISED_ENV]: '1' } })
    expect(d.armed).toBe(true)
    expect(d.reason).toBe('supervised')
  })

  it('the SCNS_BROKER_SELF_HEAL=0 kill-switch still wins everywhere', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const d = decideSelfHealArming({
        platform,
        env: { SCNS_BROKER_SELF_HEAL: '0', [SUPERVISED_ENV]: '1' },
      })
      expect(d.armed).toBe(false)
      expect(d.reason).toBe('env-disabled')
    }
  })

  it('SCNS_BROKER_SELF_HEAL=1 force-arms an unsupervised host (operator override)', () => {
    const d = decideSelfHealArming({ platform: 'win32', env: { SCNS_BROKER_SELF_HEAL: '1' } })
    expect(d.armed).toBe(true)
    expect(d.reason).toBe('env-forced')
  })

  it('a bare SCNS_BROKER_SELF_HEAL default (unset) does not force-arm win32', () => {
    expect(decideSelfHealArming({ platform: 'win32', env: {} }).armed).toBe(false)
  })
})

describe('describeSupervision', () => {
  it('renders a one-line summary naming the mechanism', () => {
    expect(describeSupervision(detectSupervision({ platform: 'darwin', env: {} }))).toContain(
      'launchd',
    )
    expect(describeSupervision(detectSupervision({ platform: 'win32', env: {} }))).toContain('none')
  })
})
