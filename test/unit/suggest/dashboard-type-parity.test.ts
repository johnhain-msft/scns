import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SuggestionType } from '../../../src/suggest/types.js'

/**
 * Phase 13.12.7 — parity test.
 *
 * The dashboard filter dropdown derives its options from
 * `dashboard/src/lib/suggestion-types.ts`. That file contains a plain
 * string array (so the dashboard can remain an independent build without
 * importing from the backend source tree).
 *
 * This test reads that file's source and asserts the string array matches
 * `Object.values(SuggestionType)` exactly. If a new type is added to the
 * backend enum without updating the dashboard constant, CI fails here.
 */
describe('dashboard SuggestionType parity', () => {
  it('SUGGESTION_TYPES in dashboard matches backend Object.values(SuggestionType)', () => {
    const dashboardFile = join(
      process.cwd(),
      'dashboard',
      'src',
      'lib',
      'suggestion-types.ts',
    )
    const src = readFileSync(dashboardFile, 'utf-8')

    // Extract the SUGGESTION_TYPES array literal.
    const m = src.match(/export const SUGGESTION_TYPES = \[([\s\S]*?)\] as const/)
    expect(m, 'SUGGESTION_TYPES export not found in dashboard/src/lib/suggestion-types.ts').toBeTruthy()
    const body = m![1]!
    const dashboardTypes = Array.from(body.matchAll(/'([^']+)'/g)).map((r) => r[1]!)

    const backendTypes = Object.values(SuggestionType)

    expect(dashboardTypes.sort()).toEqual([...backendTypes].sort())
  })
})
