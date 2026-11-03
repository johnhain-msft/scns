/**
 * Shared type definitions for SCNS.
 */

/** Autonomy trust levels */
export enum AutonomyLevel {
  Observer = 0,
  Advisor = 1,
  Assistant = 2,
  Autonomous = 3,
}

/** Session lifecycle states */
export enum SessionState {
  Starting = 'starting',
  Running = 'running',
  Paused = 'paused',
  Stopping = 'stopping',
  Stopped = 'stopped',
  Zombie = 'zombie',
}

/** Log severity levels */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/**
 * Exhaustiveness helper: throws at runtime AND fails to typecheck
 * if a discriminated union has unhandled cases. Use as the default
 * branch in switch statements on a union to force TypeScript to
 * verify every variant is handled.
 *
 * @example
 *   switch (level) {
 *     case 'debug': return 0
 *     case 'info': return 1
 *     // ... etc
 *     default: return assertNever(level)
 *   }
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`)
}
