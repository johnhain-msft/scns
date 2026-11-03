import { describe, it, expect } from 'vitest'
import {
  createManagerExitMonitor,
  type ManagerExitAgentInfo,
  type ManagerExitMonitorEventLog,
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

describe('manager-exit-monitor', () => {
  it('case (a): valid readback + dev + qa registered → no event emitted', () => {
    const { events, eventLog } = makeEventLog()
    const broadcast = [
      'Dispatch Readback:',
      '  dev_session_id: dev-1',
      '  qa_session_id: qa-1',
      '  notes: dev on parser, qa review-only',
    ].join('\n')

    const monitor = createManagerExitMonitor({
      eventLog,
      findLatestManagerBroadcast: (teamId, mgrId) => {
        expect(teamId).toBe('team-1')
        expect(mgrId).toBe('mgr-1')
        return broadcast
      },
      wasSessionRegistered: (id) => id === 'dev-1' || id === 'qa-1',
    })

    monitor.handleAgentExit(baseManager)

    expect(events).toHaveLength(0)
  })

  it('case (b): manager exits without final broadcast → emits manager_dispatch_incomplete with reason=no_readback', () => {
    const { events, eventLog } = makeEventLog()

    const monitor = createManagerExitMonitor({
      eventLog,
      findLatestManagerBroadcast: () => null,
      wasSessionRegistered: () => true,
    })

    monitor.handleAgentExit(baseManager)

    expect(events).toHaveLength(1)
    const evt = events[0]!
    expect(evt.sessionId).toBe('mgr-1')
    expect(evt.data.reason).toBe('no_readback')
    expect(evt.data.team_id).toBe('team-1')
    expect(evt.data.manager_session_id).toBe('mgr-1')
  })

  it('case (c): readback names dev/qa session ids that were never registered → emits with reason=dispatch_targets_missing', () => {
    const { events, eventLog } = makeEventLog()
    const broadcast = [
      'Dispatch Readback:',
      '  dev_session_id: phantom-dev',
      '  qa_session_id: phantom-qa',
      '  notes: hallucinated dispatch',
    ].join('\n')

    const monitor = createManagerExitMonitor({
      eventLog,
      findLatestManagerBroadcast: () => broadcast,
      wasSessionRegistered: () => false,
    })

    monitor.handleAgentExit(baseManager)

    expect(events).toHaveLength(1)
    const evt = events[0]!
    expect(evt.data.reason).toBe('dispatch_targets_missing')
    expect(evt.data.dev_session_id).toBe('phantom-dev')
    expect(evt.data.qa_session_id).toBe('phantom-qa')
    const missing = evt.data.missing as readonly string[]
    expect(missing).toEqual(expect.arrayContaining(['dev', 'qa']))
  })

  it('ignores non-manager exits (no event regardless of broadcast/session state)', () => {
    const { events, eventLog } = makeEventLog()

    const monitor = createManagerExitMonitor({
      eventLog,
      findLatestManagerBroadcast: () => null,
      wasSessionRegistered: () => false,
    })

    monitor.handleAgentExit({ ...baseManager, sessionId: 'dev-x', role: 'scns-dev' })
    monitor.handleAgentExit({ ...baseManager, sessionId: 'qa-x', role: 'scns-qa' })

    expect(events).toHaveLength(0)
  })

  it('skips when teamId is missing (manager not bound to a team)', () => {
    const { events, eventLog } = makeEventLog()

    const monitor = createManagerExitMonitor({
      eventLog,
      findLatestManagerBroadcast: () => null,
      wasSessionRegistered: () => true,
    })

    monitor.handleAgentExit({ ...baseManager, teamId: null })

    expect(events).toHaveLength(0)
  })

  it('only one of dev/qa missing → reason=dispatch_targets_missing with missing populated correctly', () => {
    const { events, eventLog } = makeEventLog()
    const broadcast = [
      'Dispatch Readback:',
      '  dev_session_id: dev-1',
      '  qa_session_id: phantom-qa',
      '  notes: only qa missing',
    ].join('\n')

    const monitor = createManagerExitMonitor({
      eventLog,
      findLatestManagerBroadcast: () => broadcast,
      wasSessionRegistered: (id) => id === 'dev-1',
    })

    monitor.handleAgentExit(baseManager)

    expect(events).toHaveLength(1)
    const missing = events[0]!.data.missing as readonly string[]
    expect(missing).toEqual(['qa'])
  })
})
