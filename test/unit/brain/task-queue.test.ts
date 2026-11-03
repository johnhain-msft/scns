import { describe, it, expect } from 'vitest'
import { createTaskQueue } from '../../../src/brain/task-queue.js'
import { DecisionPriority, type PendingTask } from '../../../src/brain/state-types.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<PendingTask>): PendingTask {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    description: 'Test task',
    priority: DecisionPriority.Normal,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('createTaskQueue', () => {
  it('enqueue adds a task and size increases', () => {
    const q = createTaskQueue()
    const task = makeTask({ id: 'a' })
    expect(q.enqueue(task)).toBe(true)
    expect(q.size()).toBe(1)
  })

  it('dequeue returns the highest priority task', () => {
    const q = createTaskQueue()
    q.enqueue(makeTask({ id: 'low', priority: DecisionPriority.Low }))
    q.enqueue(makeTask({ id: 'high', priority: DecisionPriority.High }))
    q.enqueue(makeTask({ id: 'normal', priority: DecisionPriority.Normal }))

    const task = q.dequeue()
    expect(task).not.toBeNull()
    expect(task!.id).toBe('high')
  })

  it('dequeue returns null on empty queue', () => {
    const q = createTaskQueue()
    expect(q.dequeue()).toBeNull()
  })

  it('peek returns but does not remove the task', () => {
    const q = createTaskQueue()
    const task = makeTask({ id: 'peek-me' })
    q.enqueue(task)

    expect(q.peek()).not.toBeNull()
    expect(q.peek()!.id).toBe('peek-me')
    expect(q.size()).toBe(1)
  })

  it('FIFO within same priority (earliest createdAt first)', () => {
    const q = createTaskQueue()
    q.enqueue(
      makeTask({
        id: 'first',
        priority: DecisionPriority.Normal,
        createdAt: '2025-01-01T00:00:00Z',
      }),
    )
    q.enqueue(
      makeTask({
        id: 'second',
        priority: DecisionPriority.Normal,
        createdAt: '2025-01-01T00:01:00Z',
      }),
    )
    q.enqueue(
      makeTask({
        id: 'third',
        priority: DecisionPriority.Normal,
        createdAt: '2025-01-01T00:02:00Z',
      }),
    )

    expect(q.dequeue()!.id).toBe('first')
    expect(q.dequeue()!.id).toBe('second')
    expect(q.dequeue()!.id).toBe('third')
  })

  it('Critical > High > Normal > Low ordering', () => {
    const q = createTaskQueue()
    q.enqueue(
      makeTask({ id: 'low', priority: DecisionPriority.Low, createdAt: '2025-01-01T00:00:00Z' }),
    )
    q.enqueue(
      makeTask({
        id: 'normal',
        priority: DecisionPriority.Normal,
        createdAt: '2025-01-01T00:00:01Z',
      }),
    )
    q.enqueue(
      makeTask({ id: 'high', priority: DecisionPriority.High, createdAt: '2025-01-01T00:00:02Z' }),
    )
    q.enqueue(
      makeTask({
        id: 'critical',
        priority: DecisionPriority.Critical,
        createdAt: '2025-01-01T00:00:03Z',
      }),
    )

    expect(q.dequeue()!.id).toBe('critical')
    expect(q.dequeue()!.id).toBe('high')
    expect(q.dequeue()!.id).toBe('normal')
    expect(q.dequeue()!.id).toBe('low')
  })

  it('remove by ID works', () => {
    const q = createTaskQueue()
    q.enqueue(makeTask({ id: 'a' }))
    q.enqueue(makeTask({ id: 'b' }))

    expect(q.remove('a')).toBe(true)
    expect(q.size()).toBe(1)
    expect(q.dequeue()!.id).toBe('b')
  })

  it('remove unknown ID returns false', () => {
    const q = createTaskQueue()
    q.enqueue(makeTask({ id: 'a' }))
    expect(q.remove('nonexistent')).toBe(false)
    expect(q.size()).toBe(1)
  })

  it('getAll returns sorted list', () => {
    const q = createTaskQueue()
    q.enqueue(
      makeTask({ id: 'low', priority: DecisionPriority.Low, createdAt: '2025-01-01T00:00:00Z' }),
    )
    q.enqueue(
      makeTask({ id: 'high', priority: DecisionPriority.High, createdAt: '2025-01-01T00:00:01Z' }),
    )
    q.enqueue(
      makeTask({
        id: 'normal',
        priority: DecisionPriority.Normal,
        createdAt: '2025-01-01T00:00:02Z',
      }),
    )

    const all = q.getAll()
    expect(all).toHaveLength(3)
    expect(all[0]!.id).toBe('high')
    expect(all[1]!.id).toBe('normal')
    expect(all[2]!.id).toBe('low')
  })

  it('isEmpty true when empty, false when not', () => {
    const q = createTaskQueue()
    expect(q.isEmpty()).toBe(true)

    q.enqueue(makeTask())
    expect(q.isEmpty()).toBe(false)
  })

  it('clear empties the queue', () => {
    const q = createTaskQueue()
    q.enqueue(makeTask({ id: 'a' }))
    q.enqueue(makeTask({ id: 'b' }))
    expect(q.size()).toBe(2)

    q.clear()
    expect(q.size()).toBe(0)
    expect(q.isEmpty()).toBe(true)
  })

  it('queue respects maxSize (enqueue returns false when full)', () => {
    const q = createTaskQueue({ maxSize: 2 })
    expect(q.enqueue(makeTask({ id: 'a' }))).toBe(true)
    expect(q.enqueue(makeTask({ id: 'b' }))).toBe(true)
    expect(q.enqueue(makeTask({ id: 'c' }))).toBe(false)
    expect(q.size()).toBe(2)
  })

  it('multiple priorities interleaved correctly', () => {
    const q = createTaskQueue()
    q.enqueue(
      makeTask({ id: 'n1', priority: DecisionPriority.Normal, createdAt: '2025-01-01T00:00:00Z' }),
    )
    q.enqueue(
      makeTask({ id: 'h1', priority: DecisionPriority.High, createdAt: '2025-01-01T00:00:01Z' }),
    )
    q.enqueue(
      makeTask({ id: 'n2', priority: DecisionPriority.Normal, createdAt: '2025-01-01T00:00:02Z' }),
    )
    q.enqueue(
      makeTask({ id: 'h2', priority: DecisionPriority.High, createdAt: '2025-01-01T00:00:03Z' }),
    )
    q.enqueue(
      makeTask({ id: 'l1', priority: DecisionPriority.Low, createdAt: '2025-01-01T00:00:04Z' }),
    )

    expect(q.dequeue()!.id).toBe('h1')
    expect(q.dequeue()!.id).toBe('h2')
    expect(q.dequeue()!.id).toBe('n1')
    expect(q.dequeue()!.id).toBe('n2')
    expect(q.dequeue()!.id).toBe('l1')
  })

  it('single task: enqueue + dequeue round-trip', () => {
    const q = createTaskQueue()
    const task = makeTask({ id: 'solo', description: 'Round-trip test' })

    q.enqueue(task)
    const result = q.dequeue()

    expect(result).not.toBeNull()
    expect(result!.id).toBe('solo')
    expect(result!.description).toBe('Round-trip test')
    expect(q.isEmpty()).toBe(true)
  })

  it('peek returns null on empty queue', () => {
    const q = createTaskQueue()
    expect(q.peek()).toBeNull()
  })

  it('dequeue removes the task from queue', () => {
    const q = createTaskQueue()
    q.enqueue(makeTask({ id: 'x' }))
    q.dequeue()
    expect(q.size()).toBe(0)
  })

  it('default maxSize is 100', () => {
    const q = createTaskQueue()
    for (let i = 0; i < 100; i++) {
      expect(q.enqueue(makeTask({ id: `t-${i}` }))).toBe(true)
    }
    expect(q.enqueue(makeTask({ id: 'overflow' }))).toBe(false)
    expect(q.size()).toBe(100)
  })
})
