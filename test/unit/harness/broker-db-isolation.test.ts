/**
 * Harness guard — no test-spawned broker may resolve its DB to the LIVE
 * `~/.session-broker/data.db`.
 *
 * ## Why this exists
 * `src/broker/config.ts` builds its default at MODULE LOAD:
 *
 *   dbPath: join(homedir(), '.session-broker', 'data.db')
 *
 * It uses `homedir()` — NOT `resolveScnsHome()` — so `SCNS_HOME` cannot redirect it. A spawned
 * broker (`cli.js start`) that inherits no explicit `BROKER_DB_PATH` therefore opens the operator's
 * REAL broker database and appends a `broker_started` row (`src/broker/startup.ts:815`).
 *
 * Measured before the fix: the live DB held 240 `broker_started` rows, 8 of them carrying EPHEMERAL
 * ports (54355, 54361, 55693, 55709, 55923, 55937, 57081, 57109) written by a full-suite run — test
 * traffic in the production corpus, which `.github/instructions/00-fix-first.instructions.md` §3b
 * forbids ("only real rows belong in the real DB").
 *
 * ## The part that made this invisible
 * `isolatedHomeEnv()` pinned `HOME` and `SCNS_HOME` and looked sufficient. On Windows it is not:
 * `os.homedir()` reads `USERPROFILE` and IGNORES `HOME`, so the `HOME` pin is a POSIX-only no-op.
 * Probed directly, with both pinned to a sandbox:
 *
 *   HOME        = C:\…\Temp\scns-probe-home
 *   USERPROFILE = C:\Users\<user>
 *   homedir()   = C:\Users\<user>            <- ignores HOME
 *   DEFAULT db  = C:\Users\<user>\.session-broker\data.db   <- LIVE
 *
 * So the fix pins BOTH `USERPROFILE` (so `homedir()` lands in the sandbox) AND `BROKER_DB_PATH`
 * (so the broker DB is scoped on every platform, independent of any home-directory trick).
 *
 * ## What this guard is NOT
 * It is NOT a namespace-wide `BROKER_*`/`SCNS_*` env scrub. That anti-pattern is rejected in writing
 * in `test/helpers/ambient-env.ts` and `test/unit/harness/spawn-env-isolation.test.ts`: such a scrub
 * also deletes `SCNS_HOME` and `BROKER_DB_PATH`, which are the PROTECTIVE variables, and points
 * production code back at the live tree. This guard only ever ADDS a pin.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { isolatedHomeEnv } from '../../helpers/isolation.js'

const TEST_ROOT = resolve(__dirname, '..', '..')

/** The live broker DB no test may ever open. Mirrors `src/broker/config.ts` DEFAULTS.dbPath. */
const LIVE_BROKER_DB = join(homedir(), '.session-broker', 'data.db')

// ── Part 1: the resolution model ─────────────────────────────
// A spawned child resolves its broker DB exactly this way. Modelled here so the guard can assert on
// an env WITHOUT spawning a broker (spawning one to find out is the very write we are preventing).

/**
 * `os.homedir()` as the child would compute it from `env`: Windows reads `USERPROFILE`, POSIX reads
 * `HOME`. Falls back to this process's real home when the variable is absent — exactly the leak the
 * guard exists to catch.
 */
export function childHomedir(env: NodeJS.ProcessEnv, platform: string): string {
  const fromEnv = platform === 'win32' ? env['USERPROFILE'] : env['HOME']
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : homedir()
}

/** The DB path a broker spawned with `env` would open. Mirrors `loadConfig()` + `DEFAULTS.dbPath`. */
export function childBrokerDbPath(env: NodeJS.ProcessEnv, platform: string): string {
  const explicit = env['BROKER_DB_PATH']
  if (explicit && explicit.trim() !== '') return explicit
  return join(childHomedir(env, platform), '.session-broker', 'data.db')
}

describe('childBrokerDbPath — the resolution model itself', () => {
  const SANDBOX = resolve('/sandbox/home')

  it('POSITIVE control: a HOME-only pin still resolves to the LIVE db on win32', () => {
    const leaky = { HOME: SANDBOX } as NodeJS.ProcessEnv
    expect(childBrokerDbPath(leaky, 'win32')).toBe(LIVE_BROKER_DB)
  })

  it('an explicit BROKER_DB_PATH wins on every platform', () => {
    const pinned = { BROKER_DB_PATH: join(SANDBOX, 'broker.db') } as NodeJS.ProcessEnv
    for (const platform of ['win32', 'linux', 'darwin']) {
      expect(childBrokerDbPath(pinned, platform)).toBe(join(SANDBOX, 'broker.db'))
    }
  })

  it('NEGATIVE control: a USERPROFILE pin redirects the win32 default away from live', () => {
    const env = { USERPROFILE: SANDBOX } as NodeJS.ProcessEnv
    expect(childBrokerDbPath(env, 'win32')).toBe(join(SANDBOX, '.session-broker', 'data.db'))
    expect(childBrokerDbPath(env, 'win32')).not.toBe(LIVE_BROKER_DB)
  })

  it('an empty-string pin is treated as absent, not as a valid path', () => {
    expect(childBrokerDbPath({ BROKER_DB_PATH: '  ' } as NodeJS.ProcessEnv, 'win32')).toBe(
      LIVE_BROKER_DB,
    )
  })
})

// ── Part 2: the helper every spawn site funnels through ──────

describe('isolatedHomeEnv scopes the broker DB away from the live file', () => {
  const SANDBOX = resolve('/sandbox/isolated-home')

  it('pins BROKER_DB_PATH inside the sandbox', () => {
    const env = isolatedHomeEnv(SANDBOX)
    expect(env['BROKER_DB_PATH']).toBeDefined()
    expect(env['BROKER_DB_PATH']!.startsWith(SANDBOX)).toBe(true)
  })

  it('pins USERPROFILE so `homedir()` lands in the sandbox on Windows', () => {
    expect(isolatedHomeEnv(SANDBOX)['USERPROFILE']).toBe(SANDBOX)
  })

  it('a child spawned with it NEVER resolves the live broker DB — on any platform', () => {
    const env = isolatedHomeEnv(SANDBOX)
    for (const platform of ['win32', 'linux', 'darwin']) {
      expect(childBrokerDbPath(env, platform)).not.toBe(LIVE_BROKER_DB)
    }
  })

  it('still lets a caller override the pin deliberately via `extra`', () => {
    const env = isolatedHomeEnv(SANDBOX, { BROKER_DB_PATH: ':memory:' })
    expect(childBrokerDbPath(env, 'win32')).toBe(':memory:')
  })

  it('keeps pinning HOME and SCNS_HOME (the isolation it already provided)', () => {
    const env = isolatedHomeEnv(SANDBOX)
    expect(env['HOME']).toBe(SANDBOX)
    expect(env['SCNS_HOME']).toBe(SANDBOX)
  })
})

// ── Part 3: the class-level static scan ──────────────────────
// Part 2 closes every site that funnels through the helper. This closes the OTHER half of the class:
// a future test that hand-rolls a child env and bypasses the helper entirely.

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listTypeScriptFiles(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * Opt-out marker for this file's own controls — a scanner whose fixtures trip its own tree scan is
 * useless. Put it on the same line as the spawn call. Nothing that really spawns may carry it.
 */
const FIXTURE_MARKER = 'broker-db-scan:fixture'

/** The balanced-parenthesis argument text of the call starting at `open`. */
function balancedCall(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return ''
}

function lineAt(src: string, index: number): string {
  const start = src.lastIndexOf('\n', index) + 1
  const end = src.indexOf('\n', index)
  return src.slice(start, end < 0 ? src.length : end)
}

const SPAWNERS = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(/g
/** Argv that starts a broker: a bare `'start'` argument. */
const STARTS_BROKER = /['"]start['"]/
/** The two audited ways to scope the child's broker DB. */
const SCOPES_DB = /BROKER_DB_PATH|isolatedHomeEnv/

/**
 * Every call that spawns a broker (`… 'start' …`) without scoping its DB — neither pinning
 * `BROKER_DB_PATH` at the call site nor building the env with `isolatedHomeEnv()`.
 *
 * Scoping is accepted at FILE level, not only at the call site: `repo-isolation.test.ts` spawns via
 * a `spawnBroker(env, port)` helper whose callers each supply a per-project `BROKER_DB_PATH`, so the
 * literal pin is several frames above the `spawn()`. Demanding it inside the call parens would flag
 * a file that is already correctly isolated. The narrower call-site check runs first so the reported
 * offender is still the precise spawn.
 */
export function findUnscopedBrokerSpawns(src: string): string[] {
  const fileScopesDb = SCOPES_DB.test(src)
  const offenders: string[] = []
  for (const m of src.matchAll(SPAWNERS)) {
    const open = m.index + m[0].length - 1
    if (lineAt(src, m.index).includes(FIXTURE_MARKER)) continue
    const call = balancedCall(src, open)
    if (!call || !STARTS_BROKER.test(call)) continue
    if (!SCOPES_DB.test(call) && !fileScopesDb) offenders.push(call)
  }
  return offenders
}

describe('findUnscopedBrokerSpawns — the scanner itself', () => {
  it('POSITIVE control: flags a broker spawn whose env scopes nothing', () => {
    const src = `spawn(node, [CLI, 'start', '--port', p], { env: { ...process.env, HOME: h } })` // broker-db-scan:fixture scns-home-scan:fixture
    expect(findUnscopedBrokerSpawns(src)).toHaveLength(1)
  })

  it('NEGATIVE control: does NOT flag a spawn that pins BROKER_DB_PATH at the call site', () => {
    const src = `spawn(node, [CLI, 'start'], { env: { ...process.env, BROKER_DB_PATH: db } })`
    expect(findUnscopedBrokerSpawns(src)).toEqual([])
  })

  it('NEGATIVE control: does NOT flag a spawn that builds its env with isolatedHomeEnv', () => {
    const src = `spawn(node, [CLI, 'start'], { env: isolatedHomeEnv(home, { NODE_ENV: 'test' }) })`
    expect(findUnscopedBrokerSpawns(src)).toEqual([])
  })

  it('NEGATIVE control: ignores a spawn that never starts a broker', () => {
    const src = `spawnSync('git', ['init', '-q'], { cwd: dir })`
    expect(findUnscopedBrokerSpawns(src)).toEqual([])
  })

  it('handles a nested options object without truncating at the inner paren', () => {
    const src = `spawn(execPath, ['--expose-gc', CLI, 'start'], { cwd: r, env: build(h) })` // broker-db-scan:fixture
    const found = findUnscopedBrokerSpawns(src)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('cwd: r')
  })

  it('the fixture marker exempts a line — and ONLY the marked line', () => {
    const call = `spawn(n, [CLI, 'start'], { env: e })`
    expect(findUnscopedBrokerSpawns(call)).toHaveLength(1)
    expect(findUnscopedBrokerSpawns(`${call} // ${FIXTURE_MARKER}`)).toEqual([])
    expect(findUnscopedBrokerSpawns(`// ${FIXTURE_MARKER}\n${call}`)).toHaveLength(1)
  })

  it('accepts a pin supplied by the caller of a spawn helper (file-level scoping)', () => {
    const viaHelper = [
      `function spawnBroker(env, port) {`,
      `  return spawn(NODE, [CLI, 'start', '--port', String(port)], { env: { ...process.env, ...env } })`,
      `}`,
      `spawnBroker({ BROKER_DB_PATH: join(tmp, 'a.db') }, 4001)`,
    ].join('\n')
    expect(findUnscopedBrokerSpawns(viaHelper)).toEqual([])
  })

  it('file-level scoping does NOT excuse a file that scopes nothing at all', () => {
    const unscoped = [
      `function spawnBroker(env, port) {`,
      `  return spawn(NODE, [CLI, 'start', '--port', String(port)], { env: { ...process.env, ...env } })`,
      `}`,
      `spawnBroker({ NODE_ENV: 'test' }, 4001)`,
    ].join('\n')
    expect(findUnscopedBrokerSpawns(unscoped)).toHaveLength(1)
  })
})

describe('the test tree never spawns a broker with an unscoped DB', () => {
  it('no test file spawns `cli.js start` without scoping BROKER_DB_PATH', () => {
    const offenders = listTypeScriptFiles(TEST_ROOT).flatMap((file) =>
      findUnscopedBrokerSpawns(readFileSync(file, 'utf8')).map(
        (call) =>
          `${relative(TEST_ROOT, file)}: ${call.replace(/\s+/g, ' ').slice(0, 120)}` +
          ` — scope the child DB (use isolatedHomeEnv from test/helpers/isolation.ts)`,
      ),
    )
    expect(offenders).toEqual([])
  })

  it('the scan actually reads files (guards against an empty-tree false pass)', () => {
    expect(listTypeScriptFiles(TEST_ROOT).length).toBeGreaterThan(100)
  })
})
