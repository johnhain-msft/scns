/**
 * Windows console-window flash from observer shell-outs.
 *
 * Observers shell out on timers: `activeApp` every 30s (enabled by default),
 * `terminalHistory` every 60s, `gitActivity` every 300s. None of those exec
 * calls passed `windowsHide`, so on win32 EVERY poll flashed a console window
 * onto the desktop. With one broker per project (7 registered) the activeApp
 * poll alone averages a window every ~4 seconds — observed live as "a small
 * window keeps opening and closing".
 *
 * Isolated in its own file because the child_process mock must not leak into
 * observer tests that inject their own clients.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.fn((...args: unknown[]) => {
  const cb = args.find((a) => typeof a === 'function') as
    | ((err: Error | null, stdout: string, stderr: string) => void)
    | undefined
  cb?.(null, '', '')
})

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}))

const { createGitClient } = await import('../../../src/observe/observers/git-activity.js')
const { createSystemExecutor } = await import('../../../src/observe/command-executor.js')

/** The options object is whichever argument is a plain object. */
function optionsOf(call: unknown[]): Record<string, unknown> {
  const opts = call.find(
    (a) => a !== null && typeof a === 'object' && !Array.isArray(a),
  ) as Record<string, unknown> | undefined
  return opts ?? {}
}

describe('observer shell-outs never flash a console window on win32', () => {
  beforeEach(() => {
    execFileMock.mockClear()
  })

  it('createSystemExecutor passes windowsHide (activeApp / terminalHistory polls)', async () => {
    await createSystemExecutor().execute('powershell', ['-Command', 'Get-Date'])

    expect(execFileMock).toHaveBeenCalled()
    expect(optionsOf(execFileMock.mock.calls[0]!)).toMatchObject({ windowsHide: true })
  })

  it('createSystemExecutor still reports stdout and exit code', async () => {
    const result = await createSystemExecutor().execute('echo', ['hi'])
    expect(result.exitCode).toBe(0)
  })

  it('createGitClient passes windowsHide on every git command', async () => {
    const client = createGitClient()
    await client.log('/x', '2026-01-01T00:00:00Z')
    await client.branches('/x')
    await client.currentBranch('/x')
    await client.isRepo('/x')

    expect(execFileMock).toHaveBeenCalledTimes(4)
    for (const call of execFileMock.mock.calls) {
      expect(optionsOf(call)).toMatchObject({ windowsHide: true })
    }
  })

  it('createGitClient keeps threading cwd and timeout alongside windowsHide', async () => {
    await createGitClient({ execTimeoutMs: 45_000 }).isRepo('/some/repo')
    expect(optionsOf(execFileMock.mock.calls[0]!)).toMatchObject({
      cwd: '/some/repo',
      timeout: 45_000,
      windowsHide: true,
    })
  })
})
