/**
 * File-based memory vault — SOUL.md, USER.md, MEMORY.md, daily logs.
 *
 * Whole-file writes go through a temp file + rename so a reader never observes
 * a half-written file. Appends must NOT use that path: rewriting the whole file
 * to add a line is a read-modify-write, and the vault is written concurrently by
 * every live broker process for a project. Across processes that loses entries
 * (last rename wins) and, on win32, throws EPERM when the destination is held
 * open by another writer. Appends therefore use O_APPEND, where the kernel
 * positions each write at end-of-file.
 *
 * Caveat worth knowing: O_APPEND atomicity is a property of the LOCAL
 * filesystem, not of the entry size — measured intact here for concurrent
 * writes up to 1 MB on NTFS. It is NOT guaranteed for a vault placed on SMB,
 * a redirected profile, or cloud-synced storage.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ValidationError } from '../shared/errors.js'

export interface VaultConfig {
  readonly rootDir: string
}

export interface VaultFile {
  readonly path: string
  readonly content: string
  readonly mtimeMs: number
  readonly sizeBytes: number
}

export type CoreFileName = 'SOUL.md' | 'USER.md' | 'MEMORY.md'

export function createVault(config: VaultConfig) {
  const { rootDir } = config
  const dailyDir = join(rootDir, 'daily')

  /** Ensure the resolved path stays within the vault root to prevent path traversal */
  function safePath(relativePath: string): string {
    const resolved = resolve(rootDir, relativePath)
    const rel = relative(rootDir, resolved)
    if (rel.startsWith('..') || resolve(rootDir, rel) !== resolved) {
      throw new ValidationError(`Path traversal detected: ${relativePath}`)
    }
    return resolved
  }

  function ensureDirs(): void {
    mkdirSync(rootDir, { recursive: true })
    mkdirSync(dailyDir, { recursive: true })
  }

  /** Atomic write: write to temp, then rename */
  function atomicWrite(filePath: string, content: string): void {
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })
    const tmpPath = join(dir, `.tmp-${randomUUID()}`)
    try {
      writeFileSync(tmpPath, content, 'utf-8')
      renameSync(tmpPath, filePath)
    } catch (err) {
      // Clean up temp file on failure
      try {
        unlinkSync(tmpPath)
      } catch {
        /* already gone */
      }
      throw err
    }
  }

  /**
   * Append-only write (O_APPEND). Safe for concurrent writers across processes:
   * the kernel positions each write at end-of-file, so no writer can clobber
   * another's entry and no rename is involved. Never use `atomicWrite` to append.
   */
  function appendRaw(filePath: string, text: string): void {
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, text, 'utf-8')
  }

  function read(relativePath: string): VaultFile | null {
    const fullPath = safePath(relativePath)
    if (!existsSync(fullPath)) return null
    const stat = statSync(fullPath)
    return {
      path: relativePath,
      content: readFileSync(fullPath, 'utf-8'),
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
    }
  }

  function write(relativePath: string, content: string): VaultFile {
    ensureDirs()
    const fullPath = safePath(relativePath)
    atomicWrite(fullPath, content)
    const stat = statSync(fullPath)
    return {
      path: relativePath,
      content,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
    }
  }

  function append(relativePath: string, content: string): VaultFile {
    ensureDirs()
    const fullPath = safePath(relativePath)
    appendRaw(fullPath, content)
    const stat = statSync(fullPath)
    return {
      path: relativePath,
      content: readFileSync(fullPath, 'utf-8'),
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
    }
  }

  function remove(relativePath: string): boolean {
    const fullPath = safePath(relativePath)
    if (!existsSync(fullPath)) return false
    unlinkSync(fullPath)
    return true
  }

  /**
   * Append a timestamped entry to today's daily log.
   *
   * Hot path: every observation from every observer in every live broker lands
   * here. It appends in place rather than reading the file back, so cost does
   * not grow with the size of the log.
   */
  function appendDailyLog(entry: string, date?: Date): void {
    const d = date ?? new Date()
    const dateStr = d.toISOString().slice(0, 10)
    const timestamp = d.toISOString().slice(11, 19)
    const logPath = join('daily', `${dateStr}.md`)
    const line = `\n## ${timestamp}\n\n${entry}\n`
    ensureDirs()
    appendRaw(safePath(logPath), line)
  }

  /** Directories excluded from listing/indexing (archive = "drunk memories", not searchable by default) */
  const EXCLUDED_DIRS = new Set(['archive'])

  /** List all markdown files in the vault recursively, excluding archive */
  function listFiles(dir: string = rootDir, prefix: string = ''): VaultFile[] {
    const results: VaultFile[] = []
    if (!existsSync(dir)) return results

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue
        results.push(...listFiles(join(dir, entry.name), relativePath))
      } else if (entry.name.endsWith('.md')) {
        const fullPath = join(dir, entry.name)
        const stat = statSync(fullPath)
        results.push({
          path: relativePath,
          content: readFileSync(fullPath, 'utf-8'),
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size,
        })
      }
    }
    return results
  }

  return {
    read,
    write,
    append,
    remove,
    appendDailyLog,
    listFiles,
    ensureDirs,
    rootDir,
  }
}

export type Vault = ReturnType<typeof createVault>
