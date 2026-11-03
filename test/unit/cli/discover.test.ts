import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Command } from 'commander'
import { createConfigScanner } from '../../../src/observe/discovery/config-scanner.js'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'scns-discover-'))
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

/**
 * Build a Commander program with discover subcommands that use a scanner
 * pointed at specific temp directories for deterministic testing.
 */
function buildDiscoverProgram(tempHome: string, tempCwd: string): Command {
  const program = new Command()
  program.name('scns').version('0.1.0').exitOverride()

  const discover = program
    .command('discover')
    .description('Discover MCPs, skills, and instructions from config files')
    .action(async () => {
      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const result = scanner.scan()

      if (result.mcpServers.length > 0) {
        console.log(`\nMCP Servers (${result.mcpServers.length} found):`)
        for (const mcp of result.mcpServers) {
          const cmdStr = [mcp.command, ...mcp.args].join(' ')
          console.log(`  ✓ ${mcp.name} — ${cmdStr}`)
        }
      } else {
        console.log('\nMCP Servers: none found')
      }

      if (result.skills.length > 0) {
        console.log(`\nSkills (${result.skills.length} found):`)
        for (const skill of result.skills) {
          const desc = skill.description ? ` — ${skill.description}` : ''
          console.log(`  • ${skill.name}${desc}`)
        }
      } else {
        console.log('\nSkills: none found')
      }

      if (result.instructions.length > 0) {
        console.log(`\nInstructions (${result.instructions.length} found):`)
        for (const inst of result.instructions) {
          // basename, not split('/'): sources are `\`-joined on win32
          // (mirrors the same fix in src/cli.ts's discover action).
          const name = basename(inst.source)
          console.log(`  • ${name} (${inst.fullLength.toLocaleString()} chars)`)
        }
      } else {
        console.log('\nInstructions: none found')
      }

      console.log()
    })

  discover
    .command('mcps')
    .description('List discovered MCP servers')
    .action(async () => {
      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const servers = scanner.scanMcpServers()

      if (servers.length > 0) {
        console.log(`\nMCP Servers (${servers.length} found):`)
        for (const mcp of servers) {
          const cmdStr = [mcp.command, ...mcp.args].join(' ')
          console.log(`  ✓ ${mcp.name} — ${cmdStr}`)
        }
      } else {
        console.log('\nMCP Servers: none found')
      }

      console.log()
    })

  discover
    .command('skills')
    .description('List discovered skills and commands')
    .action(async () => {
      const scanner = createConfigScanner({ homeDir: tempHome, cwd: tempCwd })
      const skills = scanner.scanSkills()

      if (skills.length > 0) {
        console.log(`\nSkills (${skills.length} found):`)
        for (const skill of skills) {
          const desc = skill.description ? ` — ${skill.description}` : ''
          console.log(`  • ${skill.name}${desc}`)
        }
      } else {
        console.log('\nSkills: none found')
      }

      console.log()
    })

  return program
}

describe('scns discover CLI', () => {
  let tempHome: string
  let tempCwd: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tempHome = makeTempDir()
    tempCwd = makeTempDir()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    rmSync(tempHome, { recursive: true, force: true })
    rmSync(tempCwd, { recursive: true, force: true })
  })

  describe('scns discover', () => {
    it('shows MCPs, skills, and instructions', async () => {
      writeSettingsJson(tempHome, {
        'github-mcp-server': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      })
      writeSkillFile(tempHome, 'quality-gate', 'Create rubric and review')
      writeFileSync(join(tempCwd, 'CLAUDE.md'), 'Project instructions here.')

      const program = buildDiscoverProgram(tempHome, tempCwd)
      await program.parseAsync(['node', 'scns', 'discover'])

      const output = logSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('MCP Servers (2 found)')
      expect(output).toContain('✓ github-mcp-server')
      expect(output).toContain('✓ filesystem')
      expect(output).toContain('Skills (1 found)')
      expect(output).toContain('• quality-gate — Create rubric and review')
      expect(output).toContain('Instructions (1 found)')
      expect(output).toContain('• CLAUDE.md')
    })

    it('shows empty messages when nothing found', async () => {
      const program = buildDiscoverProgram(tempHome, tempCwd)
      await program.parseAsync(['node', 'scns', 'discover'])

      const output = logSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('MCP Servers: none found')
      expect(output).toContain('Skills: none found')
      expect(output).toContain('Instructions: none found')
    })
  })

  describe('scns discover mcps', () => {
    it('shows only MCP servers', async () => {
      writeSettingsJson(tempHome, {
        'github-mcp-server': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
      })
      writeSkillFile(tempHome, 'some-skill', 'Should not appear')

      const program = buildDiscoverProgram(tempHome, tempCwd)
      await program.parseAsync(['node', 'scns', 'discover', 'mcps'])

      const output = logSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('MCP Servers (1 found)')
      expect(output).toContain('✓ github-mcp-server')
      // Should not contain skills or instructions sections
      expect(output).not.toContain('Skills')
      expect(output).not.toContain('Instructions')
    })

    it('shows empty message when no MCPs found', async () => {
      const program = buildDiscoverProgram(tempHome, tempCwd)
      await program.parseAsync(['node', 'scns', 'discover', 'mcps'])

      const output = logSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('MCP Servers: none found')
    })
  })

  describe('scns discover skills', () => {
    it('shows only skills', async () => {
      writeSkillFile(tempHome, 'quality-gate', 'Run quality checks')
      writeSkillFile(tempHome, 'wiggum-review', 'Multi-pass review')
      writeSettingsJson(tempHome, {
        'hidden-server': { command: 'node', args: [] },
      })

      const program = buildDiscoverProgram(tempHome, tempCwd)
      await program.parseAsync(['node', 'scns', 'discover', 'skills'])

      const output = logSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('Skills (2 found)')
      expect(output).toContain('• quality-gate — Run quality checks')
      expect(output).toContain('• wiggum-review — Multi-pass review')
      // Should not contain MCP or instruction sections
      expect(output).not.toContain('MCP Servers')
      expect(output).not.toContain('Instructions')
    })

    it('shows empty message when no skills found', async () => {
      const program = buildDiscoverProgram(tempHome, tempCwd)
      await program.parseAsync(['node', 'scns', 'discover', 'skills'])

      const output = logSpy.mock.calls.map((c) => c[0]).join('\n')
      expect(output).toContain('Skills: none found')
    })
  })
})
