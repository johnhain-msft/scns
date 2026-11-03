/**
 * Test-harness environment isolation (#54).
 *
 * A developer who follows README.md and exports `BROKER_TOKEN` on a shared
 * machine used to see ~120 unit tests fail with `401`. `createServer`
 * (src/broker/server.ts) falls back to `process.env.BROKER_TOKEN` when the
 * caller passes no `authToken`, so every in-process broker the route tests
 * spin up silently demanded a bearer token the tests never send.
 *
 * Measured on 2026-09-12 (Node 20.10.0, Windows):
 *   BROKER_TOKEN set     -> Test Files 24 failed | Tests 143 failed (7594)
 *   BROKER_TOKEN cleared -> Test Files  9 failed | Tests  23 failed (7594)
 *   CI windows-latest    -> Test Files 500 passed | 1 skipped, 0 failed
 *
 * CI never sets these vars, so CI was measuring a different environment
 * than any developer with a configured machine. The scrub makes a local
 * run match the CI reference instead of the operator's shell.
 */
import { describe, expect, it } from 'vitest'

import {
  PRESERVED_SANDBOX_VARS,
  PRESERVED_VARS,
  SCRUBBED_VARS,
  SCRUB_PRESERVE,
  lastScrubRemoved,
  scrubAmbientScnsEnv,
} from '../../helpers/ambient-env.js'

describe('scrubAmbientScnsEnv', () => {
  it('removes an ambient BROKER_TOKEN — the 401 cause', () => {
    const env: NodeJS.ProcessEnv = { BROKER_TOKEN: 'ambient-secret' }
    const removed = scrubAmbientScnsEnv(env)
    expect(env.BROKER_TOKEN).toBeUndefined()
    expect(removed).toContain('BROKER_TOKEN')
  })

  it('removes every ambient var on the scrub list', () => {
    const env: NodeJS.ProcessEnv = {}
    for (const key of SCRUBBED_VARS) env[key] = 'ambient'
    scrubAmbientScnsEnv(env)
    expect(Object.keys(env)).toEqual([])
  })

  it('leaves unrelated variables alone', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/dev', NODE_ENV: 'test' }
    scrubAmbientScnsEnv(env)
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/dev', NODE_ENV: 'test' })
  })

  it('preserves the documented operator opt-ins', () => {
    const env: NodeJS.ProcessEnv = {}
    for (const key of SCRUB_PRESERVE) env[key] = 'debug'
    scrubAmbientScnsEnv(env)
    for (const key of SCRUB_PRESERVE) {
      expect(env[key], `${key} must survive the scrub`).toBe('debug')
    }
  })

  it('reports what it removed, sorted, so the scrub is auditable', () => {
    const env: NodeJS.ProcessEnv = { SCNS_UNATTENDED: '1', BROKER_TOKEN: 'tok' }
    expect(scrubAmbientScnsEnv(env)).toEqual(['BROKER_TOKEN', 'SCNS_UNATTENDED'])
  })

  it('is a no-op on an already-clean environment (the CI case)', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    expect(scrubAmbientScnsEnv(env)).toEqual([])
    expect(env).toEqual({ PATH: '/usr/bin' })
  })
})

/**
 * Regression guard: the scrub must never delete the operator's SANDBOX.
 *
 * A first cut of this helper matched the namespace `/^(?:BROKER|SCNS)_/`,
 * which swept up `SCNS_HOME` and `BROKER_DB_PATH` along with the ambient
 * flags it was aiming at. That reinstates an anti-pattern this repo
 * considered and rejected in writing — see the docblock of
 * `spawn-env-isolation.test.ts`:
 *
 *   "A setup-file guard that simply DELETED an inherited SCNS_HOME was
 *    rejected: it would strip the in-process protection an operator
 *    deliberately opted into, pointing any non-DI production code
 *    exercised by a unit test back at the LIVE ~/.scns."
 *
 * That guard is a static scan of `{ ...process.env, HOME }` literals, so it
 * structurally cannot see a `delete` in a setup file. This suite is the
 * only thing standing between a namespace regex and the live vault, and
 * `00-fix-first.instructions.md` §6 requires BOTH vars to survive:
 * "Isolated SCNS_HOME *and* BROKER_DB_PATH (SCNS_HOME alone does not scope
 * the scheduler DB)".
 */
describe('scrubAmbientScnsEnv — sandbox variables must SURVIVE', () => {
  it.each(PRESERVED_SANDBOX_VARS)('preserves %s — an operator sandbox opt-in', (key) => {
    const env: NodeJS.ProcessEnv = { [key]: '/tmp/scns-sandbox', BROKER_TOKEN: 'tok' }
    const removed = scrubAmbientScnsEnv(env)
    expect(env[key], `${key} is the sandbox, not ambient config`).toBe('/tmp/scns-sandbox')
    expect(removed).not.toContain(key)
  })

  it('removes ONLY the ambient token from a fully-configured sandbox shell', () => {
    // Verbatim reproduction from the blind review of PR #56: this input
    // previously reported removed = ['BROKER_DB_PATH','BROKER_TOKEN','SCNS_HOME'].
    const env: NodeJS.ProcessEnv = {
      SCNS_HOME: '/tmp/sandbox',
      BROKER_DB_PATH: '/tmp/sandbox/broker.db',
      BROKER_TOKEN: 'ambient-secret',
      SCNS_LOG_LEVEL: 'debug',
      PATH: '/usr/bin',
    }
    expect(scrubAmbientScnsEnv(env)).toEqual(['BROKER_TOKEN'])
    expect(env).toEqual({
      SCNS_HOME: '/tmp/sandbox',
      BROKER_DB_PATH: '/tmp/sandbox/broker.db',
      SCNS_LOG_LEVEL: 'debug',
      PATH: '/usr/bin',
    })
  })

  it('scrubs by explicit name, never by namespace — an unknown SCNS_/BROKER_ var is left alone', () => {
    // The namespace regex made every future SCNS_*/BROKER_* var scrub-by-default,
    // so the next sandbox variable someone adds would silently vanish too.
    const env: NodeJS.ProcessEnv = { SCNS_FUTURE_SANDBOX: '1', BROKER_FUTURE_PATH: '/tmp/x' }
    expect(scrubAmbientScnsEnv(env)).toEqual([])
    expect(env).toEqual({ SCNS_FUTURE_SANDBOX: '1', BROKER_FUTURE_PATH: '/tmp/x' })
  })

  it('cannot contradict itself: no variable is both scrubbed and preserved', () => {
    const overlap = SCRUBBED_VARS.filter((key) =>
      (PRESERVED_VARS as readonly string[]).includes(key),
    )
    expect(overlap).toEqual([])
  })
})

describe('the live test process', () => {
  it('has no ambient BROKER_TOKEN, whatever the developer exported', () => {
    // The regression itself: with a token present every route test 401s.
    expect(process.env['BROKER_TOKEN']).toBeUndefined()
  })

  it('has no ambient unattended-daemon flags leaking into production config', () => {
    for (const key of [
      'BROKER_AUTOSPAWN_ENABLED',
      'BROKER_PUBLISH_GATE_PASS',
      'BROKER_NORTH_STAR_NUDGE',
      'BROKER_SELF_IMPROVE_FOLLOWUPS',
      'SCNS_DRIFT_WATCHDOG',
      'SCNS_UNATTENDED',
      'SCNS_REQUIRE_PROJECT_BROKER',
    ]) {
      expect(process.env[key], `${key} leaked into the test process`).toBeUndefined()
    }
  })

  it('still silences the logger, which the scrub must not undo', () => {
    expect(process.env['SCNS_LOG_LEVEL']).toBe('silent')
  })

  it('the scrub that actually ran took nothing off the preserve list', () => {
    // Audits the REAL setup-file scrub, not a synthetic env object: if a
    // future edit puts SCNS_HOME or BROKER_DB_PATH back on the scrub list,
    // this fails on the operator's own machine where those vars are set.
    const removed = lastScrubRemoved()
    expect(removed, 'vitest.setup.ts must run scrubAmbientScnsEnv in this worker').not.toBeNull()
    for (const key of PRESERVED_VARS) {
      expect(removed, `${key} must never be scrubbed from the live test process`).not.toContain(key)
    }
  })
})
