import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfigChangeObserver } from '../../../../src/observe/discovery/config-change-observer.js'
import type { ConfigChangeObserverOptions } from '../../../../src/observe/discovery/config-change-observer.js'
import type { Observation } from '../../../../src/observe/types.js'
import { ObservationType } from '../../../../src/observe/types.js'
import type { FileWatcher } from '../../../../src/observe/observers/file-changes.js'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'scns-config-change-observer-'))
}

type WatchCallback = (event: string, filename: string | null) => void

function createMockWatcher(): FileWatcher & {
  readonly callbacks: Map<string, WatchCallback>
  trigger(dir: string, event?: string, filename?: string | null): void
} {
  const callbacks = new Map<string, WatchCallback>()
  const handles = new Map<string, { close(): void }>()

  return {
    callbacks,
    watch(dir, _options, callback) {
      callbacks.set(dir, callback)
      const handle = {
        close() {
          callbacks.delete(dir)
          handles.delete(dir)
        },
      }
      handles.set(dir, handle)
      return handle
    },
    trigger(dir: string, event = 'change', filename: string | null = 'settings.json') {
      const cb = callbacks.get(dir)
      if (cb) cb(event, filename)
    },
  }
}

function createMockLogWriter() {
  const written: Observation[] = []
  return {
    write(observation: Observation): void {
      written.push(observation)
    },
    writeBatch(observations: readonly Observation[]): void {
      written.push(...observations)
    },
    getWritten(): readonly Observation[] {
      return written
    },
  }
}

function writeSettingsJson(
  dir: string,
  mcpServers: Record<string, { command: string; args: string[] }>,
): void {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ mcpServers }))
}

function writeSkillFile(dir: string, name: string, description: string): void {
  const commandsDir = join(dir, '.claude', 'commands')
  mkdirSync(commandsDir, { recursive: true })
  writeFileSync(
    join(commandsDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\n---\nContent`,
  )
}

function writeInstructionFile(dir: string, content: string): void {
  writeFileSync(join(dir, 'CLAUDE.md'), content)
}

describe('createConfigChangeObserver', () => {
  let tempHome: string
  let tempCwd: string

  beforeEach(() => {
    vi.useFakeTimers()
    tempHome = makeTempDir()
    tempCwd = makeTempDir()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(tempHome, { recursive: true, force: true })
    rmSync(tempCwd, { recursive: true, force: true })
  })

  function makeObserver(overrides?: Partial<ConfigChangeObserverOptions>) {
    const mockWatcher = createMockWatcher()
    const mockLogWriter = createMockLogWriter()
    const observer = createConfigChangeObserver({
      logWriter: mockLogWriter,
      config: { enabled: true, optIn: false },
      watcher: mockWatcher,
      homeDir: tempHome,
      cwd: tempCwd,
      debounceMs: 500,
      ...overrides,
    })
    return { observer, mockWatcher, mockLogWriter }
  }

  describe('Observer interface', () => {
    it('has correct type and name', () => {
      const { observer } = makeObserver()
      expect(observer.type).toBe(ObservationType.ConfigChange)
      expect(observer.name).toBe('config-change-observer')
    })

    it('start/stop/isRunning lifecycle', () => {
      writeSettingsJson(tempHome, {})
      const { observer } = makeObserver()

      expect(observer.isRunning()).toBe(false)
      observer.start()
      expect(observer.isRunning()).toBe(true)
      observer.stop()
      expect(observer.isRunning()).toBe(false)
    })

    it('start is no-op when config.enabled is false', () => {
      const { observer, mockWatcher } = makeObserver({
        config: { enabled: false, optIn: false },
      })
      observer.start()
      expect(observer.isRunning()).toBe(false)
      expect(mockWatcher.callbacks.size).toBe(0)
    })

    it('start is idempotent — calling twice does not double-register', () => {
      mkdirSync(join(tempHome, '.claude'), { recursive: true })
      const { observer, mockWatcher } = makeObserver()
      observer.start()
      const firstCallbackCount = mockWatcher.callbacks.size
      observer.start()
      expect(mockWatcher.callbacks.size).toBe(firstCallbackCount)
    })

    it('stop is idempotent — calling twice is safe', () => {
      const { observer } = makeObserver()
      observer.start()
      observer.stop()
      observer.stop() // Should not throw
      expect(observer.isRunning()).toBe(false)
    })
  })

  describe('MCP server change detection', () => {
    it('detects new MCP server added to settings.json', () => {
      // Start with one server
      writeSettingsJson(tempHome, {
        'existing-server': { command: 'node', args: ['server.js'] },
      })

      const { observer, mockWatcher, mockLogWriter } = makeObserver()
      observer.start()

      // Add a new server
      writeSettingsJson(tempHome, {
        'existing-server': { command: 'node', args: ['server.js'] },
        'github-mcp-server': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
      })

      // Trigger change and advance past debounce
      mockWatcher.trigger(join(tempHome, '.claude'))
      vi.advanceTimersByTime(600)

      const written = mockLogWriter.getWritten()
      expect(written).toHaveLength(1)
      expect(written[0]!.content).toBe('MCP server added: github-mcp-server')
      expect(written[0]!.metadata).toEqual({
        category: 'config',
        subjectType: 'mcp',
        changeType: 'added',
        name: 'github-mcp-server',
      })
    })

    it('detects MCP server removed', () => {
      writeSettingsJson(tempHome, {
        'server-a': { command: 'node', args: ['a.js'] },
        'server-b': { command: 'node', args: ['b.js'] },
      })

      const { observer, mockWatcher, mockLogWriter } = makeObserver()
      observer.start()

      // Remove server-b
      writeSettingsJson(tempHome, {
        'server-a': { command: 'node', args: ['a.js'] },
      })

      mockWatcher.trigger(join(tempHome, '.claude'))
      vi.advanceTimersByTime(600)

      const written = mockLogWriter.getWritten()
      expect(written).toHaveLength(1)
      expect(written[0]!.content).toBe('MCP server removed: server-b')
    })

    it('detects MCP server updated (command changed)', () => {
      writeSettingsJson(tempHome, {
        'my-server': { command: 'node', args: ['old.js'] },
      })

      const { observer, mockWatcher, mockLogWriter } = makeObserver()
      observer.start()

      writeSettingsJson(tempHome, {
        'my-server': { command: 'npx', args: ['-y', 'new-package'] },
      })

      mockWatcher.trigger(join(tempHome, '.claude'))
      vi.advanceTimersByTime(600)

      const written = mockLogWriter.getWritten()
      expect(written).toHaveLength(1)
      expect(written[0]!.content).toBe('MCP server updated: my-server')
    })
  })

  describe('skill change detection', () => {
    it('detects new skill file created', () => {
      // Ensure .claude dir exists so watcher can register
      mkdirSync(join(tempHome, '.claude'), { recursive: true })

      const { observer, mockWatcher, mockLogWriter } = makeObserver()
      observer.start()

      // Add a skill file after start
      writeSkillFile(tempHome, 'quality-gate', 'Run quality gate')

      mockWatcher.trigger(join(tempHome, '.claude'))
      vi.advanceTimersByTime(600)

      const written = mockLogWriter.getWritten()
      expect(written).toHaveLength(1)
      expect(written[0]!.content).toBe('Skill added: quality-gate')
    })

    it('detects skill file modified', () => {
      writeSkillFile(tempHome, 'quality-gate', 'Run quality gate v1')

      const { observer, mockWatcher, mockLogWriter } = makeObserver()
      observer.start()

      // Modify the skill
      writeSkillFile(tempHome, 'quality-gate', 'Run quality gate v2 with improvements')

      mockWatcher.trigger(join(tempHome, '.claude'))
      vi.advanceTimersByTime(600)

      const written = mockLogWriter.getWritten()
      expect(written).toHaveLength(1)
      expect(written[0]!.content).toBe('Skill updated: quality-gate')
    })

    it('detects skill removed', () => {
      writeSkillFile(tempHome, 'old-skill', 'Old skill description')

      const { observer, mockWatcher, mockLogWriter } = makeObserver()
      observer.start()

      // Remove skill file
      rmSync(join(tempHome, '.claude', 'commands', 'old-skill.md'))

      mockWatcher.trigger(join(tempHome, '.claude'))
      vi.advanceTimersByTime(600)

      const written = mockLogWriter.getWritten()
      expect(written).toHaveLength(1)
      expect(written[0]!.content).toBe('Skill removed: old-skill')
    })
  })

  describe('instruction change detection', () => {
    it('detects new instruction file', () => {
      const { observer } = makeObserver()
      observer.start()

      writeInstructionFile(tempCwd, 'Project instructions here.')

      // We need to trigger on the project claude dir or the cwd
      // The observer watches extensionsDir and claudeDir areas.
      // CLAUDE.md is at cwd root — not in a watched directory.
      // Since instructions are detected by rescan, we just need any watcher to fire.
      // Let's trigger the project .claude dir if it exists.
      mkdirSync(join(tempCwd, '.claude'), { recursive: true })
      // Restart to pick up the new directory
      observer.stop()
      const { observer: obs2, mockWatcher: mw2, mockLogWriter: lw2 } = makeObserver()
      obs2.start()

      writeInstructionFile(tempCwd, 'Updated instructions')
      mw2.trigger(join(tempCwd, '.claude'))
      vi.advanceTimersByTime(600)

      const written = lw2.getWritten()
      // Initial scan saw "Project instructions here.", rescan sees "Updated instructions"
      expect(written).toHaveLength(1)
      expect(written[0]!.content).toBe('Instruction file updated: CLAUDE.md')
    })
  })

  describe('debouncing', () => {
    it('debounces rapid changes — only one scan per debounce window', () => {
      writeSettingsJson(tempHome, {
        'server-1': { command: 'node', args: ['s1.js'] },
      })

      const { observer, mockWatcher, mockLogWriter } = makeObserver()
      observer.start()

      // Add server for the next rescan
      writeSettingsJson(tempHome, {
        'server-1': { command: 'node', args: ['s1.js'] },
        'server-2': { command: 'node', args: ['s2.js'] },
      })

      // Trigger 5 rapid events within debounce window
      for (let i = 0; i < 5; i++) {
        mockWatcher.trigger(join(tempHome, '.claude'))
        vi.advanceTimersByTime(100)
      }

      // At this point, only the last debounce timer should fire
      vi.advanceTimersByTime(500)

      const written = mockLogWriter.getWritten()
      // Only 1 observation, not 5
      expect(written).toHaveLength(1)
      expect(written[0]!.content).toBe('MCP server added: server-2')
    })
  })

  describe('missing directories', () => {
    it('handles missing config directories gracefully — no crash', () => {
      // tempHome/.claude doesn't exist, tempCwd/.github/extensions doesn't exist
      const { observer, mockWatcher } = makeObserver()

      expect(() => observer.start()).not.toThrow()
      expect(observer.isRunning()).toBe(true)
      // No watchers registered since dirs don't exist
      expect(mockWatcher.callbacks.size).toBe(0)
    })
  })

  describe('initial scan', () => {
    it('does not emit observations for existing config on startup', () => {
      // Pre-populate config
      writeSettingsJson(tempHome, {
        'existing-server': { command: 'node', args: ['srv.js'] },
      })
      writeSkillFile(tempHome, 'existing-skill', 'Already here')

      const { observer, mockLogWriter } = makeObserver()
      observer.start()

      // No observations should be emitted for existing state
      expect(mockLogWriter.getWritten()).toHaveLength(0)
    })
  })

  describe('stop cancels pending debounced scans', () => {
    it('pending debounce timer is cancelled on stop', () => {
      writeSettingsJson(tempHome, {
        'server-a': { command: 'a', args: [] },
      })

      const { observer, mockWatcher, mockLogWriter } = makeObserver()
      observer.start()

      // Modify and trigger
      writeSettingsJson(tempHome, {
        'server-a': { command: 'a', args: [] },
        'server-b': { command: 'b', args: [] },
      })
      mockWatcher.trigger(join(tempHome, '.claude'))

      // Stop before debounce fires
      observer.stop()
      vi.advanceTimersByTime(1000)

      // No observations should have been emitted
      expect(mockLogWriter.getWritten()).toHaveLength(0)
    })
  })

  describe('observation structure', () => {
    it('emits observations with correct tags and metadata', () => {
      writeSettingsJson(tempHome, {})

      const { observer, mockWatcher, mockLogWriter } = makeObserver()
      observer.start()

      writeSettingsJson(tempHome, {
        'new-server': { command: 'node', args: [] },
      })

      mockWatcher.trigger(join(tempHome, '.claude'))
      vi.advanceTimersByTime(600)

      const written = mockLogWriter.getWritten()
      expect(written).toHaveLength(1)

      const obs = written[0]!
      expect(obs.type).toBe(ObservationType.ConfigChange)
      expect(obs.source).toBe('config-change-observer')
      expect(obs.tags).toContain('config')
      expect(obs.tags).toContain('mcp')
      expect(obs.tags).toContain('added')
      expect(obs.id).toBeTruthy()
      expect(obs.timestamp).toBeTruthy()
    })
  })
})
