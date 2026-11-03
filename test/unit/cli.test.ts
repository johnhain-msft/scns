import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const CLI_PATH = resolve(__dirname, '../../dist/cli.js')

// These tests spawn `node dist/cli.js` as subprocesses. Cold node + CLI load is
// ~0.3s each idle, but the QG tests-gate runs this whole suite inside a git
// worktree WHILE up to SCNS_MAX_CONCURRENT_AGENTS (=12) agents run, so a 3-10×
// slowdown is normal. The old 5s execFileSync timeout AND vitest's default 5s
// per-test timeout both tripped under that load (esp. the 7-spawn subcommand
// test, ~2.15s idle) — a flaky EXIT-1 that the loop's tests-gate then scored as
// a phantom regression. These generous ceilings are upper bounds only: an idle
// run still finishes in ~2s. (See also the parseFailingTests ANSI fix.)
const SPAWN_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = 60_000
const MULTI_SPAWN_TEST_TIMEOUT_MS = 120_000

function runCli(args: string[]): string {
  return execFileSync('node', [CLI_PATH, ...args], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
  })
}

describe('scns CLI', () => {
  it(
    'prints help with --help',
    () => {
      const output = runCli(['--help'])
      expect(output).toContain('Second Central Nervous System')
      expect(output).toContain('start')
      expect(output).toContain('stop')
      expect(output).toContain('status')
      expect(output).toContain('dream')
      expect(output).toContain('search')
      expect(output).toContain('review')
      expect(output).toContain('promote')
      expect(output).toContain('demote')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'prints version with --version',
    () => {
      const output = runCli(['--version'])
      expect(output.trim()).toBe('0.1.0')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'prints help for each subcommand',
    () => {
      const commands = ['start', 'stop', 'status', 'dream', 'review', 'promote', 'demote']
      for (const cmd of commands) {
        const output = runCli([cmd, '--help'])
        expect(output).toBeTruthy()
      }
    },
    MULTI_SPAWN_TEST_TIMEOUT_MS,
  )

  it(
    'search subcommand shows help',
    () => {
      const output = runCli(['search', '--help'])
      expect(output).toContain('query')
      expect(output).toContain('--limit')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'start subcommand shows help with --help',
    () => {
      const output = runCli(['start', '--help'])
      expect(output).toContain('--port')
      expect(output).toContain('--autonomy')
    },
    TEST_TIMEOUT_MS,
  )
})
