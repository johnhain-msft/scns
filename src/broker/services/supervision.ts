/**
 * Issue #61 — supervision-root detection.
 *
 * SCNS's self-healing is launchd-native by design: `triggerSelfHeal` drains
 * the broker and `process.exit(1)`s, trusting launchd `KeepAlive=true` to
 * relaunch a fresh process. That contract is invisible in the code — it lives
 * entirely in a plist — so on a platform with no such supervisor the same code
 * path is an unrecoverable death. Observed live: the stack was down 11h47m and
 * nothing recovered it.
 *
 * This module makes the contract explicit and checkable. It answers one
 * question — *is there anything here that will relaunch me?* — and derives the
 * self-heal arming decision from the answer. `process.exit(1)` is only ever a
 * heal when something is watching.
 *
 * Deliberately pure (platform + env in, verdict out) so the broker, the CLI and
 * `scns doctor` all read the same fact rather than each re-deriving it.
 */

/** How the current process would be brought back if it exited. */
export type SupervisionKind = 'launchd' | 'systemd' | 'external-watchdog' | 'none'

/**
 * Set to `1` by a supervisor when it spawns the broker, so the child knows a
 * relaunch substrate exists. This is the ONLY way an unsupervised platform
 * (win32) can legitimately arm self-heal: the supervisor asserts the contract
 * at spawn time instead of the broker assuming it.
 */
export const SUPERVISED_ENV = 'SCNS_SUPERVISED'

/** Env override checked at the self-heal wiring site. `0` disables, `1` forces. */
export const SELF_HEAL_ENV = 'SCNS_BROKER_SELF_HEAL'

export interface SupervisionStatus {
  readonly kind: SupervisionKind
  /** True when exiting non-zero is expected to produce a fresh process. */
  readonly relaunches: boolean
  /** Human-readable explanation, safe to log or print in `scns doctor`. */
  readonly detail: string
}

export interface SupervisionInput {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * Detect the relaunch substrate for `platform`.
 *
 * An explicit supervisor claim (`SCNS_SUPERVISED=1`) wins on every platform:
 * only a process that actually restarts the broker sets it, and it is how the
 * external watchdog hands the contract to the child it spawned.
 *
 * darwin/linux are treated as supervised without probing, which preserves
 * pre-#61 behaviour exactly. That is an assumption, not a measurement — a
 * hand-run `scns start` in a macOS terminal has no KeepAlive either — but
 * narrowing it is a separate change from closing the Windows hole.
 */
export function detectSupervision(input: SupervisionInput): SupervisionStatus {
  if (input.env[SUPERVISED_ENV] === '1') {
    return {
      kind: 'external-watchdog',
      relaunches: true,
      detail: `${SUPERVISED_ENV}=1 — an external supervisor spawned this process and will relaunch it`,
    }
  }
  switch (input.platform) {
    case 'darwin':
      return {
        kind: 'launchd',
        relaunches: true,
        detail: 'launchd KeepAlive=true relaunches the broker after a non-zero exit',
      }
    case 'linux':
      return {
        kind: 'systemd',
        relaunches: true,
        detail: 'systemd Restart=on-failure relaunches the broker after a non-zero exit',
      }
    default:
      return {
        kind: 'none',
        relaunches: false,
        detail:
          `no relaunch substrate on ${input.platform} — a non-zero exit is permanent ` +
          `until something restarts the broker`,
      }
  }
}

/** One-line summary for logs and `scns doctor`. */
export function describeSupervision(status: SupervisionStatus): string {
  return `supervision=${status.kind} relaunches=${status.relaunches ? 'yes' : 'no'} (${status.detail})`
}

export type SelfHealArmingReason =
  | 'env-disabled'
  | 'env-forced'
  | 'supervised'
  | 'no-relaunch-substrate'

export interface SelfHealArmingDecision {
  readonly armed: boolean
  readonly reason: SelfHealArmingReason
  readonly detail: string
  readonly supervision: SupervisionStatus
}

/**
 * Decide whether self-heal may arm at all.
 *
 * Order matters: the operator kill-switch (`=0`) outranks everything, then the
 * operator force (`=1`, for a supervisor we cannot detect), then the detected
 * substrate. With no substrate we refuse to arm rather than exit into the void —
 * the health watchdog keeps observing and logging, it just never pulls a trigger
 * that has nothing behind it.
 */
export function decideSelfHealArming(input: SupervisionInput): SelfHealArmingDecision {
  const supervision = detectSupervision(input)
  const override = input.env[SELF_HEAL_ENV]

  if (override === '0') {
    return {
      armed: false,
      reason: 'env-disabled',
      detail: `${SELF_HEAL_ENV}=0`,
      supervision,
    }
  }
  if (override === '1' && !supervision.relaunches) {
    return {
      armed: true,
      reason: 'env-forced',
      detail:
        `${SELF_HEAL_ENV}=1 forces self-heal on despite ${supervision.detail} — ` +
        'a self-heal exit will NOT be relaunched automatically',
      supervision,
    }
  }
  if (supervision.relaunches) {
    return {
      armed: true,
      reason: 'supervised',
      detail: supervision.detail,
      supervision,
    }
  }
  return {
    armed: false,
    reason: 'no-relaunch-substrate',
    detail:
      `${supervision.detail}. Self-heal stays DISARMED: exiting would be a permanent ` +
      'death, not a heal. Run `scns watchdog run` (installed at logon by `scns install`) ' +
      `to supervise the broker, or set ${SELF_HEAL_ENV}=1 to override.`,
    supervision,
  }
}
