import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  createTeam,
  findTeamById,
  findTeamByName,
  findAllTeams,
  updateTeamStatus,
  deleteTeam,
  addTeamMember,
  findTeamMembers,
  removeTeamMember,
  findTeamBySession,
  countTeamsByStatus,
  getSubTeams,
  getTeamTree,
  getAncestors,
  getTeamStatus,
} from '../../../../src/broker/storage/repositories/team-repository.js'

describe('TeamRepository', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
    // Create sessions for FK constraints
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir) VALUES ('s1', 'test', '/')")
      .run()
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir) VALUES ('s2', 'test2', '/')")
      .run()
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir) VALUES ('s3', 'test3', '/')")
      .run()
  })

  afterEach(() => {
    testDb.close()
  })

  it('creates and retrieves a team', () => {
    const team = createTeam(testDb.db, { id: 't1', name: 'Alpha' })
    expect(team.id).toBe('t1')
    expect(team.name).toBe('Alpha')
    expect(team.status).toBe('active')

    const found = findTeamById(testDb.db, 't1')
    expect(found).not.toBeNull()
    expect(found!.name).toBe('Alpha')
  })

  it('findTeamByName works', () => {
    createTeam(testDb.db, { id: 't1', name: 'Alpha' })
    const found = findTeamByName(testDb.db, 'Alpha')
    expect(found!.id).toBe('t1')
  })

  it('findAllTeams returns all non-archived teams', () => {
    createTeam(testDb.db, { id: 't1', name: 'A' })
    createTeam(testDb.db, { id: 't2', name: 'B' })
    expect(findAllTeams(testDb.db)).toHaveLength(2)
  })

  it('updateTeamStatus changes status', () => {
    createTeam(testDb.db, { id: 't1', name: 'A' })
    const updated = updateTeamStatus(testDb.db, 't1', 'paused')
    expect(updated!.status).toBe('paused')
  })

  it('deleteTeam removes team', () => {
    createTeam(testDb.db, { id: 't1', name: 'A' })
    expect(deleteTeam(testDb.db, 't1')).toBe(true)
    expect(findTeamById(testDb.db, 't1')).toBeNull()
  })

  it('addTeamMember and findTeamMembers', () => {
    createTeam(testDb.db, { id: 't1', name: 'A' })
    addTeamMember(testDb.db, { team_id: 't1', session_id: 's1', name: 'Agent A', role: 'dev' })
    addTeamMember(testDb.db, { team_id: 't1', session_id: 's2', name: 'Agent B' })

    const members = findTeamMembers(testDb.db, 't1')
    expect(members).toHaveLength(2)
    expect(members[0]!.role).toBe('dev')
    expect(members[1]!.role).toBe('general')
  })

  it('removeTeamMember removes a member', () => {
    createTeam(testDb.db, { id: 't1', name: 'A' })
    addTeamMember(testDb.db, { team_id: 't1', session_id: 's1', name: 'X' })
    expect(removeTeamMember(testDb.db, 't1', 's1')).toBe(true)
    expect(findTeamMembers(testDb.db, 't1')).toHaveLength(0)
  })

  it('findTeamBySession finds team for a session', () => {
    createTeam(testDb.db, { id: 't1', name: 'A' })
    addTeamMember(testDb.db, { team_id: 't1', session_id: 's1', name: 'X' })

    const team = findTeamBySession(testDb.db, 's1')
    expect(team).not.toBeNull()
    expect(team!.id).toBe('t1')
  })

  it('countTeamsByStatus returns correct count', () => {
    createTeam(testDb.db, { id: 't1', name: 'A' })
    createTeam(testDb.db, { id: 't2', name: 'B' })
    updateTeamStatus(testDb.db, 't2', 'paused')

    expect(countTeamsByStatus(testDb.db, 'active')).toBe(1)
    expect(countTeamsByStatus(testDb.db, 'paused')).toBe(1)
  })

  describe('hierarchical teams', () => {
    beforeEach(() => {
      createTeam(testDb.db, { id: 'root', name: 'Root' })
      createTeam(testDb.db, { id: 'child1', name: 'Child1', parent_team_id: 'root' })
      createTeam(testDb.db, { id: 'child2', name: 'Child2', parent_team_id: 'root' })
      createTeam(testDb.db, { id: 'grandchild', name: 'GrandChild', parent_team_id: 'child1' })
    })

    it('getSubTeams returns direct children', () => {
      const subs = getSubTeams(testDb.db, 'root')
      expect(subs).toHaveLength(2)
      const names = subs.map((s) => s.name)
      expect(names).toContain('Child1')
      expect(names).toContain('Child2')
    })

    it('getTeamTree returns full tree (BFS)', () => {
      const tree = getTeamTree(testDb.db, 'root')
      expect(tree).toHaveLength(4)
      expect(tree[0]!.id).toBe('root')
    })

    it('getAncestors returns parent chain', () => {
      const ancestors = getAncestors(testDb.db, 'grandchild')
      expect(ancestors).toHaveLength(2)
      expect(ancestors[0]!.id).toBe('child1')
      expect(ancestors[1]!.id).toBe('root')
    })

    it('getAncestors returns empty for root', () => {
      const ancestors = getAncestors(testDb.db, 'root')
      expect(ancestors).toHaveLength(0)
    })
  })

  it('getTeamStatus returns summary info', () => {
    createTeam(testDb.db, { id: 't1', name: 'A' })
    addTeamMember(testDb.db, { team_id: 't1', session_id: 's1', name: 'X' })

    // Add a task
    testDb.db
      .prepare("INSERT INTO tasks (team_id, seq, subject) VALUES ('t1', 1, 'do thing')")
      .run()

    const status = getTeamStatus(testDb.db, 't1')
    expect(status).not.toBeNull()
    expect(status!.name).toBe('A')
    expect(status!.member_count).toBe(1)
    expect(status!.task_counts.pending).toBe(1)
    expect(status!.idle).toBe(true) // no in_progress tasks
  })

  it('getTeamStatus returns null for non-existent team', () => {
    expect(getTeamStatus(testDb.db, 'nope')).toBeNull()
  })
})
