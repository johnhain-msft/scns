/**
 * Phase 13.13.x — WS C: Manager Exit Monitor.
 *
 * Subscribes to agent-exit events filtered to role=scns-manager. For each
 * manager exit, the monitor verifies that the manager emitted a final team
 * broadcast carrying a structured Dispatch Readback block (parsed by
 * {@link parseManagerReadback}), and that the dev/qa session ids named in
 * the readback were actually registered with the broker.
 *
 * If the readback is absent, malformed, or names sessions that never
 * existed, the monitor emits a `manager_dispatch_incomplete` event with a
 * reason. The monitor only OBSERVES — it does not retry, respawn, or block
 * the manager's exit. Auto-recovery is intentionally deferred (brain
 * concern).
 *
 * This service is a pure subscriber: dependencies (broadcast lookup,
 * session-existence probe, event sink) are injected so that startup can
 * wire it to real repositories and tests can inject in-memory stubs.
 */

import { parseManagerReadback } from './manager-dispatch-readback.js'
import { logger } from '../../shared/logger.js'

const log = logger.child({ module: 'manager-exit-monitor' })

/** Subset of {@link AgentExitHookInfo} the monitor needs. */
export interface ManagerExitAgentInfo {
  readonly sessionId: string
  readonly teamId: string | null
  readonly role: string
  readonly reason?: 'normal' | 'error' | 'killed' | 'zombie'
}

/** Minimal EventLog surface — avoids forcing the full interface on tests. */
export interface ManagerExitMonitorEventLog {
  managerDispatchIncomplete(sessionId: string | null, data: Record<string, unknown>): unknown
}

export type ManagerDispatchIncompleteReason = 'no_readback' | 'dispatch_targets_missing'

/**
 * WS P (Phase 13.13.x) — durable readback flag record returned by
 * {@link ManagerExitMonitorDeps.findDispatchForManagerExit}. Loaded from
 * the task row, NOT from a purgeable messages-table lookup, so the
 * monitor can short-circuit no_readback false-positives even when
 * `messages` + `messages_history` are both empty for the manager session.
 *
 * `devSessionId` / `qaSessionId` may be raw session ids OR the encoded
 * `409:<existingOwner>` / `spawn-failed:<role>` tokens produced by
 * synthesizeReadbackBody for non-spawned outcomes; the monitor treats
 * those tokens as "not registered" and emits dispatch_targets_missing,
 * which preserves WS-C target validation even after the WS-P
 * short-circuit.
 */
export interface DispatchFlagRecord {
  readonly readbackAt: string
  readonly devSessionId: string | null
  readonly qaSessionId: string | null
}

export interface ManagerExitMonitorDeps {
  readonly eventLog: ManagerExitMonitorEventLog
  /**
   * WS P (Phase 13.13.x) — durable readback flag lookup. Returns the
   * stamped dispatch metadata for the exiting manager's most-recent
   * stamped task on this team (correlated by manager_session_id to
   * prevent stale rows masking a fresh manager exit). Null when the
   * manager never reached the WS-P stamp point (legacy path).
   */
  readonly findDispatchForManagerExit?: (
    teamId: string,
    managerSessionId: string,
  ) => DispatchFlagRecord | null
  /**
   * Returns the body of the latest broadcast authored by the given manager
   * within its team, or null if none exists. Implementations should pick a
   * broadcast-shaped message (team-wide receiver) when possible; the parser
   * tolerates extra prose around the Dispatch Readback block.
   */
  readonly findLatestManagerBroadcast: (
    teamId: string,
    managerSessionId: string,
  ) => string | null
  /**
   * Returns true iff the given session id was ever registered with the
   * broker (regardless of whether it is currently alive). Implementations
   * typically query the events table for `session_registered` rows.
   */
  readonly wasSessionRegistered: (sessionId: string) => boolean
}

export interface ManagerExitMonitor {
  handleAgentExit(info: ManagerExitAgentInfo): void
}

export function createManagerExitMonitor(deps: ManagerExitMonitorDeps): ManagerExitMonitor {
  const { eventLog, findLatestManagerBroadcast, wasSessionRegistered } = deps
  const findDispatchForManagerExit = deps.findDispatchForManagerExit ?? (() => null)

  function emitIncomplete(
    info: ManagerExitAgentInfo,
    reason: ManagerDispatchIncompleteReason,
    extra: Record<string, unknown>,
  ): void {
    const payload: Record<string, unknown> = {
      reason,
      team_id: info.teamId,
      manager_session_id: info.sessionId,
      manager_exit_reason: info.reason ?? null,
      ...extra,
    }
    try {
      eventLog.managerDispatchIncomplete(info.sessionId, payload)
      log.warn(
        {
          sessionId: info.sessionId,
          teamId: info.teamId,
          reason,
          ...extra,
        },
        'Manager exited with incomplete dispatch',
      )
    } catch (err) {
      log.error({ err, sessionId: info.sessionId }, 'Failed to emit manager_dispatch_incomplete')
    }
  }

  /**
   * WS P — a stored dev/qa "session id" may be the raw id, or the encoded
   * `409:<owner>` / `spawn-failed:<role>` tokens that synthesizeReadbackBody
   * uses for non-spawned outcomes. The latter must NOT be treated as
   * registered, so dispatch_targets_missing still fires for collision cases.
   */
  function isStoredSessionRegistered(token: string | null): boolean {
    if (!token) return false
    if (token.startsWith('409:') || token.startsWith('spawn-failed:')) return false
    return wasSessionRegistered(token)
  }

  function handleAgentExit(info: ManagerExitAgentInfo): void {
    if (info.role !== 'scns-manager') return
    if (!info.teamId) return

    // WS P short-circuit: durable readback flag is authoritative for
    // "manager dispatched its readback". When set, skip the purgeable
    // messages-table lookup entirely and validate targets from the
    // stored dev/qa ids on the task row.
    const flag = findDispatchForManagerExit(info.teamId, info.sessionId)
    if (flag) {
      const missing: string[] = []
      if (!isStoredSessionRegistered(flag.devSessionId)) missing.push('dev')
      if (!isStoredSessionRegistered(flag.qaSessionId)) missing.push('qa')

      if (missing.length > 0) {
        emitIncomplete(info, 'dispatch_targets_missing', {
          dev_session_id: flag.devSessionId,
          qa_session_id: flag.qaSessionId,
          missing,
          source: 'task_row_flag',
        })
        return
      }

      log.debug(
        {
          sessionId: info.sessionId,
          teamId: info.teamId,
          devSessionId: flag.devSessionId,
          qaSessionId: flag.qaSessionId,
          readbackAt: flag.readbackAt,
        },
        'Manager exit verified via WS-P task row flag',
      )
      return
    }

    // Legacy fallback (pre-WS-P): broadcast/history lookup (WS J).
    const body = findLatestManagerBroadcast(info.teamId, info.sessionId)
    if (!body) {
      emitIncomplete(info, 'no_readback', { detail: 'no broadcast found' })
      return
    }

    let readback
    try {
      readback = parseManagerReadback(body)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      emitIncomplete(info, 'no_readback', { detail })
      return
    }

    const missing: string[] = []
    if (!wasSessionRegistered(readback.devSessionId)) missing.push('dev')
    if (!wasSessionRegistered(readback.qaSessionId)) missing.push('qa')

    if (missing.length > 0) {
      emitIncomplete(info, 'dispatch_targets_missing', {
        dev_session_id: readback.devSessionId,
        qa_session_id: readback.qaSessionId,
        missing,
      })
      return
    }

    log.debug(
      {
        sessionId: info.sessionId,
        teamId: info.teamId,
        devSessionId: readback.devSessionId,
        qaSessionId: readback.qaSessionId,
      },
      'Manager exit verified: dispatch readback complete',
    )
  }

  return { handleAgentExit }
}
