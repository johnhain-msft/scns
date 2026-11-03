/**
 * WS G — gate freshness evidence helpers.
 *
 * The completion gate needs to reject "baseline-clean" verdicts on a
 * staged diff that was authored before the current dispatch began.
 * This module provides:
 *
 *   - `isStaleAgainstDispatch` — pure decision: given a set of staged
 *     file mtimes and the dispatch start time, is every hunk stale?
 *   - `realStagedFileMtimeCollector` — default I/O implementation that
 *     enumerates staged files via git and stats their mtimes.
 *
 * The pure function is the authoritative decision rule and is used by
 * the gate before it would otherwise allow a staged-diff verdict. The
 * collector is injectable so unit tests don't need a real working tree.
 */
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'

export interface StalenessInput {
  readonly stagedFileMtimes: ReadonlyMap<string, Date>
  readonly dispatchStartedAt?: Date | number | null
}

/**
 * Returns true iff dispatchStartedAt is provided AND there is at least
 * one staged-file mtime AND every recorded mtime strictly predates
 * dispatchStartedAt. Empty mtimes / unset dispatchStartedAt → false
 * (defensive: never claim staleness without positive evidence). A mtime
 * exactly equal to dispatchStartedAt is treated as fresh.
 */
export function isStaleAgainstDispatch(input: StalenessInput): boolean {
  if (input.dispatchStartedAt == null) return false
  const cutoff =
    input.dispatchStartedAt instanceof Date
      ? input.dispatchStartedAt.getTime()
      : Number(input.dispatchStartedAt)
  if (!Number.isFinite(cutoff)) return false
  const mtimes = Array.from(input.stagedFileMtimes.values())
  if (mtimes.length === 0) return false
  return mtimes.every((m) => m.getTime() < cutoff)
}

/**
 * WS M (Phase 13.13.x) — strict dispatch_id attribution helper.
 *
 * Returns the subset of staged files whose mtime is at-or-after the
 * dispatch start time. These are the only files that can be "attributed"
 * to the dispatch — anything older was authored by an earlier session
 * and must not count toward this dispatch's productivity / freshness.
 *
 * When `dispatchStartedAt` is null/undefined (no attribution evidence)
 * the input is returned as-is: callers must decide whether to treat the
 * unfiltered set as the dispatch's contribution or to skip attribution
 * entirely. `dispatchStartedAt` may be a Date or epoch ms.
 */
export function attributableStagedFiles(
  stagedFileMtimes: ReadonlyMap<string, Date>,
  dispatchStartedAt: Date | number | null | undefined,
): ReadonlyMap<string, Date> {
  if (dispatchStartedAt == null) return stagedFileMtimes
  const cutoff =
    dispatchStartedAt instanceof Date
      ? dispatchStartedAt.getTime()
      : Number(dispatchStartedAt)
  if (!Number.isFinite(cutoff)) return stagedFileMtimes
  const out = new Map<string, Date>()
  for (const [path, mtime] of stagedFileMtimes) {
    if (mtime.getTime() >= cutoff) out.set(path, mtime)
  }
  return out
}

/**
 * Default collector. Runs `git -C <cwd> diff --cached --name-only` and
 * stats each file. Returns an empty map on any error so the freshness
 * check defers to the existing diff verdict (no false-positive staleness).
 */
export type StagedFileMtimeCollector = (cwd: string) => ReadonlyMap<string, Date>

export function realStagedFileMtimeCollector(cwd: string): ReadonlyMap<string, Date> {
  const out = new Map<string, Date>()
  try {
    const result = spawnSync('git', ['-C', cwd, 'diff', '--cached', '--name-only'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
    if (result.status !== 0 || !result.stdout) return out
    const files = result.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const rel of files) {
      try {
        const stat = statSync(path.join(cwd, rel))
        out.set(rel, stat.mtime)
      } catch {
        // File may have been staged for deletion; skip.
      }
    }
  } catch {
    // Fall through with whatever we collected.
  }
  return out
}
