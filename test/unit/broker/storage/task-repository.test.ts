import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  createTask,
  findTaskById,
  findTaskWithDeps,
  findTasksByTeam,
  updateTask,
  deleteTask,
  addDependency,
  removeDependency,
  findBlockedBy,
  findBlocks,
  deleteTasksByTeam,
  deleteAllTasks,
  countTasksByStatus,
  countPendingTasksByTeam,
} from '../../../../src/broker/storage/repositories/task-repository.js'

describe('TaskRepository', () => {
  let testDb: TestDb
  const TEAM_ID = 'team-alpha'
  const TEAM_ID_2 = 'team-beta'

  function seedTeam(id: string, name: string): void {
    testDb.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(id, name)
  }

  beforeEach(() => {
    testDb = createBrokerTestDb()
    seedTeam(TEAM_ID, 'Alpha')
    seedTeam(TEAM_ID_2, 'Beta')
  })

  afterEach(() => {
    testDb.close()
  })

  // ── createTask ──────────────────────────────────────────────

  describe('createTask', () => {
    it('creates a task with auto-incrementing seq', () => {
      const t1 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'First' })
      const t2 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Second' })

      expect(t1.seq).toBe(1)
      expect(t2.seq).toBe(2)
      expect(t1.status).toBe('pending')
      expect(t1.team_id).toBe(TEAM_ID)
    })

    it('seq is per-team', () => {
      createTask(testDb.db, { team_id: TEAM_ID, subject: 'Alpha task' })
      const betaTask = createTask(testDb.db, { team_id: TEAM_ID_2, subject: 'Beta task' })
      expect(betaTask.seq).toBe(1)
    })

    it('stores optional description and active_form', () => {
      const task = createTask(testDb.db, {
        team_id: TEAM_ID,
        subject: 'With extras',
        description: 'A description',
        active_form: 'form-xyz',
      })
      expect(task.description).toBe('A description')
      expect(task.active_form).toBe('form-xyz')
    })

    it('defaults description and active_form to null', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Bare' })
      expect(task.description).toBeNull()
      expect(task.active_form).toBeNull()
    })
  })

  // ── findTaskById ────────────────────────────────────────────

  describe('findTaskById', () => {
    it('returns the task when found', () => {
      const created = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Find me' })
      const found = findTaskById(testDb.db, created.id)
      expect(found).toEqual(created)
    })

    it('returns null for non-existent id', () => {
      expect(findTaskById(testDb.db, 99999)).toBeNull()
    })
  })

  // ── findTasksByTeam ─────────────────────────────────────────

  describe('findTasksByTeam', () => {
    it('returns all non-deleted tasks for a team', () => {
      createTask(testDb.db, { team_id: TEAM_ID, subject: 'A' })
      createTask(testDb.db, { team_id: TEAM_ID, subject: 'B' })
      createTask(testDb.db, { team_id: TEAM_ID_2, subject: 'Other team' })

      const tasks = findTasksByTeam(testDb.db, TEAM_ID)
      expect(tasks).toHaveLength(2)
      expect(tasks[0].subject).toBe('A')
      expect(tasks[1].subject).toBe('B')
    })

    it('excludes deleted tasks when no status filter', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Will delete' })
      updateTask(testDb.db, task.id, { status: 'deleted' })

      const tasks = findTasksByTeam(testDb.db, TEAM_ID)
      expect(tasks).toHaveLength(0)
    })

    it('filters by status when provided', () => {
      createTask(testDb.db, { team_id: TEAM_ID, subject: 'Pending' })
      const t2 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Done' })
      updateTask(testDb.db, t2.id, { status: 'completed' })

      const completed = findTasksByTeam(testDb.db, TEAM_ID, 'completed')
      expect(completed).toHaveLength(1)
      expect(completed[0].subject).toBe('Done')
    })

    it('returns empty array for team with no tasks', () => {
      expect(findTasksByTeam(testDb.db, TEAM_ID)).toEqual([])
    })
  })

  // ── findTaskWithDeps ────────────────────────────────────────

  describe('findTaskWithDeps', () => {
    it('returns task with empty dependency arrays', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Solo' })
      const result = findTaskWithDeps(testDb.db, task.id)

      expect(result).not.toBeNull()
      expect(result!.blocked_by).toEqual([])
      expect(result!.blocks).toEqual([])
      expect(result!.subject).toBe('Solo')
    })

    it('returns task with blocked_by and blocks populated', () => {
      const dep = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Dependency' })
      const main = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Main' })
      const downstream = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Downstream' })

      addDependency(testDb.db, main.id, dep.id)
      addDependency(testDb.db, downstream.id, main.id)

      const result = findTaskWithDeps(testDb.db, main.id)
      expect(result!.blocked_by).toEqual([dep.id])
      expect(result!.blocks).toEqual([downstream.id])
    })

    it('returns null for non-existent task', () => {
      expect(findTaskWithDeps(testDb.db, 99999)).toBeNull()
    })
  })

  // ── updateTask ──────────────────────────────────────────────

  describe('updateTask', () => {
    it('updates status', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'To update' })
      const updated = updateTask(testDb.db, task.id, { status: 'in_progress' })

      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('in_progress')
    })

    it('updates owner', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Assign' })
      const updated = updateTask(testDb.db, task.id, { owner: 'agent-1' })

      expect(updated!.owner).toBe('agent-1')
    })

    it('updates subject', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Old' })
      const updated = updateTask(testDb.db, task.id, { subject: 'New' })

      expect(updated!.subject).toBe('New')
    })

    it('updates description', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Task' })
      const updated = updateTask(testDb.db, task.id, { description: 'New desc' })

      expect(updated!.description).toBe('New desc')
    })

    it('updates active_form', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Task' })
      const updated = updateTask(testDb.db, task.id, { active_form: 'new-form' })

      expect(updated!.active_form).toBe('new-form')
    })

    it('updates multiple fields at once', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Multi' })
      const updated = updateTask(testDb.db, task.id, {
        status: 'completed',
        owner: 'agent-2',
        description: 'Done!',
      })

      expect(updated!.status).toBe('completed')
      expect(updated!.owner).toBe('agent-2')
      expect(updated!.description).toBe('Done!')
    })

    it('sets updated_at timestamp on update', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Timestamps' })
      const before = task.updated_at

      updateTask(testDb.db, task.id, { status: 'in_progress' })
      const after = findTaskById(testDb.db, task.id)

      expect(after!.updated_at).toBeDefined()
      // updated_at should be >= the original (both are datetime('now') so typically equal in fast tests)
      expect(after!.updated_at! >= before!).toBe(true)
    })

    it('returns current task when no fields provided', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'No change' })
      const result = updateTask(testDb.db, task.id, {})

      expect(result).not.toBeNull()
      expect(result!.subject).toBe('No change')
    })

    it('can set owner to null', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Unassign' })
      updateTask(testDb.db, task.id, { owner: 'agent-1' })
      const updated = updateTask(testDb.db, task.id, { owner: null })

      expect(updated!.owner).toBeNull()
    })

    it('can set description to null', () => {
      const task = createTask(testDb.db, {
        team_id: TEAM_ID,
        subject: 'Clear desc',
        description: 'Something',
      })
      const updated = updateTask(testDb.db, task.id, { description: null })

      expect(updated!.description).toBeNull()
    })

    it('can set active_form to null', () => {
      const task = createTask(testDb.db, {
        team_id: TEAM_ID,
        subject: 'Clear form',
        active_form: 'some-form',
      })
      const updated = updateTask(testDb.db, task.id, { active_form: null })

      expect(updated!.active_form).toBeNull()
    })

    it('returns null for non-existent task id', () => {
      const result = updateTask(testDb.db, 99999, { status: 'completed' })
      expect(result).toBeNull()
    })
  })

  // ── deleteTask ──────────────────────────────────────────────

  describe('deleteTask', () => {
    it('deletes an existing task and returns true', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Delete me' })
      expect(deleteTask(testDb.db, task.id)).toBe(true)
      expect(findTaskById(testDb.db, task.id)).toBeNull()
    })

    it('returns false for non-existent task', () => {
      expect(deleteTask(testDb.db, 99999)).toBe(false)
    })
  })

  // ── addDependency / removeDependency ────────────────────────

  describe('addDependency', () => {
    it('creates a dependency between tasks', () => {
      const t1 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Dep' })
      const t2 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Main' })

      addDependency(testDb.db, t2.id, t1.id)

      const blockedBy = findBlockedBy(testDb.db, t2.id)
      expect(blockedBy).toContain(t1.id)
    })

    it('is idempotent (INSERT OR IGNORE)', () => {
      const t1 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'A' })
      const t2 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'B' })

      addDependency(testDb.db, t2.id, t1.id)
      addDependency(testDb.db, t2.id, t1.id) // duplicate — should not throw

      const blockedBy = findBlockedBy(testDb.db, t2.id)
      expect(blockedBy).toHaveLength(1)
    })
  })

  describe('removeDependency', () => {
    it('removes an existing dependency', () => {
      const t1 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Dep' })
      const t2 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Main' })

      addDependency(testDb.db, t2.id, t1.id)
      removeDependency(testDb.db, t2.id, t1.id)

      const blockedBy = findBlockedBy(testDb.db, t2.id)
      expect(blockedBy).toHaveLength(0)
    })

    it('does not throw when removing non-existent dependency', () => {
      expect(() => removeDependency(testDb.db, 1, 2)).not.toThrow()
    })
  })

  // ── findBlockedBy ───────────────────────────────────────────

  describe('findBlockedBy', () => {
    it('returns incomplete dependencies blocking a task', () => {
      const dep1 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Dep 1' })
      const dep2 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Dep 2' })
      const main = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Main' })

      addDependency(testDb.db, main.id, dep1.id)
      addDependency(testDb.db, main.id, dep2.id)

      const blocked = findBlockedBy(testDb.db, main.id)
      expect(blocked).toHaveLength(2)
      expect(blocked).toContain(dep1.id)
      expect(blocked).toContain(dep2.id)
    })

    it('excludes completed dependencies', () => {
      const dep = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Dep' })
      const main = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Main' })

      addDependency(testDb.db, main.id, dep.id)
      updateTask(testDb.db, dep.id, { status: 'completed' })

      expect(findBlockedBy(testDb.db, main.id)).toHaveLength(0)
    })

    it('excludes deleted dependencies', () => {
      const dep = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Dep' })
      const main = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Main' })

      addDependency(testDb.db, main.id, dep.id)
      updateTask(testDb.db, dep.id, { status: 'deleted' })

      expect(findBlockedBy(testDb.db, main.id)).toHaveLength(0)
    })

    it('returns empty for task with no dependencies', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Solo' })
      expect(findBlockedBy(testDb.db, task.id)).toEqual([])
    })

    it('includes in_progress and pending dependencies', () => {
      const pending = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Pending' })
      const inProgress = createTask(testDb.db, { team_id: TEAM_ID, subject: 'In Progress' })
      const main = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Main' })

      updateTask(testDb.db, inProgress.id, { status: 'in_progress' })
      addDependency(testDb.db, main.id, pending.id)
      addDependency(testDb.db, main.id, inProgress.id)

      const blocked = findBlockedBy(testDb.db, main.id)
      expect(blocked).toHaveLength(2)
    })
  })

  // ── findBlocks ──────────────────────────────────────────────

  describe('findBlocks', () => {
    it('returns tasks that depend on the given task', () => {
      const blocker = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Blocker' })
      const blocked1 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Blocked 1' })
      const blocked2 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Blocked 2' })

      addDependency(testDb.db, blocked1.id, blocker.id)
      addDependency(testDb.db, blocked2.id, blocker.id)

      const blocks = findBlocks(testDb.db, blocker.id)
      expect(blocks).toHaveLength(2)
      expect(blocks).toContain(blocked1.id)
      expect(blocks).toContain(blocked2.id)
    })

    it('returns empty array when task blocks nothing', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Leaf' })
      expect(findBlocks(testDb.db, task.id)).toEqual([])
    })
  })

  // ── deleteTasksByTeam ───────────────────────────────────────

  describe('deleteTasksByTeam', () => {
    it('deletes all tasks for a team and returns count', () => {
      createTask(testDb.db, { team_id: TEAM_ID, subject: 'A' })
      createTask(testDb.db, { team_id: TEAM_ID, subject: 'B' })
      createTask(testDb.db, { team_id: TEAM_ID_2, subject: 'Other' })

      const count = deleteTasksByTeam(testDb.db, TEAM_ID)
      expect(count).toBe(2)

      expect(findTasksByTeam(testDb.db, TEAM_ID)).toHaveLength(0)
      expect(findTasksByTeam(testDb.db, TEAM_ID_2)).toHaveLength(1)
    })

    it('returns 0 when team has no tasks', () => {
      expect(deleteTasksByTeam(testDb.db, TEAM_ID)).toBe(0)
    })
  })

  // ── deleteAllTasks ──────────────────────────────────────────

  describe('deleteAllTasks', () => {
    it('deletes all tasks across all teams', () => {
      createTask(testDb.db, { team_id: TEAM_ID, subject: 'A' })
      createTask(testDb.db, { team_id: TEAM_ID_2, subject: 'B' })

      const count = deleteAllTasks(testDb.db)
      expect(count).toBe(2)

      expect(findTasksByTeam(testDb.db, TEAM_ID)).toHaveLength(0)
      expect(findTasksByTeam(testDb.db, TEAM_ID_2)).toHaveLength(0)
    })

    it('returns 0 when no tasks exist', () => {
      expect(deleteAllTasks(testDb.db)).toBe(0)
    })
  })

  // ── countTasksByStatus ──────────────────────────────────────

  describe('countTasksByStatus', () => {
    it('counts tasks with the given status', () => {
      createTask(testDb.db, { team_id: TEAM_ID, subject: 'P1' })
      createTask(testDb.db, { team_id: TEAM_ID, subject: 'P2' })
      const t3 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Done' })
      updateTask(testDb.db, t3.id, { status: 'completed' })

      expect(countTasksByStatus(testDb.db, 'pending')).toBe(2)
      expect(countTasksByStatus(testDb.db, 'completed')).toBe(1)
      expect(countTasksByStatus(testDb.db, 'in_progress')).toBe(0)
    })

    it('counts across all teams', () => {
      createTask(testDb.db, { team_id: TEAM_ID, subject: 'Alpha' })
      createTask(testDb.db, { team_id: TEAM_ID_2, subject: 'Beta' })

      expect(countTasksByStatus(testDb.db, 'pending')).toBe(2)
    })

    it('returns 0 for status with no tasks', () => {
      expect(countTasksByStatus(testDb.db, 'failed')).toBe(0)
    })
  })

  // ── countPendingTasksByTeam ─────────────────────────────────

  describe('countPendingTasksByTeam', () => {
    it('counts only pending tasks for the specified team', () => {
      createTask(testDb.db, { team_id: TEAM_ID, subject: 'Pending 1' })
      createTask(testDb.db, { team_id: TEAM_ID, subject: 'Pending 2' })
      const t3 = createTask(testDb.db, { team_id: TEAM_ID, subject: 'In progress' })
      updateTask(testDb.db, t3.id, { status: 'in_progress' })
      createTask(testDb.db, { team_id: TEAM_ID_2, subject: 'Other team' })

      expect(countPendingTasksByTeam(testDb.db, TEAM_ID)).toBe(2)
    })

    it('returns 0 when team has no pending tasks', () => {
      const task = createTask(testDb.db, { team_id: TEAM_ID, subject: 'Done' })
      updateTask(testDb.db, task.id, { status: 'completed' })

      expect(countPendingTasksByTeam(testDb.db, TEAM_ID)).toBe(0)
    })

    it('returns 0 for team with no tasks', () => {
      expect(countPendingTasksByTeam(testDb.db, TEAM_ID)).toBe(0)
    })
  })
})
