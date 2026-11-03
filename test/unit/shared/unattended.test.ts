/**
 * Unattended-action opt-in gate (#53 AC4).
 *
 * Five daemons act on the user's behalf OUTSIDE the local machine: three
 * write to GitHub (push a branch + open a PR, file issues) and two spawn
 * agent sessions that spend real credits. Until alpha they were all
 * default-ON with a kill-switch, which is the wrong polarity for a repo
 * a stranger clones: someone who pastes the quick-start would have SCNS
 * pushing branches and opening PRs in their own repo without ever opting
 * in. This gate inverts that — OFF unless explicitly enabled — while
 * keeping every pre-existing kill-switch working exactly as documented.
 */
import { describe, expect, it } from 'vitest'

import {
  UNATTENDED_ENV_VARS,
  UNATTENDED_FEATURES,
  UNATTENDED_MASTER_ENV,
  isUnattendedEnabled,
  unattendedEnvVar,
  unattendedStatusDetail,
  type UnattendedFeature,
} from '../../../src/shared/unattended.js'

describe('unattended opt-in gate', () => {
  describe('default posture', () => {
    it('is OFF for every feature when the environment says nothing', () => {
      for (const feature of UNATTENDED_FEATURES) {
        expect(isUnattendedEnabled(feature, {}), feature).toBe(false)
      }
    })

    it('is OFF when the feature var is present but empty or whitespace', () => {
      for (const feature of UNATTENDED_FEATURES) {
        const key = unattendedEnvVar(feature)
        expect(isUnattendedEnabled(feature, { [key]: '' }), feature).toBe(false)
        expect(isUnattendedEnabled(feature, { [key]: '   ' }), feature).toBe(false)
      }
    })

    it('covers exactly the five daemons that act outside this machine', () => {
      expect([...UNATTENDED_FEATURES].sort()).toEqual([
        'drift-watchdog',
        'gate-pass-publisher',
        'north-star-nudge',
        'self-improve-followups',
        'team-task-autospawner',
      ])
    })
  })

  describe('per-feature opt-in', () => {
    it('turns a single feature ON without enabling its siblings', () => {
      const env = { BROKER_PUBLISH_GATE_PASS: '1' }
      expect(isUnattendedEnabled('gate-pass-publisher', env)).toBe(true)
      expect(isUnattendedEnabled('north-star-nudge', env)).toBe(false)
      expect(isUnattendedEnabled('drift-watchdog', env)).toBe(false)
      expect(isUnattendedEnabled('team-task-autospawner', env)).toBe(false)
      expect(isUnattendedEnabled('self-improve-followups', env)).toBe(false)
    })

    it.each(['1', 'true', 'TRUE', 'True', 'yes', 'on'])('accepts %s as opt-in', (value) => {
      for (const feature of UNATTENDED_FEATURES) {
        const key = unattendedEnvVar(feature)
        expect(isUnattendedEnabled(feature, { [key]: value }), `${feature}=${value}`).toBe(true)
      }
    })
  })

  describe('master switch', () => {
    it('enables the whole family', () => {
      const env = { [UNATTENDED_MASTER_ENV]: '1' }
      for (const feature of UNATTENDED_FEATURES) {
        expect(isUnattendedEnabled(feature, env), feature).toBe(true)
      }
    })

    it('is itself default-OFF and rejects unrecognised values', () => {
      for (const feature of UNATTENDED_FEATURES) {
        expect(isUnattendedEnabled(feature, { [UNATTENDED_MASTER_ENV]: 'maybe' }), feature).toBe(
          false,
        )
      }
    })
  })

  describe('pre-existing kill-switches keep working', () => {
    // These are the exact strings documented before #53. A user who set
    // them to disable a daemon must not have it silently re-enabled by
    // the new master switch.
    const KILL: ReadonlyArray<readonly [UnattendedFeature, string, string]> = [
      ['gate-pass-publisher', 'BROKER_PUBLISH_GATE_PASS', '0'],
      ['north-star-nudge', 'BROKER_NORTH_STAR_NUDGE', '0'],
      ['drift-watchdog', 'SCNS_DRIFT_WATCHDOG', '0'],
      ['team-task-autospawner', 'BROKER_AUTOSPAWN_ENABLED', 'false'],
      ['self-improve-followups', 'BROKER_SELF_IMPROVE_FOLLOWUPS', '0'],
    ]

    it.each(KILL)('%s: %s=%s still disables it', (feature, key, value) => {
      expect(isUnattendedEnabled(feature, { [key]: value })).toBe(false)
    })

    it.each(KILL)('%s: %s=%s beats the master switch', (feature, key, value) => {
      const env = { [UNATTENDED_MASTER_ENV]: '1', [key]: value }
      expect(isUnattendedEnabled(feature, env)).toBe(false)
    })

    it.each(['0', 'false', 'FALSE', 'no', 'off'])('treats %s as a kill-switch', (value) => {
      for (const feature of UNATTENDED_FEATURES) {
        const key = unattendedEnvVar(feature)
        expect(isUnattendedEnabled(feature, { [key]: value }), `${feature}=${value}`).toBe(false)
      }
    })
  })

  describe('fail-closed', () => {
    it('treats an unrecognised feature value as OFF, not ON', () => {
      for (const feature of UNATTENDED_FEATURES) {
        const key = unattendedEnvVar(feature)
        expect(isUnattendedEnabled(feature, { [key]: 'enabled-please' }), feature).toBe(false)
        expect(isUnattendedEnabled(feature, { [key]: '2' }), feature).toBe(false)
      }
    })

    it('does not let an unrecognised feature value inherit a master ON', () => {
      // Ambiguity must resolve to the safe side: someone who typed a
      // value we do not understand gets no unattended GitHub writes.
      const env = { [UNATTENDED_MASTER_ENV]: '1', BROKER_PUBLISH_GATE_PASS: 'sure' }
      expect(isUnattendedEnabled('gate-pass-publisher', env)).toBe(false)
    })
  })

  describe('env var mapping', () => {
    it('maps every feature to the variable that was documented for it', () => {
      expect(UNATTENDED_ENV_VARS).toEqual({
        'gate-pass-publisher': 'BROKER_PUBLISH_GATE_PASS',
        'north-star-nudge': 'BROKER_NORTH_STAR_NUDGE',
        'drift-watchdog': 'SCNS_DRIFT_WATCHDOG',
        'team-task-autospawner': 'BROKER_AUTOSPAWN_ENABLED',
        'self-improve-followups': 'BROKER_SELF_IMPROVE_FOLLOWUPS',
      })
    })
  })

  describe('operator-facing status line', () => {
    it('names the variable to set when the feature is off', () => {
      const detail = unattendedStatusDetail('gate-pass-publisher', {})
      expect(detail).toContain('BROKER_PUBLISH_GATE_PASS=1')
      expect(detail).toContain('opt-in')
    })

    it('reports which switch turned it on', () => {
      expect(unattendedStatusDetail('drift-watchdog', { SCNS_DRIFT_WATCHDOG: '1' })).toContain(
        'SCNS_DRIFT_WATCHDOG',
      )
      expect(unattendedStatusDetail('drift-watchdog', { [UNATTENDED_MASTER_ENV]: '1' })).toContain(
        UNATTENDED_MASTER_ENV,
      )
    })
  })
})
