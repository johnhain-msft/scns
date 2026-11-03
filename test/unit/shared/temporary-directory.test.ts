import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../../../src/shared/logger.js'
import { withTemporaryDirectory } from '../../../src/shared/temporary-directory.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rm: vi.fn(fs.rm) }
})

const leftovers: string[] = []

afterEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  for (const path of leftovers.splice(0)) {
    await fs.rm(path, { recursive: true, force: true })
  }
  vi.mocked(rm).mockReset().mockImplementation(fs.rm)
})

describe('withTemporaryDirectory', () => {
  it('removes only the allocated directory after the work finishes', async () => {
    let allocated = ''
    const result = await withTemporaryDirectory('scns-followup-test-', async (dir) => {
      allocated = dir
      expect(existsSync(dir)).toBe(true)
      await writeFile(join(dir, 'result.txt'), 'completed')
      return 42
    })
    expect(result).toBe(42)
    expect(existsSync(allocated)).toBe(false)
    expect(rm).toHaveBeenCalledWith(allocated, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  })

  it('preserves the work error while still removing the directory', async () => {
    let allocated = ''
    const workError = new Error('reader failed')
    await expect(
      withTemporaryDirectory('scns-followup-test-', async (dir) => {
        allocated = dir
        throw workError
      }),
    ).rejects.toBe(workError)
    expect(existsSync(allocated)).toBe(false)
  })

  it('does not turn an exhausted Windows cleanup retry into a broker-fatal rejection', async () => {
    const err = Object.assign(new Error('directory still locked'), { code: 'EBUSY' })
    vi.mocked(rm).mockRejectedValueOnce(err)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const result = await withTemporaryDirectory('scns-followup-test-', async (dir) => {
      leftovers.push(dir)
      return null
    })
    expect(result).toBeNull()
    expect(existsSync(leftovers[0]!)).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      { err, directory: leftovers[0] },
      'Temporary directory cleanup failed; directory retained',
    )
  })

  it('reports cleanup failure without replacing a failed read with a different error', async () => {
    vi.mocked(rm).mockRejectedValueOnce(
      Object.assign(new Error('access denied'), { code: 'EPERM' }),
    )
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const workError = new Error('classification failed')
    await expect(
      withTemporaryDirectory('scns-followup-test-', async (dir) => {
        leftovers.push(dir)
        throw workError
      }),
    ).rejects.toBe(workError)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
