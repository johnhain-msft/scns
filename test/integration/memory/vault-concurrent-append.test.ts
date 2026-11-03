/**
 * Concurrent daily-log append — regression for the duplicate-broker data race.
 *
 * Observed live (2026-09-14): the meta-supervisor had THREE live child brokers
 * for a single project (`fabrikam-844e15e6` on ports 3502/3503/3507), each running
 * its own file-changes observer, all appending to the SAME daily log file.
 *
 * `vault.append()` is a read-modify-write — `readFileSync` → concat →
 * `writeFileSync(tmp)` → `renameSync(tmp, dest)`. Across processes that is
 * unsafe twice over:
 *
 *   1. LOST UPDATES — two writers that read the same snapshot each rewrite the
 *      whole file, and the last one to rename silently discards the other's entry.
 *   2. EPERM ON RENAME — on win32, renaming onto a destination another process
 *      holds open throws `EPERM`, which reached the process-level uncaught
 *      handler and killed the whole broker (131 distinct PIDs crashed this way).
 *
 * A daily log is append-only, so it must be written with O_APPEND and never
 * rewritten wholesale. This test spawns real concurrent processes because the
 * failure only exists across processes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { nodeBinArgv } from '../../helpers/node-bin.js'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const VAULT_SRC = pathToFileURL(join(REPO_ROOT, 'src', 'memory', 'vault.ts')).href

const WORKERS = 4
const ENTRIES_PER_WORKER = 25
const TOTAL = WORKERS * ENTRIES_PER_WORKER
const LOG_DATE = '2026-09-14T12:00:00.000Z'

/** Worker: append ENTRIES_PER_WORKER uniquely-tagged entries to the shared daily log. */
const WORKER_SRC = `
import { createVault } from ${JSON.stringify(VAULT_SRC)}
const [rootDir, workerId, count, isoDate] = process.argv.slice(2)
const vault = createVault({ rootDir })
const when = new Date(isoDate)
for (let i = 0; i < Number(count); i++) {
  vault.appendDailyLog('MARK-' + workerId + '-' + i, when)
}
`

function runWorkers(rootDir: string, workerScript: string): Promise<number[]> {
  const [nodeBin, tsxCli] = nodeBinArgv(REPO_ROOT, 'tsx')
  return Promise.all(
    Array.from({ length: WORKERS }, (_, id) => {
      return new Promise<number>((resolveExit, rejectExit) => {
        const proc = spawn(
          nodeBin,
          [tsxCli, workerScript, rootDir, String(id), String(ENTRIES_PER_WORKER), LOG_DATE],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        let stderr = ''
        proc.stderr.on('data', (c) => (stderr += String(c)))
        proc.on('error', rejectExit)
        proc.on('exit', (code) => {
          if (code !== 0 && stderr.length > 0) {
            rejectExit(new Error(`worker ${id} exited ${code}: ${stderr.slice(0, 600)}`))
            return
          }
          resolveExit(code ?? -1)
        })
      })
    }),
  )
}

describe('vault daily-log append under concurrent processes', () => {
  let rootDir: string
  let workerScript: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'scns-vault-concurrent-'))
    mkdirSync(join(rootDir, 'daily'), { recursive: true })
    // Seed a realistic backlog. The live file was ~1.2 MB; a large file widens
    // the read-modify-write window so the race is reliably observable.
    writeFileSync(
      join(rootDir, 'daily', '2026-09-14.md'),
      '# seed\n' + 'x'.repeat(400_000),
      'utf-8',
    )
    workerScript = join(rootDir, 'worker.ts')
    writeFileSync(workerScript, WORKER_SRC, 'utf-8')
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('keeps every entry written by every process (no lost updates, no crash)', async () => {
    const exitCodes = await runWorkers(rootDir, workerScript)

    // No worker may die. On win32 the pre-fix code threw EPERM from renameSync,
    // which is exactly how the live brokers were killed.
    expect(exitCodes).toEqual(Array.from({ length: WORKERS }, () => 0))

    const logPath = join(rootDir, 'daily', '2026-09-14.md')
    expect(existsSync(logPath)).toBe(true)
    const content = readFileSync(logPath, 'utf-8')

    const missing: string[] = []
    for (let w = 0; w < WORKERS; w++) {
      for (let i = 0; i < ENTRIES_PER_WORKER; i++) {
        if (!content.includes(`MARK-${w}-${i}`)) missing.push(`MARK-${w}-${i}`)
      }
    }
    expect({ missing: missing.length, sample: missing.slice(0, 5) }).toEqual({
      missing: 0,
      sample: [],
    })

    // Exactly one entry per append — no losses and no duplicates.
    expect(content.match(/MARK-\d+-\d+/g)?.length ?? 0).toBe(TOTAL)

    // The seeded backlog must survive too — a lost update truncates history.
    expect(content.startsWith('# seed')).toBe(true)
    expect(content.length).toBeGreaterThan(400_000)
  }, 60_000)

  it('leaves no temp files behind (append must not stage through rename)', async () => {
    await runWorkers(rootDir, workerScript)
    const { readdirSync } = await import('node:fs')
    const strays = readdirSync(join(rootDir, 'daily')).filter((f) => f.startsWith('.tmp-'))
    expect(strays).toEqual([])
  }, 60_000)
})
