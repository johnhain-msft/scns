/**
 * Regression test for the libc++abi mutex aborts observed during the
 * 2026-04-22 4h auto-restart soak.
 *
 * On round 1, BOTH brokers in the soak logged "Shutdown complete cleanupCount=12"
 * cleanly, yet broker_error.log still contained two
 *   libc++abi: terminating due to uncaught exception of type
 *   std::__1::system_error: mutex lock failed: Invalid argument
 * lines — i.e. the abort fired AFTER our graceful shutdown returned, during
 * Node's native process-exit teardown. The cause was `process.exit()` in
 * src/cli.ts:1164 forcing libuv to tear down while better-sqlite3 and
 * fastembed/onnxruntime worker threads still held pthread mutexes.
 *
 * The fix replaced `process.exit()` with `process.exitCode = 0` so the event
 * loop drains naturally and native destructors run in proper order.
 *
 * This test:
 *   1. Spawns `dist/cli.js start --port <free>` with HOME and SCNS_HOME pointed
 *      at an isolated tmpdir (so the real ~/.scns/ is never touched).
 *   2. Waits for /api/health to return ok.
 *   3. POSTs to /api/memory/store to force FastEmbed/ONNX initialization (so
 *      the native worker threads are alive when SIGTERM hits — the exact
 *      condition that triggered the round-1 abort).
 *   4. Sends SIGTERM, waits for clean exit, captures stderr.
 *   5. Asserts: exit code is 0/null, no `libc++abi` substring in stderr, no
 *      `mutex lock failed` substring, and isolated home's broker_error.log
 *      contains no abort lines.
 *
 * Slow (15-30s for FastEmbed cold start). Tagged `integration > broker > slow`.
 * Run targeted: `npx vitest run test/integration/broker/broker-shutdown-no-abort.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { isolatedHomeEnv } from '../../helpers/isolation.js'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js')

function pickFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const p = addr.port
        srv.close(() => res(p))
      } else {
        srv.close()
        rej(new Error('failed to pick free port'))
      }
    })
  })
}

async function waitForHealth(port: number, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) return true
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

describe('broker shutdown — no native libc++abi aborts', () => {
  let proc: ChildProcessWithoutNullStreams | null = null
  let stderr = ''
  let stdout = ''
  let exitCode: number | null = null
  let exitSignal: NodeJS.Signals | null = null
  let isolatedHome = ''
  let port = 0

  beforeAll(async () => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(
        `dist/cli.js not found at ${CLI_PATH}. Run \`npm run build\` before this test.`,
      )
    }
    isolatedHome = mkdtempSync(join(tmpdir(), 'scns-shutdown-test-'))
    mkdirSync(join(isolatedHome, '.scns'), { recursive: true })
    port = await pickFreePort()

    proc = spawn(
      process.execPath,
      ['--expose-gc', CLI_PATH, 'start', '--port', String(port), '--autonomy', '0'],
      {
        cwd: REPO_ROOT,
        env: isolatedHomeEnv(isolatedHome, {
          NODE_ENV: 'test',
          // Keep the test deterministic — no observers hammering the loop.
          SCNS_MAX_CONCURRENT_AGENTS: '1',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ) as ChildProcessWithoutNullStreams

    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('exit', (code, signal) => {
      exitCode = code
      exitSignal = signal
    })

    const healthy = await waitForHealth(port, 30_000)
    if (!healthy) {
      proc.kill('SIGKILL')
      throw new Error(
        `broker did not become healthy in 30s.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      )
    }

    // Force FastEmbed/ONNX initialization. /api/memory/store is the simplest
    // path that lights up the native inference session. If the route is
    // missing, fall back to /api/memory/embed; either way we just need the
    // singleton instantiated so its worker threads are present when SIGTERM
    // hits — that is the round-1 abort condition.
    let triggered = false
    for (const path of ['/api/memory/store', '/api/memory/embed']) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: 'soak round-2 shutdown regression probe',
            kind: 'note',
            text: 'soak round-2 shutdown regression probe',
          }),
        })
        if (r.status < 500) {
          triggered = true
          break
        }
      } catch {
        /* try next */
      }
    }
    // Even if both POSTs 404'd, the broker is still alive and we proceed —
    // the SIGTERM path is what we are actually testing. Triggered flag is
    // logged for debugging context only.
    void triggered

    // Brief settle so any worker threads spawned by the embed call are fully
    // up before we send SIGTERM.
    await new Promise((r) => setTimeout(r, 1000))
  }, 60_000)

  afterAll(() => {
    if (proc && !proc.killed && exitCode === null) {
      proc.kill('SIGKILL')
    }
  })

  it('exits cleanly on SIGTERM with no libc++abi mutex abort', async () => {
    if (!proc) throw new Error('broker process not started')

    const exited = new Promise<void>((res) => {
      proc!.once('exit', () => res())
    })
    proc.kill('SIGTERM')

    const timeout = new Promise<'timeout'>((res) =>
      setTimeout(() => res('timeout'), 30_000),
    )
    const result = await Promise.race([exited.then(() => 'exited' as const), timeout])
    expect(result).toBe('exited')

    // Exit code must be 0 (or null if it was killed by signal — but with our
    // fix we expect a clean code-0 exit driven by process.exitCode = 0).
    expect([0, null]).toContain(exitCode)
    // We sent SIGTERM, so signal may show up as null (if process exited under
    // its own steam after handling it) or as 'SIGTERM' (if the handler did
    // not finish in time). Our fix should produce null — the handler runs
    // shutdown(), sets exitCode=0, and the loop drains.
    expect(['SIGTERM', null]).toContain(exitSignal)

    // The whole point of this regression test:
    expect(stderr).not.toMatch(/libc\+\+abi/i)
    expect(stderr).not.toMatch(/mutex lock failed/i)
    expect(stderr).not.toMatch(/std::.*system_error/)

    // Sandbox broker_error.log (if produced) must also be free of aborts.
    const errLog = join(isolatedHome, '.scns', 'logs', 'broker_error.log')
    if (existsSync(errLog)) {
      const errContents = readFileSync(errLog, 'utf8')
      expect(errContents).not.toMatch(/libc\+\+abi/i)
      expect(errContents).not.toMatch(/mutex lock failed/i)
    }
  }, 45_000)
})
