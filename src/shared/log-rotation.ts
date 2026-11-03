/**
 * Log rotation daemon — rotates and cleans up log files.
 * Rotates daily (append date suffix), deletes files older than retentionDays.
 */

import { readdirSync, statSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'

export interface LogRotationConfig {
  readonly logDir: string
  readonly retentionDays: number
  readonly maxFileSizeMB: number
  readonly rotateOnStart: boolean
}

export interface RotationResult {
  readonly rotated: readonly string[]
  readonly skipped: readonly string[]
  readonly errors: readonly string[]
}

export interface CleanupResult {
  readonly deleted: readonly string[]
  readonly freedBytes: number
}

export interface LogStats {
  readonly totalFiles: number
  readonly totalSizeBytes: number
  readonly oldestFile: string | null
  readonly newestFile: string | null
}

export interface LogRotator {
  rotate(): RotationResult
  cleanup(): CleanupResult
  getStats(): LogStats
}

const LOG_EXTENSIONS = new Set(['.log', '.json'])
const DATE_SUFFIX_PATTERN = /\.\d{4}-\d{2}-\d{2}$/

function isLogFile(fileName: string): boolean {
  const ext = extname(fileName)
  if (LOG_EXTENSIONS.has(ext)) return true
  // Check for already-rotated files like foo.log.2024-01-15
  const withoutDate = fileName.replace(/\.\d{4}-\d{2}-\d{2}$/, '')
  const innerExt = extname(withoutDate)
  return LOG_EXTENSIONS.has(innerExt)
}

function isRotatedFile(fileName: string): boolean {
  return DATE_SUFFIX_PATTERN.test(fileName)
}

function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const DEFAULT_CONFIG: LogRotationConfig = {
  logDir: '',
  retentionDays: 30,
  maxFileSizeMB: 50,
  rotateOnStart: true,
}

export function createLogRotator(
  config: Partial<LogRotationConfig> & { logDir: string },
): LogRotator {
  const cfg: LogRotationConfig = { ...DEFAULT_CONFIG, ...config }

  function listLogFiles(): string[] {
    if (!existsSync(cfg.logDir)) return []
    return readdirSync(cfg.logDir).filter(isLogFile)
  }

  function rotate(): RotationResult {
    const rotated: string[] = []
    const skipped: string[] = []
    const errors: string[] = []

    if (!existsSync(cfg.logDir)) {
      mkdirSync(cfg.logDir, { recursive: true })
      return { rotated, skipped, errors }
    }

    const files = readdirSync(cfg.logDir)
    const today = formatDate(new Date())

    for (const file of files) {
      if (!isLogFile(file)) {
        continue
      }
      if (isRotatedFile(file)) {
        skipped.push(file)
        continue
      }

      const fullPath = join(cfg.logDir, file)
      try {
        const stat = statSync(fullPath)
        if (!stat.isFile()) {
          skipped.push(file)
          continue
        }

        const sizeMB = stat.size / (1024 * 1024)
        if (sizeMB < cfg.maxFileSizeMB && stat.size > 0) {
          // Check if file was modified today — skip if so
          const fileDate = formatDate(new Date(stat.mtime))
          if (fileDate === today) {
            skipped.push(file)
            continue
          }
        }

        if (stat.size === 0) {
          skipped.push(file)
          continue
        }

        const destName = `${file}.${today}`
        const destPath = join(cfg.logDir, destName)
        renameSync(fullPath, destPath)
        rotated.push(file)
      } catch (err) {
        errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return { rotated, skipped, errors }
  }

  function cleanup(): CleanupResult {
    const deleted: string[] = []
    let freedBytes = 0

    if (!existsSync(cfg.logDir)) {
      return { deleted, freedBytes }
    }

    const cutoff = Date.now() - cfg.retentionDays * 24 * 60 * 60 * 1000
    const files = readdirSync(cfg.logDir)

    for (const file of files) {
      if (!isLogFile(file)) continue

      const fullPath = join(cfg.logDir, file)
      try {
        const stat = statSync(fullPath)
        if (!stat.isFile()) continue

        if (stat.mtimeMs < cutoff) {
          const size = stat.size
          unlinkSync(fullPath)
          deleted.push(file)
          freedBytes += size
        }
      } catch {
        // Skip files we can't access
      }
    }

    return { deleted, freedBytes }
  }

  function getStats(): LogStats {
    const files = listLogFiles()
    if (files.length === 0) {
      return { totalFiles: 0, totalSizeBytes: 0, oldestFile: null, newestFile: null }
    }

    let totalSizeBytes = 0
    let oldestTime = Infinity
    let newestTime = -Infinity
    let oldestFile: string | null = null
    let newestFile: string | null = null

    for (const file of files) {
      const fullPath = join(cfg.logDir, file)
      try {
        const stat = statSync(fullPath)
        if (!stat.isFile()) continue
        totalSizeBytes += stat.size
        if (stat.mtimeMs < oldestTime) {
          oldestTime = stat.mtimeMs
          oldestFile = file
        }
        if (stat.mtimeMs > newestTime) {
          newestTime = stat.mtimeMs
          newestFile = file
        }
      } catch {
        // Skip inaccessible files
      }
    }

    return { totalFiles: files.length, totalSizeBytes, oldestFile, newestFile }
  }

  return { rotate, cleanup, getStats }
}
