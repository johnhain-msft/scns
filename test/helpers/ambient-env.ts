/**
 * Ambient-environment scrub for the test harness (#54).
 *
 * `src/broker/server.ts` resolves its auth token as
 * `options?.authToken !== undefined ? options.authToken : process.env.BROKER_TOKEN ?? null`.
 * Unit tests construct brokers without an explicit `authToken`, so any
 * `BROKER_TOKEN` exported in the developer's shell silently switches every
 * in-process broker into authenticated mode. The tests never send a bearer
 * token, so each route assertion gets `401` instead of `200`/`404`.
 *
 * The same class of leak applies to the unattended-daemon flags and
 * `SCNS_REQUIRE_PROJECT_BROKER`, which `loadConfig()` reads straight from
 * `process.env` — `broker/config.test.ts` even has a case named "returns
 * frozen defaults when no env vars set", which cannot hold on a machine
 * where those vars are set.
 *
 * CI runs with none of these present. Scrubbing them makes a local run
 * reproduce the CI reference environment rather than the operator's shell.
 *
 * A test that needs one of these variables must set it itself (and restore
 * it afterwards) — `install-extension.test.ts` and `supervisor-probe.test.ts`
 * already do exactly that, which is why they pass either way.
 *
 * ## Why this is an explicit list and not a namespace wildcard
 *
 * A first cut matched `/^(?:BROKER|SCNS)_/`. That is the wrong shape: the
 * `SCNS_`/`BROKER_` namespaces hold the operator's SANDBOX as well as the
 * ambient flags — `SCNS_HOME` and `BROKER_DB_PATH` are precisely the two
 * variables `.github/instructions/00-fix-first.instructions.md` §6 requires
 * an isolated run to set ("Isolated `SCNS_HOME` **and** `BROKER_DB_PATH`
 * (SCNS_HOME alone does not scope the scheduler DB)").
 *
 * Deleting them is an anti-pattern this repo already considered and
 * rejected in writing — `test/unit/harness/spawn-env-isolation.test.ts`:
 *
 *   "A setup-file guard that simply DELETED an inherited SCNS_HOME was
 *    rejected: it would strip the in-process protection an operator
 *    deliberately opted into, pointing any non-DI production code
 *    exercised by a unit test back at the LIVE ~/.scns."
 *
 * That guard is a static scan of `{ ...process.env, HOME }` literals, so it
 * structurally cannot see a `delete` in a setup file. Scrubbing by explicit
 * name is what keeps the two concerns apart: a wildcard also claims every
 * SCNS_/BROKER_ variable that does not exist yet, so the next sandbox knob
 * anyone adds would start life silently deleted. The regression suite lives
 * in `test/unit/harness/ambient-env.test.ts`.
 */

/**
 * The ambient variables the scrub removes, by exact name.
 *
 * `BROKER_TOKEN` is the 401 cause; the rest are unattended-daemon flags and
 * `SCNS_REQUIRE_PROJECT_BROKER`, all read straight out of `process.env` by
 * `loadConfig()`. Add to this list only after checking the name against
 * `PRESERVED_VARS` — never widen it into a pattern.
 */
export const SCRUBBED_VARS = [
  'BROKER_TOKEN',
  'BROKER_AUTOSPAWN_ENABLED',
  'BROKER_NORTH_STAR_NUDGE',
  'BROKER_PUBLISH_GATE_PASS',
  'BROKER_SELF_IMPROVE_FOLLOWUPS',
  'SCNS_DRIFT_WATCHDOG',
  'SCNS_REQUIRE_PROJECT_BROKER',
  'SCNS_UNATTENDED',
] as const

/** Variables that survive the scrub because an operator sets them on purpose. */
export const SCRUB_PRESERVE = ['SCNS_LOG_LEVEL'] as const

/**
 * The sandbox pair mandated by `00-fix-first.instructions.md` §6. Deleting
 * either one points non-DI production code back at the live `~/.scns` tree,
 * so they are named here as a hard guard rather than left safe by omission.
 */
export const PRESERVED_SANDBOX_VARS = ['SCNS_HOME', 'BROKER_DB_PATH'] as const

/** Everything the scrub refuses to touch, whatever `SCRUBBED_VARS` says. */
export const PRESERVED_VARS = [...SCRUB_PRESERVE, ...PRESERVED_SANDBOX_VARS] as const

let removedByLastScrub: readonly string[] | null = null

/**
 * What the most recent scrub in THIS vitest worker removed, or `null` when
 * it has not run. `test/vitest.setup.ts` scrubs once per worker before any
 * test file imports a production module, so a test can audit the REAL scrub
 * that ran against the operator's shell rather than only a synthetic one.
 */
export function lastScrubRemoved(): readonly string[] | null {
  return removedByLastScrub
}

/**
 * Delete ambient SCNS/BROKER configuration from `env`, in place.
 *
 * Only the exact names in `SCRUBBED_VARS` are removed, and never one that
 * also appears in `PRESERVED_VARS`. Anything else — including an unknown
 * `SCNS_*`/`BROKER_*` variable — is left exactly as the operator set it.
 *
 * @returns the removed variable names, sorted, so the caller can report
 *          exactly what it took away.
 */
export function scrubAmbientScnsEnv(env: NodeJS.ProcessEnv): string[] {
  const preserved = new Set<string>(PRESERVED_VARS)
  const removed: string[] = []
  for (const key of SCRUBBED_VARS) {
    if (preserved.has(key) || env[key] === undefined) continue
    delete env[key]
    removed.push(key)
  }
  removed.sort()
  removedByLastScrub = [...removed]
  return removed
}
