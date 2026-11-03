import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installExtension, uninstallExtension } from '../../../src/cli/install-extension.js'

describe('install-extension', () => {
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
      rmSync: vi.fn((path: string) => {
        for (const key of Object.keys(files)) {
          if (key.startsWith(path)) delete files[key]
        }
      }),
    }
  }

  describe('installExtension', () => {
    it('installs extension to specified directory', () => {
      const fs = createMockFs()
      const result = installExtension({
        extensionDir: '/tmp/test-ext',
        brokerUrl: 'http://localhost:3456',
        fs,
      })

      expect(result.installed).toBe(true)
      expect(result.path).toContain('extension.mjs')
      expect(result.updated).toBe(false)
      expect(result.message).toContain('installed')
      expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/test-ext', { recursive: true })
      expect(fs.writeFileSync).toHaveBeenCalled()
    })

    it('generates valid extension source with broker URL', () => {
      const fs = createMockFs()
      installExtension({
        extensionDir: '/tmp/test-ext',
        brokerUrl: 'http://custom:9999',
        fs,
      })

      const writtenContent = fs.writeFileSync.mock.calls[0]![1] as string
      expect(writtenContent).toContain('http://custom:9999')
      expect(writtenContent).toContain('joinSession')
      expect(writtenContent).toContain('scns_memory_search')
    })

    it('reports updated=true when extension already exists with different content', () => {
      const fs = createMockFs()

      // First install
      installExtension({ extensionDir: '/tmp/test-ext', brokerUrl: 'http://localhost:3456', fs })

      // Tamper with existing file
      const path = Object.keys(fs.files)[0]!
      fs.files[path] = 'old content'

      // Second install
      const result = installExtension({
        extensionDir: '/tmp/test-ext',
        brokerUrl: 'http://localhost:3456',
        fs,
      })

      expect(result.updated).toBe(true)
      expect(result.message).toContain('updated')
    })

    it('reports up to date when content is identical', () => {
      const fs = createMockFs()

      // First install
      installExtension({ extensionDir: '/tmp/test-ext', brokerUrl: 'http://localhost:3456', fs })

      // Second install with same config
      const result = installExtension({
        extensionDir: '/tmp/test-ext',
        brokerUrl: 'http://localhost:3456',
        fs,
      })

      expect(result.updated).toBe(false)
      expect(result.message).toContain('up to date')
    })

    it('uses default broker URL', () => {
      const fs = createMockFs()
      installExtension({ extensionDir: '/tmp/test-ext', fs })

      const writtenContent = fs.writeFileSync.mock.calls[0]![1] as string
      expect(writtenContent).toContain('http://localhost:3456')
    })

    it('supports custom timeout', () => {
      const fs = createMockFs()
      installExtension({
        extensionDir: '/tmp/test-ext',
        timeoutMs: 1000,
        fs,
      })

      const writtenContent = fs.writeFileSync.mock.calls[0]![1] as string
      expect(writtenContent).toContain('TIMEOUT_MS = 1000')
    })
  })

  describe('uninstallExtension', () => {
    it('removes extension directory', () => {
      const fs = createMockFs()
      fs.files['/tmp/test-ext'] = '' // Mark directory as existing
      fs.files['/tmp/test-ext/extension.mjs'] = 'content'

      const result = uninstallExtension({ extensionDir: '/tmp/test-ext', fs })

      expect(result.removed).toBe(true)
      expect(result.message).toContain('removed')
      expect(fs.rmSync).toHaveBeenCalledWith('/tmp/test-ext', { recursive: true, force: true })
    })

    it('reports not installed when directory does not exist', () => {
      const fs = createMockFs()
      const result = uninstallExtension({ extensionDir: '/tmp/nonexistent', fs })

      expect(result.removed).toBe(false)
      expect(result.message).toContain('not installed')
    })
  })
})

describe('W5 — installer defaults preserve the live delivery cutover', () => {
  it('defaults TIMEOUT_MS to 5000 (Jul-25 cutover; 1500 starved GATE delivery)', () => {
    const files: Record<string, string> = {}
    const fs = {
      files,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn((path: string, content: string) => {
        files[path] = content
      }),
      existsSync: vi.fn((path: string) => path in files),
      readFileSync: vi.fn((path: string) => files[path] ?? ''),
      rmSync: vi.fn(),
    }
    installExtension({ extensionDir: '/tmp/test-ext', fs })
    const writtenContent = fs.writeFileSync.mock.calls[0]![1] as string
    expect(writtenContent).toContain('TIMEOUT_MS = 5000')
  })
})

// ── WI-2(b): broker token embedding ───────────────────────────────────────
// On a hardened setup (work machine: BROKER_TOKEN set) the extension must
// authenticate; on the tokenless Mac live setup the generated source must be
// behaviorally identical to before (authHeaders() → {}).

describe('WI-2b — broker token embedding', () => {
  function createMockFs() {
    const files: Record<string, string> = {}
    // Keys are normalized to forward slashes so the '/tmp/ext/...' literals in
    // these tests match the '\'-joined paths the CLI produces on win32.
    const norm = (p: string) => p.replaceAll('\\', '/')
    return {
      files,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn((path: string, content: string) => {
        files[norm(path)] = content
      }),
      existsSync: vi.fn((path: string) => norm(path) in files),
      readFileSync: vi.fn((path: string) => files[norm(path)] ?? ''),
      rmSync: vi.fn(),
    }
  }

  const savedToken = { value: undefined as string | undefined }
  beforeEach(() => {
    savedToken.value = process.env.BROKER_TOKEN
    delete process.env.BROKER_TOKEN
  })
  afterEach(() => {
    if (savedToken.value === undefined) delete process.env.BROKER_TOKEN
    else process.env.BROKER_TOKEN = savedToken.value
  })

  it('embeds an explicitly provided token', () => {
    const fs = createMockFs()
    installExtension({ extensionDir: '/tmp/ext', brokerToken: 'tok-explicit', fs })
    const source = fs.files['/tmp/ext/extension.mjs']!
    expect(source).toContain('const BROKER_TOKEN = "tok-explicit"')
    expect(source).toContain('Bearer')
  })

  it('falls back to BROKER_TOKEN env when no explicit token given', () => {
    process.env.BROKER_TOKEN = 'tok-from-env'
    const fs = createMockFs()
    installExtension({ extensionDir: '/tmp/ext', fs })
    expect(fs.files['/tmp/ext/extension.mjs']).toContain('const BROKER_TOKEN = "tok-from-env"')
  })

  it('falls back to the internal-token file when env is unset', () => {
    const fs = createMockFs()
    fs.files['/fake/.scns/.internal-token'] = 'a'.repeat(64) + '\n'
    installExtension({ extensionDir: '/tmp/ext', tokenPath: '/fake/.scns/.internal-token', fs })
    expect(fs.files['/tmp/ext/extension.mjs']).toContain(`const BROKER_TOKEN = "${'a'.repeat(64)}"`)
  })

  it('tokenless setups keep working unchanged (BROKER_TOKEN null, no auth header sent)', () => {
    const fs = createMockFs()
    installExtension({ extensionDir: '/tmp/ext', tokenPath: '/nonexistent/.internal-token', fs })
    const source = fs.files['/tmp/ext/extension.mjs']!
    expect(source).toContain('const BROKER_TOKEN = null')
  })

  it('explicit token wins over env', () => {
    process.env.BROKER_TOKEN = 'tok-from-env'
    const fs = createMockFs()
    installExtension({ extensionDir: '/tmp/ext', brokerToken: 'tok-explicit', fs })
    expect(fs.files['/tmp/ext/extension.mjs']).toContain('const BROKER_TOKEN = "tok-explicit"')
  })
})

// ── #61 option A — reconciliation wiring ─────────────────────────────
describe('#61 — install bakes in session-start reconciliation', () => {
  function mockFs() {
    const files: Record<string, string> = {}
    return {
      files,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn((path: string, content: string) => {
        files[path] = content
      }),
      existsSync: vi.fn((path: string) => path in files),
      readFileSync: vi.fn((path: string) => files[path] ?? ''),
      rmSync: vi.fn(),
    }
  }

  it('emits the reconcile step with the broker entry it should start', () => {
    const fs = mockFs()
    installExtension({
      extensionDir: '/tmp/ext',
      fs,
      brokerEntry: '/repo/dist/cli.js',
      scnsHome: '/home/jh',
      port: 3456,
    })
    const src = fs.writeFileSync.mock.calls[0]![1] as string
    expect(src).toContain('ensureBrokerAlive')
    // It starts the WATCHDOG (the supervision root), not a bare broker.
    expect(src).toContain('"watchdog"')
    expect(src).toContain('"run"')
    expect(src).toContain('/repo/dist/cli.js')
  })

  it('degrades to the pre-#61 source when no broker entry can be resolved', () => {
    const fs = mockFs()
    installExtension({ extensionDir: '/tmp/ext', fs, brokerEntry: null, scnsHome: '/home/jh' })
    const src = fs.writeFileSync.mock.calls[0]![1] as string
    expect(src).not.toContain('ensureBrokerAlive')
    expect(src).not.toContain('node:child_process')
  })

  it('can be switched off explicitly', () => {
    const fs = mockFs()
    installExtension({
      extensionDir: '/tmp/ext',
      fs,
      brokerEntry: '/repo/dist/cli.js',
      scnsHome: '/home/jh',
      reconcile: false,
    })
    const src = fs.writeFileSync.mock.calls[0]![1] as string
    expect(src).not.toContain('ensureBrokerAlive')
  })

  it('puts the cross-session lock under SCNS_HOME, not the extension dir', () => {
    const fs = mockFs()
    installExtension({
      extensionDir: '/tmp/ext',
      fs,
      brokerEntry: '/repo/dist/cli.js',
      scnsHome: '/home/jh',
    })
    const src = fs.writeFileSync.mock.calls[0]![1] as string
    const lockLine = src.split('\n').find((l) => l.startsWith('const RECONCILE_LOCK_PATH'))
    expect(lockLine).toBeDefined()
    expect(lockLine).toContain('jh')
    expect(lockLine).toContain('session-reconcile.lock')
    expect(lockLine).not.toContain('/tmp/ext')
  })

  it('threads a non-default port into both the probe url and the start command', () => {
    const fs = mockFs()
    installExtension({
      extensionDir: '/tmp/ext',
      fs,
      brokerUrl: 'http://localhost:9999',
      brokerEntry: '/repo/dist/cli.js',
      scnsHome: '/home/jh',
      port: 9999,
    })
    const src = fs.writeFileSync.mock.calls[0]![1] as string
    expect(src).toContain('const BROKER_URL = "http://localhost:9999"')
    expect(src).toContain('"9999"')
  })
})
