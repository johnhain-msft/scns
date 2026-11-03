/**
 * Windows Terminal flash from the session-discovery poller.
 *
 * `defaultPsProvider` runs `ps -ww -eo pid,args` through `child_process.exec`,
 * which on Windows routes via `cmd.exe`. Without `windowsHide` that allocates a
 * console every tick — and because Windows 11 delegates console hosting to
 * Windows Terminal by default ("Let Windows decide"), each tick opened a full
 * TERMINAL WINDOW, not a small conhost.
 *
 * Measured live on win32 (2026-09-14): a `WindowsTerminal.exe -Embedding`
 * window appeared at 16:50:17, :32, :47, 16:51:02, :17, :32 — a perfect 15s
 * cadence matching DEFAULT_INTERVAL_MS, each immediately preceded by
 * `cmd.exe /d /s /c "ps -ww -eo pid,args"`.
 *
 * Isolated in its own file so the child_process mock cannot leak into the main
 * session-discovery tests, which inject their own psProvider.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const execCalls: { cmd: string; options: Record<string, unknown> }[] = []

// `session-discovery.ts` uses `promisify(exec)`, which takes Node's
// `util.promisify.custom` path on child_process.exec and resolves to
// `{ stdout, stderr }`. The mock must provide that symbol or the promisified
// call resolves to a bare string.
vi.mock('node:child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom')
  const exec = Object.assign(
    (cmd: string, options: Record<string, unknown>, cb?: (...a: unknown[]) => void) => {
      execCalls.push({ cmd, options: options ?? {} })
      cb?.(null, '', '')
      return {}
    },
    {
      [custom]: (cmd: string, options: Record<string, unknown>) => {
        execCalls.push({ cmd, options: options ?? {} })
        return Promise.resolve({ stdout: '', stderr: '' })
      },
    },
  )
  return { exec }
})

const { startSessionDiscovery } = await import('../../../src/broker/session-discovery.js')
const { openDatabase, closeDatabase } = await import('../../../src/broker/storage/db.js')
const { createEventLog } = await import('../../../src/broker/services/event-log.js')
const { createEventDispatcher } = await import('../../../src/broker/event-dispatcher.js')

describe('session-discovery poller must not open a console window (win32)', () => {
  let db: ReturnType<typeof openDatabase>
  let eventLog: ReturnType<typeof createEventLog>
  let discovery: ReturnType<typeof startSessionDiscovery> | undefined

  beforeEach(() => {
    execCalls.length = 0
    db = openDatabase(':memory:')
    eventLog = createEventLog(db, createEventDispatcher())
  })

  afterEach(() => {
    discovery?.stop()
    closeDatabase(db)
  })

  it('passes windowsHide on the ps probe it runs every tick', async () => {
    discovery = startSessionDiscovery(db, eventLog, { skipInitialTick: true })
    await discovery.tick()

    // The probe is `ps` off-Windows and a Win32_Process query on win32.
    const ps = execCalls.find((c) => c.cmd.includes('ps -ww') || c.cmd.includes('Win32_Process'))
    expect(ps, 'expected the default psProvider to shell out').toBeDefined()
    expect(ps!.options).toMatchObject({ windowsHide: true })
  })

  it('keeps the existing timeout and maxBuffer guards alongside windowsHide', async () => {
    discovery = startSessionDiscovery(db, eventLog, { skipInitialTick: true, psTimeoutMs: 1234 })
    await discovery.tick()

    const ps = execCalls.find((c) => c.cmd.includes('ps -ww') || c.cmd.includes('Win32_Process'))!
    expect(ps.options).toMatchObject({ timeout: 1234, windowsHide: true })
    expect(ps.options['maxBuffer']).toBeGreaterThan(0)
  })
})
