/**
 * On-disk footprint reporter.
 *
 * Surfaces current SCNS disk usage (telemetry log, session-state folders,
 * broker DB, …) plus the timestamp of the last telemetry rotation so
 * operators can see at a glance whether retention/rotation is keeping the
 * footprint under control. Mounted by the broker at `/api/footprint`.
 */

import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Router } from 'express'
import type { Request, Response } from 'express'

export interface FootprintTarget {
  readonly label: string
  readonly path: string
}

export interface FootprintEntry {
  readonly label: string
  readonly path: string
  readonly bytes: number
  readonly exists: boolean
}

export interface FootprintReport {
  readonly targets: FootprintEntry[]
  readonly totalBytes: number
  readonly lastRotationAt: string | null
  readonly generatedAt: string
}

export interface ComputeFootprintOptions {
  readonly targets: readonly FootprintTarget[]
  readonly lastRotationAt: string | null
}

export async function computeFootprint(
  opts: ComputeFootprintOptions,
): Promise<FootprintReport> {
  const targets: FootprintEntry[] = opts.targets.map(({ label, path }) => {
    if (!existsSync(path)) {
      return { label, path, bytes: 0, exists: false }
    }
    try {
      const st = statSync(path)
      const bytes = st.isDirectory() ? sumDir(path) : st.size
      return { label, path, bytes, exists: true }
    } catch {
      return { label, path, bytes: 0, exists: false }
    }
  })

  const totalBytes = targets.reduce((sum, t) => sum + t.bytes, 0)
  return {
    targets,
    totalBytes,
    lastRotationAt: opts.lastRotationAt,
    generatedAt: new Date().toISOString(),
  }
}

function sumDir(dir: string): number {
  let total = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    const child = join(dir, name)
    try {
      const st = statSync(child)
      if (st.isDirectory()) {
        total += sumDir(child)
      } else if (st.isFile()) {
        total += st.size
      }
    } catch {
      // Skip unreadable entries; we want a best-effort total.
    }
  }
  return total
}

export function createFootprintRouter(
  provider: () => Promise<FootprintReport>,
): Router {
  const router = Router()
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const report = await provider()
      res.status(200).json(report)
    } catch (err) {
      res.status(500).json({
        error: 'footprint_failed',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })
  return router
}
