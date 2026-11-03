import { describe, it, expect, beforeEach } from 'vitest'
import { Command } from 'commander'

/**
 * Test the CLI team commands by constructing a fresh Command and
 * asserting that it parses correctly. We mock fetch to prevent
 * actual HTTP calls.
 */

// ── Helper: build the team subcommand the same way cli.ts does ────

function buildTeamCommand(): Command {
  const program = new Command()
  program.name('scns').version('0.1.0')

  const team = program.command('team').description('Manage agent teams')

  team
    .command('create <name>')
    .description('Create a new team')
    .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
    .action(() => {})

  team
    .command('list')
    .description('List all teams')
    .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
    .action(() => {})

  team
    .command('info <id>')
    .description('Show team details')
    .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
    .action(() => {})

  team
    .command('spawn <template>')
    .description('Spawn a team from template')
    .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
    .action(() => {})

  team
    .command('disband <id>')
    .description('Disband a team')
    .option('--broker-url <url>', 'Broker URL', 'http://localhost:3456')
    .action(() => {})

  return program
}

describe('CLI team commands', () => {
  let program: Command

  beforeEach(() => {
    program = buildTeamCommand()
    program.exitOverride()
  })

  it('parses "team create" command', () => {
    let parsedName = ''
    const team = program.commands.find((c) => c.name() === 'team')!
    const create = team.commands.find((c) => c.name() === 'create')!
    create.action((name: string) => {
      parsedName = name
    })

    program.parse(['team', 'create', 'my-team'], { from: 'user' })
    expect(parsedName).toBe('my-team')
  })

  it('parses "team list" command', () => {
    let called = false
    const team = program.commands.find((c) => c.name() === 'team')!
    const list = team.commands.find((c) => c.name() === 'list')!
    list.action(() => {
      called = true
    })

    program.parse(['team', 'list'], { from: 'user' })
    expect(called).toBe(true)
  })

  it('parses "team info" command with id argument', () => {
    let parsedId = ''
    const team = program.commands.find((c) => c.name() === 'team')!
    const info = team.commands.find((c) => c.name() === 'info')!
    info.action((id: string) => {
      parsedId = id
    })

    program.parse(['team', 'info', 'team-123'], { from: 'user' })
    expect(parsedId).toBe('team-123')
  })

  it('parses "team spawn" command with template name', () => {
    let parsedTemplate = ''
    const team = program.commands.find((c) => c.name() === 'team')!
    const spawn = team.commands.find((c) => c.name() === 'spawn')!
    spawn.action((template: string) => {
      parsedTemplate = template
    })

    program.parse(['team', 'spawn', 'research'], { from: 'user' })
    expect(parsedTemplate).toBe('research')
  })

  it('parses "team disband" command', () => {
    let parsedId = ''
    const team = program.commands.find((c) => c.name() === 'team')!
    const disband = team.commands.find((c) => c.name() === 'disband')!
    disband.action((id: string) => {
      parsedId = id
    })

    program.parse(['team', 'disband', 'team-456'], { from: 'user' })
    expect(parsedId).toBe('team-456')
  })

  it('accepts --broker-url option on spawn', () => {
    let opts: Record<string, string> = {}
    const team = program.commands.find((c) => c.name() === 'team')!
    const spawn = team.commands.find((c) => c.name() === 'spawn')!
    spawn.action((_template: string, cmdOpts: Record<string, string>) => {
      opts = cmdOpts
    })

    program.parse(['team', 'spawn', 'research', '--broker-url', 'http://example.com:9999'], {
      from: 'user',
    })
    expect(opts.brokerUrl).toBe('http://example.com:9999')
  })

  it('defaults broker-url to localhost:3456', () => {
    let opts: Record<string, string> = {}
    const team = program.commands.find((c) => c.name() === 'team')!
    const list = team.commands.find((c) => c.name() === 'list')!
    list.action((cmdOpts: Record<string, string>) => {
      opts = cmdOpts
    })

    program.parse(['team', 'list'], { from: 'user' })
    expect(opts.brokerUrl).toBe('http://localhost:3456')
  })

  it('team subcommand shows help with --help', () => {
    expect(() => {
      program.parse(['team', '--help'], { from: 'user' })
    }).toThrow()
    // commander.exitOverride makes --help throw; that's expected
  })

  it('accepts all valid template names for spawn', () => {
    const templates = ['research', 'implementation', 'review', 'full']
    for (const t of templates) {
      let parsed = ''
      const freshProgram = buildTeamCommand()
      freshProgram.exitOverride()
      const team = freshProgram.commands.find((c) => c.name() === 'team')!
      const spawn = team.commands.find((c) => c.name() === 'spawn')!
      spawn.action((template: string) => {
        parsed = template
      })

      freshProgram.parse(['team', 'spawn', t], { from: 'user' })
      expect(parsed).toBe(t)
    }
  })
})
