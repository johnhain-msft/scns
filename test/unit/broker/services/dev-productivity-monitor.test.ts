import { describe, it, expect } from 'vitest'
import {
  createDevProductivityMonitor,
  type DevExitAgentInfo,
  type DevProductivityMonitorEventLog,
} from '../../../../src/broker/services/dev-productivity-monitor.js'

interface RecordedNoWork {
  readonly sessionId: string | null
  readonly data: Record<string, unknown>
}

function makeEventLog(): {
  readonly events: RecordedNoWork[]
  readonly eventLog: DevProductivityMonitorEventLog
} {
  const events: RecordedNoWork[] = []
  const eventLog: DevProductivityMonitorEventLog = {
    devNoWork(sessionId, data) {
      events.push({ sessionId, data })
    },
  }
  return { events, eventLog }
}

const baseDev: DevExitAgentInfo = {
  sessionId: 'dev-1',
  teamId: 'team-1',
  role: 'scns-dev',
  reason: 'normal',
}

describe('dev-productivity-monitor', () => {
  it('case (1): dev exits with >=1 message_sent → no event emitted (regardless of diff)', () => {
    const { events, eventLog } = makeEventLog()
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: (id) => {
        expect(id).toBe('dev-1')
        return 3
      },
      // Even with zero diff bytes, messages alone count as productive.
      getDispatchDiffBytes: () => 0,
    })

    monitor.handleAgentExit(baseDev)

    expect(events).toHaveLength(0)
  })

  it('case (2): dev exits with 0 messages AND 0 diff bytes → emits dev_no_work reason=silent_exit', () => {
    const { events, eventLog } = makeEventLog()
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => 0,
      getDispatchDiffBytes: () => 0,
    })

    monitor.handleAgentExit(baseDev)

    expect(events).toHaveLength(1)
    const ev = events[0]!
    expect(ev.sessionId).toBe('dev-1')
    expect(ev.data.reason).toBe('silent_exit')
    expect(ev.data.team_id).toBe('team-1')
    expect(ev.data.dev_session_id).toBe('dev-1')
    expect(ev.data.dev_exit_reason).toBe('normal')
    expect(ev.data.message_count).toBe(0)
    expect(ev.data.diff_bytes).toBe(0)
  })

  it('case (3): dev exits with 0 messages but non-trivial dispatch-attributed diff → no event (work counts)', () => {
    const { events, eventLog } = makeEventLog()
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => 0,
      getDispatchDiffBytes: () => 1234,
    })

    monitor.handleAgentExit(baseDev)

    expect(events).toHaveLength(0)
  })

  it('case (4a): non-dev role (manager) → no event regardless of zero signals', () => {
    const { events, eventLog } = makeEventLog()
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => 0,
      getDispatchDiffBytes: () => 0,
    })

    monitor.handleAgentExit({ ...baseDev, role: 'scns-manager' })

    expect(events).toHaveLength(0)
  })

  it('case (4b): non-dev role (qa) → no event regardless of zero signals', () => {
    const { events, eventLog } = makeEventLog()
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => 0,
      getDispatchDiffBytes: () => 0,
    })

    monitor.handleAgentExit({ ...baseDev, role: 'scns-qa' })

    expect(events).toHaveLength(0)
  })

  it('does not call countDevMessages or getDispatchDiffBytes for non-dev roles', () => {
    const { events, eventLog } = makeEventLog()
    let countCalls = 0
    let diffCalls = 0
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => {
        countCalls++
        return 0
      },
      getDispatchDiffBytes: () => {
        diffCalls++
        return 0
      },
    })

    monitor.handleAgentExit({ ...baseDev, role: 'scns-manager' })
    monitor.handleAgentExit({ ...baseDev, role: 'scns-qa' })

    expect(countCalls).toBe(0)
    expect(diffCalls).toBe(0)
    expect(events).toHaveLength(0)
  })

  it('short-circuits diff lookup when message_count > 0', () => {
    const { events, eventLog } = makeEventLog()
    let diffCalls = 0
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => 1,
      getDispatchDiffBytes: () => {
        diffCalls++
        return 0
      },
    })

    monitor.handleAgentExit(baseDev)

    expect(diffCalls).toBe(0)
    expect(events).toHaveLength(0)
  })

  it('treats throwing dependencies as zero (does not crash)', () => {
    const { events, eventLog } = makeEventLog()
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => {
        throw new Error('db down')
      },
      getDispatchDiffBytes: () => {
        throw new Error('git down')
      },
    })

    expect(() => monitor.handleAgentExit(baseDev)).not.toThrow()

    expect(events).toHaveLength(1)
    expect(events[0]!.data.reason).toBe('silent_exit')
  })

  // ── WS M (Phase 13.13.x) — strict dispatch_id attribution ────────────
  describe('WS M strict dispatch_id attribution', () => {
    it('passes lookupDispatch result to getDispatchDiffBytes so attribution is dispatch-scoped', () => {
      const { events, eventLog } = makeEventLog()
      const calls: Array<{
        sessionId: string
        attribution: { dispatchId: string; startedAt: Date } | null
      }> = []
      const dispatchAt = new Date('2026-05-12T10:00:00Z')
      const monitor = createDevProductivityMonitor({
        eventLog,
        countDevMessages: () => 0,
        lookupDispatch: (sid) => {
          expect(sid).toBe('dev-1')
          return { dispatchId: 'this-dispatch', startedAt: dispatchAt }
        },
        getDispatchDiffBytes: (sid, attribution) => {
          calls.push({ sessionId: sid, attribution })
          // Strict attribution: only this dispatch's bytes count.
          // Concurrent staged work for OTHER dispatches must NOT suppress
          // dev_no_work — the production impl filters staged files by
          // (mtime >= attribution.startedAt) AND dispatch_id match.
          return attribution?.dispatchId === 'this-dispatch' ? 0 : 9999
        },
      })

      monitor.handleAgentExit(baseDev)

      expect(calls).toHaveLength(1)
      expect(calls[0]!.attribution).not.toBeNull()
      expect(calls[0]!.attribution!.dispatchId).toBe('this-dispatch')
      expect(calls[0]!.attribution!.startedAt.toISOString()).toBe(dispatchAt.toISOString())
      // Even though other dispatches have 9999 bytes of staged work, this
      // dispatch's attributable bytes are 0 → dev_no_work fires.
      expect(events).toHaveLength(1)
      const ev = events[0]!
      expect(ev.data.reason).toBe('silent_exit')
      expect(ev.data.dispatch_id).toBe('this-dispatch')
      expect(ev.data.dispatch_started_at).toBe(dispatchAt.toISOString())
      expect(ev.data.diff_bytes).toBe(0)
    })

    it('passes null attribution when lookupDispatch returns null (legacy fallback)', () => {
      const { events, eventLog } = makeEventLog()
      let receivedAttribution: unknown = 'not-set'
      const monitor = createDevProductivityMonitor({
        eventLog,
        countDevMessages: () => 0,
        lookupDispatch: () => null,
        getDispatchDiffBytes: (_sid, attribution) => {
          receivedAttribution = attribution
          return 0
        },
      })

      monitor.handleAgentExit(baseDev)

      expect(receivedAttribution).toBeNull()
      expect(events).toHaveLength(1)
      expect(events[0]!.data.dispatch_id).toBeNull()
    })

    it('does not fire dev_no_work when dispatch-attributable bytes > 0 even if other dispatches are zero', () => {
      const { events, eventLog } = makeEventLog()
      const monitor = createDevProductivityMonitor({
        eventLog,
        countDevMessages: () => 0,
        lookupDispatch: () => ({ dispatchId: 'd1', startedAt: new Date() }),
        getDispatchDiffBytes: () => 500,
      })

      monitor.handleAgentExit(baseDev)
      expect(events).toHaveLength(0)
    })
  })
})