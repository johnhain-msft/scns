import { describe, it, expect } from 'vitest'
import {
  detectPlatform,
  findCli,
  isTmuxAvailable,
  toWslPath,
} from '../../../../src/broker/services/platform.js'
import type { PlatformDeps } from '../../../../src/broker/services/platform.js'

describe('Platform Detection', () => {
  describe('detectPlatform', () => {
    it('returns darwin on macOS', () => {
      const result = detectPlatform({ processPlatform: 'darwin' })
      expect(result).toBe('darwin')
    })

    it('returns win32 on Windows', () => {
      const result = detectPlatform({ processPlatform: 'win32' })
      expect(result).toBe('win32')
    })

    it('returns linux on plain Linux', () => {
      const result = detectPlatform({
        processPlatform: 'linux',
        readFileSync: () => 'Linux version 5.15.0',
      })
      expect(result).toBe('linux')
    })

    it('returns wsl when /proc/version contains microsoft', () => {
      const result = detectPlatform({
        processPlatform: 'linux',
        readFileSync: () => 'Linux version 5.15.0-microsoft-standard-WSL2',
      })
      expect(result).toBe('wsl')
    })

    it('returns linux when /proc/version is unreadable', () => {
      const result = detectPlatform({
        processPlatform: 'linux',
        readFileSync: () => {
          throw new Error('ENOENT')
        },
      })
      expect(result).toBe('linux')
    })

    it('returns a valid Platform type', () => {
      const validPlatforms = ['darwin', 'linux', 'win32', 'wsl']
      const result = detectPlatform()
      expect(validPlatforms).toContain(result)
    })
  })

  describe('findCli', () => {
    const makeExecSync = (available: ReadonlyArray<string>) =>
      ((cmd: string) => {
        for (const cli of available) {
          if (cmd.includes(cli)) return Buffer.from(`/usr/bin/${cli}`)
        }
        throw new Error('not found')
      }) as PlatformDeps['execSync']

    it('returns copilot when available', () => {
      const result = findCli('darwin', { execSync: makeExecSync(['copilot']) })
      expect(result).not.toBeNull()
      expect(result!.command).toBe('copilot')
    })

    it('returns claude when copilot is unavailable', () => {
      const result = findCli('darwin', { execSync: makeExecSync(['claude']) })
      expect(result).not.toBeNull()
      expect(result!.command).toBe('claude')
    })

    it('prefers copilot over claude', () => {
      const result = findCli('darwin', { execSync: makeExecSync(['copilot', 'claude']) })
      expect(result).not.toBeNull()
      expect(result!.command).toBe('copilot')
    })

    it('returns null when no CLI is available', () => {
      const result = findCli('darwin', { execSync: makeExecSync([]) })
      expect(result).toBeNull()
    })

    it('returns CliInfo shape with command field', () => {
      const result = findCli('linux', { execSync: makeExecSync(['copilot']) })
      expect(result).toHaveProperty('command')
    })
  })

  describe('isTmuxAvailable', () => {
    it('returns true when tmux is installed', () => {
      const result = isTmuxAvailable({
        processPlatform: 'darwin',
        execSync: () => Buffer.from('/usr/bin/tmux'),
      })
      expect(result).toBe(true)
    })

    it('returns false when tmux is not installed', () => {
      const result = isTmuxAvailable({
        processPlatform: 'darwin',
        execSync: () => {
          throw new Error('not found')
        },
      })
      expect(result).toBe(false)
    })

    it('returns false on Windows regardless', () => {
      const result = isTmuxAvailable({
        processPlatform: 'win32',
        execSync: () => Buffer.from('/usr/bin/tmux'),
      })
      expect(result).toBe(false)
    })

    it('returns a boolean', () => {
      const result = isTmuxAvailable({
        processPlatform: 'darwin',
        execSync: () => {
          throw new Error('not found')
        },
      })
      expect(typeof result).toBe('boolean')
    })
  })

  describe('toWslPath', () => {
    it('converts Windows backslash paths', () => {
      expect(toWslPath('C:\\Users\\foo\\bar')).toBe('/mnt/c/Users/foo/bar')
    })

    it('converts Windows forward-slash paths', () => {
      expect(toWslPath('D:/Projects/code')).toBe('/mnt/d/Projects/code')
    })

    it('lowercases the drive letter', () => {
      expect(toWslPath('E:\\test')).toBe('/mnt/e/test')
    })

    it('passes POSIX paths through unchanged', () => {
      expect(toWslPath('/home/user/code')).toBe('/home/user/code')
    })

    it('passes relative paths through unchanged', () => {
      expect(toWslPath('relative/path')).toBe('relative/path')
    })
  })
})
