/**
 * Agent lifecycle state machine.
 *
 * Defines the valid session statuses and the allowed transitions between them.
 * All exports are pure functions with no side effects — validation is separate
 * from persistence.
 *
 * State diagram:
 *   registered → active → working → reporting → idle → completed
 *                  ↕                                     ↓
 *                paused                               (deregistered)
 *                                                        ↓
 *                                                     (zombie if heartbeat expires)
 */

import { ConflictError } from './errors.js'

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export const SESSION_STATUSES = Object.freeze([
  'registered',
  'active',
  'working',
  'reporting',
  'idle',
  'paused',
  'completed',
  'zombie',
  // Issue #70: execution lease lapsed; identity retained and revivable.
  'expired',
] as const)

export type SessionStatus = (typeof SESSION_STATUSES)[number]

// ---------------------------------------------------------------------------
// Transition map (immutable)
// ---------------------------------------------------------------------------

const _TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  registered: Object.freeze(['active', 'expired'] as const),
  active: Object.freeze(['working', 'paused', 'completed', 'zombie', 'expired'] as const),
  working: Object.freeze(['reporting', 'active', 'paused', 'zombie', 'expired'] as const),
  reporting: Object.freeze(['idle', 'active', 'zombie', 'expired'] as const),
  idle: Object.freeze(['active', 'working', 'completed', 'zombie', 'expired'] as const),
  paused: Object.freeze(['active', 'completed', 'zombie', 'expired'] as const),
  // Issue #70: 'completed' and 'zombie' revive to 'active' (explicit
  // re-registration / resume / discovery); 'expired' additionally revives on
  // any proof of life (heartbeat, hook activity).
  completed: Object.freeze(['active'] as const),
  zombie: Object.freeze(['active', 'expired'] as const),
  expired: Object.freeze(['active'] as const),
}

export const TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> =
  Object.freeze(_TRANSITIONS)

// ---------------------------------------------------------------------------
// Pure validation
// ---------------------------------------------------------------------------

/** Throws ConflictError if `from → to` is not an allowed transition. */
export function validateTransition(from: SessionStatus, to: SessionStatus): void {
  const allowed = TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw new ConflictError(
      `Invalid status transition: '${from}' → '${to}'. ` +
        `Allowed transitions from '${from}': [${allowed.join(', ')}]`,
    )
  }
}

/** Returns the list of statuses reachable from `status`. */
export function getValidTransitions(status: SessionStatus): readonly SessionStatus[] {
  return TRANSITIONS[status]
}

/** Returns true if the status has no outgoing transitions. */
export function isTerminalStatus(status: SessionStatus): boolean {
  return TRANSITIONS[status].length === 0
}
