import { describe, it, expect } from 'vitest'
import {
  createManagerExitMonitor,
  type ManagerExitAgentInfo,
  type ManagerExitMonitorEventLog,
  type DispatchFlagRecord,
} from '../../../../src/broker/services/manager-exit-monitor.js'

interface RecordedIncomplete {
  readonly sessionId: string | null
  readonly data: Record<string, unknown>
}

function makeEventLog(): {
  readonly events: RecordedIncomplete[]
  readonly eventLog: ManagerExitMonitorEventLog
} {
  const events: RecordedIncomplete[] = []
  const eventLog: ManagerExitMonitorEventLog = {
    managerDispatchIncomplete(sessionId, data) {
      events.push({ sessionId, data })
    },
  }
  return { events, eventLog }
}

const baseManager: ManagerExitAgentInfo = {
  sessionId: 'mgr-1',
  teamId: 'team-1',
  role: 'scns-manager',
  reason: 'normal',
}

/**
 * WS P — dispatch flag short-circuit.
 *
 * The task row's dispatch_readback_at column is now the authoritative
 * "manager dispatched its readback" signal. When the flag is present
 * for the exiting manager's most-recent in_progress task on this team,
 * the monitor MUST NOT emit `manager_dispatch_incomplete:no_readback`,
 * even when both `messages` and `messages_history` are empty for the
 * manager session (the WS-N HARD-FAIL case).
 *
 * The flag does NOT mask `dispatch_targets_missing`: dev/qa session IDs
 * are also persisted on the row and validated against wasSessionRegistered.
 * Legacy (pre-WS-P) dispatches with the flag unset fall back to the
 * existing WS-J broadcast lookup so backward compat is preserved.
 */
describe('manager-exit-monitor (WS P dispatch flag short-circuit)', () => {
  it('case (a): flag set + dev/qa registered → NO event emitted, even when broadcast lookup returns null', () => {
    const { events, eventLog } = makeEventLog()
    const record: DispatchFlagRecord = {
      readbackAt: '2026-05-12T20:00:00.000Z',
      devSessionId: 'dev-1',
      qaSessionId: 'qa-1',
    }

    const monitor = createManagerExitMonitor({
      eventLog,
      findDispatchForManagerExit: (teamId, mgrId) => {
        expect(teamId).toBe('team-1')
        expect(mgrId).toBe('mgr-1')
        return record
      },
      findLatestManagerBroadcast: () => null,
      wasSessionRegistered: (id) => id === 'dev-1' || id === 'qa-1',
    })

    monitor.handleAgentExit(baseManager)

    expect(events).toHaveLength(0)
  })

  it('case (b): flag set BUT a stored dev/qa id was never registered → emits dispatch_targets_missing (flag does not mask target validation)', () => {
    const { events, eventLog } = makeEventLog()
    const record: DispatchFlagRecord = {
      readbackAt: '2026-05-12T20:00:00.000Z',
      devSessionId: '409:other-dev',
      qaSessionId: 'qa-1',
    }

    const monitor = createManagerExitMonitor({
      eventLog,
      findDispatchForManagerExit: () => record,
      findLatestManagerBroadcast: () => null,
      wasSessionRegistered: (id) => id === 'qa-1',
    })

    monitor.handleAgentExit(baseManager)

    expect(events).toHaveLength(1)
    expect(events[0]!.data.reason).toBe('dispatch_targets_missing')
    const missing = events[0]!.data.missing as readonly string[]
    expect(missing).toEqual(['dev'])
  })

  it('case (c): legacy — flag NOT set + valid broadcast in history → no emit (WS-J fallback preserved)', () => {
    const { events, eventLog } = makeEventLog()
    const broadcast = [
      'Dispatch Readback:',
      '  dev_session_id: dev-1',
      '  qa_session_id: qa-1',
      '  notes: legacy fallback',
    ].join('\n')

    const monitor = createManagerExitMonitor({
      eventLog,
      findDispatchForManagerExit: () => null,
      findLatestManagerBroadcast: () => broadcast,
      wasSessionRegistered: () => true,
    })

    monitor.handleAgentExit(baseManager)

    expect(events).toHaveLength(0)
  })

  it('case (d): true silent — flag NOT set + no broadcast → no_readback STILL fires', () => {
    const { events, eventLog } = makeEventLog()

    const monitor = createManagerExitMonitor({
      eventLog,
      findDispatchForManagerExit: () => null,
      findLatestManagerBroadcast: () => null,
      wasSessionRegistered: () => true,
    })

    monitor.handleAgentExit(baseManager)

    expect(events).toHaveLength(1)
    expect(events[0]!.data.reason).toBe('no_readback')
  })

  it('case (e): stale-row guard — flag lookup is correlated by manager_session_id, so an unrelated stamped row does not mask a new manager exit', () => {
    const { events, eventLog } = makeEventLog()
    // findDispatchForManagerExit returns null because the stamped row
    // belongs to a different manager_session_id on the same team.
    const monitor = createManagerExitMonitor({
      eventLog,
      findDispatchForManagerExit: (teamId, mgrId) => {
        expect(teamId).toBe('team-1')
        expect(mgrId).toBe('mgr-1')
        return null
      },
      findLatestManagerBroadcast: () => null,
      wasSessionRegistered: () => true,
    })

    monitor.handleAgentExit(baseManager)

    expect(events).toHaveLength(1)
    expect(events[0]!.data.reason).toBe('no_readback')
  })
})
