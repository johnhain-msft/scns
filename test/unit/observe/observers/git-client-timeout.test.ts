import { describe, it, expect, vi, beforeEach } from 'vitest'

// Isolated in its own file so the child_process mock does not affect the
// observer tests (which inject a mock GitClient and never touch execFile).
const execFileMock = vi.fn(
  (_file: string, _args: string[], _opts: { cwd: string; timeout: number }, cb: (err: Error | null, stdout: string) => void) =>
    cb(null, ''),
)

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => (execFileMock as (...a: unknown[]) => void)(...args),
}))

import {
  createGitClient,
  DEFAULT_GIT_EXEC_TIMEOUT_MS,
} from '../../../../src/observe/observers/git-activity.js'

describe('createGitClient execTimeoutMs threading', () => {
  beforeEach(() => {
    execFileMock.mockClear()
  })

  it('defaults to DEFAULT_GIT_EXEC_TIMEOUT_MS (30s, up from the original 10s)', async () => {
    expect(DEFAULT_GIT_EXEC_TIMEOUT_MS).toBe(30_000)
    await createGitClient().isRepo('/x')
    expect(execFileMock).toHaveBeenCalled()
    const opts = execFileMock.mock.calls[0]![2] as { timeout: number }
    expect(opts.timeout).toBe(DEFAULT_GIT_EXEC_TIMEOUT_MS)
  })

  it('honors a custom execTimeoutMs on every git command', async () => {
    const client = createGitClient({ execTimeoutMs: 45_000 })
    await client.log('/x', '2026-01-01T00:00:00Z')
    await client.branches('/x')
    await client.currentBranch('/x')
    await client.isRepo('/x')
    expect(execFileMock).toHaveBeenCalledTimes(4)
    for (const call of execFileMock.mock.calls) {
      const opts = call[2] as { timeout: number }
      expect(opts.timeout).toBe(45_000)
    }
  })
})
