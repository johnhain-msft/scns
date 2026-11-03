import { describe, it, expect } from 'vitest'
import {
  SESSION_STATUSES,
  TRANSITIONS,
  validateTransition,
  getValidTransitions,
  isTerminalStatus,
  type SessionStatus,
} from '../../../src/broker/lifecycle.js'
import { ConflictError } from '../../../src/broker/errors.js'

describe('lifecycle state machine', () => {
  describe('SESSION_STATUSES', () => {
    it('should contain all 9 statuses', () => {
      expect(SESSION_STATUSES).toEqual([
        'registered',
        'active',
        'working',
        'reporting',
        'idle',
        'paused',
        'completed',
        'zombie',
        'expired',
      ])
      expect(SESSION_STATUSES).toHaveLength(9)
    })

    it('should be frozen/immutable', () => {
      expect(Object.isFrozen(SESSION_STATUSES)).toBe(true)
    })
  })

  describe('TRANSITIONS', () => {
    it('should be frozen/immutable', () => {
      expect(Object.isFrozen(TRANSITIONS)).toBe(true)
    })

    it('registered can transition to active or expired', () => {
      expect(TRANSITIONS.registered).toEqual(['active', 'expired'])
    })

    it('active can transition to working, paused, completed, zombie, expired', () => {
      expect(TRANSITIONS.active).toEqual(['working', 'paused', 'completed', 'zombie', 'expired'])
    })

    it('working can transition to reporting, active, paused, zombie, expired', () => {
      expect(TRANSITIONS.working).toEqual(['reporting', 'active', 'paused', 'zombie', 'expired'])
    })

    it('reporting can transition to idle, active, zombie, expired', () => {
      expect(TRANSITIONS.reporting).toEqual(['idle', 'active', 'zombie', 'expired'])
    })

    it('idle can transition to active, working, completed, zombie, expired', () => {
      expect(TRANSITIONS.idle).toEqual(['active', 'working', 'completed', 'zombie', 'expired'])
    })

    it('paused can transition to active, completed, zombie, expired', () => {
      expect(TRANSITIONS.paused).toEqual(['active', 'completed', 'zombie', 'expired'])
    })

    // Issue #70: no status is fully terminal any more — identity is durable
    // and revives on explicit re-registration/resume (completed, zombie) or
    // any proof of life (expired).
    it('completed revives only to active (resume / re-register)', () => {
      expect(TRANSITIONS.completed).toEqual(['active'])
    })

    it('zombie revives to active or is retired to expired', () => {
      expect(TRANSITIONS.zombie).toEqual(['active', 'expired'])
    })

    it('expired revives only to active (any proof of life)', () => {
      expect(TRANSITIONS.expired).toEqual(['active'])
    })

    it('each transition target array should be frozen', () => {
      for (const status of SESSION_STATUSES) {
        expect(Object.isFrozen(TRANSITIONS[status])).toBe(true)
      }
    })
  })

  describe('validateTransition', () => {
    it('should not throw for valid transitions', () => {
      expect(() => validateTransition('registered', 'active')).not.toThrow()
      expect(() => validateTransition('active', 'working')).not.toThrow()
      expect(() => validateTransition('working', 'reporting')).not.toThrow()
    })

    it('should throw ConflictError for invalid transitions', () => {
      expect(() => validateTransition('registered', 'working')).toThrow(ConflictError)
      expect(() => validateTransition('active', 'registered')).toThrow(ConflictError)
    })

    it('revival transitions are valid; sideways moves from retired states are not', () => {
      expect(() => validateTransition('completed', 'active')).not.toThrow()
      expect(() => validateTransition('zombie', 'active')).not.toThrow()
      expect(() => validateTransition('expired', 'active')).not.toThrow()
      expect(() => validateTransition('completed', 'working')).toThrow(ConflictError)
      expect(() => validateTransition('expired', 'zombie')).toThrow(ConflictError)
    })

    it('error message should include from and to states', () => {
      expect(() => validateTransition('registered', 'working')).toThrow(/registered.*working/)
    })

    it('error message should include allowed transitions', () => {
      expect(() => validateTransition('registered', 'working')).toThrow(/active/)
    })
  })

  describe('getValidTransitions', () => {
    it('should return allowed transitions for each status', () => {
      expect(getValidTransitions('registered')).toEqual(['active', 'expired'])
      expect(getValidTransitions('active')).toEqual([
        'working',
        'paused',
        'completed',
        'zombie',
        'expired',
      ])
      expect(getValidTransitions('idle')).toEqual([
        'active',
        'working',
        'completed',
        'zombie',
        'expired',
      ])
    })

    it('retired statuses can only revive to active', () => {
      expect(getValidTransitions('completed')).toEqual(['active'])
      expect(getValidTransitions('zombie')).toEqual(['active', 'expired'])
      expect(getValidTransitions('expired')).toEqual(['active'])
    })

    it('should return readonly array', () => {
      const transitions = getValidTransitions('active')
      expect(Object.isFrozen(transitions)).toBe(true)
    })
  })

  describe('isTerminalStatus', () => {
    // Issue #70: identity is durable — every status has a revival path, so
    // nothing is terminal any more.
    it('should return false for completed (revivable by resume/re-register)', () => {
      expect(isTerminalStatus('completed')).toBe(false)
    })

    it('should return false for zombie (revivable by discovery/re-register)', () => {
      expect(isTerminalStatus('zombie')).toBe(false)
    })

    it('should return false for all non-terminal statuses', () => {
      const nonTerminal: SessionStatus[] = [
        'registered',
        'active',
        'working',
        'reporting',
        'idle',
        'paused',
      ]
      for (const status of nonTerminal) {
        expect(isTerminalStatus(status)).toBe(false)
      }
    })
  })

  describe('exhaustive valid transitions', () => {
    const validTransitions: [SessionStatus, SessionStatus][] = [
      ['registered', 'active'],
      ['active', 'working'],
      ['active', 'paused'],
      ['active', 'completed'],
      ['active', 'zombie'],
      ['working', 'reporting'],
      ['working', 'active'],
      ['working', 'paused'],
      ['working', 'zombie'],
      ['reporting', 'idle'],
      ['reporting', 'active'],
      ['reporting', 'zombie'],
      ['idle', 'active'],
      ['idle', 'working'],
      ['idle', 'completed'],
      ['idle', 'zombie'],
      ['paused', 'active'],
      ['paused', 'completed'],
      ['paused', 'zombie'],
      ['active', 'expired'],
      ['zombie', 'active'],
      ['zombie', 'expired'],
      ['completed', 'active'],
      ['expired', 'active'],
    ]

    it.each(validTransitions)('%s → %s should be valid', (from, to) => {
      expect(() => validateTransition(from, to)).not.toThrow()
    })

    const invalidTransitions: [SessionStatus, SessionStatus][] = [
      ['registered', 'working'],
      ['registered', 'completed'],
      ['registered', 'zombie'],
      ['completed', 'zombie'],
      ['completed', 'working'],
      ['zombie', 'completed'],
      ['expired', 'zombie'],
      ['expired', 'completed'],
      ['active', 'registered'],
      ['working', 'registered'],
      ['idle', 'registered'],
    ]

    it.each(invalidTransitions)('%s → %s should be invalid', (from, to) => {
      expect(() => validateTransition(from, to)).toThrow(ConflictError)
    })
  })
})
