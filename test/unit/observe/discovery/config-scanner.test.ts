import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfigScanner } from '../../../../src/observe/discovery/config-scanner.js'
import type { DiscoveredConfig } from '../../../../src/observe/discovery/config-scanner.js'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'scns-config-scanner-'))
}

describe('createConfigScanner', () => {
  let tempHome: string
  let tempCwd: string

  beforeEach(() => {
    tempHome = makeTempDir()
    tempCwd = makeTempDir()
  })

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true })
    rmSync(tempCwd, { recursive: true, force: true })
  })

  describe('scanMcpServers', () => {
    it('scans Claude settings.json with MCP servers → returns correct DiscoveredMcp entries', () => {
      const claudeDir = join(tempHome, '.claude')
      mkdirSync(claudeDir, { recursive: true })
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            'my-server': {
              command: 'npx',
              args: ['-y', '@my/mcp-server'],
            },
            'another-server': {
              command: 'node',
              args: ['server.js', '--port', '3000'],
            },
          },
        }),
      )

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const servers = scanner.scanMcpServers()

      expect(servers).toHaveLength(2)
      expect(servers[0]).toEqual({
        name: 'my-server',
        command: 'npx',
        args: ['-y', '@my/mcp-server'],
        source: join(claudeDir, 'settings.json'),
      })
      expect(servers[1]).toEqual({
        name: 'another-server',
        command: 'node',
        args: ['server.js', '--port', '3000'],
        source: join(claudeDir, 'settings.json'),
      })
    })

    it('scans project-level .claude/settings.json', () => {
      const projectClaudeDir = join(tempCwd, '.claude')
      mkdirSync(projectClaudeDir, { recursive: true })
      writeFileSync(
        join(projectClaudeDir, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            'project-server': {
              command: 'python',
              args: ['mcp.py'],
            },
          },
        }),
      )

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const servers = scanner.scanMcpServers()

      expect(servers).toHaveLength(1)
      expect(servers[0]!.name).toBe('project-server')
      expect(servers[0]!.source).toBe(join(projectClaudeDir, 'settings.json'))
    })

    it('combines home and project MCP servers', () => {
      const homeClaudeDir = join(tempHome, '.claude')
      mkdirSync(homeClaudeDir, { recursive: true })
      writeFileSync(
        join(homeClaudeDir, 'settings.json'),
        JSON.stringify({
          mcpServers: { 'home-srv': { command: 'a', args: [] } },
        }),
      )

      const projectClaudeDir = join(tempCwd, '.claude')
      mkdirSync(projectClaudeDir, { recursive: true })
      writeFileSync(
        join(projectClaudeDir, 'settings.json'),
        JSON.stringify({
          mcpServers: { 'proj-srv': { command: 'b', args: [] } },
        }),
      )

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const servers = scanner.scanMcpServers()

      expect(servers).toHaveLength(2)
      expect(servers.map((s) => s.name)).toEqual(['home-srv', 'proj-srv'])
    })

    it('handles missing settings.json → empty array', () => {
      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const servers = scanner.scanMcpServers()
      expect(servers).toEqual([])
    })

    it('handles malformed settings.json → empty array, no crash', () => {
      const claudeDir = join(tempHome, '.claude')
      mkdirSync(claudeDir, { recursive: true })
      writeFileSync(join(claudeDir, 'settings.json'), '{ not valid json !!!')

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const servers = scanner.scanMcpServers()
      expect(servers).toEqual([])
    })

    it('handles settings.json without mcpServers key → empty array', () => {
      const claudeDir = join(tempHome, '.claude')
      mkdirSync(claudeDir, { recursive: true })
      writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ theme: 'dark' }))

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const servers = scanner.scanMcpServers()
      expect(servers).toEqual([])
    })

    it('redacts env vars in MCP server configs', () => {
      const claudeDir = join(tempHome, '.claude')
      mkdirSync(claudeDir, { recursive: true })
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            'secure-server': {
              command: 'node',
              args: ['server.js'],
              env: {
                API_KEY: 'sk-secret-12345',
                DATABASE_URL: 'postgres://user:pass@host/db',
              },
            },
          },
        }),
      )

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const servers = scanner.scanMcpServers()

      expect(servers).toHaveLength(1)
      // env vars should not appear in the result
      const serialized = JSON.stringify(servers[0])
      expect(serialized).not.toContain('sk-secret-12345')
      expect(serialized).not.toContain('postgres://user:pass@host/db')
    })

    it('handles mcpServers entry missing command gracefully', () => {
      const claudeDir = join(tempHome, '.claude')
      mkdirSync(claudeDir, { recursive: true })
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            'bad-entry': { args: ['foo'] },
            'good-entry': { command: 'node', args: ['bar'] },
          },
        }),
      )

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const servers = scanner.scanMcpServers()

      // Should skip the bad entry, keep the good one
      expect(servers).toHaveLength(1)
      expect(servers[0]!.name).toBe('good-entry')
    })
  })

  describe('scanSkills', () => {
    it('scans commands directory with .md skill files → returns DiscoveredSkill entries', () => {
      const commandsDir = join(tempHome, '.claude', 'commands')
      mkdirSync(commandsDir, { recursive: true })

      writeFileSync(
        join(commandsDir, 'deploy.md'),
        `---
name: deploy
description: Deploy the application
argument-hint: <environment>
---

Deploy instructions here.`,
      )

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const skills = scanner.scanSkills()

      expect(skills).toHaveLength(1)
      expect(skills[0]).toEqual({
        name: 'deploy',
        description: 'Deploy the application',
        argumentHint: '<environment>',
        source: join(commandsDir, 'deploy.md'),
      })
    })

    it('parses YAML frontmatter correctly (name, description, argument-hint)', () => {
      const commandsDir = join(tempHome, '.claude', 'commands')
      mkdirSync(commandsDir, { recursive: true })

      writeFileSync(
        join(commandsDir, 'review.md'),
        `---
name: code-review
description: Review code changes
argument-hint: <file-path>
---

Review body.`,
      )

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const skills = scanner.scanSkills()

      expect(skills).toHaveLength(1)
      expect(skills[0]!.name).toBe('code-review')
      expect(skills[0]!.description).toBe('Review code changes')
      expect(skills[0]!.argumentHint).toBe('<file-path>')
    })

    it('uses filename as name when no frontmatter', () => {
      const commandsDir = join(tempHome, '.claude', 'commands')
      mkdirSync(commandsDir, { recursive: true })

      writeFileSync(join(commandsDir, 'quick-fix.md'), 'Just a plain markdown file.')

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const skills = scanner.scanSkills()

      expect(skills).toHaveLength(1)
      expect(skills[0]!.name).toBe('quick-fix')
      expect(skills[0]!.description).toBe('')
      expect(skills[0]!.argumentHint).toBeNull()
    })

    it('handles missing commands directory → empty array', () => {
      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const skills = scanner.scanSkills()
      expect(skills).toEqual([])
    })

    it('ignores non-.md files in commands directory', () => {
      const commandsDir = join(tempHome, '.claude', 'commands')
      mkdirSync(commandsDir, { recursive: true })
      writeFileSync(join(commandsDir, 'notes.txt'), 'not a skill')
      writeFileSync(join(commandsDir, 'skill.md'), 'a skill')

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const skills = scanner.scanSkills()

      expect(skills).toHaveLength(1)
      expect(skills[0]!.name).toBe('skill')
    })

    it('scans project-level .claude/commands/ directory', () => {
      const commandsDir = join(tempCwd, '.claude', 'commands')
      mkdirSync(commandsDir, { recursive: true })

      writeFileSync(
        join(commandsDir, 'local-cmd.md'),
        `---
name: local-cmd
description: A project command
---
Content.`,
      )

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const skills = scanner.scanSkills()

      expect(skills).toHaveLength(1)
      expect(skills[0]!.name).toBe('local-cmd')
    })
  })

  describe('scanInstructions', () => {
    it('finds CLAUDE.md → returns DiscoveredInstruction', () => {
      writeFileSync(
        join(tempCwd, 'CLAUDE.md'),
        'This is a CLAUDE.md file with project instructions.',
      )

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const instructions = scanner.scanInstructions()

      expect(instructions).toHaveLength(1)
      expect(instructions[0]!.source).toBe(join(tempCwd, 'CLAUDE.md'))
      expect(instructions[0]!.contentPreview).toBe(
        'This is a CLAUDE.md file with project instructions.',
      )
      expect(instructions[0]!.fullLength).toBe(51)
    })

    it('finds .github/copilot-instructions.md → returns DiscoveredInstruction', () => {
      const githubDir = join(tempCwd, '.github')
      mkdirSync(githubDir, { recursive: true })
      writeFileSync(
        join(githubDir, 'copilot-instructions.md'),
        'Copilot instructions for the project.',
      )

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const instructions = scanner.scanInstructions()

      expect(instructions).toHaveLength(1)
      expect(instructions[0]!.source).toBe(join(githubDir, 'copilot-instructions.md'))
      expect(instructions[0]!.contentPreview).toBe('Copilot instructions for the project.')
    })

    it('truncates contentPreview to 200 chars', () => {
      const longContent = 'A'.repeat(500)
      writeFileSync(join(tempCwd, 'CLAUDE.md'), longContent)

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const instructions = scanner.scanInstructions()

      expect(instructions[0]!.contentPreview).toHaveLength(200)
      expect(instructions[0]!.fullLength).toBe(500)
    })

    it('returns empty array when no instruction files exist', () => {
      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const instructions = scanner.scanInstructions()
      expect(instructions).toEqual([])
    })

    it('returns both CLAUDE.md and copilot-instructions.md when both exist', () => {
      writeFileSync(join(tempCwd, 'CLAUDE.md'), 'Claude instructions.')
      const githubDir = join(tempCwd, '.github')
      mkdirSync(githubDir, { recursive: true })
      writeFileSync(join(githubDir, 'copilot-instructions.md'), 'Copilot instructions.')

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const instructions = scanner.scanInstructions()

      expect(instructions).toHaveLength(2)
    })
  })

  describe('.github/extensions', () => {
    it('scans .github/extensions directory → returns entries', () => {
      const extDir = join(tempCwd, '.github', 'extensions')
      mkdirSync(extDir, { recursive: true })
      writeFileSync(join(extDir, 'my-tool.js'), '// extension code')
      writeFileSync(join(extDir, 'helper.ts'), '// ts extension')
      writeFileSync(join(extDir, 'config.yaml'), 'name: config')

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const skills = scanner.scanSkills()

      const extensionSkills = skills.filter((s) =>
        s.source.replaceAll('\\', '/').includes('.github/extensions'),
      )
      expect(extensionSkills).toHaveLength(3)
      expect(extensionSkills.map((s) => s.name).sort()).toEqual(
        ['config', 'helper', 'my-tool'].sort(),
      )
    })

    it('handles missing .github/extensions directory → no crash', () => {
      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const skills = scanner.scanSkills()
      // Should not throw, may return empty or just claude commands
      expect(Array.isArray(skills)).toBe(true)
    })
  })

  describe('scan (full)', () => {
    it('returns combined results with timestamp', () => {
      // Set up multiple sources
      const claudeDir = join(tempHome, '.claude')
      mkdirSync(join(claudeDir, 'commands'), { recursive: true })
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            test: { command: 'node', args: [] },
          },
        }),
      )
      writeFileSync(join(claudeDir, 'commands', 'cmd.md'), '---\nname: cmd\n---\nBody')
      writeFileSync(join(tempCwd, 'CLAUDE.md'), 'Instructions')

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const before = new Date().toISOString()
      const result: DiscoveredConfig = scanner.scan()
      const after = new Date().toISOString()

      expect(result.mcpServers).toHaveLength(1)
      expect(result.skills).toHaveLength(1)
      expect(result.instructions).toHaveLength(1)
      expect(result.scannedPaths.length).toBeGreaterThan(0)
      expect(result.scannedAt >= before).toBe(true)
      expect(result.scannedAt <= after).toBe(true)
    })

    it('returns scannedPaths listing only locations that exist', () => {
      // Create one known path so scannedPaths is non-empty
      writeFileSync(join(tempCwd, 'CLAUDE.md'), 'exists')

      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const result = scanner.scan()

      expect(result.scannedPaths).toContain(join(tempCwd, 'CLAUDE.md'))
      // Paths that don't exist should not appear
      expect(result.scannedPaths).not.toContain(join(tempHome, '.claude', 'settings.json'))
    })

    it('works with default options (no args)', () => {
      // Should not throw even with real home/cwd
      const scanner = createConfigScanner()
      const result = scanner.scan()
      expect(result).toBeDefined()
      expect(Array.isArray(result.mcpServers)).toBe(true)
      expect(Array.isArray(result.skills)).toBe(true)
      expect(Array.isArray(result.instructions)).toBe(true)
      expect(typeof result.scannedAt).toBe('string')
    })
  })
})
