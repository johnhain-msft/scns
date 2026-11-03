import { describe, it, expect } from 'vitest'
import {
  slugifyProjectId,
  deriveProjectId,
} from '../../../src/broker/project-identity.js'

describe('slugifyProjectId', () => {
  it('lowercases and replaces non-alphanumeric runs with a single dash', () => {
    expect(slugifyProjectId('My Cool Repo!!')).toBe('my-cool-repo')
  })

  it('trims leading and trailing dashes', () => {
    expect(slugifyProjectId('  --Foo.Bar--  ')).toBe('foo-bar')
  })

  it('preserves existing dashes and digits', () => {
    expect(slugifyProjectId('scns-main-2')).toBe('scns-main-2')
  })

  it('falls back to "project" for empty/symbol-only input', () => {
    expect(slugifyProjectId('!!!')).toBe('project')
    expect(slugifyProjectId('')).toBe('project')
  })
})

describe('deriveProjectId', () => {
  it('is deterministic for the same path', () => {
    const a = deriveProjectId('/Users/x/Coding/scns', {
      canonicalize: (p) => p,
    })
    const b = deriveProjectId('/Users/x/Coding/scns', {
      canonicalize: (p) => p,
    })
    expect(a).toBe(b)
  })

  it('includes the repo basename as a human-readable prefix', () => {
    const id = deriveProjectId('/Users/x/Coding/scns', {
      canonicalize: (p) => p,
    })
    expect(id.startsWith('scns-')).toBe(true)
  })

  it('produces different ids for different paths (even same basename)', () => {
    const a = deriveProjectId('/Users/x/a/scns', { canonicalize: (p) => p })
    const b = deriveProjectId('/Users/x/b/scns', { canonicalize: (p) => p })
    expect(a).not.toBe(b)
  })

  it('appends an 8-char hex hash suffix', () => {
    const id = deriveProjectId('/Users/x/Coding/scns', {
      canonicalize: (p) => p,
    })
    expect(id).toMatch(/^scns-[0-9a-f]{8}$/)
  })

  it('canonicalizes the path before hashing (two aliases collapse)', () => {
    const viaSymlink = deriveProjectId('/tmp/link/scns', {
      canonicalize: () => '/real/scns',
    })
    const viaReal = deriveProjectId('/real/scns', {
      canonicalize: (p) => p,
    })
    expect(viaSymlink).toBe(viaReal)
  })

  it('honours an explicit override (slugified, no hash)', () => {
    const id = deriveProjectId('/Users/x/Coding/scns', {
      override: 'Prod Cluster A',
      canonicalize: (p) => p,
    })
    expect(id).toBe('prod-cluster-a')
  })

  it('ignores a blank/whitespace override', () => {
    const id = deriveProjectId('/Users/x/Coding/scns', {
      override: '   ',
      canonicalize: (p) => p,
    })
    expect(id).toMatch(/^scns-[0-9a-f]{8}$/)
  })

  it('falls back to "root" basename for filesystem root', () => {
    const id = deriveProjectId('/', { canonicalize: (p) => p })
    expect(id).toMatch(/^root-[0-9a-f]{8}$/)
  })
})
