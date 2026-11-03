import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../../src/broker/storage/db.js'
import {
  registerRole,
  listRoles,
  isRoleRegistered,
} from '../../../src/broker/role-registry.js'

describe('role-registry (P4: de-hardcode roles)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => closeDatabase(db))

  describe('builtin seeding', () => {
    it('seeds the known SCNS + generic roles as builtin on a fresh DB', () => {
      const roles = listRoles(db)
      const names = new Set(roles.map((r) => r.role))
      for (const r of ['scns-manager', 'scns-dev', 'scns-qa', 'general', 'critic']) {
        expect(names.has(r)).toBe(true)
      }
      const mgr = roles.find((r) => r.role === 'scns-manager')!
      expect(mgr.builtin).toBe(true)
    })

    it('marks the three task-spawnable SCNS roles spawnable, others not', () => {
      const roles = listRoles(db)
      const byName = new Map(roles.map((r) => [r.role, r]))
      expect(byName.get('scns-manager')!.spawnable).toBe(true)
      expect(byName.get('scns-dev')!.spawnable).toBe(true)
      expect(byName.get('scns-qa')!.spawnable).toBe(true)
      expect(byName.get('general')!.spawnable).toBe(false)
      expect(byName.get('critic')!.spawnable).toBe(false)
    })

    it('seeds scns-researcher as a builtin, task-spawnable role (Track 1 / 1C)', () => {
      const roles = listRoles(db)
      const byName = new Map(roles.map((r) => [r.role, r]))
      const researcher = byName.get('scns-researcher')
      expect(researcher).toBeDefined()
      expect(researcher!.builtin).toBe(true)
      expect(researcher!.spawnable).toBe(true)
    })
  })

  describe('registerRole', () => {
    it('adds a novel role at runtime (self-innovate path)', () => {
      expect(isRoleRegistered(db, 'data-scientist')).toBe(false)
      registerRole(db, { role: 'data-scientist', description: 'analyzes datasets' })
      expect(isRoleRegistered(db, 'data-scientist')).toBe(true)
      const row = listRoles(db).find((r) => r.role === 'data-scientist')!
      expect(row).toMatchObject({
        role: 'data-scientist',
        description: 'analyzes datasets',
        builtin: false,
        spawnable: false,
      })
    })

    it('is idempotent (upsert) and can update description/spawnable', () => {
      registerRole(db, { role: 'analyst' })
      registerRole(db, { role: 'analyst', description: 'updated', spawnable: true })
      const rows = listRoles(db).filter((r) => r.role === 'analyst')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ description: 'updated', spawnable: true })
    })

    it('never downgrades a builtin role to non-builtin', () => {
      registerRole(db, { role: 'scns-dev', description: 'hijack attempt' })
      const row = listRoles(db).find((r) => r.role === 'scns-dev')!
      expect(row.builtin).toBe(true)
    })

    it('rejects empty/whitespace role names', () => {
      expect(() => registerRole(db, { role: '' })).toThrow()
      expect(() => registerRole(db, { role: '   ' })).toThrow()
    })

    it('trims surrounding whitespace on the role name', () => {
      registerRole(db, { role: '  spacey  ' })
      expect(isRoleRegistered(db, 'spacey')).toBe(true)
    })
  })

  describe('isRoleRegistered', () => {
    it('returns false for unknown roles', () => {
      expect(isRoleRegistered(db, 'nope')).toBe(false)
    })
  })
})
