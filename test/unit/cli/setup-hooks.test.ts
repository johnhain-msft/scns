import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { setupHooks, generateHooksConfig } from '../../../src/cli/setup-hooks.js'

describe('setup-hooks', () => {
  function createMockFs() {
    const files: Record<string, string> = {}
    return {
      files,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn((path: string, content: string) => {
        files[path] = content
      }),
      existsSync: vi.fn((path: string) => path in files),
      readFileSync: vi.fn((path: string) => files[path] ?? ''),
    }
  }

  describe('generateHooksConfig', () => {
    it('generates config with all event hooks', () => {
      const config = generateHooksConfig('http://localhost:3456')

      expect(config.hooks['session-start']).toBeDefined()
      expect(config.hooks['session-end']).toBeDefined()
      expect(config.hooks['tool-use']).toBeDefined()
      expect(config.hooks['pre-compact']).toBeDefined()
      expect(config.hooks['user-prompt']).toBeDefined()
      expect(config.hooks['error']).toBeDefined()
      expect(config.hooks['pre-tool-use']).toBeDefined()
      expect(config.hooks['post-tool-use']).toBeDefined()
    })

    it('uses correct broker URL in commands', () => {
      const config = generateHooksConfig('http://custom:9999')

      for (const hook of Object.values(config.hooks)) {
        expect(hook.command).toContain('http://custom:9999')
      }
    })

    it('includes curl with timeout and silent mode', () => {
      const config = generateHooksConfig('http://localhost:3456')

      for (const hook of Object.values(config.hooks)) {
        expect(hook.command).toContain('curl -s -m 1')
      }
    })

    it('includes error suppression (|| true)', () => {
      const config = generateHooksConfig('http://localhost:3456')

      for (const hook of Object.values(config.hooks)) {
        expect(hook.command).toContain('|| true')
      }
    })

    it('uses COPILOT_SESSION_ID env var', () => {
      const config = generateHooksConfig('http://localhost:3456')
      const cmd = config.hooks['session-start']!.command
      expect(cmd).toContain('$COPILOT_SESSION_ID')
    })

    it('posts correct event type in body', () => {
      const config = generateHooksConfig('http://localhost:3456')
      const cmd = config.hooks['session-start']!.command
      expect(cmd).toContain('session-start')
      expect(cmd).toContain('/api/hooks/session-start')
    })
  })

  describe('setupHooks', () => {
    it('creates hooks config in project directory', () => {
      const fs = createMockFs()
      const result = setupHooks({
        projectDir: '/tmp/project',
        brokerUrl: 'http://localhost:3456',
        fs,
      })

      expect(result.created).toBe(true)
      expect(result.path).toContain('scns-hooks.json')
      expect(result.updated).toBe(false)
      // join(): the CLI builds this path with the native separator.
      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining(join('.github', 'hooks')), {
        recursive: true,
      })
    })

    it('writes valid JSON', () => {
      const fs = createMockFs()
      setupHooks({ projectDir: '/tmp/project', fs })

      const written = fs.writeFileSync.mock.calls[0]![1] as string
      const parsed = JSON.parse(written)
      expect(parsed.hooks).toBeDefined()
      expect(typeof parsed.hooks['session-start'].command).toBe('string')
    })

    it('reports up to date when content is identical', () => {
      const fs = createMockFs()
      setupHooks({ projectDir: '/tmp/project', brokerUrl: 'http://localhost:3456', fs })

      const result = setupHooks({
        projectDir: '/tmp/project',
        brokerUrl: 'http://localhost:3456',
        fs,
      })

      expect(result.updated).toBe(false)
      expect(result.message).toContain('up to date')
    })

    it('reports updated when content changes', () => {
      const fs = createMockFs()
      setupHooks({ projectDir: '/tmp/project', brokerUrl: 'http://localhost:3456', fs })

      // Tamper with file
      const path = Object.keys(fs.files)[0]!
      fs.files[path] = '{"old": true}'

      const result = setupHooks({
        projectDir: '/tmp/project',
        brokerUrl: 'http://localhost:3456',
        fs,
      })

      expect(result.updated).toBe(true)
      expect(result.message).toContain('updated')
    })

    it('uses default broker URL', () => {
      const fs = createMockFs()
      setupHooks({ projectDir: '/tmp/project', fs })

      const written = fs.writeFileSync.mock.calls[0]![1] as string
      expect(written).toContain('http://localhost:3456')
    })
  })
})
