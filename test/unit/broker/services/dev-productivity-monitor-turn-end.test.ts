import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createDevProductivityMonitor,
  parseNumstatZ,
  type DevProductivityMonitorEventLog,
  type DevTurnEndedInfo,
  type NumstatResult,
} from '../../../../src/broker/services/dev-productivity-monitor.js'

/**
 * WS Q (Phase 13.13.x) — turn-end-anchored work measurement.
 *
 * Replaces the WS-H session-deregistered measurement window with a
 * subscription to `dev_turn_ended` (emitted by agent-spawner when the
 * ACP `prompt()` Promise resolves for a dispatch-attributed dev
 * session). Sampling AFTER the turn ends — never on a timer — closes
 * the measurement-window race that produced `diff_bytes:0` in WS-N
 * despite the dev staging a real 504 B diff.
 *
 * dev_no_work payloads from the new path carry
 * `measured_at_turn_end: true` so live re-dogfood (WS-S) can
 * distinguish them from legacy WS-H emissions on tmux / non-ACP dev
 * sessions.
 */
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

const baseTurnEnd: DevTurnEndedInfo = {
  sessionId: 'dev-q1',
  dispatchId: 'disp-q1',
  teamId: 'team-q1',
  taskId: 42,
  workingDir: '/tmp/scns-test-fixture',
  stopReason: 'end_turn',
  endedAt: new Date('2026-05-12T20:00:00.000Z'),
}

describe('dev-productivity-monitor — WS Q turn-end-anchored measurement', () => {
  it('case (a): dev_turn_ended + non-zero numstat → NO event (work counts as productive)', () => {
    const { events, eventLog } = makeEventLog()
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => 0,
      getDispatchDiffBytes: () => 0, // legacy dep, unused on new path
      getStagedNumstat: (cwd) => {
        expect(cwd).toBe('/tmp/scns-test-fixture')
        return {
          entries: [{ added: 12, deleted: 4, path: 'src/foo.ts' }],
          totalLines: 16,
        }
      },
    })

    monitor.handleDevTurnEnded(baseTurnEnd)

    expect(events).toHaveLength(0)
  })

  it('case (b): dev_turn_ended + zero numstat + zero messages → emits silent_exit with measured_at_turn_end:true', () => {
    const { events, eventLog } = makeEventLog()
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => 0,
      getDispatchDiffBytes: () => 0,
      getStagedNumstat: (): NumstatResult => ({ entries: [], totalLines: 0 }),
    })

    monitor.handleDevTurnEnded(baseTurnEnd)

    expect(events).toHaveLength(1)
    const ev = events[0]!
    expect(ev.sessionId).toBe('dev-q1')
    expect(ev.data.reason).toBe('silent_exit')
    expect(ev.data.dispatch_id).toBe('disp-q1')
    expect(ev.data.measured_at_turn_end).toBe(true)
    expect(ev.data.numstat_total_lines).toBe(0)
    expect(ev.data.stop_reason).toBe('end_turn')
  })

  // WS-Q² (Phase 13.13.x) — race-fix regression. At task-24 22:08:43
  // the ACP loop saw `staged-diff-detected` (WS-L closed the client
  // for that reason) but `getStagedNumstat` 80ms later observed zero
  // bytes because the index was being rewritten by `git add` mid-flight.
  // The monitor MUST treat WS-L's vote as authoritative against
  // silent_exit. Otherwise we emit a false dev_no_work even though
  // WS-L just confirmed the dev DID stage work this turn.
  it('case (c): WS-L stagedDiffDetected=true vetoes silent_exit even when numstat=0 (race fix)', () => {
    const { events, eventLog } = makeEventLog()
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => 0,
      getDispatchDiffBytes: () => 0,
      getStagedNumstat: (): NumstatResult => ({ entries: [], totalLines: 0 }),
    })

    monitor.handleDevTurnEnded({ ...baseTurnEnd, stagedDiffDetected: true })

    expect(events).toHaveLength(0)
  })

  it('case (d): WS-L stagedDiffDetected=false + numstat=0 still emits silent_exit (real silent dev preserved)', () => {
    const { events, eventLog } = makeEventLog()
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => 0,
      getDispatchDiffBytes: () => 0,
      getStagedNumstat: (): NumstatResult => ({ entries: [], totalLines: 0 }),
    })

    monitor.handleDevTurnEnded({ ...baseTurnEnd, stagedDiffDetected: false })

    expect(events).toHaveLength(1)
    expect(events[0]!.data.reason).toBe('silent_exit')
    expect(events[0]!.data.staged_diff_detected).toBe(false)
  })

  it('case (e): stagedDiffDetected omitted (legacy/unknown) preserves prior behaviour — emits when numstat=0', () => {
    const { events, eventLog } = makeEventLog()
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => 0,
      getDispatchDiffBytes: () => 0,
      getStagedNumstat: (): NumstatResult => ({ entries: [], totalLines: 0 }),
    })

    monitor.handleDevTurnEnded(baseTurnEnd)

    expect(events).toHaveLength(1)
    expect(events[0]!.data.reason).toBe('silent_exit')
  })

  it('short-circuits numstat when message_count > 0 (messages count as work)', () => {
    const { events, eventLog } = makeEventLog()
    let numstatCalls = 0
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => 2,
      getDispatchDiffBytes: () => 0,
      getStagedNumstat: () => {
        numstatCalls++
        return { entries: [], totalLines: 0 }
      },
    })

    monitor.handleDevTurnEnded(baseTurnEnd)

    expect(numstatCalls).toBe(0)
    expect(events).toHaveLength(0)
  })

  it('legacy handleAgentExit path does NOT emit measured_at_turn_end:true (distinguishes from WS-Q path)', () => {
    const { events, eventLog } = makeEventLog()
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => 0,
      getDispatchDiffBytes: () => 0,
    })

    monitor.handleAgentExit({
      sessionId: 'dev-legacy',
      teamId: 'team-legacy',
      role: 'scns-dev',
      reason: 'normal',
    })

    expect(events).toHaveLength(1)
    expect(events[0]!.data.measured_at_turn_end).toBeFalsy()
  })

  // WS-Q³ (Phase 13.13.x) — cross-path race fix. Reproduces task-26
  // 2026-05-13 13:48:28 broker.log: WS-L closed the dev client with
  // reason=staged-diff-detected at 1778680025965 (real 22,739 B diff),
  // the quality gate committed the diff at 1778680108484, then
  // agent-exit fired and the WS-H legacy path observed diff_bytes=0
  // (because the gate already harvested the staged work onto its
  // worktree branch) and emitted a false silent_exit at 1778680108489.
  //
  // The WS-Q² fix only patched the turn-end path. The WS-H path must
  // also respect the WS-L vote — if any prior dev_turn_ended for this
  // session reported stagedDiffDetected=true, the dev produced work
  // even if the post-gate staged index is now empty.
  it('case (WS-Q³): prior turn-end stagedDiffDetected=true suppresses handleAgentExit silent_exit', () => {
    const { events, eventLog } = makeEventLog()
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => 0,
      // WS-H legacy probe reports zero because the quality gate has
      // already committed the staged diff onto its worktree branch
      // by the time the agent-exit hook fires (task-26 scenario).
      getDispatchDiffBytes: () => 0,
      getStagedNumstat: (): NumstatResult => ({ entries: [], totalLines: 0 }),
      lookupDispatch: () => ({ dispatchId: 'disp-q3', startedAt: new Date() }),
    })

    // WS-L observed real staged work this turn → vote=true.
    monitor.handleDevTurnEnded({ ...baseTurnEnd, stagedDiffDetected: true })
    // Followed by agent-exit on the SAME session id. WS-H legacy
    // path must NOT emit silent_exit because we already know this
    // dev produced work this dispatch.
    monitor.handleAgentExit({
      sessionId: baseTurnEnd.sessionId,
      teamId: baseTurnEnd.teamId,
      role: 'scns-dev',
      reason: 'normal',
    })

    expect(events).toHaveLength(0)
  })

  it('case (WS-Q³ negative): no prior staged-diff vote → handleAgentExit still emits silent_exit', () => {
    const { events, eventLog } = makeEventLog()
    const monitor = createDevProductivityMonitor({
      eventLog,
      countDevMessages: () => 0,
      getDispatchDiffBytes: () => 0,
      getStagedNumstat: (): NumstatResult => ({ entries: [], totalLines: 0 }),
    })

    // Turn-end with stagedDiffDetected=false → genuine silent dev.
    monitor.handleDevTurnEnded({ ...baseTurnEnd, stagedDiffDetected: false })
    // The turn-end path already emitted once; agent-exit should also
    // remain free to flag (legacy behaviour preserved for non-vote case).
    monitor.handleAgentExit({
      sessionId: baseTurnEnd.sessionId,
      teamId: baseTurnEnd.teamId,
      role: 'scns-dev',
      reason: 'normal',
    })

    // Two emissions: one from turn-end (case d), one from agent-exit.
    expect(events.length).toBeGreaterThanOrEqual(1)
    // At least one is the legacy WS-H emission (no measured_at_turn_end).
    expect(events.some((e) => !e.data.measured_at_turn_end)).toBe(true)
  })
})

describe('parseNumstatZ — git diff --numstat -z parser', () => {
  it('parses a single regular entry', () => {
    const buf = '5\t2\tsrc/a.ts\0'
    const out = parseNumstatZ(buf)
    expect(out.entries).toEqual([{ added: 5, deleted: 2, path: 'src/a.ts' }])
    expect(out.totalLines).toBe(7)
  })

  it('parses multiple regular entries', () => {
    const buf = '5\t2\tsrc/a.ts\0' + '10\t0\tsrc/b.ts\0' + '0\t8\tsrc/c.ts\0'
    const out = parseNumstatZ(buf)
    expect(out.entries.map((e) => e.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(out.totalLines).toBe(5 + 2 + 10 + 0 + 0 + 8)
  })

  it('parses a rename triple — added/deleted then \\0from\\0to\\0', () => {
    // git -z numstat rename shape: "<added>\t<deleted>\t\0<from>\0<to>\0"
    const buf = '3\t1\t\0old/path.ts\0new/path.ts\0'
    const out = parseNumstatZ(buf)
    expect(out.entries).toHaveLength(1)
    expect(out.entries[0]).toEqual({
      added: 3,
      deleted: 1,
      path: 'new/path.ts',
      renamedFrom: 'old/path.ts',
    })
    expect(out.totalLines).toBe(4)
  })

  it('parses a mix of regular and rename entries', () => {
    const buf =
      '5\t2\tsrc/a.ts\0' + '3\t1\t\0old/b.ts\0new/b.ts\0' + '0\t7\tsrc/c.ts\0'
    const out = parseNumstatZ(buf)
    expect(out.entries).toHaveLength(3)
    expect(out.entries[0]!.path).toBe('src/a.ts')
    expect(out.entries[1]!.path).toBe('new/b.ts')
    expect(out.entries[1]!.renamedFrom).toBe('old/b.ts')
    expect(out.entries[2]!.path).toBe('src/c.ts')
    expect(out.totalLines).toBe(7 + 4 + 7)
  })

  it('treats binary file marker "-\\t-" as zero lines (not NaN)', () => {
    const buf = '-\t-\tsrc/blob.bin\0' + '4\t0\tsrc/a.ts\0'
    const out = parseNumstatZ(buf)
    expect(out.entries).toHaveLength(2)
    expect(out.entries[0]).toEqual({ added: 0, deleted: 0, path: 'src/blob.bin' })
    expect(out.totalLines).toBe(4)
  })

  it('handles empty input', () => {
    expect(parseNumstatZ('')).toEqual({ entries: [], totalLines: 0 })
  })
})

describe('dev-productivity-monitor — WS Q architectural guard', () => {
  it('source contains NO setInterval/setTimeout that drives diff sampling', () => {
    const src = readFileSync(
      resolve('src/broker/services/dev-productivity-monitor.ts'),
      'utf-8',
    )
    // Strip comments so doc-only mentions never trip the guard.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(stripped).not.toMatch(/\bsetInterval\b/)
    expect(stripped).not.toMatch(/\bsetTimeout\b/)
  })
})
