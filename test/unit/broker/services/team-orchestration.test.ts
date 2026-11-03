import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  createTeam,
  disbandTeam,
  joinTeam,
  leaveTeam,
  getTeamInfo,
  getTeamHierarchy,
  getTeamAncestors,
  getRootTeams,
  updateMemberStatus,
} from '../../../../src/broker/services/team-orchestration.js'
import { NotFoundError, ConflictError } from '../../../../src/broker/errors.js'

describe('TeamOrchestration', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
    // Pre-register sessions for FK constraints
    testDb.db
      .prepare('INSERT INTO sessions (id, purpose, working_dir) VALUES (?, ?, ?)')
      .run('s1', 'agent-1', '/workspace/a')
    testDb.db
      .prepare('INSERT INTO sessions (id, purpose, working_dir) VALUES (?, ?, ?)')
      .run('s2', 'agent-2', '/workspace/b')
    testDb.db
      .prepare('INSERT INTO sessions (id, purpose, working_dir) VALUES (?, ?, ?)')
      .run('s3', 'agent-3', '/workspace/c')
  })

  afterEach(() => {
    testDb.close()
  })

  // ── createTeam ──────────────────────────────────────────────

  describe('createTeam', () => {
    it('creates a team with UUID, correct name/description, status=active', () => {
      const team = createTeam(testDb.db, 'Alpha', 'The alpha team')
      expect(team.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(team.name).toBe('Alpha')
      expect(team.description).toBe('The alpha team')
      expect(team.status).toBe('active')
    })

    it('creates a team with parent_team_id when parent exists', () => {
      const parent = createTeam(testDb.db, 'Parent')
      const child = createTeam(testDb.db, 'Child', undefined, parent.id)
      expect(child.parent_team_id).toBe(parent.id)
    })

    it('throws NotFoundError when parent does not exist', () => {
      expect(() => createTeam(testDb.db, 'Orphan', undefined, 'nonexistent')).toThrow(NotFoundError)
    })
  })

  // ── disbandTeam ─────────────────────────────────────────────

  describe('disbandTeam', () => {
    it('sets status to disbanded, archives team, and removes all members', () => {
      const team = createTeam(testDb.db, 'Doomed')
      joinTeam(testDb.db, team.id, 's1', 'Agent-1')
      joinTeam(testDb.db, team.id, 's2', 'Agent-2')

      const disbanded = disbandTeam(testDb.db, team.id)
      expect(disbanded.status).toBe('disbanded')

      const info = getTeamInfo(testDb.db, team.id)
      expect(info.members).toHaveLength(0)
    })

    it('throws NotFoundError for nonexistent team', () => {
      expect(() => disbandTeam(testDb.db, 'ghost')).toThrow(NotFoundError)
    })
  })

  // ── joinTeam ────────────────────────────────────────────────

  describe('joinTeam', () => {
    it('adds member with correct role, default role=general', () => {
      const team = createTeam(testDb.db, 'Crew')
      const member = joinTeam(testDb.db, team.id, 's1', 'Agent-1')
      expect(member.team_id).toBe(team.id)
      expect(member.session_id).toBe('s1')
      expect(member.name).toBe('Agent-1')
      expect(member.role).toBe('general')
    })

    it('adds member with specified role and agent_type', () => {
      const team = createTeam(testDb.db, 'Crew')
      const member = joinTeam(testDb.db, team.id, 's1', 'Lead Agent', 'lead', 'orchestrator')
      expect(member.role).toBe('lead')
      expect(member.agent_type).toBe('orchestrator')
    })

    it('throws ConflictError when joining disbanded team', () => {
      const team = createTeam(testDb.db, 'Dead')
      disbandTeam(testDb.db, team.id)

      expect(() => joinTeam(testDb.db, team.id, 's1', 'Agent-1')).toThrow(ConflictError)
    })

    it('throws ConflictError on duplicate join (PK violation)', () => {
      const team = createTeam(testDb.db, 'Crew')
      joinTeam(testDb.db, team.id, 's1', 'Agent-1')

      expect(() => joinTeam(testDb.db, team.id, 's1', 'Agent-1-dup')).toThrow(ConflictError)
    })
  })

  // ── leaveTeam ───────────────────────────────────────────────

  describe('leaveTeam', () => {
    it('removes a member from the team', () => {
      const team = createTeam(testDb.db, 'Crew')
      joinTeam(testDb.db, team.id, 's1', 'Agent-1')

      leaveTeam(testDb.db, team.id, 's1')

      const info = getTeamInfo(testDb.db, team.id)
      expect(info.members).toHaveLength(0)
    })
  })

  // ── getTeamInfo ─────────────────────────────────────────────

  describe('getTeamInfo', () => {
    it('returns complete info with member count and task counts', () => {
      const team = createTeam(testDb.db, 'Alpha', 'desc')
      joinTeam(testDb.db, team.id, 's1', 'Agent-1', 'dev')

      // Add a task for this team
      testDb.db
        .prepare("INSERT INTO tasks (team_id, seq, subject) VALUES (?, 1, 'build feature')")
        .run(team.id)

      const info = getTeamInfo(testDb.db, team.id)
      expect(info.team.name).toBe('Alpha')
      expect(info.members).toHaveLength(1)
      expect(info.members[0]!.role).toBe('dev')
      expect(info.task_counts.pending).toBe(1)
      expect(info.sub_teams).toHaveLength(0)
    })
  })

  // ── Hierarchy ───────────────────────────────────────────────

  describe('hierarchy', () => {
    it('getTeamHierarchy returns parent, child, and grandchild', () => {
      const parent = createTeam(testDb.db, 'Parent')
      const child = createTeam(testDb.db, 'Child', undefined, parent.id)
      createTeam(testDb.db, 'GrandChild', undefined, child.id)

      const tree = getTeamHierarchy(testDb.db, parent.id)
      expect(tree).toHaveLength(3)
      expect(tree[0]!.name).toBe('Parent')
    })

    it('getTeamAncestors from grandchild returns [child, parent]', () => {
      const parent = createTeam(testDb.db, 'Parent')
      const child = createTeam(testDb.db, 'Child', undefined, parent.id)
      const gc = createTeam(testDb.db, 'GrandChild', undefined, child.id)

      const ancestors = getTeamAncestors(testDb.db, gc.id)
      expect(ancestors).toHaveLength(2)
      expect(ancestors[0]!.name).toBe('Child')
      expect(ancestors[1]!.name).toBe('Parent')
    })

    it('getRootTeams returns only teams with no parent', () => {
      const root1 = createTeam(testDb.db, 'Root1')
      const _root2 = createTeam(testDb.db, 'Root2')
      createTeam(testDb.db, 'Child', undefined, root1.id)

      const roots = getRootTeams(testDb.db)
      expect(roots).toHaveLength(2)
      const names = roots.map((t) => t.name)
      expect(names).toContain('Root1')
      expect(names).toContain('Root2')
    })
  })

  // ── updateMemberStatus ──────────────────────────────────────

  describe('updateMemberStatus', () => {
    it('changes member status correctly', () => {
      const team = createTeam(testDb.db, 'Crew')
      joinTeam(testDb.db, team.id, 's1', 'Agent-1')

      updateMemberStatus(testDb.db, team.id, 's1', 'working')

      const info = getTeamInfo(testDb.db, team.id)
      expect(info.members[0]!.status).toBe('working')
    })
  })
})
