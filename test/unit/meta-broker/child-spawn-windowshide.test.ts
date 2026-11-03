/**
 * Windows console-window leak on child-broker spawn.
 *
 * `spawnChild` launched every per-project broker WITHOUT `windowsHide`, so on
 * win32 each spawn popped a visible console window onto the user's desktop.
 * With 7 registered projects — and a supervisor that respawns a child whenever
 * one exits or is replaced — this produced a stream of windows jumping to the
 * foreground during normal operation.
 *
 * Every other process-spawn site in this codebase already passes
 * `windowsHide: true` (cli/watchdog-runtime.ts, cli/meta-supervision.ts,
 * cli/blue-green-runtime.ts, copilot-extension/extension-template.ts); the
 * meta-supervisor was the sole exception, and the noisiest one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

const spawnCalls: { args: readonly string[]; options: Record<string, unknown> }[] = []

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (cmd: string, args: readonly string[], options: Record<string, unknown>) => {
      spawnCalls.push({ args, options })
      return {
        pid: 4242,
        on: () => undefined,
        kill: () => true,
        unref: () => undefined,
      } as unknown as ReturnType<typeof actual.spawn>
    },
  }
})

const { createMetaSupervisor } = await import('../../../src/meta-broker/meta-supervisor.js')
type MetaSupervisor = Awaited<
  ReturnType<typeof import('../../../src/meta-broker/meta-supervisor.js').createMetaSupervisor>
>
const { applyMetaSchema, registerProject } = await import('../../../src/meta-broker/registry.js')

const PROJECT_ID = 'proj-windowshide'

describe('meta-supervisor child spawn (win32 console-window leak)', () => {
  let db: Database.Database
  let tempDir: string
  let supervisor: MetaSupervisor

  beforeEach(() => {
    spawnCalls.length = 0
    db = new Database(':memory:')
    applyMetaSchema(db)
    tempDir = mkdtempSync(join(tmpdir(), 'scns-windowshide-'))
    registerProject(db, { projectId: PROJECT_ID, projectRoot: join(tempDir, 'repo') })
    supervisor = createMetaSupervisor({
      db,
      brokerEntry: 'dist/cli.js',
      projectDbDir: tempDir,
      httpProbe: async () => true,
    })
  })

  afterEach(async () => {
    await supervisor.stop()
    db.close()
    // spawnChild opens the child log fd; with spawn mocked nothing closes it,
    // so cleanup is best-effort.
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* temp dir is disposable */
    }
  })

  it('spawns child brokers with windowsHide so no console window is shown', async () => {
    await supervisor.tickOnce()

    expect(spawnCalls.length).toBeGreaterThan(0)
    for (const call of spawnCalls) {
      expect(call.options).toMatchObject({ windowsHide: true })
    }
  })
})
