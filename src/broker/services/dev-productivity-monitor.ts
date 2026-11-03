/**
 * Phase 13.13.x — WS H + WS Q: Dev Productivity Monitor.
 *
 * Two ingress paths share the same emit logic:
 *
 *   - WS H (legacy): {@link DevProductivityMonitor.handleAgentExit}
 *     subscribes to agent-exit events filtered to role=scns-dev. Kept
 *     for non-ACP transports (tmux/detached) where no turn-end signal
 *     is available. Emissions on this path do NOT carry
 *     `measured_at_turn_end:true`.
 *
 *   - WS Q (preferred): {@link DevProductivityMonitor.handleDevTurnEnded}
 *     subscribes to `dev_turn_ended` events emitted by agent-spawner
 *     when the ACP `prompt()` Promise resolves for a dispatch-attributed
 *     dev session. Sampling AFTER the turn ends — never on a timer —
 *     closes the measurement-window race that produced `diff_bytes:0`
 *     in WS-N despite a real 504 B staged diff. The numstat reader uses
 *     `git diff --cached --numstat -z` (parsed by {@link parseNumstatZ})
 *     for atomic, NUL-terminated, rename-safe output. Emissions on this
 *     path carry `measured_at_turn_end:true` so live re-dogfood (WS-S)
 *     can distinguish them from WS-H emissions.
 *
 * The monitor only OBSERVES — it does not retry, respawn, or block exit.
 * The completion gate (WS G) is the authority for refusing
 * task.status='completed' on stale diffs. Auto-respawn is deferred (per
 * next-loop-plan WS H "Out of scope").
 *
 * Dependencies are injected so startup wires real DB / git queries while
 * tests inject in-memory stubs.
 */

import { logger } from '../../shared/logger.js'

const log = logger.child({ module: 'dev-productivity-monitor' })

/** Subset of {@link AgentExitHookInfo} the monitor needs. */
export interface DevExitAgentInfo {
  readonly sessionId: string
  readonly teamId: string | null
  readonly role: string
  readonly reason?: 'normal' | 'error' | 'killed' | 'zombie'
}

/**
 * WS Q (Phase 13.13.x) — payload of the `dev_turn_ended` event handled by
 * {@link DevProductivityMonitor.handleDevTurnEnded}. Emitted by
 * agent-spawner after every ACP `sendPrompt` resolution for dispatch-
 * attributed dev sessions (one event per turn, including WS-L nudges).
 */
export interface DevTurnEndedInfo {
  readonly sessionId: string
  readonly dispatchId: string
  readonly teamId: string | null
  readonly taskId: number | null
  readonly workingDir: string
  readonly stopReason: string | null
  readonly endedAt: Date
  /**
   * WS-Q² (Phase 13.13.x) — race-fix. The agent-spawner WS-L stop
   * condition (`git diff --cached --quiet`) is sampled inside the same
   * iteration that emits this event, so when WS-L observed staged work
   * THIS turn we know the dev produced something — even if the
   * subsequent {@link DevProductivityMonitorDeps.getStagedNumstat} read
   * raced against an in-flight `git add` and saw zero. When `true`,
   * {@link DevProductivityMonitor.handleDevTurnEnded} treats the turn
   * as productive and skips `silent_exit`. `false` / `undefined`
   * preserves the prior numstat-only decision (real silent devs with
   * empty index are still flagged).
   */
  readonly stagedDiffDetected?: boolean
}

/** Minimal EventLog surface — avoids forcing the full interface on tests. */
export interface DevProductivityMonitorEventLog {
  devNoWork(sessionId: string | null, data: Record<string, unknown>): unknown
}

export type DevNoWorkReason = 'silent_exit'

/**
 * WS M (Phase 13.13.x) — strict dispatch_id attribution. Resolved by the
 * monitor for the exiting dev session and passed to
 * {@link DevProductivityMonitorDeps.getDispatchDiffBytes} so the diff
 * lookup can scope its byte count to files actually authored by THIS
 * dispatch (mtime ≥ startedAt + dispatch_id match where storable).
 */
export interface DispatchAttribution {
  readonly dispatchId: string
  readonly startedAt: Date
}

/**
 * WS Q — parsed `git diff --numstat -z` entry. For renames, `path` is
 * the destination and `renamedFrom` is set; both totalLines accounting
 * and totalFiles count the rename as a single entry.
 */
export interface NumstatEntry {
  readonly added: number
  readonly deleted: number
  readonly path: string
  readonly renamedFrom?: string
}

export interface NumstatResult {
  readonly entries: readonly NumstatEntry[]
  /** Sum of added + deleted across all entries. Binary files (`-\t-`) contribute 0. */
  readonly totalLines: number
}

/**
 * WS Q — parse the raw output of `git diff [--cached] --numstat -z`.
 *
 * Wire format (from `man git-diff`):
 *   - Regular: `<added>\t<deleted>\t<path>\0`
 *   - Rename:  `<added>\t<deleted>\t\0<from>\0<to>\0`
 *   - Binary files use `-` for both added and deleted; treated as 0
 *     here (binary work is not line-counted but is otherwise valid).
 *
 * Lifted from chamber-copilot's `lib/diff.mjs:267` (NUL-split, robust
 * to renames). totalLines is the productivity signal: any value > 0
 * means the dev produced staged work for this dispatch.
 */
export function parseNumstatZ(buffer: string): NumstatResult {
  const records = buffer.split('\0')
  // Trailing NUL produces a trailing empty record; strip it (and any
  // empty records git left behind).
  while (records.length > 0 && records[records.length - 1] === '') {
    records.pop()
  }

  const entries: NumstatEntry[] = []
  let total = 0

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!
    const parts = rec.split('\t')
    if (parts.length < 3) continue
    const addedRaw = parts[0]!
    const deletedRaw = parts[1]!
    const pathPart = parts[2]!

    const added = addedRaw === '-' ? 0 : Number.parseInt(addedRaw, 10) || 0
    const deleted = deletedRaw === '-' ? 0 : Number.parseInt(deletedRaw, 10) || 0

    if (pathPart === '') {
      // Rename: the next two NUL-separated records are <from> then <to>.
      const from = records[i + 1]
      const to = records[i + 2]
      if (from === undefined || to === undefined) continue
      entries.push({ added, deleted, path: to, renamedFrom: from })
      total += added + deleted
      i += 2
    } else {
      entries.push({ added, deleted, path: pathPart })
      total += added + deleted
    }
  }

  return { entries, totalLines: total }
}

export interface DevProductivityMonitorDeps {
  readonly eventLog: DevProductivityMonitorEventLog
  /**
   * Returns the number of `message_sent` events authored by the given dev
   * session while alive. Implementations typically count rows in the
   * events table where event_type='message_sent' AND session_id=?.
   */
  readonly countDevMessages: (sessionId: string) => number
  /**
   * WS M — Optional lookup of the dispatch attribution for the exiting
   * dev session. Production wiring queries the `dispatch_started` event
   * payload for an entry whose dev.session_id equals `sessionId`. Tests
   * may inject any deterministic value (or omit for legacy behaviour).
   */
  readonly lookupDispatch?: (sessionId: string) => DispatchAttribution | null
  /**
   * Returns total bytes of diff attributable to the dev's dispatch.
   * Receives the resolved attribution (or null if unknown) so the impl
   * can filter staged files strictly to files authored by THIS dispatch.
   * Tests may inject any non-negative integer.
   *
   * NOTE: used only on the WS-H legacy path (handleAgentExit). The WS-Q
   * turn-end path uses {@link getStagedNumstat} for atomic, rename-safe
   * line counts.
   */
  readonly getDispatchDiffBytes: (
    sessionId: string,
    attribution: DispatchAttribution | null,
  ) => number
  /**
   * WS Q — required for the turn-end path. Runs
   * `git diff --cached --numstat -z` against `workingDir` and returns
   * the parsed result. Tests inject deterministic numstat values.
   * Production wiring uses spawnSync + parseNumstatZ.
   */
  readonly getStagedNumstat?: (workingDir: string) => NumstatResult
}

export interface DevProductivityMonitor {
  handleAgentExit(info: DevExitAgentInfo): void
  /**
   * WS Q — measure productivity at ACP turn-end, sampling the staged
   * numstat AFTER the dev's `prompt()` Promise has resolved. Emits
   * `dev_no_work:silent_exit` only when BOTH the message count and the
   * post-turn staged numstat are zero.
   */
  handleDevTurnEnded(info: DevTurnEndedInfo): void
}

export function createDevProductivityMonitor(
  deps: DevProductivityMonitorDeps,
): DevProductivityMonitor {
  const { eventLog, countDevMessages, getDispatchDiffBytes, lookupDispatch, getStagedNumstat } =
    deps

  // WS-Q³ (Phase 13.13.x) — cross-path race fix. The WS-Q² fix made
  // handleDevTurnEnded honour WS-L's `staged-diff-detected` vote, but
  // the WS-H legacy `handleAgentExit` path remained blind to it. Task
  // 26 (2026-05-13 13:48:28) exposed the gap: WS-L observed a 22,739 B
  // staged diff and closed the client; the quality gate then committed
  // the diff onto its worktree branch; the agent process exited; the
  // agent-exit hook fired; `getDispatchDiffBytes` returned 0 (because
  // the gate already harvested the staged work); and the WS-H path
  // emitted a false silent_exit at 1778680108489.
  //
  // The fix tracks, per dev session, whether any prior turn-end event
  // for that session voted stagedDiffDetected=true. handleAgentExit
  // short-circuits before its diff probe when the vote is recorded.
  // We intentionally keep this in-memory (Set) — broker restarts
  // invalidate it, but a restarted broker also loses the WS-L vote
  // signal, so degrading gracefully to numstat-only is correct.
  const sessionsWithStagedDiffVote = new Set<string>()

  function emitNoWork(
    sessionId: string | null,
    teamId: string | null,
    devExitReason: string | null,
    reason: DevNoWorkReason,
    extra: Record<string, unknown>,
  ): void {
    const payload: Record<string, unknown> = {
      reason,
      team_id: teamId,
      dev_session_id: sessionId,
      dev_exit_reason: devExitReason,
      ...extra,
    }
    try {
      eventLog.devNoWork(sessionId, payload)
      log.warn(
        {
          sessionId,
          teamId,
          reason,
          ...extra,
        },
        'Dev session exited without producing work',
      )
    } catch (err) {
      log.error({ err, sessionId }, 'Failed to emit dev_no_work')
    }
  }

  function handleAgentExit(info: DevExitAgentInfo): void {
    if (info.role !== 'scns-dev') return

    let messages = 0
    try {
      messages = countDevMessages(info.sessionId)
    } catch (err) {
      log.error({ err, sessionId: info.sessionId }, 'countDevMessages threw; treating as 0')
    }
    if (messages > 0) return

    // WS-Q³ race fix: if any prior turn-end for this session reported
    // stagedDiffDetected=true, WS-L confirmed staged work this dispatch.
    // The post-gate `getDispatchDiffBytes` probe would race against the
    // gate's worktree harvest and observe 0 — suppress the false flag.
    if (sessionsWithStagedDiffVote.has(info.sessionId)) {
      sessionsWithStagedDiffVote.delete(info.sessionId)
      return
    }

    let attribution: DispatchAttribution | null = null
    if (lookupDispatch) {
      try {
        attribution = lookupDispatch(info.sessionId)
      } catch (err) {
        log.error(
          { err, sessionId: info.sessionId },
          'lookupDispatch threw; treating as no attribution',
        )
        attribution = null
      }
    }

    let diffBytes = 0
    try {
      diffBytes = getDispatchDiffBytes(info.sessionId, attribution)
    } catch (err) {
      log.error({ err, sessionId: info.sessionId }, 'getDispatchDiffBytes threw; treating as 0')
    }
    if (diffBytes > 0) return

    emitNoWork(info.sessionId, info.teamId, info.reason ?? null, 'silent_exit', {
      message_count: messages,
      diff_bytes: diffBytes,
      dispatch_id: attribution?.dispatchId ?? null,
      dispatch_started_at: attribution?.startedAt.toISOString() ?? null,
    })
  }

  function handleDevTurnEnded(info: DevTurnEndedInfo): void {
    // WS-Q³: persist the WS-L vote for cross-path consumption by the
    // WS-H agent-exit handler (which fires AFTER the gate has harvested
    // the staged diff onto its worktree branch, by which time the
    // numstat / diff probes can no longer see the original work).
    if (info.stagedDiffDetected === true) {
      sessionsWithStagedDiffVote.add(info.sessionId)
    }

    let messages = 0
    try {
      messages = countDevMessages(info.sessionId)
    } catch (err) {
      log.error(
        { err, sessionId: info.sessionId },
        'WS Q: countDevMessages threw; treating as 0',
      )
    }
    if (messages > 0) return

    let numstat: NumstatResult = { entries: [], totalLines: 0 }
    if (getStagedNumstat) {
      try {
        numstat = getStagedNumstat(info.workingDir)
      } catch (err) {
        log.error(
          { err, sessionId: info.sessionId, workingDir: info.workingDir },
          'WS Q: getStagedNumstat threw; treating as empty',
        )
      }
    }
    if (numstat.totalLines > 0) return

    // WS-Q² race fix: WS-L's `git diff --cached --quiet` runs in the
    // same loop iteration that produced this event, so its true vote
    // means the dev DID stage work this turn. The numstat-zero we just
    // observed is a measurement-window race against an in-flight
    // `git add` (see task-24 22:08:43 broker.log). Suppress the false
    // silent_exit. `false`/`undefined` keeps the prior behaviour so
    // genuinely silent devs are still flagged.
    if (info.stagedDiffDetected === true) return

    emitNoWork(info.sessionId, info.teamId, null, 'silent_exit', {
      measured_at_turn_end: true,
      message_count: messages,
      numstat_total_lines: numstat.totalLines,
      numstat_files: numstat.entries.length,
      dispatch_id: info.dispatchId,
      task_id: info.taskId,
      stop_reason: info.stopReason,
      ended_at: info.endedAt.toISOString(),
      staged_diff_detected: info.stagedDiffDetected ?? false,
    })
  }

  return { handleAgentExit, handleDevTurnEnded }
}
