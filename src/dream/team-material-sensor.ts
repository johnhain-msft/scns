/**
 * W3 — consolidation-material sensor for meta-CHILD brokers.
 *
 * The dream count gate asks "is there enough new material?" and is fed by CLI
 * session-end hooks — which children never receive (the machine-wide session
 * observers are deliberately disabled per Track-2 encapsulation), so a child's
 * `sessions_since_last_run` stays 0 forever and consolidation never runs.
 *
 * A completed team run is the child's real unit of new material — the exact
 * analogue of the session-ends that feed the healthy root broker. Failures
 * count too, deliberately: dont-rules from failed attempts are exactly what
 * consolidation exists to digest. The existing counter/threshold/gate is
 * reused byte-for-byte — no gate softening, no parallel lane.
 */

export interface TeamCompletionMaterialSensorDeps {
  /** True only when SCNS_INSTANCE_ID is set (meta-supervisor child spawn). */
  readonly isMetaChild: boolean
  /** `dreamDaemon.notifySessionCompleted` — increments the count gate. */
  readonly notifySessionCompleted: () => void
}

/** Returns a handler for `team_completed` events; true when material was counted. */
export function createTeamCompletionMaterialSensor(deps: TeamCompletionMaterialSensorDeps) {
  return (): boolean => {
    if (!deps.isMetaChild) return false
    try {
      deps.notifySessionCompleted()
      return true
    } catch {
      // A broken counter must never take the event subscription down.
      return false
    }
  }
}
