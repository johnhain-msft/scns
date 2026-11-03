import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadAutonomy,
  saveAutonomy,
  seedAutonomyIfAbsent,
  promote,
  demote,
  getAutonomyDescription,
} from '../../../src/shared/autonomy.js'
import type { AutonomyState } from '../../../src/shared/autonomy.js'

let TEST_STATE_DIR: string

describe('autonomy', () => {
  beforeEach(() => {
    TEST_STATE_DIR = mkdtempSync(join(tmpdir(), 'scns-autonomy-'))
  })

  afterEach(() => {
    rmSync(TEST_STATE_DIR, { recursive: true, force: true })
  })

  describe('seedAutonomyIfAbsent', () => {
    it('seeds the level from the flag when no state file exists', () => {
      const state = seedAutonomyIfAbsent(TEST_STATE_DIR, 2)
      expect(state.level).toBe(2)
      expect(state.changedBy).toBe('startup-flag')
      // and it persisted, so a subsequent load reads 2 (not the default 0)
      expect(loadAutonomy(TEST_STATE_DIR).level).toBe(2)
    })

    it('does NOT overwrite an existing store (idempotent)', () => {
      saveAutonomy(TEST_STATE_DIR, {
        level: 1,
        changedAt: '2024-01-01T00:00:00.000Z',
        changedBy: 'user',
      })
      const state = seedAutonomyIfAbsent(TEST_STATE_DIR, 3)
      expect(state.level).toBe(1) // unchanged
      expect(loadAutonomy(TEST_STATE_DIR).level).toBe(1)
    })

    it('clamps an out-of-range seed level', () => {
      expect(seedAutonomyIfAbsent(TEST_STATE_DIR, 9).level).toBe(3)
    })
  })

  describe('loadAutonomy', () => {
    it('returns default state (level 0) when file does not exist', () => {
      const state = loadAutonomy(TEST_STATE_DIR)
      expect(state.level).toBe(0)
      expect(state.changedBy).toBe('user')
      expect(state.changedAt).toBeTruthy()
    })

    it('loads saved state from file', () => {
      const saved: AutonomyState = {
        level: 2,
        changedAt: '2024-01-01T00:00:00.000Z',
        changedBy: 'brain',
      }
      writeFileSync(join(TEST_STATE_DIR, 'autonomy.json'), JSON.stringify(saved))

      const state = loadAutonomy(TEST_STATE_DIR)
      expect(state.level).toBe(2)
      expect(state.changedBy).toBe('brain')
      expect(state.changedAt).toBe('2024-01-01T00:00:00.000Z')
    })

    it('returns default state when level is out of valid range', () => {
      writeFileSync(
        join(TEST_STATE_DIR, 'autonomy.json'),
        JSON.stringify({ level: 99, changedAt: 'now', changedBy: 'user' }),
      )
      const state = loadAutonomy(TEST_STATE_DIR)
      expect(state.level).toBe(0)
      expect(state.changedBy).toBe('user')
    })
  })

  describe('saveAutonomy', () => {
    it('creates directory and writes file', () => {
      const nested = join(TEST_STATE_DIR, 'nested', 'dir')
      const state: AutonomyState = {
        level: 1,
        changedAt: '2024-06-15T12:00:00Z',
        changedBy: 'user',
      }
      saveAutonomy(nested, state)

      const raw = readFileSync(join(nested, 'autonomy.json'), 'utf-8')
      const loaded = JSON.parse(raw) as AutonomyState
      expect(loaded.level).toBe(1)
    })

    it('round-trips with loadAutonomy', () => {
      const state: AutonomyState = {
        level: 3,
        changedAt: '2024-12-25T00:00:00Z',
        changedBy: 'brain',
      }
      saveAutonomy(TEST_STATE_DIR, state)
      const loaded = loadAutonomy(TEST_STATE_DIR)
      expect(loaded.level).toBe(3)
      expect(loaded.changedBy).toBe('brain')
    })
  })

  describe('promote', () => {
    it('increments level from 0 to 1', () => {
      saveAutonomy(TEST_STATE_DIR, { level: 0, changedAt: 'x', changedBy: 'user' })
      const result = promote(TEST_STATE_DIR)
      expect(result.level).toBe(1)
      expect(result.changedBy).toBe('user')
    })

    it('caps at level 3', () => {
      saveAutonomy(TEST_STATE_DIR, { level: 3, changedAt: 'x', changedBy: 'user' })
      const result = promote(TEST_STATE_DIR)
      expect(result.level).toBe(3)
    })

    it('persists the promoted state', () => {
      saveAutonomy(TEST_STATE_DIR, { level: 1, changedAt: 'x', changedBy: 'user' })
      promote(TEST_STATE_DIR)
      const loaded = loadAutonomy(TEST_STATE_DIR)
      expect(loaded.level).toBe(2)
    })
  })

  describe('demote', () => {
    it('decrements level from 2 to 1', () => {
      saveAutonomy(TEST_STATE_DIR, { level: 2, changedAt: 'x', changedBy: 'user' })
      const result = demote(TEST_STATE_DIR)
      expect(result.level).toBe(1)
    })

    it('floors at level 0', () => {
      saveAutonomy(TEST_STATE_DIR, { level: 0, changedAt: 'x', changedBy: 'user' })
      const result = demote(TEST_STATE_DIR)
      expect(result.level).toBe(0)
    })

    it('persists the demoted state', () => {
      saveAutonomy(TEST_STATE_DIR, { level: 3, changedAt: 'x', changedBy: 'user' })
      demote(TEST_STATE_DIR)
      const loaded = loadAutonomy(TEST_STATE_DIR)
      expect(loaded.level).toBe(2)
    })
  })

  describe('getAutonomyDescription', () => {
    it('returns correct description for level 0', () => {
      expect(getAutonomyDescription(0)).toContain('Observer')
    })

    it('returns correct description for level 1', () => {
      expect(getAutonomyDescription(1)).toContain('Assistant')
    })

    it('returns correct description for level 2', () => {
      expect(getAutonomyDescription(2)).toContain('Collaborator')
    })

    it('returns correct description for level 3', () => {
      expect(getAutonomyDescription(3)).toContain('Autonomous')
    })

    it('returns fallback for unknown levels', () => {
      expect(getAutonomyDescription(99)).toContain('Unknown level 99')
    })
  })
})
