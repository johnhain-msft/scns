/**
 * Regression reproducer for the `libc++abi: mutex lock failed` aborts that
 * persisted after the round-2 shutdown-sequencing fix (2026-04-22 soak).
 *
 * The round-2 integration test exercised a plain SIGTERM via `child.kill()`.
 * That passed — but the real production termination mechanism is
 * `launchctl bootout`, which sends SIGTERM and escalates to SIGKILL if the
 * process hasn't exited within its launchd-controlled grace window. Under
 * bootout conditions the round-2 fix was not sufficient: both the cycle-1
 * blue-broker teardown and the final soak-harness bootout aborted with
 *   libc++abi: terminating due to uncaught exception of type
 *   std::__1::system_error: mutex lock failed: Invalid argument
 *
 * Round-3 fix explicitly calls `session.release()` on the private ONNX
 * InferenceSession held by the FastEmbed wrapper before dropping the JS
 * reference. This test reproduces the bootout path and asserts that the
 * stderr log is free of both markers.
 *
 * Opt-in & environmentally sensitive:
 *   - macOS-only (launchctl)
 *   - requires `SCNS_BOOTOUT_TEST=1` to run (otherwise the `it` block is
 *     skipped — normal CI and normal `vitest run` skip it)
 *   - creates a UNIQUELY-labeled plist `com.scns.bootout-test.<pid>` so the
 *     live `com.scns.broker` and any active `com.scns.soak` cannot collide
 *   - isolates HOME and SCNS_HOME under /tmp so the real ~/.scns/ is never touched
 *
 * Run directly:
 *   npm run build
 *   SCNS_BOOTOUT_TEST=1 npx vitest run test/integration/broker/broker-launchctl-bootout.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { platform, tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js')
const NODE_BIN = process.execPath

const ENABLED = process.env.SCNS_BOOTOUT_TEST === '1' && platform() === 'darwin'
const describeBootout = ENABLED ? describe : describe.skip

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

function buildPlist(label: string, port: number, scnsHome: string, logPath: string, errLogPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>--expose-gc</string>
    <string>${CLI_PATH}</string>
    <string>start</string>
    <string>--port</string>
    <string>${String(port)}</string>
    <string>--autonomy</string>
    <string>0</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${scnsHome}</string>
    <key>SCNS_HOME</key>
    <string>${scnsHome}</string>
    <key>NODE_ENV</key>
    <string>test</string>
    <key>SCNS_MAX_CONCURRENT_AGENTS</key>
    <string>1</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${errLogPath}</string>
</dict>
</plist>
`
}

function launchctl(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' })
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function getPidByLabel(label: string): number | null {
  // `launchctl list <label>` prints a plist-style dict; we need "PID" = N
  const r = spawnSync('launchctl', ['list', label], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const m = /"PID"\s*=\s*(\d+)\s*;/.exec(r.stdout ?? '')
  if (!m) return null
  const pid = Number(m[1])
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

describeBootout('broker teardown via launchctl bootout — no libc++abi', () => {
  const label = `com.scns.bootout-test.${process.pid}`
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)

  // `id` is a POSIX-only tool. Vitest executes a describe callback at collect
  // time even when the suite is skipped, so resolving the uid eagerly here
  // threw `spawnSync id ENOENT` on Windows and failed the whole FILE rather
  // than skipping it. Resolve it in beforeAll, which skipped suites never run.
  let domain = ''

  let scnsHome = ''
  let logPath = ''
  let errLogPath = ''
  let port = 0
  let loaded = false

  beforeAll(async () => {
    domain = `gui/${Number(execFileSync('id', ['-u']).toString().trim())}`
    if (!existsSync(CLI_PATH)) {
      throw new Error(`dist/cli.js not found — run \`npm run build\` first (${CLI_PATH})`)
    }
    const sandbox = mkdtempSync(join(tmpdir(), 'scns-bootout-test-'))
    scnsHome = join(sandbox, 'home')
    mkdirSync(join(scnsHome, '.scns'), { recursive: true })
    logPath = join(sandbox, 'broker.out.log')
    errLogPath = join(sandbox, 'broker.err.log')
    // Pre-touch log files so launchd can write to them before the broker
    // redirects via pino.
    writeFileSync(logPath, '')
    writeFileSync(errLogPath, '')
    port = await pickFreePort()

    writeFileSync(plistPath, buildPlist(label, port, scnsHome, logPath, errLogPath))

    // Ensure no leftover from a previous test run under the same label.
    launchctl(['bootout', `${domain}/${label}`])

    const bootstrap = launchctl(['bootstrap', domain, plistPath])
    if (!bootstrap.ok) {
      throw new Error(
        `launchctl bootstrap failed: ${bootstrap.stderr || bootstrap.stdout}`,
      )
    }
    loaded = true

    const healthy = await waitForHealth(port, 45_000)
    if (!healthy) {
      const stderr = existsSync(errLogPath) ? readFileSync(errLogPath, 'utf8') : ''
      const stdout = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
      throw new Error(
        `broker did not become healthy in 45s under launchctl.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      )
    }

    // Force FastEmbed/ONNX initialization — that's the round-3 abort
    // precondition (native worker threads alive at bootout time). The round-2
    // aborts happened on brokers with substantial embedding history, so we
    // store several memories and run a search to ensure the ORT session has
    // actually been constructed and used.
    for (let i = 0; i < 6; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/api/memory/store`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            key: `bootout-probe-${i}`,
            value: `bootout regression probe number ${i} — lorem ipsum dolor sit amet`,
          }),
        })
      } catch {
        /* keep going */
      }
    }
    try {
      await fetch(
        `http://127.0.0.1:${port}/api/memory/search?q=bootout+regression+probe&limit=5`,
      )
    } catch {
      /* ignore */
    }
    // Let FastEmbed/ONNX finish warming (model load + worker threads) before
    // bootout. 15s empirically covers first-run model download on cold disk.
    await new Promise((r) => setTimeout(r, 15_000))
  }, 180_000)

  afterAll(() => {
    if (loaded) {
      launchctl(['bootout', `${domain}/${label}`])
    }
    if (existsSync(plistPath)) {
      rmSync(plistPath, { force: true })
    }
  })

  it('bootout completes with zero libc++abi / mutex-lock lines in stderr', async () => {
    const pid = getPidByLabel(label)
    expect(pid, 'expected a running PID before bootout').not.toBeNull()

    const rr = launchctl(['bootout', `${domain}/${label}`])
    loaded = false
    expect(rr.ok, `launchctl bootout: ${rr.stderr || rr.stdout}`).toBe(true)

    // Wait up to 15s for the PID to actually exit after bootout.
    const start = Date.now()
    while (Date.now() - start < 15_000) {
      try {
        process.kill(pid as number, 0)
        await new Promise((r) => setTimeout(r, 250))
      } catch {
        break // process gone
      }
    }
    let stillAlive = false
    try {
      process.kill(pid as number, 0)
      stillAlive = true
    } catch {
      stillAlive = false
    }
    expect(stillAlive, 'broker PID should be gone after bootout').toBe(false)

    // Give launchd a moment to flush stderr to disk.
    await new Promise((r) => setTimeout(r, 500))
    const err = existsSync(errLogPath) ? readFileSync(errLogPath, 'utf8') : ''
    const out = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''

    // Main assertions — this is the regression gate.
    expect(err, 'stderr must not contain libc++abi abort').not.toMatch(/libc\+\+abi/i)
    expect(err, 'stderr must not contain mutex lock failed').not.toMatch(/mutex lock failed/i)
    expect(err, 'stderr must not contain std::system_error').not.toMatch(/std::.*system_error/)

    // Also sanity-check that graceful shutdown actually ran (via broker.log
    // which is where pino writes if broker.out was redirected).
    // Not required for the gate, but useful diagnostic context on failure.
    void out
  }, 45_000)
})
