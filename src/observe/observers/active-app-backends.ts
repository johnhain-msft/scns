/**
 * Platform-specific backends for active-app observation.
 *
 * Each backend knows how to retrieve the currently focused application name
 * and window title on its platform.
 */

import type { CommandExecutor } from '../command-executor.js'
import { logger } from '../../shared/logger.js'

export type Platform = 'darwin' | 'linux' | 'wsl' | 'win32'

export interface ActiveAppInfo {
  readonly appName: string
  readonly windowTitle: string
}

export interface ActiveAppBackend {
  poll(executor: CommandExecutor): Promise<ActiveAppInfo | null>
}

// ---------------------------------------------------------------------------
// macOS — AppleScript via osascript
// ---------------------------------------------------------------------------

const GET_APP_SCRIPT =
  'tell application "System Events" to get name of first application process whose frontmost is true'
const GET_TITLE_SCRIPT =
  'tell application "System Events" to get title of front window of first application process whose frontmost is true'

export function createDarwinBackend(): ActiveAppBackend {
  return {
    async poll(executor) {
      const appResult = await executor.execute('osascript', ['-e', GET_APP_SCRIPT])
      const appName = appResult.stdout.trim()

      if (appResult.exitCode !== 0 || appName.length === 0) return null

      let windowTitle = ''
      const titleResult = await executor.execute('osascript', ['-e', GET_TITLE_SCRIPT])
      if (titleResult.exitCode === 0) {
        windowTitle = titleResult.stdout.trim()
      }

      return { appName, windowTitle }
    },
  }
}

// ---------------------------------------------------------------------------
// Linux X11 — xdotool
// ---------------------------------------------------------------------------

export function createLinuxBackend(): ActiveAppBackend {
  const log = logger.child({ backend: 'active-app-linux' })
  let warned = false

  return {
    async poll(executor) {
      const titleResult = await executor.execute('xdotool', ['getactivewindow', 'getwindowname'])

      if (titleResult.exitCode !== 0) {
        if (!warned) {
          log.warn('xdotool not available — active-app observation disabled on this platform')
          warned = true
        }
        return null
      }

      const windowTitle = titleResult.stdout.trim()
      if (windowTitle.length === 0) return null

      // Resolve application name via PID → /proc/<pid>/comm
      const pidResult = await executor.execute('xdotool', ['getactivewindow', 'getwindowpid'])

      let appName = windowTitle // fallback
      if (pidResult.exitCode === 0) {
        const pid = pidResult.stdout.trim()
        if (pid.length > 0) {
          const commResult = await executor.execute('cat', [`/proc/${pid}/comm`])
          if (commResult.exitCode === 0 && commResult.stdout.trim().length > 0) {
            appName = commResult.stdout.trim()
          }
        }
      }

      return { appName, windowTitle }
    },
  }
}

// ---------------------------------------------------------------------------
// WSL — best-effort via powershell.exe
// ---------------------------------------------------------------------------

export function createWslBackend(): ActiveAppBackend {
  const log = logger.child({ backend: 'active-app-wsl' })
  let warned = false

  return {
    async poll(executor) {
      const result = await executor.execute('powershell.exe', [
        '-NoProfile',
        '-Command',
        '(Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -First 1).ProcessName',
      ])

      if (result.exitCode !== 0) {
        if (!warned) {
          log.warn('powershell.exe not available — active-app observation disabled in WSL')
          warned = true
        }
        return null
      }

      const appName = result.stdout.trim()
      if (appName.length === 0) return null

      const titleResult = await executor.execute('powershell.exe', [
        '-NoProfile',
        '-Command',
        '(Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -First 1).MainWindowTitle',
      ])
      const windowTitle = titleResult.exitCode === 0 ? titleResult.stdout.trim() : ''

      return { appName, windowTitle }
    },
  }
}

// ---------------------------------------------------------------------------
// Noop — always returns null (unsupported platform fallback)
// ---------------------------------------------------------------------------

export function createNoopBackend(): ActiveAppBackend {
  return {
    async poll() {
      return null
    },
  }
}

// ---------------------------------------------------------------------------
// Factory — select backend by detected platform
// ---------------------------------------------------------------------------

export function createActiveAppBackend(platform: Platform): ActiveAppBackend {
  switch (platform) {
    case 'darwin':
      return createDarwinBackend()
    case 'linux':
      return createLinuxBackend()
    case 'wsl':
      return createWslBackend()
    default:
      return createNoopBackend()
  }
}
