/**
 * WI-1(b) native-Windows path handling — platform-parameterized pure helpers.
 *
 * Runtime callers pass no platform module and get host semantics (Mac/Linux
 * behavior unchanged by construction). The win32 branch is exercised HERE, on
 * any host, by injecting `path.win32` — this is the from-Mac stand-in for
 * running the suite on Windows.
 */
import { describe, expect, it } from 'vitest'
import path, { posix, win32 } from 'node:path'

import {
  isAbsolutePath,
  isPathWithinRoot,
  resolveDeepestRootIndex,
} from '../../../src/shared/paths.js'

describe('isAbsolutePath', () => {
  it('defaults to host-platform semantics', () => {
    expect(isAbsolutePath('/a/b')).toBe(path.isAbsolute('/a/b'))
    expect(isAbsolutePath('rel/x')).toBe(false)
  })

  it('posix branch: / roots are absolute, everything else is not', () => {
    expect(isAbsolutePath('/Users/j/repo', posix)).toBe(true)
    expect(isAbsolutePath('repo/src', posix)).toBe(false)
    expect(isAbsolutePath('C:\\Users\\j', posix)).toBe(false)
    expect(isAbsolutePath('', posix)).toBe(false)
  })

  it('win32 branch: drive and UNC roots are absolute', () => {
    expect(isAbsolutePath('C:\\Users\\j\\repo', win32)).toBe(true)
    expect(isAbsolutePath('C:/Users/j/repo', win32)).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\dir', win32)).toBe(true)
    expect(isAbsolutePath('repo\\src', win32)).toBe(false)
    expect(isAbsolutePath('C:relative', win32)).toBe(false)
    expect(isAbsolutePath('', win32)).toBe(false)
  })
})

describe('isPathWithinRoot', () => {
  describe('posix branch', () => {
    it('matches the root itself and any descendant', () => {
      expect(isPathWithinRoot('/a/foo', '/a/foo', posix)).toBe(true)
      expect(isPathWithinRoot('/a/foo', '/a/foo/src/deep', posix)).toBe(true)
    })

    it('never matches a sibling sharing a name prefix', () => {
      expect(isPathWithinRoot('/a/foo', '/a/foobar/src', posix)).toBe(false)
    })

    it('ignores trailing slashes on either side', () => {
      expect(isPathWithinRoot('/a/foo/', '/a/foo', posix)).toBe(true)
      expect(isPathWithinRoot('/a/foo', '/a/foo/', posix)).toBe(true)
    })

    it('treats the filesystem root as containing everything', () => {
      expect(isPathWithinRoot('/', '/any/where', posix)).toBe(true)
    })

    it('is case-sensitive', () => {
      expect(isPathWithinRoot('/a/Foo', '/a/foo/src', posix)).toBe(false)
    })
  })

  describe('win32 branch', () => {
    it('matches the root itself and any descendant', () => {
      expect(isPathWithinRoot('C:\\repos\\app', 'C:\\repos\\app', win32)).toBe(true)
      expect(isPathWithinRoot('C:\\repos\\app', 'C:\\repos\\app\\src\\deep', win32)).toBe(true)
    })

    it('normalizes mixed separators', () => {
      expect(isPathWithinRoot('C:/repos/app', 'C:\\repos\\app\\src', win32)).toBe(true)
      expect(isPathWithinRoot('C:\\repos\\app', 'C:/repos/app/src', win32)).toBe(true)
    })

    it('compares case-insensitively (NTFS default)', () => {
      expect(isPathWithinRoot('c:\\Repos\\App', 'C:\\repos\\app\\SRC', win32)).toBe(true)
    })

    it('never matches a sibling sharing a name prefix', () => {
      expect(isPathWithinRoot('C:\\repos\\app', 'C:\\repos\\app2\\src', win32)).toBe(false)
    })

    it('never matches across drive letters', () => {
      expect(isPathWithinRoot('C:\\repos\\app', 'D:\\repos\\app\\src', win32)).toBe(false)
    })

    it('treats a drive root as containing everything on that drive', () => {
      expect(isPathWithinRoot('C:\\', 'C:\\any\\where', win32)).toBe(true)
    })

    it('handles UNC roots', () => {
      expect(isPathWithinRoot('\\\\srv\\share\\team', '\\\\srv\\share\\team\\repo', win32)).toBe(
        true,
      )
      expect(isPathWithinRoot('\\\\srv\\share\\team', '\\\\srv\\other\\team\\repo', win32)).toBe(
        false,
      )
    })
  })
})

describe('resolveDeepestRootIndex', () => {
  it('returns -1 when nothing contains the path', () => {
    expect(resolveDeepestRootIndex(['/a/foo'], '/elsewhere', posix)).toBe(-1)
    expect(resolveDeepestRootIndex([], '/a', posix)).toBe(-1)
  })

  it('picks the deepest containing root, not the first (posix)', () => {
    const roots = ['/mono', '/mono/packages/app']
    expect(resolveDeepestRootIndex(roots, '/mono/packages/app/src', posix)).toBe(1)
    expect(resolveDeepestRootIndex(roots, '/mono/other', posix)).toBe(0)
  })

  it('picks the deepest containing root on win32, case-insensitively', () => {
    const roots = ['C:\\mono', 'C:\\mono\\packages\\app']
    expect(resolveDeepestRootIndex(roots, 'c:\\MONO\\packages\\app\\src', win32)).toBe(1)
    expect(resolveDeepestRootIndex(roots, 'C:/mono/other', win32)).toBe(0)
  })
})
