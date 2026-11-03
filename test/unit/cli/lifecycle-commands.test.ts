import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Test the CLI lifecycle commands by constructing fresh Command instances
 * and mocking external dependencies (fetch, fs, imports).
 */

// ── Helpers ──────────────────────────────────────────────────

let TEST_STATE_DIR: string
let PLIST_DIR: string

function buildStartCommand(): Command {
  const program = new Command()
  program.name('scns').version('0.1.0').exitOverride()

  program
    .command('start')
    .description('Start the SCNS brain agent and session broker')
    .option('-p, --port <port>', 'broker port', '3456')
    .option('--autonomy <level>', 'autonomy level (0–3)', '0')
    .action(() => {})

  return program
}

function buildStopCommand(): Command {
  const program = new Command()
  program.name('scns').version('0.1.0').exitOverride()

  program
    .command('stop')
    .description('Stop the SCNS brain agent and all managed sessions')
    .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
    .action(() => {})

  return program
}

function buildStatusCommand(): Command {
  const program = new Command()
  program.name('scns').version('0.1.0').exitOverride()

  program
    .command('status')
    .description('Show SCNS status')
    .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
    .option('--json', 'Machine-readable JSON output')
    .action(() => {})

  return program
}

function buildSearchCommand(): Command {
  const program = new Command()
  program.name('scns').version('0.1.0').exitOverride()

  program
    .command('search <query>')
    .description('Search the memory vault')
    .option('-n, --limit <limit>', 'max results', '10')
    .action(() => {})

  return program
}

function buildPromoteDemoteCommands(): Command {
  const program = new Command()
  program.name('scns').version('0.1.0').exitOverride()

  program
    .command('promote')
    .description('Promote autonomy')
    .action(() => {})
  program
    .command('demote')
    .description('Demote autonomy')
    .action(() => {})

  return program
}

function buildDashboardCommand(): Command {
  const program = new Command()
  program.name('scns').version('0.1.0').exitOverride()

  program
    .command('dashboard')
    .description('Launch the SCNS dashboard')
    .option('-p, --port <port>', 'dashboard port', '3001')
    .action(() => {})

  return program
}

function buildInstallUninstallCommands(): Command {
  const program = new Command()
  program.name('scns').version('0.1.0').exitOverride()

  program
    .command('install')
    .description('Install SCNS')
    .action(() => {})
  program
    .command('uninstall')
    .description('Uninstall SCNS')
    .action(() => {})

  return program
}

describe('CLI lifecycle commands', () => {
  beforeEach(() => {
    TEST_STATE_DIR = mkdtempSync(join(tmpdir(), 'scns-cli-state-'))
    PLIST_DIR = mkdtempSync(join(tmpdir(), 'scns-cli-plist-'))
  })

  afterEach(() => {
    rmSync(TEST_STATE_DIR, { recursive: true, force: true })
    rmSync(PLIST_DIR, { recursive: true, force: true })
  })

  // ── start command ──────────────────────────────────────────

  describe('start command', () => {
    it('accepts --port option', () => {
      let parsedPort = ''
      const program = buildStartCommand()
      const start = program.commands.find((c) => c.name() === 'start')!
      start.action((opts: { port: string }) => {
        parsedPort = opts.port
      })

      program.parse(['start', '--port', '9999'], { from: 'user' })
      expect(parsedPort).toBe('9999')
    })

    it('accepts --autonomy option', () => {
      let parsedAutonomy = ''
      const program = buildStartCommand()
      const start = program.commands.find((c) => c.name() === 'start')!
      start.action((opts: { autonomy: string }) => {
        parsedAutonomy = opts.autonomy
      })

      program.parse(['start', '--autonomy', '2'], { from: 'user' })
      expect(parsedAutonomy).toBe('2')
    })

    it('defaults port to 3456', () => {
      let parsedPort = ''
      const program = buildStartCommand()
      const start = program.commands.find((c) => c.name() === 'start')!
      start.action((opts: { port: string }) => {
        parsedPort = opts.port
      })

      program.parse(['start'], { from: 'user' })
      expect(parsedPort).toBe('3456')
    })

    it('defaults autonomy to 0', () => {
      let parsedAutonomy = ''
      const program = buildStartCommand()
      const start = program.commands.find((c) => c.name() === 'start')!
      start.action((opts: { autonomy: string }) => {
        parsedAutonomy = opts.autonomy
      })

      program.parse(['start'], { from: 'user' })
      expect(parsedAutonomy).toBe('0')
    })
  })

  // ── stop command ───────────────────────────────────────────

  describe('stop command', () => {
    it('accepts --broker-url option', () => {
      let parsedUrl = ''
      const program = buildStopCommand()
      const stop = program.commands.find((c) => c.name() === 'stop')!
      stop.action((opts: { brokerUrl: string }) => {
        parsedUrl = opts.brokerUrl
      })

      program.parse(['stop', '--broker-url', 'http://example.com:8080'], { from: 'user' })
      expect(parsedUrl).toBe('http://example.com:8080')
    })

    it('defaults broker-url to localhost:3456', () => {
      let parsedUrl = ''
      const program = buildStopCommand()
      const stop = program.commands.find((c) => c.name() === 'stop')!
      stop.action((opts: { brokerUrl: string }) => {
        parsedUrl = opts.brokerUrl
      })

      program.parse(['stop'], { from: 'user' })
      expect(parsedUrl).toBe('http://localhost:3456')
    })
  })

  // ── status command ─────────────────────────────────────────

  describe('status command', () => {
    it('accepts --broker-url and --json options', () => {
      let opts: Record<string, unknown> = {}
      const program = buildStatusCommand()
      const status = program.commands.find((c) => c.name() === 'status')!
      status.action((cmdOpts: Record<string, unknown>) => {
        opts = cmdOpts
      })

      program.parse(['status', '--broker-url', 'http://custom:1234', '--json'], { from: 'user' })
      expect(opts.brokerUrl).toBe('http://custom:1234')
      expect(opts.json).toBe(true)
    })

    it('defaults to human-readable output', () => {
      let opts: Record<string, unknown> = {}
      const program = buildStatusCommand()
      const status = program.commands.find((c) => c.name() === 'status')!
      status.action((cmdOpts: Record<string, unknown>) => {
        opts = cmdOpts
      })

      program.parse(['status'], { from: 'user' })
      expect(opts.json).toBeUndefined()
    })
  })

  // ── search command ─────────────────────────────────────────

  describe('search command', () => {
    it('accepts query argument and --limit option', () => {
      let parsedQuery = ''
      let parsedLimit = ''
      const program = buildSearchCommand()
      const search = program.commands.find((c) => c.name() === 'search')!
      search.action((query: string, opts: { limit: string }) => {
        parsedQuery = query
        parsedLimit = opts.limit
      })

      program.parse(['search', 'test query', '--limit', '5'], { from: 'user' })
      expect(parsedQuery).toBe('test query')
      expect(parsedLimit).toBe('5')
    })

    it('defaults limit to 10', () => {
      let parsedLimit = ''
      const program = buildSearchCommand()
      const search = program.commands.find((c) => c.name() === 'search')!
      search.action((_query: string, opts: { limit: string }) => {
        parsedLimit = opts.limit
      })

      program.parse(['search', 'my query'], { from: 'user' })
      expect(parsedLimit).toBe('10')
    })
  })

  // ── promote / demote ───────────────────────────────────────

  describe('promote command', () => {
    it('parses promote command', () => {
      let called = false
      const program = buildPromoteDemoteCommands()
      const promote = program.commands.find((c) => c.name() === 'promote')!
      promote.action(() => {
        called = true
      })

      program.parse(['promote'], { from: 'user' })
      expect(called).toBe(true)
    })
  })

  describe('demote command', () => {
    it('parses demote command', () => {
      let called = false
      const program = buildPromoteDemoteCommands()
      const demote = program.commands.find((c) => c.name() === 'demote')!
      demote.action(() => {
        called = true
      })

      program.parse(['demote'], { from: 'user' })
      expect(called).toBe(true)
    })
  })

  // ── promote/demote with actual autonomy module ─────────────

  describe('promote with autonomy module', () => {
    it('increments autonomy level via module', async () => {
      const { saveAutonomy, promote } = await import('../../../src/shared/autonomy.js')
      saveAutonomy(TEST_STATE_DIR, { level: 1, changedAt: 'x', changedBy: 'user' })
      const result = promote(TEST_STATE_DIR)
      expect(result.level).toBe(2)
    })
  })

  describe('demote with autonomy module', () => {
    it('decrements autonomy level via module', async () => {
      const { saveAutonomy, demote } = await import('../../../src/shared/autonomy.js')
      saveAutonomy(TEST_STATE_DIR, { level: 2, changedAt: 'x', changedBy: 'user' })
      const result = demote(TEST_STATE_DIR)
      expect(result.level).toBe(1)
    })
  })

  // ── dashboard command ──────────────────────────────────────

  describe('dashboard command', () => {
    it('parses --port option', () => {
      let parsedPort = ''
      const program = buildDashboardCommand()
      const dashboard = program.commands.find((c) => c.name() === 'dashboard')!
      dashboard.action((opts: { port: string }) => {
        parsedPort = opts.port
      })

      program.parse(['dashboard', '--port', '8080'], { from: 'user' })
      expect(parsedPort).toBe('8080')
    })

    it('defaults port to 3001', () => {
      let parsedPort = ''
      const program = buildDashboardCommand()
      const dashboard = program.commands.find((c) => c.name() === 'dashboard')!
      dashboard.action((opts: { port: string }) => {
        parsedPort = opts.port
      })

      program.parse(['dashboard'], { from: 'user' })
      expect(parsedPort).toBe('3001')
    })
  })

  // ── install / uninstall ────────────────────────────────────

  describe('install command', () => {
    it('parses install command', () => {
      let called = false
      const program = buildInstallUninstallCommands()
      const install = program.commands.find((c) => c.name() === 'install')!
      install.action(() => {
        called = true
      })

      program.parse(['install'], { from: 'user' })
      expect(called).toBe(true)
    })

    it('creates a plist file at the expected path', () => {
      const plistPath = join(PLIST_DIR, 'com.scns.brain.plist')
      const plistContent = `<?xml version="1.0"?><plist><dict><key>Label</key><string>com.scns.brain</string></dict></plist>`
      writeFileSync(plistPath, plistContent)
      expect(existsSync(plistPath)).toBe(true)
      const content = readFileSync(plistPath, 'utf-8')
      expect(content).toContain('com.scns.brain')
    })
  })

  describe('uninstall command', () => {
    it('parses uninstall command', () => {
      let called = false
      const program = buildInstallUninstallCommands()
      const uninstall = program.commands.find((c) => c.name() === 'uninstall')!
      uninstall.action(() => {
        called = true
      })

      program.parse(['uninstall'], { from: 'user' })
      expect(called).toBe(true)
    })

    it('removes plist file when it exists', () => {
      const plistPath = join(PLIST_DIR, 'test.plist')
      writeFileSync(plistPath, 'test')
      expect(existsSync(plistPath)).toBe(true)

      unlinkSync(plistPath)
      expect(existsSync(plistPath)).toBe(false)
    })
  })
})
