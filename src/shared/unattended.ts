/**
 * Opt-in gate for unattended actions that leave this machine.
 *
 * Five daemons act on the operator's behalf beyond the local process:
 *
 *   - `gate-pass-publisher`    `git push origin <branch>` + `gh pr create`
 *   - `north-star-nudge`       files/maintains a GitHub issue
 *   - `drift-watchdog`         files/refreshes a GitHub issue
 *   - `team-task-autospawner`  spawns agent sessions (real credit spend)
 *   - `self-improve-followups` queues work the autospawner then spawns
 *
 * Before alpha these were default-ON with a kill-switch. That polarity is
 * only defensible on the author's own machine: a tester who clones this
 * repo and pastes the quick-start would have SCNS pushing branches and
 * opening PRs in *their* repo, and spending *their* credits, without ever
 * having agreed to it. Documentation does not protect someone who pastes
 * a quick-start, so the default is inverted here rather than warned about
 * (#53 AC4).
 *
 * Resolution order, highest precedence first:
 *
 *   1. the feature's own variable, when it is set to a value we recognise
 *      — this preserves every previously documented kill-switch verbatim
 *      (`BROKER_PUBLISH_GATE_PASS=0`, `BROKER_AUTOSPAWN_ENABLED=false`, …)
 *      and also lets one feature be enabled on its own
 *   2. the family switch `SCNS_UNATTENDED`, for "I know what this does,
 *      turn the set of them on"
 *   3. OFF
 *
 * Unrecognised values fail CLOSED. A typo in a variable whose job is to
 * authorise writes to someone's GitHub account must not be read as
 * consent.
 */

/** A daemon whose effects are visible outside this machine. */
export type UnattendedFeature =
  | 'gate-pass-publisher'
  | 'north-star-nudge'
  | 'drift-watchdog'
  | 'team-task-autospawner'
  | 'self-improve-followups'

/** Family switch: opts in to every feature that has no explicit setting. */
export const UNATTENDED_MASTER_ENV = 'SCNS_UNATTENDED'

/**
 * The variable each feature has always used. These names are load-bearing
 * — they are what existing installs and docs already set — so the gate
 * changes their DEFAULT, never their spelling.
 */
export const UNATTENDED_ENV_VARS: Readonly<Record<UnattendedFeature, string>> = {
  'gate-pass-publisher': 'BROKER_PUBLISH_GATE_PASS',
  'north-star-nudge': 'BROKER_NORTH_STAR_NUDGE',
  'drift-watchdog': 'SCNS_DRIFT_WATCHDOG',
  'team-task-autospawner': 'BROKER_AUTOSPAWN_ENABLED',
  'self-improve-followups': 'BROKER_SELF_IMPROVE_FOLLOWUPS',
}

export const UNATTENDED_FEATURES: readonly UnattendedFeature[] = Object.keys(
  UNATTENDED_ENV_VARS,
) as UnattendedFeature[]

/** One-line description used in startup logs and the README table. */
export const UNATTENDED_EFFECTS: Readonly<Record<UnattendedFeature, string>> = {
  'gate-pass-publisher': 'pushes scns/auto/* branches to origin and opens PRs via gh',
  'north-star-nudge': 'files a GitHub issue when intent goes stale',
  'drift-watchdog': 'files/refreshes a GitHub staleness issue',
  'team-task-autospawner': 'spawns agent sessions (consumes credits)',
  'self-improve-followups': 'queues follow-up tasks the autospawner then spawns',
}

type EnvLike = Readonly<Record<string, string | undefined>>

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled'])
const FALSY = new Set(['0', 'false', 'no', 'off', 'disabled'])

/** `true` / `false` for a recognised value, `null` for absent or unparseable. */
function tri(raw: string | undefined): boolean | null {
  if (raw === undefined) return null
  const v = raw.trim().toLowerCase()
  if (v === '') return null
  if (FALSY.has(v)) return false
  if (TRUTHY.has(v)) return true
  return null
}

/** The environment variable that controls `feature`. */
export function unattendedEnvVar(feature: UnattendedFeature): string {
  return UNATTENDED_ENV_VARS[feature]
}

/**
 * Whether `feature` is authorised to act. Default `false`.
 *
 * @param env  environment to read; defaults to `process.env`.
 */
export function isUnattendedEnabled(
  feature: UnattendedFeature,
  env: EnvLike = process.env,
): boolean {
  const own = env[UNATTENDED_ENV_VARS[feature]]
  if (own !== undefined && own.trim() !== '') {
    // Set-but-unrecognised is deliberate ambiguity, and ambiguity about
    // consent resolves to "no" — including against a master ON.
    return tri(own) === true
  }
  return tri(env[UNATTENDED_MASTER_ENV]) === true
}

/** Human-readable state for a startup log line or `doctor` output. */
export function unattendedStatusDetail(
  feature: UnattendedFeature,
  env: EnvLike = process.env,
): string {
  const key = UNATTENDED_ENV_VARS[feature]
  const own = env[key]
  const effect = UNATTENDED_EFFECTS[feature]
  if (own !== undefined && own.trim() !== '' && tri(own) === true) {
    return `ON via ${key} — ${effect}`
  }
  if (isUnattendedEnabled(feature, env)) {
    return `ON via ${UNATTENDED_MASTER_ENV} — ${effect}`
  }
  return `OFF (opt-in) — set ${key}=1 (or ${UNATTENDED_MASTER_ENV}=1) to allow it to ${effect}`
}
