/**
 * Platform-specific backends for browser-tab observation.
 *
 * Each backend knows how to retrieve the active browser tab information
 * (browser name, tab title, optional URL) on its platform.
 */

import type { CommandExecutor } from '../command-executor.js'
import { logger } from '../../shared/logger.js'

export type Platform = 'darwin' | 'linux' | 'wsl' | 'win32'

export interface BrowserTabInfo {
  readonly browser: string
  readonly title: string
  readonly url?: string
}

export interface BrowserTabsBackend {
  poll(executor: CommandExecutor): Promise<readonly BrowserTabInfo[]>
}

// ---------------------------------------------------------------------------
// macOS — AppleScript via osascript + pgrep
// ---------------------------------------------------------------------------

interface DarwinBrowserDef {
  readonly name: string
  readonly processName: string
  readonly script: string
}

const DARWIN_BROWSERS: readonly DarwinBrowserDef[] = [
  {
    name: 'Google Chrome',
    processName: 'Google Chrome',
    script: 'tell application "Google Chrome" to get {URL, title} of active tab of front window',
  },
  {
    name: 'Safari',
    processName: 'Safari',
    script: 'tell application "Safari" to get {URL, name} of current tab of front window',
  },
  {
    name: 'Arc',
    processName: 'Arc',
    script: 'tell application "Arc" to get {URL, title} of active tab of front window',
  },
]

function parseDarwinTabOutput(stdout: string): { url: string; title: string } | null {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return null

  const commaIdx = trimmed.indexOf(', ')
  if (commaIdx <= 0) return null

  const url = trimmed.slice(0, commaIdx).trim()
  const title = trimmed.slice(commaIdx + 2).trim()

  if (url.length === 0) return null
  return { url, title }
}

export function createDarwinBrowserBackend(): BrowserTabsBackend {
  return {
    async poll(executor) {
      const results: BrowserTabInfo[] = []

      for (const browser of DARWIN_BROWSERS) {
        const running = await executor.execute('pgrep', ['-x', browser.processName])
        if (running.exitCode !== 0 || running.stdout.trim().length === 0) continue

        const result = await executor.execute('osascript', ['-e', browser.script])
        if (result.exitCode !== 0) continue

        const parsed = parseDarwinTabOutput(result.stdout)
        if (parsed === null) continue

        results.push({
          browser: browser.name,
          title: parsed.title,
          url: parsed.url,
        })
      }

      return results
    },
  }
}

// ---------------------------------------------------------------------------
// Linux X11 — active window title parsing
// ---------------------------------------------------------------------------

interface LinuxBrowserPattern {
  readonly name: string
  readonly suffix: string
}

const LINUX_BROWSER_PATTERNS: readonly LinuxBrowserPattern[] = [
  { name: 'Google Chrome', suffix: ' - Google Chrome' },
  { name: 'Chromium', suffix: ' - Chromium' },
  { name: 'Mozilla Firefox', suffix: ' — Mozilla Firefox' },
  { name: 'Firefox', suffix: ' — Firefox' },
  { name: 'Brave', suffix: ' - Brave' },
]

export function createLinuxBrowserBackend(): BrowserTabsBackend {
  const log = logger.child({ backend: 'browser-tabs-linux' })
  let warned = false

  return {
    async poll(executor) {
      const titleResult = await executor.execute('xdotool', ['getactivewindow', 'getwindowname'])

      if (titleResult.exitCode !== 0) {
        if (!warned) {
          log.warn('xdotool not available — browser-tab observation disabled on this platform')
          warned = true
        }
        return []
      }

      const windowTitle = titleResult.stdout.trim()
      if (windowTitle.length === 0) return []

      for (const pattern of LINUX_BROWSER_PATTERNS) {
        if (windowTitle.endsWith(pattern.suffix)) {
          const tabTitle = windowTitle.slice(0, -pattern.suffix.length)
          return [{ browser: pattern.name, title: tabTitle }]
        }
      }

      return []
    },
  }
}

// ---------------------------------------------------------------------------
// Noop — returns empty array (WSL, win32)
// ---------------------------------------------------------------------------

export function createNoopBrowserBackend(): BrowserTabsBackend {
  return {
    async poll() {
      return []
    },
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBrowserTabsBackend(platform: Platform): BrowserTabsBackend {
  switch (platform) {
    case 'darwin':
      return createDarwinBrowserBackend()
    case 'linux':
      return createLinuxBrowserBackend()
    default:
      return createNoopBrowserBackend()
  }
}
