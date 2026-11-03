import { describe, it, expect } from 'vitest'
import { assertNever } from '../../../src/shared/types.js'

describe('assertNever', () => {
  it('throws when invoked at runtime with any value cast to never', () => {
    const bogus = 'unhandled' as never
    expect(() => assertNever(bogus)).toThrow(/Unexpected value/)
  })
})
