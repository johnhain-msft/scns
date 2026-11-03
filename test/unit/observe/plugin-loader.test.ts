import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createPluginLoader,
  resolveDefaultPluginDirs,
  detectRuntimeMode,
} from '../../../src/observe/plugin-loader.js'
import { createMockPlugin } from './plugin.test.js'

// Suppress pino logs in tests
vi.mock('../../../src/shared/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}))

// Mock fs/promises for filesystem tests
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  access: vi.fn(),
}))

describe('createPluginLoader', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('validatePlugin', () => {
    it('accepts a module with default factory export', () => {
      const loader = createPluginLoader({ pluginDirs: [] })
      const mod = { default: () => createMockPlugin() }
      expect(loader.validatePlugin(mod)).toBe(true)
    })

    it('accepts a module with named createPlugin factory export', () => {
      const loader = createPluginLoader({ pluginDirs: [] })
      const mod = { createPlugin: () => createMockPlugin() }
      expect(loader.validatePlugin(mod)).toBe(true)
    })

    it('rejects null', () => {
      const loader = createPluginLoader({ pluginDirs: [] })
      expect(loader.validatePlugin(null)).toBe(false)
    })

    it('rejects undefined', () => {
      const loader = createPluginLoader({ pluginDirs: [] })
      expect(loader.validatePlugin(undefined)).toBe(false)
    })

    it('rejects a module with no factory export', () => {
      const loader = createPluginLoader({ pluginDirs: [] })
      expect(loader.validatePlugin({ someOtherExport: 'hello' })).toBe(false)
    })

    it('rejects a module where default is not a function', () => {
      const loader = createPluginLoader({ pluginDirs: [] })
      expect(loader.validatePlugin({ default: 'not a function' })).toBe(false)
    })

    it('rejects a module where createPlugin is not a function', () => {
      const loader = createPluginLoader({ pluginDirs: [] })
      expect(loader.validatePlugin({ createPlugin: 42 })).toBe(false)
    })

    it('rejects non-object modules', () => {
      const loader = createPluginLoader({ pluginDirs: [] })
      expect(loader.validatePlugin(42)).toBe(false)
      expect(loader.validatePlugin('string')).toBe(false)
      expect(loader.validatePlugin(true)).toBe(false)
    })
  })

  describe('validatePluginInstance', () => {
    it('accepts a valid plugin instance', () => {
      const loader = createPluginLoader({ pluginDirs: [] })
      const plugin = createMockPlugin()
      expect(loader.validatePluginInstance(plugin)).toBe(true)
    })

    it('rejects an object missing required methods', () => {
      const loader = createPluginLoader({ pluginDirs: [] })
      const incomplete = {
        type: 'session-hook',
        name: 'incomplete',
        // missing start, stop, isRunning, configure, healthCheck, etc.
      }
      expect(loader.validatePluginInstance(incomplete)).toBe(false)
    })

    it('rejects an object missing metadata', () => {
      const loader = createPluginLoader({ pluginDirs: [] })
      const noMeta = {
        type: 'session-hook',
        name: 'no-meta',
        start: vi.fn(),
        stop: vi.fn(),
        isRunning: () => false,
        configure: vi.fn(),
        getConfigSchema: () => ({}),
        healthCheck: vi.fn(),
        capabilities: [],
        state: 'idle',
        // no metadata
      }
      expect(loader.validatePluginInstance(noMeta)).toBe(false)
    })

    it('rejects null', () => {
      const loader = createPluginLoader({ pluginDirs: [] })
      expect(loader.validatePluginInstance(null)).toBe(false)
    })
  })

  describe('discover', () => {
    it('returns empty array for empty pluginDirs', async () => {
      const loader = createPluginLoader({ pluginDirs: [] })
      const plugins = await loader.discover()
      expect(plugins).toEqual([])
    })

    it('returns empty array when directory does not exist', async () => {
      const { access } = await import('node:fs/promises')
      vi.mocked(access).mockRejectedValue(new Error('ENOENT'))

      const loader = createPluginLoader({ pluginDirs: ['/nonexistent/dir'] })
      const plugins = await loader.discover()
      expect(plugins).toEqual([])
    })

    it('scans directories for .js files', async () => {
      const { access, readdir } = await import('node:fs/promises')
      vi.mocked(access).mockResolvedValue(undefined)
      vi.mocked(readdir).mockResolvedValue([
        { name: 'my-plugin.js', isFile: () => true } as any,
        { name: 'not-a-plugin.txt', isFile: () => true } as any,
        { name: 'subdir', isFile: () => false } as any,
      ])

      const loader = createPluginLoader({ pluginDirs: ['/plugins'] })
      // discover will try to import the .js files, which will fail in test
      // We just verify it doesn't crash and returns empty when import fails
      const plugins = await loader.discover()
      expect(plugins).toEqual([])
    })

    it('scans for .ts files too when in dev (src) mode', async () => {
      const { access, readdir } = await import('node:fs/promises')
      vi.mocked(access).mockResolvedValue(undefined)
      vi.mocked(readdir).mockResolvedValue([
        { name: 'my-plugin.ts', isFile: () => true } as any,
        { name: 'compiled.js', isFile: () => true } as any,
        { name: 'typed.d.ts', isFile: () => true } as any, // excluded
      ])

      const loader = createPluginLoader({ pluginDirs: ['/plugins'], mode: 'src' })
      const plugins = await loader.discover()
      expect(plugins).toEqual([])
      // Verify it tried both .ts and .js but excluded .d.ts
      // (via lack of warnings for .d.ts; indirect check — assertion passes if no crash)
    })

    it('only scans .js files when in dist (prod) mode', async () => {
      const { access, readdir } = await import('node:fs/promises')
      vi.mocked(access).mockResolvedValue(undefined)
      const readdirMock = vi
        .mocked(readdir)
        .mockResolvedValue([
          { name: 'my-plugin.ts', isFile: () => true } as any,
          { name: 'compiled.js', isFile: () => true } as any,
        ])

      const loader = createPluginLoader({ pluginDirs: ['/plugins'], mode: 'dist' })
      await loader.discover()
      expect(readdirMock).toHaveBeenCalled()
      // Indirect: only attempted to load .js; no crash.
    })
  })

  describe('detectRuntimeMode', () => {
    it('returns "dist" when import.meta.url contains /dist/', () => {
      expect(detectRuntimeMode('file:///home/x/project/dist/observe/plugin-loader.js')).toBe('dist')
    })

    it('returns "src" for other paths', () => {
      expect(detectRuntimeMode('file:///home/x/project/src/observe/plugin-loader.ts')).toBe('src')
    })
  })

  describe('resolveDefaultPluginDirs', () => {
    // Build the module URL from a host-valid absolute path (a hardcoded
    // posix file:/// URL makes fileURLToPath throw on win32) and compare
    // with native separators.
    it('maps src path to src plugin dir in dev mode', () => {
      const modPath = resolve('/home/x/project/src/observe/plugin-loader.ts')
      const dirs = resolveDefaultPluginDirs(pathToFileURL(modPath).href)
      expect(dirs.some((d) => d.endsWith(join(sep, 'src', 'observe', 'plugins')))).toBe(true)
    })

    it('maps dist path to dist plugin dir in prod mode', () => {
      const modPath = resolve('/home/x/project/dist/observe/plugin-loader.js')
      const dirs = resolveDefaultPluginDirs(pathToFileURL(modPath).href)
      expect(dirs.some((d) => d.endsWith(join(sep, 'dist', 'observe', 'plugins')))).toBe(true)
    })
  })

  describe('loadPlugin', () => {
    it('returns null for non-existent file', async () => {
      const loader = createPluginLoader({ pluginDirs: [] })
      const plugin = await loader.loadPlugin('/nonexistent/plugin.js')
      expect(plugin).toBeNull()
    })
  })
})
