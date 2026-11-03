import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from './logger.js'

/** Cleanup must not replace a result/error or escape a background reader. */
export async function withTemporaryDirectory<T>(
  prefix: string,
  work: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await work(directory)
  } finally {
    try {
      // A terminating Windows child can briefly retain its cwd handle.
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (err) {
      logger.warn({ err, directory }, 'Temporary directory cleanup failed; directory retained')
    }
  }
}
