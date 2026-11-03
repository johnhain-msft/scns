/**
 * T003 — test isolation helper (Phase 1 Setup, specs/001-learning-memory-loop).
 *
 * The helper must (a) create a throwaway root under mktemp with dependency-injected vault/experience
 * DB paths, and (b) assert a vault file's mtime+size are unchanged before+after a run — the read-only
 * live-vault guard (Constitution: Safety & Operational Constraints; invariant documented at
 * `experience-store.ts:12-15`). Controls: positive (untouched file passes) AND negative (a mutated
 * file throws) — a guard that cannot fail is not a guard.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import {
  createIsolatedRoot,
  createIsolatedHome,
  isolatedHomeEnv,
  killByPid,
  snapshotVault,
  assertVaultUnchanged,
  LIVE_VAULT_DB,
  BROKER_PORT,
} from '../helpers/isolation.js'

describe('createIsolatedRoot — throwaway root with DI vault/experience paths', () => {
  it('creates a fresh root under the OS tmpdir with vault + experience DB paths inside it', () => {
    const root = createIsolatedRoot()
    try {
      expect(root.rootDir.startsWith(tmpdir())).toBe(true)
      expect(existsSync(root.rootDir)).toBe(true)
      expect(root.vaultDbPath).toBe(join(root.rootDir, 'vault.db'))
      expect(root.experienceDbPath).toBe(join(root.rootDir, 'experience.db'))
    } finally {
      root.cleanup()
    }
  })

  it('two roots never collide, and neither is the live vault location', () => {
    const a = createIsolatedRoot()
    const b = createIsolatedRoot()
    try {
      expect(a.rootDir).not.toBe(b.rootDir)
      expect(a.vaultDbPath).not.toBe(LIVE_VAULT_DB)
      expect(b.vaultDbPath).not.toBe(LIVE_VAULT_DB)
      expect(LIVE_VAULT_DB).toBe(join(homedir(), '.scns', 'memory', 'vault.db'))
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  it('cleanup removes the root recursively', () => {
    const root = createIsolatedRoot()
    writeFileSync(root.vaultDbPath, 'x')
    root.cleanup()
    expect(existsSync(root.rootDir)).toBe(false)
  })
})

describe('snapshotVault / assertVaultUnchanged — the read-only vault guard', () => {
  it('POSITIVE control: an untouched vault file passes the unchanged assertion', () => {
    const root = createIsolatedRoot()
    try {
      writeFileSync(root.vaultDbPath, 'vault-bytes')
      const before = snapshotVault(root.vaultDbPath)
      expect(before.exists).toBe(true)
      expect(before.size).toBe('vault-bytes'.length)
      const after = assertVaultUnchanged(before)
      expect(after.size).toBe(before.size)
      expect(after.mtimeMs).toBe(before.mtimeMs)
    } finally {
      root.cleanup()
    }
  })

  it('NEGATIVE control: a size change throws naming the vault path', () => {
    const root = createIsolatedRoot()
    try {
      writeFileSync(root.vaultDbPath, 'vault-bytes')
      const before = snapshotVault(root.vaultDbPath)
      appendFileSync(root.vaultDbPath, '-mutated')
      expect(() => assertVaultUnchanged(before)).toThrow(/vault.*changed/i)
    } finally {
      root.cleanup()
    }
  })

  it('NEGATIVE control: an mtime-only change (same size) still throws', () => {
    const root = createIsolatedRoot()
    try {
      writeFileSync(root.vaultDbPath, 'vault-bytes')
      const before = snapshotVault(root.vaultDbPath)
      // same byte count, later mtime — a rewrite must not pass the guard
      const later = new Date(Date.now() + 5_000)
      utimesSync(root.vaultDbPath, later, later)
      expect(() => assertVaultUnchanged(before)).toThrow(/mtime/i)
    } finally {
      root.cleanup()
    }
  })

  it('a missing vault file snapshots as exists:false and stays unchanged if still absent', () => {
    const root = createIsolatedRoot()
    try {
      const missing = join(root.rootDir, 'never-created.db')
      const before = snapshotVault(missing)
      expect(before.exists).toBe(false)
      expect(() => assertVaultUnchanged(before)).not.toThrow()
    } finally {
      root.cleanup()
    }
  })

  it('NEGATIVE control: a vault file APPEARING where none existed throws', () => {
    const root = createIsolatedRoot()
    try {
      const path = join(root.rootDir, 'appears.db')
      const before = snapshotVault(path)
      writeFileSync(path, 'sneaky-write')
      expect(() => assertVaultUnchanged(before)).toThrow(/vault.*changed/i)
    } finally {
      root.cleanup()
    }
  })

  it('defaults to the LIVE vault path when no path is given', () => {
    const snap = snapshotVault()
    expect(snap.path).toBe(LIVE_VAULT_DB)
  })
})

describe('createIsolatedHome — SCNS_HOME=$(mktemp -d) guard-preamble isolation', () => {
  it('POSITIVE control: exports a fresh throwaway SCNS_HOME, never the live ~/.scns', () => {
    const iso = createIsolatedHome()
    try {
      expect(process.env.SCNS_HOME).toBe(iso.home)
      expect(iso.home.startsWith(tmpdir())).toBe(true)
      expect(existsSync(iso.home)).toBe(true)
      expect(iso.home).not.toBe(join(homedir(), '.scns'))
      expect(LIVE_VAULT_DB.startsWith(iso.home)).toBe(false)
    } finally {
      iso.restore()
    }
  })

  it('restore() puts the prior SCNS_HOME back exactly and removes the temp home', () => {
    const prev = process.env.SCNS_HOME
    process.env.SCNS_HOME = '/tmp/prior-home-marker'
    const iso = createIsolatedHome()
    expect(process.env.SCNS_HOME).toBe(iso.home)
    iso.restore()
    expect(process.env.SCNS_HOME).toBe('/tmp/prior-home-marker')
    expect(existsSync(iso.home)).toBe(false)
    if (prev === undefined) delete process.env.SCNS_HOME
    else process.env.SCNS_HOME = prev
  })

  it('restore() deletes SCNS_HOME when there was none before', () => {
    const prev = process.env.SCNS_HOME
    delete process.env.SCNS_HOME
    const iso = createIsolatedHome()
    expect(process.env.SCNS_HOME).toBe(iso.home)
    iso.restore()
    expect('SCNS_HOME' in process.env).toBe(false)
    if (prev !== undefined) process.env.SCNS_HOME = prev
  })

  it('two isolated homes never collide', () => {
    const a = createIsolatedHome()
    const b = createIsolatedHome()
    try {
      expect(a.home).not.toBe(b.home)
    } finally {
      b.restore()
      a.restore()
    }
  })
})

describe('killByPid — kill-by-explicit-PID-only guard (never pkill/killall)', () => {
  it('POSITIVE control: signal 0 to our own live pid is delivered (returns true)', () => {
    expect(killByPid(process.pid, 0)).toBe(true)
  })

  it('returns false for a definitely-dead pid (ESRCH), never throwing', () => {
    // 2^30 is far above any real pid on macOS/Linux; probing it is a no-op.
    expect(killByPid(2 ** 30, 0)).toBe(false)
  })

  it('NEGATIVE control: refuses non-positive-integer pids (0, negatives, NaN, floats)', () => {
    for (const bad of [0, -1, -1234, Number.NaN, 3.14, Infinity]) {
      expect(() => killByPid(bad, 0)).toThrow(/kill by explicit PID only/i)
    }
  })

  it('NEGATIVE control: refuses a negative pid that would signal a process GROUP', () => {
    // process.kill(-pgid, sig) signals a whole group — exactly what the guard must forbid.
    expect(() => killByPid(-process.pid, 0)).toThrow(/explicit PID/i)
  })
})

describe('BROKER_PORT — the port a guarded run must leave undisturbed', () => {
  it('is the documented broker port 3456', () => {
    expect(BROKER_PORT).toBe(3456)
  })
})

describe('isolatedHomeEnv — a spawned child must not inherit the operator’s SCNS_HOME', () => {
  const prev = process.env.SCNS_HOME

  afterEach(() => {
    if (prev === undefined) delete process.env.SCNS_HOME
    else process.env.SCNS_HOME = prev
  })

  it('POSITIVE control: pins BOTH HOME and SCNS_HOME to the same throwaway dir', () => {
    const env = isolatedHomeEnv('/sandbox/home-a')
    expect(env.HOME).toBe('/sandbox/home-a')
    expect(env.SCNS_HOME).toBe('/sandbox/home-a')
  })

  it('REGRESSION: an outer SCNS_HOME is OVERRIDDEN, not inherited — resolveScnsHome() gives it precedence over homedir(), so leaking it defeats the sandbox', () => {
    process.env.SCNS_HOME = '/outer/leaked-home'
    const env = isolatedHomeEnv('/sandbox/home-b')
    expect(env.SCNS_HOME).toBe('/sandbox/home-b')
    expect(env.SCNS_HOME).not.toBe('/outer/leaked-home')
  })

  it('NEGATIVE control: the raw `{ ...process.env, HOME }` spread it replaces DOES leak the outer value', () => {
    process.env.SCNS_HOME = '/outer/leaked-home'
    const leaky = { ...process.env, HOME: '/sandbox/home-c' } // scns-home-scan:fixture
    expect(leaky.SCNS_HOME).toBe('/outer/leaked-home') // the bug, reproduced
  })

  it('still inherits the rest of the environment and applies `extra` last', () => {
    process.env.SCNS_ISOLATION_PROBE = 'inherited'
    try {
      const env = isolatedHomeEnv('/sandbox/home-d', { NODE_ENV: 'test', SCNS_HOME: '/explicit' })
      expect(env.SCNS_ISOLATION_PROBE).toBe('inherited')
      expect(env.NODE_ENV).toBe('test')
      expect(env.SCNS_HOME).toBe('/explicit') // caller can still override deliberately
    } finally {
      delete process.env.SCNS_ISOLATION_PROBE
    }
  })
})
