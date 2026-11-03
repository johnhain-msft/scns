/**
 * Terminal history observer — watches shell history files for new entries.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Observer, ObserverState } from '../observer.js'
import { ObservationType, type Observation, type ObserverConfig } from '../types.js'
import type { createSecretSanitizer } from '../secret-sanitizer.js'
import type { createDailyLogWriter } from '../daily-log-writer.js'
import type { createPrivacyFilter } from '../privacy-filter.js'
import { buildTags } from '../tags.js'
import { logger } from '../../shared/logger.js'

const MAX_LINES_PER_BATCH = 50
const MAX_INITIAL_LINES = 100
const HARMLESS_COMMANDS = new Set(['ls', 'cd', 'pwd', 'clear', 'exit', 'history'])

function getDefaultHistoryPaths(): string[] {
  const home = homedir()
  const paths = [join(home, '.zsh_history'), join(home, '.bash_history')]
  // PowerShell history on Windows/WSL
  const psHistoryPath =
    process.platform === 'win32'
      ? join(
          home,
          'AppData',
          'Roaming',
          'Microsoft',
          'Windows',
          'PowerShell',
          'PSReadLine',
          'ConsoleHost_history.txt',
        )
      : join(home, '.local', 'share', 'powershell', 'PSReadLine', 'ConsoleHost_history.txt')
  paths.push(psHistoryPath)
  return paths
}

export interface FileStatReader {
  stat(path: string): { mtimeMs: number } | null
  readLines(path: string, fromLine: number): string[]
  lineCount(path: string): number
}

export function createFileStatReader(): FileStatReader {
  return {
    stat(path: string) {
      try {
        const s = statSync(path)
        return { mtimeMs: s.mtimeMs }
      } catch {
        return null
      }
    },
    readLines(path: string, fromLine: number) {
      try {
        const content = readFileSync(path, 'utf-8')
        return content.split('\n').slice(fromLine)
      } catch {
        return []
      }
    },
    lineCount(path: string) {
      try {
        const content = readFileSync(path, 'utf-8')
        return content.split('\n').length
      } catch {
        return 0
      }
    },
  }
}

export interface TerminalHistoryObserverOptions {
  readonly fileReader?: FileStatReader
  readonly sanitizer: ReturnType<typeof createSecretSanitizer>
  readonly logWriter: ReturnType<typeof createDailyLogWriter>
  readonly privacyFilter: ReturnType<typeof createPrivacyFilter>
  readonly config: ObserverConfig
  readonly intervalMs?: number
  readonly historyPaths?: readonly string[]
}

function detectShellType(path: string): string {
  if (path.includes('zsh')) return 'zsh'
  if (path.includes('bash')) return 'bash'
  if (path.includes('fish')) return 'fish'
  return 'shell'
}

function isHarmlessCommand(line: string): boolean {
  const trimmed = line.trim()
  return HARMLESS_COMMANDS.has(trimmed)
}

function filterLines(
  lines: readonly string[],
  sanitizer: ReturnType<typeof createSecretSanitizer>,
): string[] {
  return lines
    .filter((l) => l.trim().length > 0)
    .filter((l) => !isHarmlessCommand(l))
    .map((l) => sanitizer.sanitize(l))
}

function batchLines(lines: readonly string[], maxPerBatch: number): string[][] {
  const batches: string[][] = []
  for (let i = 0; i < lines.length; i += maxPerBatch) {
    batches.push(lines.slice(i, i + maxPerBatch))
  }
  return batches
}

export function createTerminalHistoryObserver(
  options: TerminalHistoryObserverOptions,
): Observer & { poll(): Promise<Observation[]> } {
  const {
    sanitizer,
    logWriter,
    privacyFilter,
    intervalMs = 60_000,
    historyPaths = getDefaultHistoryPaths(),
  } = options

  const fileReader = options.fileReader ?? createFileStatReader()
  const fileState = new Map<string, { lastMtime: number; lastLineCount: number }>()
  let state: ObserverState = 'idle'
  let timer: ReturnType<typeof setInterval> | null = null

  // Filter DEFAULT history paths to those that exist on this platform.
  // Caller-supplied paths are explicit intent and are watched as-is — on
  // win32 the old unconditional filter silently dropped injected fixture
  // paths that happened to be named like zsh/bash history files.
  const validPaths =
    options.historyPaths !== undefined
      ? [...historyPaths]
      : historyPaths.filter((p) => {
          if (process.platform !== 'linux' && process.platform !== 'darwin') {
            // On non-Unix platforms, only keep PowerShell history paths
            if (p.includes('.zsh_history') || p.includes('.bash_history')) return false
          }
          return true
        })

  function pollFile(path: string): Observation[] {
    const stat = fileReader.stat(path)
    if (!stat) {
      logger.warn({ path }, 'History file not found')
      return []
    }

    const prev = fileState.get(path)
    const totalLines = fileReader.lineCount(path)

    if (prev && stat.mtimeMs === prev.lastMtime) {
      return []
    }

    let fromLine: number
    if (prev) {
      fromLine = prev.lastLineCount
    } else {
      // First poll: read only last MAX_INITIAL_LINES
      fromLine = Math.max(0, totalLines - MAX_INITIAL_LINES)
    }

    fileState.set(path, { lastMtime: stat.mtimeMs, lastLineCount: totalLines })

    const rawLines = fileReader.readLines(path, fromLine)
    const filtered = filterLines(rawLines, sanitizer)
    if (filtered.length === 0) return []

    const shellType = detectShellType(path)
    const batches = batchLines(filtered, MAX_LINES_PER_BATCH)

    return batches.map((batch) => {
      const observation: Observation = {
        id: randomUUID(),
        type: ObservationType.TerminalHistory,
        timestamp: new Date().toISOString(),
        source: shellType,
        content: batch.join('\n'),
        tags: buildTags(ObservationType.TerminalHistory, shellType),
      }
      logWriter.write(observation)
      return observation
    })
  }

  async function poll(): Promise<Observation[]> {
    const results: Observation[] = []
    for (const path of validPaths) {
      results.push(...pollFile(path))
    }
    return results
  }

  return {
    type: ObservationType.TerminalHistory,
    name: 'terminal-history',

    start() {
      if (!privacyFilter.isTerminalAllowed()) {
        logger.info('Terminal history observer requires opt-in — skipping')
        return
      }
      if (state === 'running') return
      state = 'running'
      timer = setInterval(() => {
        void poll()
      }, intervalMs)
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      state = 'idle'
    },

    isRunning() {
      return state === 'running'
    },

    poll,
  }
}
