import { describe, it, expect, vi } from 'vitest'
import {
  createHumanFeedbackTaskBridge,
  humanFeedbackSignalKey,
} from '../../../src/brain/human-feedback-bridge.js'

const mem = {
  id: 'mem-1',
  dontRule: 'stop rewriting my commit messages',
  category: 'correction',
  recommendedTarget: 'general',
}

describe('humanFeedbackSignalKey', () => {
  it('is deterministic on the rule text so repeats dedupe', () => {
    expect(humanFeedbackSignalKey('same rule')).toBe(humanFeedbackSignalKey('same rule'))
    expect(humanFeedbackSignalKey('same rule')).not.toBe(humanFeedbackSignalKey('other rule'))
    expect(humanFeedbackSignalKey('same rule')).toMatch(/^human-feedback:/)
  })
})

describe('createHumanFeedbackTaskBridge (blind-review finding 1: dedup)', () => {
  it('creates a High task with the content-derived signal key', () => {
    const addTask = vi.fn().mockReturnValue('task-1')
    const bridge = createHumanFeedbackTaskBridge({
      addTask,
      hasQueuedSignal: () => false,
      requestWake: vi.fn(),
    })
    expect(bridge(mem)).toBe('task-1')
    expect(addTask).toHaveBeenCalledWith(
      expect.stringContaining('stop rewriting my commit messages'),
      'high',
      humanFeedbackSignalKey(mem.dontRule),
    )
  })

  it('dedupes identical feedback already sitting in the queue', () => {
    const addTask = vi.fn()
    const bridge = createHumanFeedbackTaskBridge({
      addTask,
      hasQueuedSignal: (key) => key === humanFeedbackSignalKey(mem.dontRule),
      requestWake: vi.fn(),
    })
    expect(bridge(mem)).toBeNull()
    expect(addTask).not.toHaveBeenCalled()
  })

  it('wakes the brain only when a task was actually enqueued', () => {
    const requestWake = vi.fn()
    const full = createHumanFeedbackTaskBridge({
      addTask: () => null,
      hasQueuedSignal: () => false,
      requestWake,
    })
    expect(full(mem)).toBeNull()
    expect(requestWake).not.toHaveBeenCalled()

    const ok = createHumanFeedbackTaskBridge({
      addTask: () => 'task-2',
      hasQueuedSignal: () => false,
      requestWake,
    })
    expect(ok(mem)).toBe('task-2')
    expect(requestWake).toHaveBeenCalledTimes(1)
  })
})
