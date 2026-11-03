/**
 * File change observer — watches directories for filesystem changes using native fs.watch.
 */

import { randomUUID } from 'node:crypto'
import { watch as fsWatch } from 'node:fs'
import { extname, join } from 'node:path'
import type { Observer } from '../observer.js'
import { ObservationType } from '../types.js'
import type { Observation, ObserverConfig } from '../types.js'
import { buildTags, formatTag } from '../tags.js'
import type { createDailyLogWriter } from '../daily-log-writer.js'
import type { createPrivacyFilter } from '../privacy-filter.js'
import { logger } from '../../shared/logger.js'

const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.ssh',
  '.hg',
  '.svn',
  '.DS_Store',
  '__pycache__',
  '.next',
  '.turbo',
  'dist',
  // Python / build / tooling dirs whose churn floods the daily logs (e.g. a
  // session's .venv site-packages renames produced ~4,600 useless index chunks).
  '.venv',
  'venv',
  'site-packages',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.gradle',
  'target',
  'build',
  'vendor',
  '.cache',
  'coverage',
])

export interface FileWatcher {
  watch(
    dir: string,
    options: { recursive: boolean },
    callback: (event: string, filename: string | null) => void,
  ): { close(): void }
}

/** Default watcher using native fs.watch */
export function createNativeFileWatcher(): FileWatcher {
  return {
    watch(dir, options, callback) {
      return fsWatch(dir, { recursive: options.recursive }, callback)
    },
  }
}

export interface FileChangeObserverOptions {
  readonly watcher?: FileWatcher
  readonly logWriter: ReturnType<typeof createDailyLogWriter>
  readonly privacyFilter: ReturnType<typeof createPrivacyFilter>
  readonly config: ObserverConfig
  readonly debounceMs?: number
}

function isIgnoredPath(filename: string): boolean {
  // Split on both separators — watcher events carry `\` paths on win32.
  const segments = filename.split(/[\\/]/)
  return segments.some((s) => IGNORED_SEGMENTS.has(s))
}

export function createFileChangeObserver(
  options: FileChangeObserverOptions,
): Observer & { getWatchedDirs(): readonly string[] } {
  const {
    watcher = createNativeFileWatcher(),
    logWriter,
    privacyFilter,
    config,
    debounceMs = 500,
  } = options

  const log = logger.child({ observer: 'file-change' })
  const dirs = config.directories ?? []
  const handles: Array<{ close(): void }> = []
  let running = false
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function createObservation(dir: string, event: string, filename: string): Observation {
    const ext = extname(filename).replace('.', '')
    const tags = buildTags(ObservationType.FileChange, dir)
    if (ext) {
      tags.push(formatTag('ext', ext))
    }

    return {
      id: randomUUID(),
      type: ObservationType.FileChange,
      timestamp: new Date().toISOString(),
      source: dir,
      content: `${event}: ${filename}`,
      tags,
    }
  }

  function handleEvent(dir: string, event: string, filename: string | null): void {
    if (!filename) return
    if (isIgnoredPath(filename)) return

    const fullPath = join(dir, filename)
    if (privacyFilter.isPathExcluded(fullPath)) return

    const key = `${dir}:${filename}`
    const existing = debounceTimers.get(key)
    if (existing !== undefined) {
      clearTimeout(existing)
    }

    debounceTimers.set(
      key,
      setTimeout(() => {
        debounceTimers.delete(key)
        const observation = createObservation(dir, event, filename)
        logWriter.write(observation)
      }, debounceMs),
    )
  }

  return {
    type: ObservationType.FileChange,
    name: 'file-change-observer',

    start(): void {
      if (running || dirs.length === 0) return

      for (const dir of dirs) {
        try {
          const handle = watcher.watch(dir, { recursive: true }, (event, filename) => {
            handleEvent(dir, event, filename)
          })
          handles.push(handle)
        } catch (err) {
          log.error({ err, dir }, 'Failed to watch directory')
        }
      }

      if (handles.length > 0) {
        running = true
      }
    },

    stop(): void {
      for (const handle of handles) {
        handle.close()
      }
      handles.length = 0

      for (const timer of debounceTimers.values()) {
        clearTimeout(timer)
      }
      debounceTimers.clear()

      running = false
    },

    isRunning(): boolean {
      return running
    },

    getWatchedDirs(): readonly string[] {
      return dirs
    },
  }
}
