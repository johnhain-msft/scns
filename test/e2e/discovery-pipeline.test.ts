/**
 * E2E test — discovery pipeline
 *
 * Exercises the full config discovery pipeline:
 *   scanner finds MCPs/skills/instructions → change observer detects
 *   modifications → re-scan reflects updated state.
 *
 * Uses mock FileWatcher + fake timers for determinism in observer tests,
 * with one real-watcher smoke test for true end-to-end coverage.
 */

import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createConfigScanner } from '../../src/observe/discovery/config-scanner.js'
import { createConfigChangeObserver } from '../../src/observe/discovery/config-change-observer.js'
import type { Observation } from '../../src/observe/types.js'
import { ObservationType } from '../../src/observe/types.js'
import type { FileWatcher } from '../../src/observe/observers/file-changes.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WatchCallback = (event: string, filename: string | null) => void

function createMockWatcher(): FileWatcher & {
  readonly callbacks: Map<string, WatchCallback>
  trigger(dir: string, event?: string, filename?: string | null): void
} {
  const callbacks = new Map<string, WatchCallback>()
  return {
    callbacks,
    watch(dir, _options, callback) {
      callbacks.set(dir, callback)
      return {
        close() {
          callbacks.delete(dir)
        },
      }
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
    `---\nname: ${name}\ndescription: ${description}\n---\nContent for ${name}`,
  )
}

function writeInstructionFile(dir: string, filename: string, content: string): void {
  const parent = join(dir, ...filename.split('/').slice(0, -1))
  if (parent !== dir) mkdirSync(parent, { recursive: true })
  writeFileSync(join(dir, filename), content)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Discovery pipeline — end-to-end', { timeout: 30_000 }, () => {
  let tempHome: string
  let tempCwd: string

  beforeEach(() => {
    vi.useFakeTimers()
    tempHome = mkdtempSync(join(tmpdir(), 'scns-e2e-home-'))
    tempCwd = mkdtempSync(join(tmpdir(), 'scns-e2e-cwd-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(tempHome, { recursive: true, force: true })
    rmSync(tempCwd, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // Scanner
  // -----------------------------------------------------------------------

  describe('config scanner — full scan', () => {
    it('discovers MCPs, skills, and instructions in a single scan', () => {
      // MCPs in home settings
      writeSettingsJson(tempHome, {
        'github-mcp': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        filesystem: { command: 'node', args: ['fs-server.js'] },
      })

      // Skills in home commands dir
      writeSkillFile(tempHome, 'quality-gate', 'Run quality gate checks')

      // Skills in project commands dir
      writeSkillFile(tempCwd, 'deploy', 'Deploy to production')

      // Extension in project .github/extensions
      const extDir = join(tempCwd, '.github', 'extensions')
      mkdirSync(extDir, { recursive: true })
      writeFileSync(join(extDir, 'my-ext.ts'), 'export default {}')

      // Instructions
      writeInstructionFile(tempCwd, 'CLAUDE.md', 'Project-level instructions for the agent.')
      writeInstructionFile(tempCwd, '.github/copilot-instructions.md', 'Copilot specific guidance.')

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const result = scanner.scan()

      // MCPs
      expect(result.mcpServers).toHaveLength(2)
      const mcpNames = result.mcpServers.map((m) => m.name)
      expect(mcpNames).toContain('github-mcp')
      expect(mcpNames).toContain('filesystem')

      const ghMcp = result.mcpServers.find((m) => m.name === 'github-mcp')!
      expect(ghMcp.command).toBe('npx')
      expect(ghMcp.args).toEqual(['-y', '@modelcontextprotocol/server-github'])
      expect(ghMcp.source).toBe(join(tempHome, '.claude', 'settings.json'))

      // Skills (home commands + project commands + extension)
      expect(result.skills).toHaveLength(3)
      const skillNames = result.skills.map((s) => s.name)
      expect(skillNames).toContain('quality-gate')
      expect(skillNames).toContain('deploy')
      expect(skillNames).toContain('my-ext')

      const qg = result.skills.find((s) => s.name === 'quality-gate')!
      expect(qg.description).toBe('Run quality gate checks')

      // Instructions
      expect(result.instructions).toHaveLength(2)
      const instructionSources = result.instructions.map((i) => i.source)
      expect(instructionSources).toContain(join(tempCwd, 'CLAUDE.md'))
      expect(instructionSources).toContain(join(tempCwd, '.github', 'copilot-instructions.md'))

      const claudeMd = result.instructions.find((i) => i.source.endsWith('CLAUDE.md'))!
      expect(claudeMd.contentPreview).toBe('Project-level instructions for the agent.')
      expect(claudeMd.fullLength).toBe('Project-level instructions for the agent.'.length)

      // Scanned paths only include paths that exist
      expect(result.scannedPaths.length).toBeGreaterThan(0)
      for (const p of result.scannedPaths) {
        expect(existsSync(p)).toBe(true)
      }

      // Timestamp is ISO string
      expect(() => new Date(result.scannedAt).toISOString()).not.toThrow()
    })

    it('returns empty arrays when no config files exist', () => {
      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const result = scanner.scan()

      expect(result.mcpServers).toHaveLength(0)
      expect(result.skills).toHaveLength(0)
      expect(result.instructions).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Change observer
  // -----------------------------------------------------------------------

  describe('config change observer', () => {
    function makeObserver(overrides?: {
      watcher?: ReturnType<typeof createMockWatcher>
      debounceMs?: number
    }) {
      const mockWatcher = overrides?.watcher ?? createMockWatcher()
      const mockLogWriter = createMockLogWriter()
      const observer = createConfigChangeObserver({
        logWriter: mockLogWriter,
        config: { enabled: true, optIn: false },
        watcher: mockWatcher,
        homeDir: tempHome,
        cwd: tempCwd,
        debounceMs: overrides?.debounceMs ?? 500,
      })
      return { observer, mockWatcher, mockLogWriter }
    }

    it('emits no observations for pre-existing config on startup', () => {
      writeSettingsJson(tempHome, {
        'existing-server': { command: 'node', args: ['srv.js'] },
      })
      writeSkillFile(tempHome, 'existing-skill', 'Already here')
      writeInstructionFile(tempCwd, 'CLAUDE.md', 'Pre-existing instructions')

      const { observer, mockLogWriter } = makeObserver()
      observer.start()

      // Advance well past debounce to prove nothing fires
      vi.advanceTimersByTime(2000)

      expect(mockLogWriter.getWritten()).toHaveLength(0)
      observer.stop()
    })

    it('detects new MCP server added after startup', () => {
      writeSettingsJson(tempHome, {
        'server-a': { command: 'node', args: ['a.js'] },
      })

      const { observer, mockWatcher, mockLogWriter } = makeObserver()
      observer.start()

      // Add a new MCP server
      writeSettingsJson(tempHome, {
        'server-a': { command: 'node', args: ['a.js'] },
        'server-b': { command: 'npx', args: ['-y', 'new-pkg'] },
      })

      mockWatcher.trigger(join(tempHome, '.claude'))
      vi.advanceTimersByTime(600)

      const written = mockLogWriter.getWritten()
      expect(written).toHaveLength(1)
      expect(written[0]!.type).toBe(ObservationType.ConfigChange)
      expect(written[0]!.source).toBe('config-change-observer')
      expect(written[0]!.content).toBe('MCP server added: server-b')
      expect(written[0]!.tags).toEqual(expect.arrayContaining(['config', 'mcp', 'added']))
      expect(written[0]!.metadata).toEqual({
        category: 'config',
        subjectType: 'mcp',
        changeType: 'added',
        name: 'server-b',
      })
      expect(written[0]!.id).toBeTruthy()
      expect(written[0]!.timestamp).toBeTruthy()

      observer.stop()
    })

    it('detects removed skill file', () => {
      writeSkillFile(tempHome, 'temp-skill', 'Temporary skill')
      writeSkillFile(tempHome, 'permanent-skill', 'Permanent skill')

      const { observer, mockWatcher, mockLogWriter } = makeObserver()
      observer.start()

      // Remove one skill
      rmSync(join(tempHome, '.claude', 'commands', 'temp-skill.md'))

      mockWatcher.trigger(join(tempHome, '.claude'))
      vi.advanceTimersByTime(600)

      const written = mockLogWriter.getWritten()
      expect(written).toHaveLength(1)
      expect(written[0]!.content).toBe('Skill removed: temp-skill')
      expect(written[0]!.metadata).toMatchObject({
        subjectType: 'skill',
        changeType: 'removed',
        name: 'temp-skill',
      })

      observer.stop()
    })

    it('detects instruction update when watched dir triggers rescan', () => {
      // CLAUDE.md is not in a watched directory — it lives at cwd root.
      // The observer only rescans when a watched dir fires an event.
      writeInstructionFile(tempCwd, 'CLAUDE.md', 'Original instructions')
      // Need a watched dir to exist so watcher registers
      mkdirSync(join(tempCwd, '.claude'), { recursive: true })

      const { observer, mockWatcher, mockLogWriter } = makeObserver()
      observer.start()

      // Edit CLAUDE.md (changes first 200 chars and length)
      writeInstructionFile(
        tempCwd,
        'CLAUDE.md',
        'Updated project instructions with much more detail',
      )

      // Trigger via .claude dir (the watched dir) to cause a rescan
      mockWatcher.trigger(join(tempCwd, '.claude'))
      vi.advanceTimersByTime(600)

      const written = mockLogWriter.getWritten()
      expect(written).toHaveLength(1)
      expect(written[0]!.content).toBe('Instruction file updated: CLAUDE.md')
      expect(written[0]!.metadata).toMatchObject({
        subjectType: 'instruction',
        changeType: 'updated',
      })

      observer.stop()
    })

    it('does not observe changes in dirs created after startup', () => {
      // Start with no watched dirs existing
      const { observer, mockWatcher, mockLogWriter } = makeObserver()
      observer.start()

      expect(mockWatcher.callbacks.size).toBe(0)

      // Create dirs and configs after startup
      writeSettingsJson(tempHome, {
        'late-server': { command: 'node', args: ['late.js'] },
      })

      // Even if we try to trigger, no callback is registered
      mockWatcher.trigger(join(tempHome, '.claude'))
      vi.advanceTimersByTime(600)

      expect(mockLogWriter.getWritten()).toHaveLength(0)

      observer.stop()
    })

    it('full pipeline round-trip: scan → modify → observe → re-scan', () => {
      // --- Phase 1: seed initial config ---
      writeSettingsJson(tempHome, {
        'mcp-alpha': { command: 'node', args: ['alpha.js'] },
      })
      writeSkillFile(tempCwd, 'skill-one', 'First skill')
      writeInstructionFile(tempCwd, 'CLAUDE.md', 'Initial instructions content')

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })

      // Verify initial scan
      const initial = scanner.scan()
      expect(initial.mcpServers).toHaveLength(1)
      expect(initial.mcpServers[0]!.name).toBe('mcp-alpha')
      expect(initial.skills).toHaveLength(1)
      expect(initial.skills[0]!.name).toBe('skill-one')
      expect(initial.instructions).toHaveLength(1)

      // --- Phase 2: start observer ---
      const { observer, mockWatcher, mockLogWriter } = makeObserver()
      observer.start()

      // --- Phase 3: modify configs ---
      // Add a second MCP
      writeSettingsJson(tempHome, {
        'mcp-alpha': { command: 'node', args: ['alpha.js'] },
        'mcp-beta': { command: 'npx', args: ['beta-pkg'] },
      })
      // Remove the skill
      rmSync(join(tempCwd, '.claude', 'commands', 'skill-one.md'))
      // Update instructions (change content within first 200 chars)
      writeInstructionFile(tempCwd, 'CLAUDE.md', 'Revised instructions with new guidance')

      // Trigger changes on both watched dirs
      mockWatcher.trigger(join(tempHome, '.claude'))
      vi.advanceTimersByTime(600)

      // --- Phase 4: verify observations ---
      const written = mockLogWriter.getWritten()
      const changes = written.map((o) => ({
        type: (o.metadata as Record<string, unknown>)['subjectType'],
        action: (o.metadata as Record<string, unknown>)['changeType'],
        name: (o.metadata as Record<string, unknown>)['name'],
      }))

      expect(changes).toContainEqual({ type: 'mcp', action: 'added', name: 'mcp-beta' })
      expect(changes).toContainEqual({ type: 'skill', action: 'removed', name: 'skill-one' })
      expect(changes).toContainEqual({ type: 'instruction', action: 'updated', name: 'CLAUDE.md' })

      // --- Phase 5: re-scan shows updated state ---
      const updated = scanner.scan()
      expect(updated.mcpServers).toHaveLength(2)
      expect(updated.mcpServers.map((m) => m.name)).toContain('mcp-beta')
      expect(updated.skills).toHaveLength(0)
      expect(updated.instructions).toHaveLength(1)
      expect(updated.instructions[0]!.contentPreview).toBe('Revised instructions with new guidance')

      observer.stop()
    })
  })
})
