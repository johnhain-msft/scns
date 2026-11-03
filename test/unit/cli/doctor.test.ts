/**
 * WI-5 — `scns doctor`: cross-platform self-diagnosis.
 *
 * The command converts "something's wrong on the work machine" into
 * "layer N failed because X". Every probe is injected (DI) so each check's
 * pass/fail/warn branch is exercised here regardless of host platform.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  runDoctor,
  formatReport,
  SUPPORTED_NODE_MAJORS,
  SUPPORTED_NODE_RANGE,
  type DoctorDeps,
  type DoctorReport,
} from '../../../src/cli/doctor.js'

/** Fully-healthy fake deps; individual tests break one layer at a time. */
function healthyDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    platform: 'darwin',
    nodeVersion: 'v22.20.0',
    env: {},
    cwd: '/Users/j/Coding_Projects/repo',
    scnsHome: '/Users/j',
    packageRoot: '/opt/scns',
    homedir: '/Users/j',
    existsSync: () => true,
    listDir: () => ['models--Xenova--bge-small-en-v1.5'],
    probeWritable: () => true,
    readFileSync: () => 'const BROKER_TOKEN = null;',
    loadNativeModules: () => ({ ok: true, detail: 'better-sqlite3 + sqlite-vec + fastembed' }),
    countRegisteredProjects: () => 1,
    readLivePid: () => 7788,
    httpGet: async (url: string) => {
      if (url.endsWith('/health')) return { status: 200, body: { status: 'ok' } }
      if (url.includes('/api/meta/resolve')) {
        return {
          status: 200,
          body: { resolved: true, projectId: 'repo-abc123', boundPort: 3501 },
        }
      }
      return { status: 200, body: {} }
    },
    ...overrides,
  }
}

async function run(overrides: Partial<DoctorDeps> = {}): Promise<DoctorReport> {
  return runDoctor(healthyDeps(overrides))
}

function check(report: DoctorReport, id: string) {
  const c = report.checks.find((c) => c.id === id)
  if (!c) throw new Error(`missing check ${id} in report`)
  return c
}

describe('runDoctor — healthy machine', () => {
  it('passes every check and reports ok', async () => {
    const report = await run()
    expect(report.ok).toBe(true)
    for (const c of report.checks) {
      expect(['pass', 'info', 'warn']).toContain(c.status)
    }
    // The full ladder is present, in failure-localization order.
    const ids = report.checks.map((c) => c.id)
    expect(ids).toEqual([
      'node-version',
      'dist-build',
      'native-modules',
      'embedding-cache',
      'scns-home-writable',
      'broker-reachable',
      'broker-auth',
      'meta-registry',
      'meta-resolve-cwd',
      'extension-installed',
      'strict-mode',
      'unattended-actions',
      'supervision-root',
      'meta-broker-supervision',
      'self-heal-arming',
    ])
  })
})

describe('runDoctor — per-layer failures carry actionable hints', () => {
  it('fails node-version below 20', async () => {
    const report = await run({ nodeVersion: 'v18.19.0' })
    const c = check(report, 'node-version')
    expect(c.status).toBe('fail')
    expect(c.hint).toMatch(/20/)
    expect(report.ok).toBe(false)
  })

  it('passes on every supported Node major', async () => {
    for (const major of SUPPORTED_NODE_MAJORS) {
      const c = check(await run({ nodeVersion: `v${major}.4.1` }), 'node-version')
      expect(c.status, `Node ${major} should be supported`).toBe('pass')
    }
  })

  // The regression that motivated the ceiling: `major >= 20` green-lit the very
  // Node that breaks the native modules, then the next check failed with an ABI
  // mismatch. Doctor must not bless a Node it cannot run on.
  it('fails above the supported ceiling instead of green-lighting it', async () => {
    const report = await run({ nodeVersion: 'v26.0.0' })
    const c = check(report, 'node-version')
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('v26.0.0')
    expect(report.ok).toBe(false)
  })

  // Node 21 sits *inside* the floor/ceiling but has no better-sqlite3 win32-x64
  // prebuild (NODE_MODULE_VERSION 120 is absent from the 12.9.x matrix), so a
  // naive `>=20 <26` range would still be a lie.
  it('fails on a major inside the range that has no prebuild (Node 21)', async () => {
    const c = check(await run({ nodeVersion: 'v21.7.3' }), 'node-version')
    expect(c.status).toBe('fail')
  })

  it('names a Node the user can actually switch to when it fails', async () => {
    const c = check(await run({ nodeVersion: 'v26.0.0' }), 'node-version')
    expect(c.hint).toBeTruthy()
    const suggested = SUPPORTED_NODE_MAJORS.some((m) => c.hint?.includes(String(m)))
    expect(suggested, `hint should name a supported major: ${c.hint}`).toBe(true)
  })

  it('native-modules hint does not prescribe a remedy that cannot work', async () => {
    const c = check(
      await run({
        loadNativeModules: () => ({
          ok: false,
          detail: 'better-sqlite3: NODE_MODULE_VERSION 115. This version of Node.js requires 137',
        }),
      }),
      'native-modules',
    )
    // `warn`, not `fail`: this fixture is an ABI mismatch, which describes the
    // interpreter running doctor rather than the install (see the ABI test below).
    // The point of THIS test is the hint's content, which is unchanged.
    expect(c.status).toBe('warn')
    // A bare `npm ci` re-resolves `node` from PATH, so it can reinstall the SAME
    // wrong ABI — and without a C++ toolchain the node-gyp fallback cannot
    // succeed at all. The hint must point at the prebuild for the running Node.
    expect(c.hint).toMatch(/prebuild-install/)
    expect(c.hint).toMatch(/process\.version|running Node|--target/)
  })

  it('fails dist-build when a build artifact is missing, hinting npm run build', async () => {
    const report = await run({
      existsSync: (p: string) => !p.includes('schema.sql'),
    })
    const c = check(report, 'dist-build')
    expect(c.status).toBe('fail')
    expect(c.hint).toMatch(/npm run build/)
  })

  it('fails native-modules with the loader error surfaced', async () => {
    const report = await run({
      loadNativeModules: () => ({ ok: false, detail: 'better-sqlite3: invalid ELF header' }),
    })
    const c = check(report, 'native-modules')
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('invalid ELF header')
    expect(c.hint).toMatch(/npm ci/)
  })

  // An ABI mismatch describes the interpreter running `scns doctor`, NOT the
  // install. SCNS pins Node 20 for better-sqlite3 while the Copilot CLI requires
  // Node >= 24, so on Windows `scns doctor` normally runs under the global Node
  // and reported `1 check(s) failed` on a perfectly healthy machine — the same
  // "looks broken to an alpha tester" trap as #54/#56. A genuinely broken binary
  // still fails, and a stack that truly cannot load it fails `broker-reachable`.
  it('WARNS rather than fails when the native error is an ABI mismatch', async () => {
    const report = await run({
      nodeVersion: 'v24.15.0',
      loadNativeModules: () => ({
        ok: false,
        detail:
          "better-sqlite3: The module 'better_sqlite3.node' was compiled against a " +
          'different Node.js version using NODE_MODULE_VERSION 115. This version of ' +
          'Node.js requires NODE_MODULE_VERSION 137.',
      }),
    })
    const c = check(report, 'native-modules')
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('NODE_MODULE_VERSION')
    expect(c.hint).toMatch(/broker-reachable/)
    expect(report.ok).toBe(true)
  })

  it('warns (not fails) on a missing embedding cache, mentioning download + proxy', async () => {
    const report = await run({ listDir: () => [] })
    const c = check(report, 'embedding-cache')
    expect(c.status).toBe('warn')
    expect(c.detail + (c.hint ?? '')).toMatch(/128\s?MB/i)
    expect(c.hint).toMatch(/proxy|SCNS_EMBED_CACHE_DIR/i)
    expect(report.ok).toBe(true)
  })

  it('honors SCNS_EMBED_CACHE_DIR when locating the cache', async () => {
    const seen: string[] = []
    await run({
      env: { SCNS_EMBED_CACHE_DIR: '/relocated/cache' },
      listDir: (p: string) => {
        seen.push(p)
        return ['models--x']
      },
    })
    expect(seen).toContain('/relocated/cache')
  })

  it('fails scns-home-writable with the probed path in the detail', async () => {
    const report = await run({ probeWritable: () => false, scnsHome: '/locked/home' })
    const c = check(report, 'scns-home-writable')
    expect(c.status).toBe('fail')
    // join() normalizes to the native separator the probe path is built with.
    expect(c.detail).toContain(join('/locked/home'))
  })

  it('fails broker-reachable when /health does not answer, hinting scns start', async () => {
    const report = await run({
      httpGet: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const c = check(report, 'broker-reachable')
    expect(c.status).toBe('fail')
    expect(c.hint).toMatch(/scns start/)
    // Downstream checks that need the broker degrade explicitly, not silently.
    expect(check(report, 'broker-auth').status).toBe('fail')
    expect(check(report, 'meta-resolve-cwd').status).toBe('fail')
  })

  it('respects BROKER_PORT when probing', async () => {
    const urls: string[] = []
    await run({
      env: { BROKER_PORT: '9999' },
      httpGet: async (url: string) => {
        urls.push(url)
        return { status: 200, body: { status: 'ok', resolved: true } }
      },
    })
    expect(urls.some((u) => u.includes(':9999/health'))).toBe(true)
  })

  it('fails broker-auth on 401 with a token-mismatch hint', async () => {
    const report = await run({
      env: { BROKER_TOKEN: 'tok' },
      httpGet: async (url: string) => {
        if (url.endsWith('/health')) return { status: 200, body: { status: 'ok' } }
        if (url.includes('/api/sessions')) return { status: 401, body: {} }
        return { status: 200, body: { resolved: true } }
      },
    })
    const c = check(report, 'broker-auth')
    expect(c.status).toBe('fail')
    expect(c.hint).toMatch(/BROKER_TOKEN|install-extension/)
  })

  it('fails meta-registry when the registry DB is absent, hinting register + supervisor', async () => {
    const report = await run({ existsSync: (p: string) => !p.includes('meta-broker.db') })
    const c = check(report, 'meta-registry')
    expect(c.status).toBe('fail')
    expect(c.hint).toMatch(/meta-broker register/)
  })

  it('warns on meta-resolve-cwd when cwd is unregistered (global-fallback hazard)', async () => {
    const report = await run({
      httpGet: async (url: string) => {
        if (url.endsWith('/health')) return { status: 200, body: { status: 'ok' } }
        if (url.includes('/api/meta/resolve')) {
          return { status: 200, body: { resolved: false, reason: 'no-project-for-path' } }
        }
        return { status: 200, body: {} }
      },
    })
    const c = check(report, 'meta-resolve-cwd')
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('no-project-for-path')
    expect(c.hint).toMatch(/meta-broker register/)
  })

  it('fails extension-installed when extension.mjs is absent', async () => {
    const report = await run({ existsSync: (p: string) => !p.includes('extension.mjs') })
    const c = check(report, 'extension-installed')
    expect(c.status).toBe('fail')
    expect(c.hint).toMatch(/scns install-extension/)
  })

  it('reports whether the installed extension embeds a token', async () => {
    const withToken = await run({ readFileSync: () => 'const BROKER_TOKEN = "abc";' })
    expect(check(withToken, 'extension-installed').detail).toMatch(/token embedded/)
    const without = await run({ readFileSync: () => 'const BROKER_TOKEN = null;' })
    expect(check(without, 'extension-installed').detail).toMatch(/no token/)
  })

  it('reports strict-mode as info ON/OFF from the env', async () => {
    const on = await run({ env: { SCNS_REQUIRE_PROJECT_BROKER: '1' } })
    expect(check(on, 'strict-mode').detail).toMatch(/ON/)
    const off = await run()
    expect(check(off, 'strict-mode').status).toBe('info')
    expect(check(off, 'strict-mode').detail).toMatch(/OFF/)
  })

  // #53 AC4 — a tester must be able to SEE, from doctor alone, that
  // nothing is authorised to push branches, open PRs, file issues, or
  // spend credits on their behalf.
  it('reports all unattended actions OFF on a default install', async () => {
    const report = await run()
    const c = check(report, 'unattended-actions')
    expect(c.status).toBe('info')
    expect(c.detail).toMatch(/all OFF/i)
    expect(c.detail).toMatch(/opt-in/i)
  })

  it('names each unattended action that is enabled, and warns', async () => {
    const report = await run({
      env: { BROKER_PUBLISH_GATE_PASS: '1', SCNS_DRIFT_WATCHDOG: '1' },
    })
    const c = check(report, 'unattended-actions')
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('gate-pass-publisher')
    expect(c.detail).toContain('drift-watchdog')
    expect(c.detail).not.toContain('north-star-nudge')
    // Still not a failure — it is the operator's choice, loudly surfaced.
    expect(report.ok).toBe(true)
  })

  it('surfaces the family switch turning the whole set on', async () => {
    const report = await run({ env: { SCNS_UNATTENDED: '1' } })
    const c = check(report, 'unattended-actions')
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('gate-pass-publisher')
    expect(c.detail).toContain('team-task-autospawner')
  })
})

describe('formatReport — cross-platform console output', () => {
  it('uses ASCII status tags (cmd.exe-safe) and one line per check plus hints', async () => {
    const report = await run({ nodeVersion: 'v18.0.0' })
    const text = formatReport(report)
    expect(text).toContain('[FAIL] node-version')
    expect(text).toContain('[OK]')
    expect(text).toMatch(/hint:/)
    expect(text).not.toMatch(/[✓✗✔✘]/u)
  })

  it('ends with an overall verdict line', async () => {
    const healthy = formatReport(await run())
    expect(healthy).toMatch(/all checks passed/i)
    const broken = formatReport(await run({ nodeVersion: 'v18.0.0' }))
    expect(broken).toMatch(/1 check\(s\) failed/i)
  })
})

// =====================================================================
// The supported-Node range must be stated identically everywhere.
//
// `engines` claimed `>=20.0.0` while the native modules only loaded on a
// subset of that range. Deriving the range from one exported constant and
// asserting package.json against it makes that class of drift a test failure
// rather than an ENOENT on someone else's machine.
// =====================================================================

describe('supported Node range is declared consistently', () => {
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, '..', '..', '..', 'package.json'), 'utf-8'),
  ) as { engines?: { node?: string } }

  it('package.json engines.node matches the doctor ceiling exactly', () => {
    expect(pkg.engines?.node).toBe(SUPPORTED_NODE_RANGE)
  })

  it('the declared range is derived from the supported majors', () => {
    expect(SUPPORTED_NODE_RANGE).toBe(SUPPORTED_NODE_MAJORS.map((m) => `^${m}.0.0`).join(' || '))
  })

  it('excludes the majors with no better-sqlite3 win32-x64 prebuild', () => {
    for (const unsupported of [18, 19, 21, 26]) {
      expect(
        SUPPORTED_NODE_MAJORS as readonly number[],
        `Node ${unsupported} has no prebuild and must not be declared supported`,
      ).not.toContain(unsupported)
    }
  })
})

// ── #61 — durability checks ──────────────────────────────────────────
// `scns doctor` reported "all checks passed" minutes before an 11h47m
// outage, because every check asked "is it up NOW?" and none asked "will
// anything bring it back?".
describe('runDoctor — supervision durability (#61)', () => {
  it('passes on darwin when the launchd plist is installed', async () => {
    const r = await run({ platform: 'darwin' })
    const c = check(r, 'supervision-root')
    expect(c.status).toBe('pass')
    expect(c.detail).toContain('launchd')
  })

  it('FAILS on darwin when no plist is installed — nothing would relaunch the broker', async () => {
    const r = await run({ platform: 'darwin', existsSync: () => false })
    expect(check(r, 'supervision-root').status).toBe('fail')
    expect(r.ok).toBe(false)
  })

  it('FAILS on win32 when neither the Startup shim nor a watchdog exists', async () => {
    const r = await run({ platform: 'win32', existsSync: () => false })
    const c = check(r, 'supervision-root')
    expect(c.status).toBe('fail')
    expect(c.hint).toContain('scns install')
  })

  it('WARNS on win32 when the shim is installed but no watchdog is running', async () => {
    const r = await run({
      platform: 'win32',
      existsSync: (p: string) => p.includes('Startup'),
    })
    const c = check(r, 'supervision-root')
    expect(c.status).toBe('warn')
    expect(c.detail).toMatch(/not running|no watchdog/i)
  })

  it('passes on win32 when a live watchdog holds its pidfile', async () => {
    const r = await run({
      platform: 'win32',
      existsSync: () => true,
      readFileSync: (p: string) =>
        p.includes('watchdog')
          ? JSON.stringify({ pid: process.pid, port: 0 })
          : 'const BROKER_TOKEN = null;',
      isProcessAlive: () => true,
    })
    const c = check(r, 'supervision-root')
    expect(c.status).toBe('pass')
    expect(c.detail).toContain('watchdog')
  })

  it('treats a STALE watchdog pidfile as not running', async () => {
    const r = await run({
      platform: 'win32',
      existsSync: () => true,
      readFileSync: (p: string) =>
        p.includes('watchdog')
          ? JSON.stringify({ pid: 999999, port: 0 })
          : 'const BROKER_TOKEN = null;',
      isProcessAlive: () => false,
    })
    expect(check(r, 'supervision-root').status).toBe('warn')
  })

  it('reports self-heal as DISARMED on an unsupervised win32 host', async () => {
    const r = await run({ platform: 'win32', existsSync: () => false })
    const c = check(r, 'self-heal-arming')
    expect(c.detail).toMatch(/disarmed/i)
    expect(c.status).toBe('warn')
  })

  // `decideSelfHealArming` reads the DOCTOR's env, so on a supervised win32 host
  // it said "disarmed — no relaunch substrate … install a supervision root" in the
  // same report where `supervision-root` said the watchdog was running, and while
  // the live broker logged "Self-heal armed — supervision=external-watchdog".
  // The arming report must describe the supervised broker, not the operator shell.
  it('does not tell a SUPERVISED win32 host to install a supervision root', async () => {
    const r = await run({
      platform: 'win32',
      existsSync: () => true,
      readFileSync: (p: string) =>
        p.includes('watchdog')
          ? JSON.stringify({ pid: process.pid, port: 0 })
          : 'const BROKER_TOKEN = null;',
      isProcessAlive: () => true,
    })
    expect(check(r, 'supervision-root').status).toBe('pass')
    const c = check(r, 'self-heal-arming')
    expect(c.status).toBe('info')
    expect(c.detail).toMatch(/supervis/i)
    expect(c.hint ?? '').not.toMatch(/install a supervision root/)
  })

  it('reports self-heal as armed on darwin', async () => {
    const c = check(await run({ platform: 'darwin' }), 'self-heal-arming')
    expect(c.status).toBe('info')
    expect(c.detail).toMatch(/armed/i)
  })

  it('flags a FORCED self-heal on an unsupervised host as the footgun it is', async () => {
    const r = await run({ platform: 'win32', env: { SCNS_BROKER_SELF_HEAL: '1' } })
    const c = check(r, 'self-heal-arming')
    expect(c.status).toBe('warn')
    expect(c.detail).toMatch(/will NOT be relaunched|not be relaunched/i)
  })

  it('a healthy broker does not make the durability check pass', async () => {
    // The exact shape of the outage: broker up, nothing supervising it.
    const r = await run({ platform: 'win32', existsSync: () => false })
    expect(check(r, 'broker-reachable').status).toBe('pass')
    expect(check(r, 'supervision-root').status).toBe('fail')
    expect(formatReport(r)).toContain('check(s) failed')
  })
})

describe('runDoctor — meta-broker supervision (#61)', () => {
  it('fails when projects are registered but no meta-broker is running', async () => {
    // The outage this names: the GLOBAL broker stays perfectly healthy, so every
    // other check passes while every session in every registered repo quietly
    // writes to the shared brain instead of its own project.
    const r = await run({ countRegisteredProjects: () => 3, readLivePid: () => null })
    const c = check(r, 'meta-broker-supervision')
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('global:fallback')
    expect(c.hint).toContain('--supervise-meta')
    expect(r.ok).toBe(false)
  })

  it('passes when a meta-broker is running for the registered projects', async () => {
    const c = check(
      await run({ countRegisteredProjects: () => 2, readLivePid: () => 4242 }),
      'meta-broker-supervision',
    )
    expect(c.status).toBe('pass')
    expect(c.detail).toContain('4242')
    expect(c.detail).toContain('2 registered project(s)')
  })

  it('stays quiet when nothing is registered — supervising it would be opt-in for nobody', async () => {
    const c = check(
      await run({ countRegisteredProjects: () => 0, readLivePid: () => null }),
      'meta-broker-supervision',
    )
    expect(c.status).toBe('info')
    expect(c.detail).toContain('nothing to supervise')
  })

  it('says so, rather than guessing, when the registry cannot be read', async () => {
    const c = check(
      await run({ countRegisteredProjects: () => null, readLivePid: () => null }),
      'meta-broker-supervision',
    )
    expect(c.status).toBe('info')
    expect(c.detail).toContain('not readable')
  })
})
