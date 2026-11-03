import { describe, it, expect } from 'vitest'
import {
  createSystemExecutor,
  isDarwin,
  type CommandExecutor,
  type CommandResult,
} from '../../../src/observe/command-executor.js'

describe('CommandExecutor types', () => {
  it('createSystemExecutor returns an object with execute method', () => {
    const executor = createSystemExecutor()
    expect(executor).toBeDefined()
    expect(typeof executor.execute).toBe('function')
  })

  it('isDarwin returns a boolean', () => {
    const result = isDarwin()
    expect(typeof result).toBe('boolean')
  })
})

describe('mock CommandExecutor', () => {
  function createMockExecutor(result: CommandResult): CommandExecutor {
    return {
      execute: async () => result,
    }
  }

  it('returns expected stdout', async () => {
    const executor = createMockExecutor({ stdout: 'hello', stderr: '', exitCode: 0 })
    const result = await executor.execute('echo', ['hello'])
    expect(result.stdout).toBe('hello')
    expect(result.exitCode).toBe(0)
  })

  it('returns expected stderr and non-zero exit code', async () => {
    const executor = createMockExecutor({ stdout: '', stderr: 'error', exitCode: 1 })
    const result = await executor.execute('fail')
    expect(result.stderr).toBe('error')
    expect(result.exitCode).toBe(1)
  })

  it('execute with args passes through', async () => {
    const calls: Array<{ command: string; args?: readonly string[] }> = []
    const executor: CommandExecutor = {
      execute: async (command, args) => {
        calls.push({ command, args })
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }
    await executor.execute('osascript', ['-e', 'tell app'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe('osascript')
    expect(calls[0]!.args).toEqual(['-e', 'tell app'])
  })

  it('handles empty stdout gracefully', async () => {
    const executor = createMockExecutor({ stdout: '', stderr: '', exitCode: 0 })
    const result = await executor.execute('cmd')
    expect(result.stdout).toBe('')
  })
})

/**
 * These exercise real process spawning, so they need a real executable.
 * `echo` / `false` / `sh` are POSIX assumptions: on Windows `echo` is a
 * cmd.exe builtin rather than a binary, so `spawn('echo')` produces empty
 * stdout, and `spawn('false')` fails to launch at all — which made the
 * exit-code assertion pass for the wrong reason (#54).
 *
 * `process.execPath` is the running Node binary: present on every platform
 * the suite supports, and it lets each case assert precisely what it means.
 */
describe('createSystemExecutor integration', () => {
  const node = process.execPath

  it('can execute a simple command', async () => {
    const executor = createSystemExecutor()
    const result = await executor.execute(node, ['-e', 'process.stdout.write("hello")'])
    expect(result.stdout.trim()).toBe('hello')
    expect(result.exitCode).toBe(0)
  })

  it('reports the child’s real exit code, not a collapsed 1', async () => {
    const executor = createSystemExecutor()
    const result = await executor.execute(node, ['-e', 'process.exit(3)'])
    expect(result.exitCode).toBe(3)
  })

  it('distinguishes one non-zero exit code from another', async () => {
    const executor = createSystemExecutor()
    const result = await executor.execute(node, ['-e', 'process.exit(127)'])
    expect(result.exitCode).toBe(127)
  })

  it('reports 1 when the command cannot be spawned at all', async () => {
    const executor = createSystemExecutor()
    const result = await executor.execute('scns-no-such-binary-38f1c0', [])
    expect(result.exitCode).toBe(1)
  })

  it('captures stderr output', async () => {
    const executor = createSystemExecutor()
    const result = await executor.execute(node, ['-e', 'process.stderr.write("err")'])
    expect(result.stderr.trim()).toBe('err')
  })
})
