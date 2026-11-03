import { describe, it, expect } from 'vitest'
import {
  routeIdentityVerdict,
  routeIdentityRuntimeJs,
  type RouteVerdict,
} from '../../../src/copilot-extension/route-identity.js'

const IDS: ReadonlyArray<string | null> = [null, 'scns-132b6d01', 'fabrikam-ee9a1386']

describe('routeIdentityVerdict', () => {
  it('skips when the session is not on a project route', () => {
    expect(routeIdentityVerdict(null, 'fabrikam-ee9a1386')).toBe('skip')
    expect(routeIdentityVerdict(null, null)).toBe('skip')
  })

  it('passes when the broker reports the expected project', () => {
    expect(routeIdentityVerdict('scns-132b6d01', 'scns-132b6d01')).toBe('ok')
  })

  // The exact live failure: a session resolved for scns kept POSTing to the
  // port that a meta-broker restart had handed to a sibling project.
  it('flags a mismatch when the port now serves another project', () => {
    expect(routeIdentityVerdict('scns-132b6d01', 'fabrikam-ee9a1386')).toBe('mismatch')
  })

  it('reports unverified when identity cannot be read', () => {
    expect(routeIdentityVerdict('scns-132b6d01', null)).toBe('unverified')
  })
})

describe('routeIdentityRuntimeJs', () => {
  it('emits a function behaviourally identical to the core over the input space', () => {
    const emitted = new Function(`${routeIdentityRuntimeJs()}; return routeIdentityVerdict;`)() as (
      e: string | null,
      a: string | null,
    ) => RouteVerdict

    for (const expected of IDS) {
      for (const actual of IDS) {
        expect(emitted(expected, actual)).toBe(routeIdentityVerdict(expected, actual))
      }
    }
  })
})
