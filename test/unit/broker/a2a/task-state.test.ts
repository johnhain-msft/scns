import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  A2ATaskStatus,
  VALID_TRANSITIONS,
  createA2ATaskStateMachine,
} from '../../../../src/broker/a2a/task-state.js'

describe('A2ATaskStatus', () => {
  it('has all expected status values', () => {
    expect(A2ATaskStatus.Submitted).toBe('submitted')
    expect(A2ATaskStatus.Assigned).toBe('assigned')
    expect(A2ATaskStatus.Working).toBe('working')
    expect(A2ATaskStatus.InputRequired).toBe('input-required')
    expect(A2ATaskStatus.Completed).toBe('completed')
    expect(A2ATaskStatus.Failed).toBe('failed')
    expect(A2ATaskStatus.Canceled).toBe('canceled')
  })
})

describe('VALID_TRANSITIONS', () => {
  it('submitted can go to assigned or canceled', () => {
    expect(VALID_TRANSITIONS['submitted']).toEqual(expect.arrayContaining(['assigned', 'canceled']))
    expect(VALID_TRANSITIONS['submitted']).toHaveLength(2)
  })

  it('assigned can go to working or canceled', () => {
    expect(VALID_TRANSITIONS['assigned']).toEqual(expect.arrayContaining(['working', 'canceled']))
    expect(VALID_TRANSITIONS['assigned']).toHaveLength(2)
  })

  it('working can go to completed, failed, input-required, or canceled', () => {
    expect(VALID_TRANSITIONS['working']).toEqual(
      expect.arrayContaining(['completed', 'failed', 'input-required', 'canceled']),
    )
    expect(VALID_TRANSITIONS['working']).toHaveLength(4)
  })

  it('input-required can go to working or canceled', () => {
    expect(VALID_TRANSITIONS['input-required']).toEqual(
      expect.arrayContaining(['working', 'canceled']),
    )
    expect(VALID_TRANSITIONS['input-required']).toHaveLength(2)
  })

  it('completed is terminal (empty transitions)', () => {
    expect(VALID_TRANSITIONS['completed']).toEqual([])
  })

  it('failed can go to submitted (retry)', () => {
    expect(VALID_TRANSITIONS['failed']).toEqual(expect.arrayContaining(['submitted']))
    expect(VALID_TRANSITIONS['failed']).toHaveLength(1)
  })

  it('canceled is terminal (empty transitions)', () => {
    expect(VALID_TRANSITIONS['canceled']).toEqual([])
  })
})

describe('A2ATaskStateMachine', () => {
  const sm = createA2ATaskStateMachine()

  describe('create', () => {
    it('produces task in submitted state', () => {
      const task = sm.create({
        id: randomUUID(),
        submittedBy: 'agent-1',
        description: 'Do something',
      })
      expect(task.status).toBe('submitted')
      expect(task.assignedTo).toBeNull()
      expect(task.result).toBeNull()
      expect(task.error).toBeNull()
      expect(task.history).toEqual([])
      expect(task.createdAt).toBeTruthy()
      expect(task.updatedAt).toBeTruthy()
    })

    it('records submittedBy', () => {
      const task = sm.create({
        id: randomUUID(),
        submittedBy: 'requester-42',
        description: 'Task desc',
      })
      expect(task.submittedBy).toBe('requester-42')
    })
  })

  describe('transition', () => {
    it('submitted → assigned works', () => {
      const task = sm.create({ id: randomUUID(), submittedBy: 'a', description: 't' })
      const next = sm.transition(task, 'assigned', { assignedTo: 'agent-2' })
      expect(next.status).toBe('assigned')
      expect(next.assignedTo).toBe('agent-2')
    })

    it('assigned → working works', () => {
      let task = sm.create({ id: randomUUID(), submittedBy: 'a', description: 't' })
      task = sm.transition(task, 'assigned', { assignedTo: 'agent-2' })
      const next = sm.transition(task, 'working')
      expect(next.status).toBe('working')
    })

    it('working → completed with result', () => {
      let task = sm.create({ id: randomUUID(), submittedBy: 'a', description: 't' })
      task = sm.transition(task, 'assigned', { assignedTo: 'agent-1' })
      task = sm.transition(task, 'working')
      const next = sm.transition(task, 'completed', { result: { output: 'done' } })
      expect(next.status).toBe('completed')
      expect(next.result).toEqual({ output: 'done' })
    })

    it('working → failed with error', () => {
      let task = sm.create({ id: randomUUID(), submittedBy: 'a', description: 't' })
      task = sm.transition(task, 'assigned', { assignedTo: 'agent-1' })
      task = sm.transition(task, 'working')
      const next = sm.transition(task, 'failed', { error: 'something broke' })
      expect(next.status).toBe('failed')
      expect(next.error).toBe('something broke')
    })

    it('working → input-required works', () => {
      let task = sm.create({ id: randomUUID(), submittedBy: 'a', description: 't' })
      task = sm.transition(task, 'assigned', { assignedTo: 'agent-1' })
      task = sm.transition(task, 'working')
      const next = sm.transition(task, 'input-required')
      expect(next.status).toBe('input-required')
    })

    it('input-required → working (resume)', () => {
      let task = sm.create({ id: randomUUID(), submittedBy: 'a', description: 't' })
      task = sm.transition(task, 'assigned', { assignedTo: 'agent-1' })
      task = sm.transition(task, 'working')
      task = sm.transition(task, 'input-required')
      const next = sm.transition(task, 'working')
      expect(next.status).toBe('working')
    })

    it('failed → submitted (retry)', () => {
      let task = sm.create({ id: randomUUID(), submittedBy: 'a', description: 't' })
      task = sm.transition(task, 'assigned', { assignedTo: 'agent-1' })
      task = sm.transition(task, 'working')
      task = sm.transition(task, 'failed', { error: 'oops' })
      const next = sm.transition(task, 'submitted', { reason: 'retry' })
      expect(next.status).toBe('submitted')
    })

    it('submitted → canceled works', () => {
      const task = sm.create({ id: randomUUID(), submittedBy: 'a', description: 't' })
      const next = sm.transition(task, 'canceled', { reason: 'user canceled' })
      expect(next.status).toBe('canceled')
    })

    it('invalid transition submitted → completed throws', () => {
      const task = sm.create({ id: randomUUID(), submittedBy: 'a', description: 't' })
      expect(() => sm.transition(task, 'completed')).toThrow(/invalid transition/i)
    })

    it('invalid transition completed → working throws', () => {
      let task = sm.create({ id: randomUUID(), submittedBy: 'a', description: 't' })
      task = sm.transition(task, 'assigned', { assignedTo: 'agent-1' })
      task = sm.transition(task, 'working')
      task = sm.transition(task, 'completed', { result: 'done' })
      expect(() => sm.transition(task, 'working')).toThrow(/invalid transition/i)
    })

    it('invalid transition canceled → working throws', () => {
      let task = sm.create({ id: randomUUID(), submittedBy: 'a', description: 't' })
      task = sm.transition(task, 'canceled')
      expect(() => sm.transition(task, 'working')).toThrow(/invalid transition/i)
    })

    it('history records all transitions', () => {
      let task = sm.create({ id: randomUUID(), submittedBy: 'a', description: 't' })
      task = sm.transition(task, 'assigned', { assignedTo: 'agent-1' })
      task = sm.transition(task, 'working')
      task = sm.transition(task, 'completed', { result: 'ok' })

      expect(task.history).toHaveLength(3)
      expect(task.history[0]!.from).toBe('submitted')
      expect(task.history[0]!.to).toBe('assigned')
      expect(task.history[1]!.from).toBe('assigned')
      expect(task.history[1]!.to).toBe('working')
      expect(task.history[2]!.from).toBe('working')
      expect(task.history[2]!.to).toBe('completed')
    })

    it('task timestamps updated on transition', () => {
      const task = sm.create({ id: randomUUID(), submittedBy: 'a', description: 't' })
      const origUpdated = task.updatedAt
      const next = sm.transition(task, 'assigned', { assignedTo: 'agent-1' })
      expect(new Date(next.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(origUpdated).getTime(),
      )
    })

    it('transition records reason', () => {
      const task = sm.create({ id: randomUUID(), submittedBy: 'a', description: 't' })
      const next = sm.transition(task, 'canceled', { reason: 'user requested' })
      expect(next.history[0]!.reason).toBe('user requested')
    })
  })

  describe('isValidTransition', () => {
    it('returns true for valid transitions', () => {
      expect(sm.isValidTransition('submitted', 'assigned')).toBe(true)
      expect(sm.isValidTransition('working', 'completed')).toBe(true)
      expect(sm.isValidTransition('failed', 'submitted')).toBe(true)
    })

    it('returns false for invalid transitions', () => {
      expect(sm.isValidTransition('submitted', 'completed')).toBe(false)
      expect(sm.isValidTransition('completed', 'working')).toBe(false)
      expect(sm.isValidTransition('canceled', 'submitted')).toBe(false)
    })
  })

  describe('getValidTransitions', () => {
    it('returns correct states for submitted', () => {
      expect(sm.getValidTransitions('submitted')).toEqual(
        expect.arrayContaining(['assigned', 'canceled']),
      )
    })

    it('returns correct states for working', () => {
      expect(sm.getValidTransitions('working')).toEqual(
        expect.arrayContaining(['completed', 'failed', 'input-required', 'canceled']),
      )
    })

    it('returns empty for terminal states', () => {
      expect(sm.getValidTransitions('completed')).toEqual([])
      expect(sm.getValidTransitions('canceled')).toEqual([])
    })
  })

  describe('isTerminal', () => {
    it('returns true for completed', () => {
      expect(sm.isTerminal('completed')).toBe(true)
    })

    it('returns true for canceled', () => {
      expect(sm.isTerminal('canceled')).toBe(true)
    })

    it('returns false for submitted', () => {
      expect(sm.isTerminal('submitted')).toBe(false)
    })

    it('returns false for working', () => {
      expect(sm.isTerminal('working')).toBe(false)
    })

    it('returns false for assigned', () => {
      expect(sm.isTerminal('assigned')).toBe(false)
    })

    it('returns false for input-required', () => {
      expect(sm.isTerminal('input-required')).toBe(false)
    })

    it('returns false for failed (can retry)', () => {
      expect(sm.isTerminal('failed')).toBe(false)
    })
  })
})
