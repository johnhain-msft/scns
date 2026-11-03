import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import {
  createTeam,
  findAllTeams,
} from '../../../../src/broker/storage/repositories/team-repository.js'
import {
  createSession,
  findAllSessions,
} from '../../../../src/broker/storage/repositories/session-repository.js'

describe('multi-project (P3) repository scoping', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => {
    closeDatabase(db)
  })

  describe('createTeam stamps project_id', () => {
    it('persists the provided project_id', () => {
      const team = createTeam(db, { id: 't1', name: 'alpha', project_id: 'proj-a' })
      expect(team.project_id).toBe('proj-a')
    })

    it('defaults project_id to null when omitted (legacy behaviour)', () => {
      const team = createTeam(db, { id: 't2', name: 'beta' })
      expect(team.project_id ?? null).toBeNull()
    })
  })

  describe('createSession stamps project_id', () => {
    it('persists the provided project_id', () => {
      const s = createSession(db, {
        id: 's1',
        purpose: 'x',
        working_dir: '/repo',
        worktree: null,
        project_id: 'proj-a',
      })
      expect(s.project_id).toBe('proj-a')
    })
  })

  describe('findAllTeams strict project scoping', () => {
    beforeEach(() => {
      createTeam(db, { id: 'a1', name: 'a-one', project_id: 'proj-a' })
      createTeam(db, { id: 'a2', name: 'a-two', project_id: 'proj-a' })
      createTeam(db, { id: 'b1', name: 'b-one', project_id: 'proj-b' })
      createTeam(db, { id: 'legacy', name: 'legacy-team' }) // project_id NULL
    })

    it('returns only the requested project (legacy NULL rows excluded)', () => {
      const teams = findAllTeams(db, undefined, undefined, undefined, 'proj-a')
      expect(teams.map((t) => t.id).sort()).toEqual(['a1', 'a2'])
    })

    it('does NOT leak other projects', () => {
      const teams = findAllTeams(db, undefined, undefined, undefined, 'proj-b')
      expect(teams.map((t) => t.id)).toEqual(['b1'])
    })

    it('returns all teams (including legacy NULL) when no projectId given', () => {
      const teams = findAllTeams(db)
      expect(teams.map((t) => t.id).sort()).toEqual(['a1', 'a2', 'b1', 'legacy'])
    })

    it('composes project scope with a status filter', () => {
      const teams = findAllTeams(db, 'active', undefined, undefined, 'proj-a')
      expect(teams.map((t) => t.id).sort()).toEqual(['a1', 'a2'])
    })
  })

  describe('findAllSessions strict project scoping', () => {
    beforeEach(() => {
      createSession(db, { id: 'sa', purpose: 'x', working_dir: '/a', worktree: null, project_id: 'proj-a' })
      createSession(db, { id: 'sb', purpose: 'x', working_dir: '/b', worktree: null, project_id: 'proj-b' })
      createSession(db, { id: 'sl', purpose: 'x', working_dir: '/l', worktree: null }) // NULL
    })

    it('returns only the requested project (legacy NULL excluded)', () => {
      const rows = findAllSessions(db, undefined, undefined, 'proj-a')
      expect(rows.map((r) => r.id)).toEqual(['sa'])
    })

    it('returns all sessions when no projectId given', () => {
      const rows = findAllSessions(db)
      expect(rows.map((r) => r.id).sort()).toEqual(['sa', 'sb', 'sl'])
    })
  })
})
