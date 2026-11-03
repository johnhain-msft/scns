import { readFileSync as fsReadFileSync } from 'node:fs'
import { execSync as cpExecSync } from 'node:child_process'

export type Platform = 'darwin' | 'linux' | 'win32' | 'wsl'

export interface CliInfo {
  readonly command: string
  readonly version?: string
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

  if (processPlatform === 'win32') return 'win32'
  if (processPlatform === 'darwin') return 'darwin'

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
  darwin: ['copilot', 'claude'],
  wsl: ['copilot', 'claude', 'copilot.exe', 'claude.exe'],
  win32: ['copilot.cmd', 'copilot.exe', 'copilot', 'claude.exe', 'claude'],
}

function whichCommand(candidate: string, platform: Platform): string {
  if (platform === 'win32') return `where ${candidate}`
  return `command -v ${candidate}`
}

export function findCli(platform: Platform, deps?: Partial<PlatformDeps>): CliInfo | null {
  const { execSync } = { ...defaultDeps, ...deps }
  const candidates = CLI_CANDIDATES[platform]

  for (const candidate of candidates) {
    try {
      execSync(whichCommand(candidate, platform))
      const version = tryGetVersion(candidate, execSync)
      return { command: candidate, version: version ?? undefined }
    } catch {
      // not found, try next
    }
  }

  return null
}

function tryGetVersion(command: string, execSync: (cmd: string) => Buffer): string | null {
  try {
    const output = execSync(`${command} --version`)
    return output.toString().trim() || null
  } catch {
    return null
  }
}

/**
 * Convert a Windows-style path (e.g. `C:\Users\foo`) to its WSL mount
 * equivalent (`/mnt/c/Users/foo`).  Passes non-Windows paths through unchanged.
 */
export function toWslPath(p: string): string {
  const match = p.match(/^([A-Za-z]):[/\\](.*)$/)
  if (!match) return p
  const drive = match[1]!.toLowerCase()
  const rest = match[2]!.replace(/\\/g, '/')
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
