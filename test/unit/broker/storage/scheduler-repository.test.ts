import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  seedDefaultTasks,
  findAllTasks,
  findTaskById,
  findTasksByCategory,
  findEnabledTasks,
  updateTask,
  recordTaskRun,
  getTaskRunHistory,
  deleteTask,
} from '../../../../src/broker/storage/repositories/scheduler-repository.js'
import { cronMatches } from '../../../../src/broker/services/task-scheduler.js'

describe('SchedulerRepository', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
  })

  afterEach(() => {
    testDb.close()
  })

  describe('seedDefaultTasks', () => {
    it('inserts all 21 default tasks', () => {
      seedDefaultTasks(testDb.db)
      const tasks = findAllTasks(testDb.db)
      expect(tasks).toHaveLength(21)
    })

    it('is idempotent — calling twice does not duplicate', () => {
      seedDefaultTasks(testDb.db)
      seedDefaultTasks(testDb.db)
      const tasks = findAllTasks(testDb.db)
      expect(tasks).toHaveLength(21)
    })

    // The scheduler SILENTLY SKIPS a task whose id has no registered handler (task-scheduler.ts:245,
    // debug-level only), so an id typo here would disable the harvest with no error anywhere. This
    // pins the id the `settle-sweep` handler in cli.ts registers, and that its cron actually parses.
    it('seeds settle-sweep enabled, with a cron the evaluator accepts', () => {
      seedDefaultTasks(testDb.db)
      const task = findTaskById(testDb.db, 'settle-sweep')
      expect(task).not.toBeNull()
      expect(task?.enabled).toBe(true)
      expect(task?.category).toBe('cron')
      expect(cronMatches(task!.cron_expression!, new Date(2026, 6, 31, 4, 17, 0))).toBe(true)
      expect(cronMatches(task!.cron_expression!, new Date(2026, 6, 31, 4, 18, 0))).toBe(false)
    })
  })

  describe('findAllTasks', () => {
    it('returns all seeded tasks', () => {
      seedDefaultTasks(testDb.db)
      const tasks = findAllTasks(testDb.db)
      expect(tasks).toHaveLength(21)
      const ids = tasks.map((t) => t.id)
      expect(ids).toContain('heartbeat-poller')
      expect(ids).toContain('dream-consolidation')
      expect(ids).toContain('memory-search')
      expect(ids).toContain('telemetry-rotation')
    })

    it('returns empty array when no tasks exist', () => {
      const tasks = findAllTasks(testDb.db)
      expect(tasks).toEqual([])
    })
  })

  describe('findTaskById', () => {
    it('returns the correct task', () => {
      seedDefaultTasks(testDb.db)
      const task = findTaskById(testDb.db, 'zombie-cleanup')
      expect(task).not.toBeNull()
      expect(task!.name).toBe('Zombie Cleanup')
      expect(task!.category).toBe('cron')
      expect(task!.enabled).toBe(true)
      expect(task!.run_count).toBe(0)
      expect(task!.config_json).toBe('{}')
    })

    it('returns null for missing id', () => {
      seedDefaultTasks(testDb.db)
      const task = findTaskById(testDb.db, 'nonexistent')
      expect(task).toBeNull()
    })

    it('converts enabled INTEGER to boolean', () => {
      seedDefaultTasks(testDb.db)
      const enabled = findTaskById(testDb.db, 'heartbeat-poller')
      expect(enabled!.enabled).toBe(true)
      expect(typeof enabled!.enabled).toBe('boolean')

      const disabled = findTaskById(testDb.db, 'suggestion-auto-execute')
      expect(disabled!.enabled).toBe(false)
      expect(typeof disabled!.enabled).toBe('boolean')
    })
  })

  describe('new scheduler tasks', () => {
    it('newsletter-daily has correct properties', () => {
      seedDefaultTasks(testDb.db)
      const task = findTaskById(testDb.db, 'newsletter-daily')
      expect(task).not.toBeNull()
      expect(task!.name).toBe('Morning Pod Newsletter')
      expect(task!.category).toBe('cron')
      expect(task!.cron_expression).toBe('0 8 * * *')
      expect(task!.enabled).toBe(true)
    })

    it('realestate-news-learner has correct properties', () => {
      seedDefaultTasks(testDb.db)
      const task = findTaskById(testDb.db, 'realestate-news-learner')
      expect(task).not.toBeNull()
      expect(task!.name).toBe('Real Estate News Learner')
      expect(task!.category).toBe('cron')
      expect(task!.cron_expression).toBe('0 7 * * *')
      expect(task!.enabled).toBe(true)
    })

    it('new tasks are included in enabled tasks', () => {
      seedDefaultTasks(testDb.db)
      const enabled = findEnabledTasks(testDb.db)
      const ids = enabled.map((t) => t.id)
      expect(ids).toContain('newsletter-daily')
      expect(ids).toContain('realestate-news-learner')
    })
  })

  describe('findTasksByCategory', () => {
    it('filters cron tasks correctly', () => {
      seedDefaultTasks(testDb.db)
      const cronTasks = findTasksByCategory(testDb.db, 'cron')
      expect(cronTasks.length).toBe(16)
      for (const task of cronTasks) {
        expect(task.category).toBe('cron')
        expect(task.cron_expression).not.toBeNull()
      }
    })

    it('filters on-demand tasks correctly', () => {
      seedDefaultTasks(testDb.db)
      const onDemandTasks = findTasksByCategory(testDb.db, 'on-demand')
      expect(onDemandTasks.length).toBe(5)
      for (const task of onDemandTasks) {
        expect(task.category).toBe('on-demand')
      }
    })
  })

  describe('findEnabledTasks', () => {
    it('excludes disabled tasks', () => {
      seedDefaultTasks(testDb.db)
      const enabledTasks = findEnabledTasks(testDb.db)
      // suggestion-auto-execute is disabled by default
      expect(enabledTasks.length).toBe(20)
      const ids = enabledTasks.map((t) => t.id)
      expect(ids).not.toContain('suggestion-auto-execute')
    })

    it('reflects toggled state', () => {
      seedDefaultTasks(testDb.db)
      updateTask(testDb.db, 'heartbeat-poller', { enabled: false })
      const enabledTasks = findEnabledTasks(testDb.db)
      expect(enabledTasks.length).toBe(19)
      const ids = enabledTasks.map((t) => t.id)
      expect(ids).not.toContain('heartbeat-poller')
    })
  })

  describe('updateTask', () => {
    it('toggles enabled state', () => {
      seedDefaultTasks(testDb.db)
      const updated = updateTask(testDb.db, 'heartbeat-poller', { enabled: false })
      expect(updated).not.toBeNull()
      expect(updated!.enabled).toBe(false)

      const reEnabled = updateTask(testDb.db, 'heartbeat-poller', { enabled: true })
      expect(reEnabled!.enabled).toBe(true)
    })

    it('changes cron_expression', () => {
      seedDefaultTasks(testDb.db)
      const updated = updateTask(testDb.db, 'zombie-cleanup', {
        cron_expression: '*/15 * * * *',
      })
      expect(updated!.cron_expression).toBe('*/15 * * * *')
    })

    it('updates config_json', () => {
      seedDefaultTasks(testDb.db)
      const config = JSON.stringify({ retries: 3, timeout: 5000 })
      const updated = updateTask(testDb.db, 'memory-search', { config_json: config })
      expect(updated!.config_json).toBe(config)
    })

    it('updates name and description', () => {
      seedDefaultTasks(testDb.db)
      const updated = updateTask(testDb.db, 'heartbeat-poller', {
        name: 'Renamed Task',
        description: 'New description',
      })
      expect(updated!.name).toBe('Renamed Task')
      expect(updated!.description).toBe('New description')
    })

    it('returns null for non-existent task', () => {
      seedDefaultTasks(testDb.db)
      const result = updateTask(testDb.db, 'nonexistent', { enabled: false })
      expect(result).toBeNull()
    })

    it('sets updated_at on change', () => {
      seedDefaultTasks(testDb.db)
      const before = findTaskById(testDb.db, 'heartbeat-poller')!
      // Small delay isn't reliable in tests, so we check updated_at is set
      const updated = updateTask(testDb.db, 'heartbeat-poller', {
        description: 'Changed',
      })
      expect(updated!.updated_at).toBeDefined()
      // updated_at should be >= created_at
      expect(new Date(updated!.updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(before.created_at).getTime(),
      )
    })

    it('supports partial updates — only specified fields change', () => {
      seedDefaultTasks(testDb.db)
      const original = findTaskById(testDb.db, 'zombie-cleanup')!
      const updated = updateTask(testDb.db, 'zombie-cleanup', {
        description: 'Updated desc',
      })
      expect(updated!.name).toBe(original.name)
      expect(updated!.cron_expression).toBe(original.cron_expression)
      expect(updated!.enabled).toBe(original.enabled)
      expect(updated!.description).toBe('Updated desc')
    })
  })

  describe('recordTaskRun', () => {
    it('inserts history record and updates task metadata', () => {
      seedDefaultTasks(testDb.db)
      const startedAt = '2025-01-15T10:00:00Z'
      const finishedAt = '2025-01-15T10:00:05Z'

      recordTaskRun(testDb.db, 'heartbeat-poller', 'success', startedAt, finishedAt, 5000)

      const task = findTaskById(testDb.db, 'heartbeat-poller')!
      expect(task.last_run_at).toBe(startedAt)
      expect(task.last_status).toBe('success')
      expect(task.run_count).toBe(1)

      const history = getTaskRunHistory(testDb.db, 'heartbeat-poller')
      expect(history).toHaveLength(1)
      expect(history[0].status).toBe('success')
      expect(history[0].started_at).toBe(startedAt)
      expect(history[0].finished_at).toBe(finishedAt)
      expect(history[0].duration_ms).toBe(5000)
      expect(history[0].error_message).toBeNull()
    })

    it('records failure status with error_message', () => {
      seedDefaultTasks(testDb.db)
      const startedAt = '2025-01-15T10:00:00Z'
      const finishedAt = '2025-01-15T10:00:01Z'

      recordTaskRun(
        testDb.db,
        'dream-consolidation',
        'failure',
        startedAt,
        finishedAt,
        1000,
        'Connection timeout',
      )

      const task = findTaskById(testDb.db, 'dream-consolidation')!
      expect(task.last_status).toBe('failure')
      expect(task.run_count).toBe(1)

      const history = getTaskRunHistory(testDb.db, 'dream-consolidation')
      expect(history[0].status).toBe('failure')
      expect(history[0].error_message).toBe('Connection timeout')
    })

    it('increments run_count across multiple runs', () => {
      seedDefaultTasks(testDb.db)

      recordTaskRun(
        testDb.db,
        'zombie-cleanup',
        'success',
        '2025-01-15T10:00:00Z',
        '2025-01-15T10:00:01Z',
        1000,
      )
      recordTaskRun(
        testDb.db,
        'zombie-cleanup',
        'success',
        '2025-01-15T10:05:00Z',
        '2025-01-15T10:05:01Z',
        1000,
      )
      recordTaskRun(
        testDb.db,
        'zombie-cleanup',
        'failure',
        '2025-01-15T10:10:00Z',
        '2025-01-15T10:10:02Z',
        2000,
        'DB locked',
      )

      const task = findTaskById(testDb.db, 'zombie-cleanup')!
      expect(task.run_count).toBe(3)
      expect(task.last_status).toBe('failure')
      expect(task.last_run_at).toBe('2025-01-15T10:10:00Z')
    })
  })

  describe('getTaskRunHistory', () => {
    it('returns records in reverse chronological order', () => {
      seedDefaultTasks(testDb.db)

      recordTaskRun(
        testDb.db,
        'heartbeat-poller',
        'success',
        '2025-01-15T10:00:00Z',
        '2025-01-15T10:00:01Z',
        1000,
      )
      recordTaskRun(
        testDb.db,
        'heartbeat-poller',
        'failure',
        '2025-01-15T10:05:00Z',
        '2025-01-15T10:05:01Z',
        1000,
        'err',
      )
      recordTaskRun(
        testDb.db,
        'heartbeat-poller',
        'success',
        '2025-01-15T10:10:00Z',
        '2025-01-15T10:10:01Z',
        1000,
      )

      const history = getTaskRunHistory(testDb.db, 'heartbeat-poller')
      expect(history).toHaveLength(3)
      expect(history[0].started_at).toBe('2025-01-15T10:10:00Z')
      expect(history[1].started_at).toBe('2025-01-15T10:05:00Z')
      expect(history[2].started_at).toBe('2025-01-15T10:00:00Z')
    })

    it('respects limit parameter', () => {
      seedDefaultTasks(testDb.db)

      for (let i = 0; i < 5; i++) {
        recordTaskRun(
          testDb.db,
          'heartbeat-poller',
          'success',
          `2025-01-15T10:0${i}:00Z`,
          `2025-01-15T10:0${i}:01Z`,
          1000,
        )
      }

      const limited = getTaskRunHistory(testDb.db, 'heartbeat-poller', 3)
      expect(limited).toHaveLength(3)
    })

    it('returns empty array for task with no runs', () => {
      seedDefaultTasks(testDb.db)
      const history = getTaskRunHistory(testDb.db, 'heartbeat-poller')
      expect(history).toEqual([])
    })
  })

  describe('deleteTask', () => {
    it('removes task and cascades to history', () => {
      seedDefaultTasks(testDb.db)

      recordTaskRun(
        testDb.db,
        'heartbeat-poller',
        'success',
        '2025-01-15T10:00:00Z',
        '2025-01-15T10:00:01Z',
        1000,
      )

      const deleted = deleteTask(testDb.db, 'heartbeat-poller')
      expect(deleted).toBe(true)

      expect(findTaskById(testDb.db, 'heartbeat-poller')).toBeNull()
      const history = getTaskRunHistory(testDb.db, 'heartbeat-poller')
      expect(history).toEqual([])
    })

    it('returns false for non-existent task', () => {
      seedDefaultTasks(testDb.db)
      const deleted = deleteTask(testDb.db, 'nonexistent')
      expect(deleted).toBe(false)
    })

    it('does not affect other tasks', () => {
      seedDefaultTasks(testDb.db)
      deleteTask(testDb.db, 'heartbeat-poller')
      const tasks = findAllTasks(testDb.db)
      expect(tasks).toHaveLength(20)
      expect(findTaskById(testDb.db, 'zombie-cleanup')).not.toBeNull()
    })
  })
})
