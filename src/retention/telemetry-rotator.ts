/**
 * Telemetry log rotator.
 *
 * Caps the on-disk growth of the Copilot OTel JSONL log
 * (~/.scns/telemetry/copilot-otel.jsonl by default). When the active log
 * exceeds `maxBytes`, archives are shifted (.{N-1} → .{N}, dropping the
 * oldest), the active log moves to `.1`, and a fresh empty primary is
 * recreated so the file watcher / external producers can keep appending.
 *
 * Pure I/O on a single path — no broker / DB coupling — so this module is
 * safe to call from any daemon (CLI, scheduler, manual maintenance script).
 *
 * Rationale for rename-then-recreate (not copytruncate):
 *   SCNS's OTel writers are the per-session Copilot CLI processes spawned
 *   by agent-spawner. Each session opens the OTel path fresh, writes for
 *   the lifetime of that session, then closes. Long-running sessions that
 *   were spawned before a rotation will keep writing to the renamed `.1`
 *   file (their open file-handle's inode follows the rename) — we accept
 *   that small loss because rotations are rare (every ~6h or on startup
 *   if the file is over threshold) and the data is preserved in the
 *   archive. New sessions after rotation always open the recreated empty
 *   primary, so growth continues from zero.
 */

import { existsSync, statSync, renameSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { resolveScnsHome } from '../shared/scns-home.js'

export interface TelemetryRotationConfig {
  readonly filePath: string
  readonly maxBytes: number
  readonly retainCount: number
  /**
   * P5a: enforce a TOTAL-bytes cap across the rotated archive set
   * (`.1..N`). Prevents a single hostile pre-policy archive from
   * squatting indefinitely on disk just because there have not been
   * enough rotations to roll it off the end of the retain window.
   * Honored by {@link pruneTelemetryArchives}; ignored by
   * {@link rotateTelemetryIfNeeded} (which only triggers on
   * per-file `maxBytes`).
   */
  readonly maxTotalBytes: number
}

export type TelemetryRotationReason = 'missing' | 'under-threshold' | 'rotated'

export interface TelemetryRotationResult {
  readonly rotated: boolean
  readonly reason: TelemetryRotationReason
  readonly beforeBytes: number
  readonly archivePath?: string
  readonly removedPath?: string
  readonly rotatedAt?: string
}

export const DEFAULT_TELEMETRY_MAX_BYTES = 100 * 1024 * 1024
/**
 * P5a (2026-06-03): lowered from 5 → 3 as belt-and-suspenders.
 * Combined with the new total-bytes cap, three numbered archives is
 * enough recent history for trace-assembly debugging without letting
 * a slow-rotation cadence pile up half a gigabyte of `.4`/`.5`.
 */
export const DEFAULT_TELEMETRY_RETAIN_COUNT = 3
/**
 * P5a: default total-bytes cap across all rotated archives. 300 MiB
 * = 3× per-file maxBytes; tightly aligned with `retainCount=3` so a
 * steady-state run with every archive at threshold ≈ exactly the cap.
 */
export const DEFAULT_TELEMETRY_MAX_TOTAL_BYTES = 300 * 1024 * 1024

/**
 * Resolve a runtime rotation config from environment variables.
 *
 * Honored env vars (all optional):
 *   - SCNS_TELEMETRY_FILE_PATH — override default ~/.scns/telemetry/copilot-otel.jsonl
 *   - SCNS_TELEMETRY_MAX_BYTES — size threshold; falls back to default 100 MiB
 *   - SCNS_TELEMETRY_RETAIN_COUNT — archive count; falls back to default 5
 *
 * Per-call overrides win over env which wins over defaults. Invalid numerics
 * are silently ignored (we'd rather rotate at defaults than crash a scheduled
 * task on a bad env string).
 */
export function resolveTelemetryRotationConfig(
  overrides?: Partial<TelemetryRotationConfig>,
  env: NodeJS.ProcessEnv = process.env,
): TelemetryRotationConfig {
  const defaultPath = join(resolveScnsHome(), '.scns', 'telemetry', 'copilot-otel.jsonl')
  const envPath = env['SCNS_TELEMETRY_FILE_PATH']
  const filePath = overrides?.filePath ?? (envPath && envPath.length > 0 ? envPath : defaultPath)

  const parsePositiveInt = (value: string | undefined): number | undefined => {
    if (value === undefined || value === '') return undefined
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  }

  const maxBytes =
    overrides?.maxBytes ??
    parsePositiveInt(env['SCNS_TELEMETRY_MAX_BYTES']) ??
    DEFAULT_TELEMETRY_MAX_BYTES

  const retainCount =
    overrides?.retainCount ??
    parsePositiveInt(env['SCNS_TELEMETRY_RETAIN_COUNT']) ??
    DEFAULT_TELEMETRY_RETAIN_COUNT

  const maxTotalBytes =
    overrides?.maxTotalBytes ??
    parsePositiveInt(env['SCNS_TELEMETRY_MAX_TOTAL_BYTES']) ??
    DEFAULT_TELEMETRY_MAX_TOTAL_BYTES

  return { filePath, maxBytes, retainCount, maxTotalBytes }
}

export async function rotateTelemetryIfNeeded(
  cfg: TelemetryRotationConfig,
): Promise<TelemetryRotationResult> {
  const { filePath, maxBytes, retainCount } = cfg

  if (!existsSync(filePath)) {
    return { rotated: false, reason: 'missing', beforeBytes: 0 }
  }

  const size = statSync(filePath).size
  if (size < maxBytes) {
    return { rotated: false, reason: 'under-threshold', beforeBytes: size }
  }

  let removedPath: string | undefined
  const oldest = `${filePath}.${retainCount}`
  if (existsSync(oldest)) {
    unlinkSync(oldest)
    removedPath = oldest
  }

  for (let i = retainCount - 1; i >= 1; i--) {
    const src = `${filePath}.${i}`
    const dst = `${filePath}.${i + 1}`
    if (existsSync(src)) {
      renameSync(src, dst)
    }
  }

  const archivePath = `${filePath}.1`
  renameSync(filePath, archivePath)
  // Recreate an empty primary so appenders / watchers don't see ENOENT.
  writeFileSync(filePath, '')

  const result: TelemetryRotationResult = {
    rotated: true,
    reason: 'rotated',
    beforeBytes: size,
    archivePath,
    rotatedAt: new Date().toISOString(),
    ...(removedPath ? { removedPath } : {}),
  }
  return result
}

export interface ParkedSweepResult {
  readonly removed: readonly string[]
  readonly freedBytes: number
}

/**
 * P5a: result of a total-bytes cap sweep over rotated archives.
 *
 * `removed` is the list of full paths actually deleted. `freedBytes`
 * is the sum of their sizes at deletion time. `capExceeded` is true
 * when the post-sweep total bytes is STILL over `maxTotalBytes` — in
 * practice this only happens when only `.1` remains and `.1` alone
 * is larger than the cap. We intentionally never delete `.1` to
 * avoid orphaning live writer inodes (Unix unlink-on-open leaves the
 * disk usage stuck until those Copilot CLI children exit).
 */
export interface TelemetryPruneResult {
  readonly removed: readonly string[]
  readonly freedBytes: number
  readonly capExceeded: boolean
}

/**
 * P5a: enforce a total-bytes cap across rotated archives. Walks all
 * `<filePath>.<N>` siblings on disk, sums their sizes, then deletes
 * highest-numbered (oldest) first until the remaining total is ≤
 * `maxTotalBytes`. The active (unsuffixed) file and `.1` are both
 * protected (see {@link TelemetryPruneResult}).
 *
 * Gaps in numbering are tolerated. A missing parent directory is a
 * no-op. Individual unlink failures are swallowed (best-effort).
 */
export function pruneTelemetryArchives(cfg: TelemetryRotationConfig): TelemetryPruneResult {
  const { filePath, maxTotalBytes } = cfg
  const dir = dirname(filePath)
  const base = basename(filePath)

  if (!existsSync(dir)) {
    return { removed: [], freedBytes: 0, capExceeded: false }
  }

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return { removed: [], freedBytes: 0, capExceeded: false }
  }

  // Match <base>.<N> exactly — never the active file (no suffix) and
  // never anything other than a positive integer suffix (so we don't
  // accidentally eat `.parked*` siblings that the dedicated
  // sweepParkedTelemetry handles).
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const numberedRe = new RegExp(`^${escapedBase}\\.(\\d+)$`)
  type Archive = { readonly index: number; readonly path: string; readonly size: number }
  const archives: Archive[] = []
  for (const entry of entries) {
    const match = numberedRe.exec(entry)
    if (!match) continue
    const index = Number.parseInt(match[1]!, 10)
    if (!Number.isFinite(index) || index < 1) continue
    const full = join(dir, entry)
    let size = 0
    try {
      size = statSync(full).size
    } catch {
      continue
    }
    archives.push({ index, path: full, size })
  }

  let totalBytes = archives.reduce((sum, a) => sum + a.size, 0)
  if (totalBytes <= maxTotalBytes) {
    return { removed: [], freedBytes: 0, capExceeded: false }
  }

  // Sort by index DESC — highest-numbered (oldest) gets removed first.
  archives.sort((a, b) => b.index - a.index)

  const removed: string[] = []
  let freedBytes = 0
  for (const archive of archives) {
    if (totalBytes <= maxTotalBytes) break
    // Protect .1: long-running sessions may still hold its inode.
    if (archive.index === 1) continue
    try {
      unlinkSync(archive.path)
      removed.push(archive.path)
      freedBytes += archive.size
      totalBytes -= archive.size
    } catch {
      /* best-effort: ignore individual unlink failures */
    }
  }

  return {
    removed,
    freedBytes,
    capExceeded: totalBytes > maxTotalBytes,
  }
}

/**
 * Delete orphaned manually-"parked" telemetry siblings (e.g.
 * `copilot-otel.jsonl.parked`, `copilot-otel.jsonl.parked-ws-s-<ts>`). The
 * regular rotation only manages numbered `.1..N` archives and never reclaims
 * `.parked*` leftovers, so they accumulate unbounded (2.3 GB observed). This
 * matches by the `<base>.parked` prefix only — the active log and numbered
 * archives are untouched. Best-effort: individual unlink failures are ignored.
 */
export function sweepParkedTelemetry(filePath: string): ParkedSweepResult {
  const dir = dirname(filePath)
  const prefix = `${basename(filePath)}.parked`

  if (!existsSync(dir)) {
    return { removed: [], freedBytes: 0 }
  }

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return { removed: [], freedBytes: 0 }
  }

  const removed: string[] = []
  let freedBytes = 0
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const full = join(dir, entry)
    try {
      freedBytes += statSync(full).size
      unlinkSync(full)
      removed.push(full)
    } catch {
      /* ignore individual failures — sweep is best-effort */
    }
  }

  return { removed, freedBytes }
}
