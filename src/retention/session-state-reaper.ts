/**
 * Session-state reaper.
 *
 * Walks ~/.copilot/session-state/<id>/ folders and removes anything older
 * than `maxAgeMs`. Before deleting, an optional `extract` hook is invoked
 * so durable signal (checkpoints, plan.md, files/) can be funneled into
 * the existing memory / lessons / dream pipelines. The hook receives the
 * absolute path of the session directory while it still exists; if the
 * hook throws, the directory is preserved and the error is recorded so
 * the operator can inspect it on the next sweep.
 */

import { existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface SessionStateReaperConfig {
  readonly rootDir: string
  readonly maxAgeMs: number
  readonly now?: number
  readonly extract?: (sessionDir: string) => Promise<void> | void
}

export interface ReapError {
  readonly path: string
  readonly message: string
}

export interface ReapResult {
  readonly scanned: number
  readonly reaped: string[]
  readonly extracted: string[]
  readonly errors: ReapError[]
  readonly cutoffMs: number
}

export const DEFAULT_SESSION_STATE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

export async function reapStaleSessionStates(
  cfg: SessionStateReaperConfig,
): Promise<ReapResult> {
  const { rootDir, maxAgeMs } = cfg
  const now = cfg.now ?? Date.now()
  const cutoffMs = now - maxAgeMs

  const reaped: string[] = []
  const extracted: string[] = []
  const errors: ReapError[] = []

  if (!existsSync(rootDir)) {
    return { scanned: 0, reaped, extracted, errors, cutoffMs }
  }

  let entries: string[]
  try {
    entries = readdirSync(rootDir)
  } catch (err) {
    errors.push({ path: rootDir, message: errMessage(err) })
    return { scanned: 0, reaped, extracted, errors, cutoffMs }
  }

  let scanned = 0
  for (const name of entries) {
    const dir = join(rootDir, name)
    let st
    try {
      st = statSync(dir)
    } catch (err) {
      errors.push({ path: dir, message: errMessage(err) })
      continue
    }
    if (!st.isDirectory()) continue
    scanned++

    if (st.mtimeMs > cutoffMs) continue

    if (cfg.extract) {
      try {
        await cfg.extract(dir)
        extracted.push(dir)
      } catch (err) {
        errors.push({ path: dir, message: errMessage(err) })
        continue
      }
    }

    try {
      rmSync(dir, { recursive: true, force: true })
      reaped.push(dir)
    } catch (err) {
      errors.push({ path: dir, message: errMessage(err) })
    }
  }

  return { scanned, reaped, extracted, errors, cutoffMs }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
