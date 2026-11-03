/**
 * Route-identity verdict — shared by the TypeScript side and the generated
 * extension runtime.
 *
 * Child-broker ports are reassigned whenever the meta-broker restarts, but a
 * Copilot session resolves its broker exactly ONCE at startup and pins the URL
 * for the rest of the session. A restart can therefore hand that pinned port
 * to a different project, and the session keeps writing — into the wrong
 * project's database, under a route label that still names the right one.
 *
 * The existing re-resolve only fires on a TRANSPORT failure. A wrong-project
 * broker answers 200, so nothing detected this. Comparing the `project_id`
 * echoed by `/api/health` against the project that owns this cwd closes it.
 *
 * Emitted as JS (rather than duplicated by hand) so the generated extension
 * and this module can never drift; the unit test cross-checks them over the
 * whole input space, mirroring `broker-reconcile.ts`.
 */

export type RouteVerdict = 'skip' | 'ok' | 'mismatch' | 'unverified'

/**
 * @param expectedProjectId project that owns this cwd, or null when the
 *   session is not on a per-project route (global/team — governed elsewhere).
 * @param actualProjectId `project_id` echoed by the broker, or null when it
 *   could not be read (unreachable, non-OK, or a broker with no project).
 */
export function routeIdentityVerdict(
  expectedProjectId: string | null,
  actualProjectId: string | null,
): RouteVerdict {
  if (expectedProjectId === null) return 'skip'
  if (actualProjectId === null) return 'unverified'
  return actualProjectId === expectedProjectId ? 'ok' : 'mismatch'
}

/** The same decision, as source for the generated extension. */
export function routeIdentityRuntimeJs(): string {
  return `function routeIdentityVerdict(expectedProjectId, actualProjectId) {
  if (expectedProjectId === null) return "skip";
  if (actualProjectId === null) return "unverified";
  return actualProjectId === expectedProjectId ? "ok" : "mismatch";
}`
}
