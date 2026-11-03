import { readFileSync as fsReadFileSync } from 'node:fs'
import { execSync as cpExecSync } from 'node:child_process'

export type Platform = 'wsl' | 'linux' | 'macos' | 'windows'

export interface CliInfo {
  readonly command: string
  readonly isWindowsBinary: boolean
}

export interface PlatformDeps {
  readonly readFileSync: (path: string, encoding: 'utf-8') => string
  readonly execSync: (cmd: string) => Buffer
  readonly processPlatform: NodeJS.Platform
}

const defaultDeps: PlatformDeps = {
  readFileSync: fsReadFileSync,
  execSync: cpExecSync,
  processPlatform: process.platform,
}

export function detectPlatform(deps?: Partial<PlatformDeps>): Platform {
  const { processPlatform, readFileSync } = { ...defaultDeps, ...deps }

  if (processPlatform === 'win32') return 'windows'
  if (processPlatform === 'darwin') return 'macos'

  if (processPlatform === 'linux') {
    try {
      const version = readFileSync('/proc/version', 'utf-8')
      if (/microsoft/i.test(version)) return 'wsl'
    } catch {
      // /proc/version unreadable — fall through to linux
    }
  }

  return 'linux'
}

const CLI_CANDIDATES: Record<Platform, ReadonlyArray<string>> = {
  linux: ['copilot', 'claude'],
  macos: ['copilot', 'claude'],
  wsl: ['copilot', 'claude', 'copilot.exe', 'claude.exe'],
  windows: ['copilot.cmd', 'copilot.exe', 'copilot', 'claude.exe', 'claude'],
}

function isWindowsBinaryOnWsl(command: string, platform: Platform): boolean {
  if (platform !== 'wsl') return false
  return command.endsWith('.exe') || command.endsWith('.cmd')
}

function whichCommand(candidate: string, platform: Platform): string {
  if (platform === 'windows') return `where ${candidate}`
  return `command -v ${candidate}`
}

export function findCli(platform: Platform, deps?: Partial<PlatformDeps>): CliInfo | null {
  const { execSync } = { ...defaultDeps, ...deps }
  const candidates = CLI_CANDIDATES[platform]

  for (const candidate of candidates) {
    try {
      execSync(whichCommand(candidate, platform))
      return {
        command: candidate,
        isWindowsBinary: isWindowsBinaryOnWsl(candidate, platform),
      }
    } catch {
      // not found, try next
    }
  }

  return null
}

/**
 * Convert a Windows-style path (e.g. `C:\Users\foo`) to its WSL mount
 * equivalent (`/mnt/c/Users/foo`).  Passes non-Windows paths through unchanged.
 */
export function toWslPath(p: string): string {
  // Match drive letter paths: C:\..., D:\..., C:/...
  const match = p.match(/^([A-Za-z]):[/\\](.*)$/)
  if (!match) return p
  const drive = match[1].toLowerCase()
  const rest = match[2].replace(/\\/g, '/')
  return `/mnt/${drive}/${rest}`
}

export function isTmuxAvailable(deps?: Partial<PlatformDeps>): boolean {
  const { processPlatform, execSync } = { ...defaultDeps, ...deps }

  if (processPlatform === 'win32') return false

  try {
    execSync('command -v tmux')
    return true
  } catch {
    return false
  }
}
