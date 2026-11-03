import { describe, it, expect } from 'vitest'
import { isPathInside } from '../../../src/broker/path-containment.js'

describe('isPathInside', () => {
  it('accepts the root itself', () => {
    expect(isPathInside('/repo/a', '/repo/a', 'linux')).toBe(true)
  })

  it('accepts a descendant', () => {
    expect(isPathInside('/repo/a/src/deep', '/repo/a', 'linux')).toBe(true)
  })

  it('rejects a sibling', () => {
    expect(isPathInside('/repo/b', '/repo/a', 'linux')).toBe(false)
  })

  it('rejects a parent', () => {
    expect(isPathInside('/repo', '/repo/a', 'linux')).toBe(false)
  })

  // The bug this guard exists to stop: a scns session landing in a sibling
  // project's broker. Neither path is a prefix-boundary edge case — it must simply fail.
  it('rejects an unrelated project root', () => {
    expect(
      isPathInside('C:\\Users\\j\\Documents\\scns', 'C:\\Users\\j\\Documents\\fabrikam', 'win32'),
    ).toBe(false)
  })

  it('is boundary-safe: /repo/ab is not inside /repo/a', () => {
    expect(isPathInside('/repo/ab', '/repo/a', 'linux')).toBe(false)
  })

  it('is boundary-safe for a dotted sibling name', () => {
    expect(isPathInside('/repo/a/../..foo', '/repo/a', 'linux')).toBe(false)
  })

  it('is case-insensitive on win32', () => {
    expect(isPathInside('C:\\Repo\\A\\src', 'c:\\repo\\a', 'win32')).toBe(true)
  })

  it('is case-sensitive off win32', () => {
    expect(isPathInside('/repo/A/src', '/repo/a', 'linux')).toBe(false)
  })

  it('rejects a different win32 drive', () => {
    expect(isPathInside('D:\\repo\\a', 'C:\\repo\\a', 'win32')).toBe(false)
  })

  it('rejects empty inputs rather than defaulting to true', () => {
    expect(isPathInside('', '/repo/a', 'linux')).toBe(false)
    expect(isPathInside('/repo/a', '', 'linux')).toBe(false)
  })
})
