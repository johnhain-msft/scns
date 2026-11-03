import { describe, it, expect } from 'vitest'
import { clamp } from '../../../src/shared/clamp.js'

describe('clamp', () => {
  it('returns the value unchanged when it is within range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })

  it('returns min when the value is below min', () => {
    expect(clamp(-5, 0, 10)).toBe(0)
  })

  it('returns max when the value is above max', () => {
    expect(clamp(15, 0, 10)).toBe(10)
  })

  it('returns the bound when the value equals min', () => {
    expect(clamp(0, 0, 10)).toBe(0)
  })

  it('returns the bound when the value equals max', () => {
    expect(clamp(10, 0, 10)).toBe(10)
  })
})
