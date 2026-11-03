/**
 * Vitest setup file — runs in each worker BEFORE any test file imports
 * production modules. Forces `SCNS_LOG_LEVEL=silent` so the broker pino
 * logger (`src/shared/logger.ts`) constructs at level 'silent' and emits
 * nothing during the test run.
 *
 * Why this matters (postmortem qc=5f6f8a0d-c5cb-410b-b9a4-6c12dab7a71d):
 * the quality-gate-arbiter feeds the COMBINED npm build/test/lint stdout
 * into `evaluateRubric`. When pino is left at level 'info', the
 * arbiter's own `logger.info('Quality gate FAIL', { findings:
 * ['Unresolved issues (TODO/FIXME/HACK) detected in output'] })` calls
 * (triggered by its OWN unit tests) echo trigger strings into the test
 * stdout. The outer QG then matches `\bTODO\b` / `\bFIXME\b` / `\bHACK\b`
 * on its own log lines and false-fires the no-unresolved rubric on
 * every candidate diff — including unrelated work. Silencing pino in
 * tests removes the trigger at its source without changing production
 * behavior (the env override is local to the vitest worker process).
 *
 * Tests that need to assert on log output must use a pino-test sink,
 * spy on the logger, or read structured events from the DB — they must
 * NOT depend on pino writing to stdout.
 *
 * This file also scrubs ambient SCNS/BROKER configuration (#54). A
 * developer who follows README.md and exports BROKER_TOKEN used to see
 * ~120 route tests fail with 401, because `createServer` falls back to
 * `process.env.BROKER_TOKEN` when a test passes no explicit authToken.
 * CI sets none of these vars, so scrubbing makes a local run reproduce
 * the CI reference environment instead of the operator's shell. See
 * `test/helpers/ambient-env.ts` for the measured before/after.
 */
import { scrubAmbientScnsEnv } from './helpers/ambient-env.js'

// Runs before any test file imports a production module, so `loadConfig()`
// and `createServer()` observe a clean environment.
scrubAmbientScnsEnv(process.env)

// Use ||= so an operator can still opt back into verbose logs by exporting
// SCNS_LOG_LEVEL before invoking vitest (e.g. SCNS_LOG_LEVEL=debug npm test).
// SCNS_LOG_LEVEL is on the scrub's preserve list for exactly this reason.
process.env['SCNS_LOG_LEVEL'] ||= 'silent'

// Pino reads `NODE_ENV !== 'production'` to enable the pino-pretty
// transport. At level 'silent' pino emits nothing regardless of
// transport, but explicitly marking the env as 'test' prevents any
// future transport from spinning up an idle worker thread per file.
process.env['NODE_ENV'] ||= 'test'
