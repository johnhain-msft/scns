/**
 * Bootstrap regression for QG postmortem qc=5f6f8a0d-c5cb-410b-b9a4-6c12dab7a71d.
 *
 * Root cause: the broker's pino logger (src/shared/logger.ts) defaulted to
 * level 'info' during `npm test`. The quality-gate-arbiter's own
 * `logger.info('Quality gate FAIL', { findings: ['Unresolved issues
 * (TODO/FIXME/HACK) detected in output'] })` calls — triggered by the
 * arbiter's own UNIT TESTS via test fixtures — therefore echoed those
 * trigger strings into the test stdout. The OUTER QG that grades a
 * candidate team's staged diff feeds that combined stdout into
 * `evaluateRubric`, whose `no-unresolved` rubric then matches `/\bTODO\b/i`
 * / `/\bFIXME\b/i` / `/\bHACK\b/i` on the broker's OWN log echoes and
 * issues a false-positive `rubric-failed` verdict (score 0.45).
 *
 * Chicken-and-egg consequence: NO candidate diff — including the staged
 * `Task 45` rubric-scope fix — can pass the live QG, because every
 * `npm test` run replays those broker log lines.
 *
 * Fix: a vitest setup file (`test/vitest.setup.ts`) forces
 * `SCNS_LOG_LEVEL=silent` BEFORE any test file imports `src/shared/logger.ts`.
 * Pino at `silent` emits nothing, so the broker's warn/info calls during
 * tests can no longer pollute the QG's combined output.
 *
 * This test asserts the setup file wired the env + logger correctly. It
 * MUST fail in any tree that does not wire the setup file, so the
 * regression cannot silently reappear.
 */
import { describe, it, expect } from 'vitest'

import { logger } from '../../../src/shared/logger.js'

describe('logger configuration in test environment (bootstrap)', () => {
  it('SCNS_LOG_LEVEL env is set to silent before any module loads', () => {
    expect(process.env['SCNS_LOG_LEVEL']).toBe('silent')
  })

  it('pino logger reads silent level so broker log lines never pollute QG combined output', () => {
    expect(logger.level).toBe('silent')
  })

  it('logger.warn/info at silent level emit nothing observable (smoke check)', () => {
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return originalWrite(chunk as string, ...(rest as []))
    }) as typeof process.stdout.write
    try {
      logger.warn(
        { findings: ['Unresolved issues (TODO/FIXME/HACK) detected in output'] },
        'Quality gate FAIL',
      )
      logger.info({ marker: 'silent-test-marker-xyzzy' }, 'silent-test-msg')
    } finally {
      process.stdout.write = originalWrite
    }
    const joined = writes.join('')
    expect(joined).not.toMatch(/silent-test-marker-xyzzy/)
    expect(joined).not.toMatch(/Quality gate FAIL/)
    expect(joined).not.toMatch(/Unresolved issues/)
  })
})
