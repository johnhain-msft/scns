import { describe, it, expect, vi } from 'vitest'
import { createTeamCompletionMaterialSensor } from '../../../src/dream/team-material-sensor.js'

describe('createTeamCompletionMaterialSensor (W3: child consolidation material)', () => {
  it('counts every team completion on a meta-child, failures included', () => {
    const notifySessionCompleted = vi.fn()
    const sensor = createTeamCompletionMaterialSensor({
      isMetaChild: true,
      notifySessionCompleted,
    })
    expect(sensor()).toBe(true)
    expect(sensor()).toBe(true)
    expect(notifySessionCompleted).toHaveBeenCalledTimes(2)
  })

  it('does nothing on the root/singleton (its session-end hooks already feed the gate)', () => {
    const notifySessionCompleted = vi.fn()
    const sensor = createTeamCompletionMaterialSensor({
      isMetaChild: false,
      notifySessionCompleted,
    })
    expect(sensor()).toBe(false)
    expect(notifySessionCompleted).not.toHaveBeenCalled()
  })

  it('never throws even when the counter does', () => {
    const sensor = createTeamCompletionMaterialSensor({
      isMetaChild: true,
      notifySessionCompleted: () => {
        throw new Error('dream db closed')
      },
    })
    expect(sensor()).toBe(false)
  })
})
