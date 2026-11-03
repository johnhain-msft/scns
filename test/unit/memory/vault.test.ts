import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createVault } from '../../../src/memory/vault.js'

describe('Vault', () => {
  let rootDir: string
  let vault: ReturnType<typeof createVault>

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'scns-vault-test-'))
    vault = createVault({ rootDir })
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  describe('write + read', () => {
    it('writes and reads a file', () => {
      vault.write('SOUL.md', '# Soul\nI am SCNS.')
      const file = vault.read('SOUL.md')
      expect(file).not.toBeNull()
      expect(file!.content).toBe('# Soul\nI am SCNS.')
      expect(file!.path).toBe('SOUL.md')
      expect(file!.sizeBytes).toBeGreaterThan(0)
      expect(file!.mtimeMs).toBeGreaterThan(0)
    })

    it('returns null for non-existent file', () => {
      expect(vault.read('NONEXISTENT.md')).toBeNull()
    })

    it('overwrites existing file', () => {
      vault.write('USER.md', 'v1')
      vault.write('USER.md', 'v2')
      expect(vault.read('USER.md')!.content).toBe('v2')
    })
  })

  describe('append', () => {
    it('appends to existing file', () => {
      vault.write('MEMORY.md', 'line1\n')
      vault.append('MEMORY.md', 'line2\n')
      expect(vault.read('MEMORY.md')!.content).toBe('line1\nline2\n')
    })

    it('creates file if it does not exist', () => {
      vault.append('NEW.md', 'hello')
      expect(vault.read('NEW.md')!.content).toBe('hello')
    })
  })

  describe('remove', () => {
    it('removes an existing file', () => {
      vault.write('TEMP.md', 'temporary')
      expect(vault.remove('TEMP.md')).toBe(true)
      expect(vault.read('TEMP.md')).toBeNull()
    })

    it('returns false for non-existent file', () => {
      expect(vault.remove('NOPE.md')).toBe(false)
    })
  })

  describe('appendDailyLog', () => {
    it('creates a dated log file', () => {
      const date = new Date('2026-04-04T14:30:00Z')
      vault.appendDailyLog('Test entry', date)
      const log = vault.read('daily/2026-04-04.md')
      expect(log).not.toBeNull()
      expect(log!.content).toContain('## 14:30:00')
      expect(log!.content).toContain('Test entry')
    })

    it('appends multiple entries to same day', () => {
      const date1 = new Date('2026-04-04T10:00:00Z')
      const date2 = new Date('2026-04-04T11:00:00Z')
      vault.appendDailyLog('Entry 1', date1)
      vault.appendDailyLog('Entry 2', date2)
      const log = vault.read('daily/2026-04-04.md')!
      expect(log.content).toContain('Entry 1')
      expect(log.content).toContain('Entry 2')
      expect(log.content).toContain('## 10:00:00')
      expect(log.content).toContain('## 11:00:00')
    })
  })

  describe('listFiles', () => {
    it('lists all markdown files recursively', () => {
      vault.write('SOUL.md', 'soul')
      vault.write('USER.md', 'user')
      vault.appendDailyLog('log', new Date('2026-04-04T12:00:00Z'))
      const files = vault.listFiles()
      const paths = files.map((f) => f.path)
      expect(paths).toContain('SOUL.md')
      expect(paths).toContain('USER.md')
      expect(paths).toContain('daily/2026-04-04.md')
    })

    it('returns empty array for empty vault', () => {
      expect(vault.listFiles()).toEqual([])
    })

    it('excludes archive directory from listing', () => {
      vault.write('MEMORY.md', 'memory')
      vault.write('archive/old-lesson.md', 'archived content')
      vault.write('archive/another.md', 'more archived')
      const files = vault.listFiles()
      const paths = files.map((f) => f.path)
      expect(paths).toContain('MEMORY.md')
      expect(paths).not.toContain('archive/old-lesson.md')
      expect(paths).not.toContain('archive/another.md')
    })
  })

  describe('atomic writes', () => {
    it('does not leave partial files on error', () => {
      vault.write('SAFE.md', 'original content')
      // Verify the file was written atomically (no tmp files left)
      const entries = readdirSync(rootDir) as string[]
      const tmpFiles = entries.filter((e: string) => e.startsWith('.tmp-'))
      expect(tmpFiles).toHaveLength(0)
    })
  })

  describe('path traversal protection', () => {
    it('rejects read with ../', () => {
      expect(() => vault.read('../../../etc/passwd')).toThrow('Path traversal detected')
    })

    it('rejects write with ../', () => {
      expect(() => vault.write('../../escape.md', 'evil')).toThrow('Path traversal detected')
    })

    it('rejects append with ../', () => {
      expect(() => vault.append('../escape.md', 'evil')).toThrow('Path traversal detected')
    })

    it('rejects remove with ../', () => {
      expect(() => vault.remove('../../escape.md')).toThrow('Path traversal detected')
    })

    it('allows valid nested paths', () => {
      const result = vault.write('subdir/nested/file.md', 'content')
      expect(result.path).toBe('subdir/nested/file.md')
      expect(result.content).toBe('content')
    })
  })
})
