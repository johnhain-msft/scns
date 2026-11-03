import { describe, it, expect } from 'vitest'
import type { Observer, ObserverState } from '../../../src/observe/observer.js'

describe('Observer interface', () => {
  it('ObserverState type accepts valid states', () => {
    const states: ObserverState[] = ['idle', 'running', 'stopping', 'error']
    expect(states).toHaveLength(4)
  })

  it('Observer interface can be implemented', () => {
    const mock: Observer = {
      type: 'claude-hooks',
      name: 'test-observer',
      start: () => {},
      stop: () => {},
      isRunning: () => false,
    }
    expect(mock.type).toBe('claude-hooks')
    expect(mock.name).toBe('test-observer')
    expect(mock.isRunning()).toBe(false)
  })
})
