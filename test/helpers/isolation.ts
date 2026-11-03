/**
 * Test isolation helper (T003, specs/001-learning-memory-loop Phase 1).
 *
 * Creates a throwaway root (`mkdtemp`) whose vault/experience DB paths are dependency-injected into
 * whatever is under test — never `~/.scns` — and provides the read-only live-vault guard: snapshot
 * `~/.scns/memory/vault.db` mtime+size before a run and assert both are unchanged after (the invariant
 * documented at `experience-store.ts:12-15`). The vault path is a parameter so the guard itself is
 * testable with a negative control; it defaults to the live vault.
 */
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'

/** The live vault every test/benchmark must leave byte-identical. */
export const LIVE_VAULT_DB = resolve(homedir(), '.scns', 'memory', 'vault.db')

/** The default broker port (see broker/config.ts). Every guarded run MUST leave it undisturbed. */
export const BROKER_PORT = 3456

export interface IsolatedRoot {
  /** Fresh `mkdtemp` directory; everything under test writes only here. */
  readonly rootDir: string
  /** DI this as the vault DB path (e.g. `openMemoryDb(vaultDbPath)`). */
  readonly vaultDbPath: string
  /** DI this as the experience DB path (e.g. `openExperienceStore(experienceDbPath)`). */
  readonly experienceDbPath: string
  /** Remove the root recursively. */
  readonly cleanup: () => void
}

/** Throwaway root with injected vault/experience DB paths (never `~/.scns`). */
export function createIsolatedRoot(): IsolatedRoot {
  const rootDir = mkdtempSync(join(tmpdir(), 'scns-isolated-'))
  return {
    rootDir,
    vaultDbPath: join(rootDir, 'vault.db'),
    experienceDbPath: join(rootDir, 'experience.db'),
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  }
}

export interface VaultSnapshot {
  readonly path: string
  readonly exists: boolean
  readonly mtimeMs: number
  readonly size: number
}

/** Snapshot a vault file's existence + mtime + size. Defaults to the LIVE vault. */
export function snapshotVault(path: string = LIVE_VAULT_DB): VaultSnapshot {
  if (!existsSync(path)) return { path, exists: false, mtimeMs: 0, size: 0 }
  const s = statSync(path)
  return { path, exists: true, mtimeMs: s.mtimeMs, size: s.size }
}

/**
 * Assert the vault is byte-identical to `before` (same existence, mtime, size). Throws on ANY
 * difference — including a file appearing where none existed. Returns the after-snapshot so callers
 * can log it as evidence.
 */
export function assertVaultUnchanged(before: VaultSnapshot): VaultSnapshot {
  const after = snapshotVault(before.path)
  if (after.exists !== before.exists || after.size !== before.size) {
    throw new Error(
      `vault ${before.path} changed during the run: ` +
        `exists ${before.exists}→${after.exists}, size ${before.size}→${after.size} — ` +
        `the live vault must stay READ-ONLY`,
    )
  }
  if (after.mtimeMs !== before.mtimeMs) {
    throw new Error(
      `vault ${before.path} changed during the run: mtime ${before.mtimeMs}→${after.mtimeMs} ` +
        `(size unchanged) — the live vault must stay READ-ONLY`,
    )
  }
  return after
}

export interface IsolatedHome {
  /** Fresh `mkdtemp` directory now exported as `process.env.SCNS_HOME`. */
  readonly home: string
  /** Restore the prior `SCNS_HOME` (or delete it) and remove the throwaway home. */
  readonly restore: () => void
}

/**
 * The guard preamble's `SCNS_HOME=$(mktemp -d)` isolation as a reusable helper: point every SCNS run
 * at a throwaway home so it can never read or write the live `~/.scns`. Snapshots the prior value and
 * restores it exactly (including `undefined`) on `restore()`, then removes the temp home.
 */
export function createIsolatedHome(): IsolatedHome {
  const home = mkdtempSync(join(tmpdir(), 'scns-home-'))
  const prev = process.env.SCNS_HOME
  process.env.SCNS_HOME = home
  return {
    home,
    restore: () => {
      if (prev === undefined) delete process.env.SCNS_HOME
      else process.env.SCNS_HOME = prev
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/**
 * Build the `env` for a child process (broker, CLI, worker) that must run entirely inside `home`.
 *
 * Overriding `HOME` alone is NOT enough, for two independent reasons.
 *
 * 1. `resolveScnsHome()` (`src/shared/scns-home.ts`) gives `SCNS_HOME` PRECEDENCE over `homedir()`,
 *    so when the operator's shell exports `SCNS_HOME` — this repo's own documented isolation
 *    convention (`SCNS_HOME=$(mktemp -d)`, see `.github/instructions/00-fix-first.instructions.md`
 *    §6) — that outer value leaks through `...process.env` and silently points the child's whole
 *    `~/.scns` tree back OUT of the sandbox. The child then writes its vault/experience DBs
 *    somewhere the test never looks, and assertions on `<home>/.scns/...` fail with
 *    `SqliteError: unable to open database file`.
 *
 * 2. `HOME` does not move `homedir()` on Windows at all — `os.homedir()` reads `USERPROFILE` there
 *    and ignores `HOME`, so the pin is a POSIX-only no-op. That matters because
 *    `src/broker/config.ts` computes its default broker DB at MODULE LOAD as
 *    `join(homedir(), '.session-broker', 'data.db')` using `homedir()` and NOT `resolveScnsHome()`
 *    — so `SCNS_HOME` cannot redirect it either. A spawned broker inheriting neither
 *    `USERPROFILE` nor `BROKER_DB_PATH` opens the operator's LIVE `~/.session-broker/data.db` and
 *    appends a `broker_started` row (`src/broker/startup.ts:815`). Measured before this fix: 8
 *    ephemeral-port rows in the live DB from one full-suite run — test traffic in the production
 *    corpus, which §3b forbids.
 *
 * So pin all four: `HOME` + `USERPROFILE` (so `homedir()` lands in the sandbox on every platform),
 * `SCNS_HOME` (the `.scns` tree), and `BROKER_DB_PATH` (the broker DB, which no home-directory pin
 * can be trusted to scope). The guard is `test/unit/harness/broker-db-isolation.test.ts`.
 *
 * `extra` is applied last so a caller can still override any pinned key deliberately.
 */
export function isolatedHomeEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    SCNS_HOME: home,
    BROKER_DB_PATH: join(home, '.session-broker', 'data.db'),
    ...extra,
  }
}

/**
 * Kill-by-explicit-PID guard: the ONLY sanctioned way to terminate a spawned process in a guarded run
 * (never `pkill`/`killall`, which are name-based and can hit the broker or an unrelated process). Refuses
 * any non-positive-integer pid so a bad value can't be coerced into a broad signal. `signal` defaults to
 * `SIGTERM`; pass `0` to probe liveness without signalling. Returns `true` if the signal was delivered,
 * `false` if the process was already gone (ESRCH).
 */
export function killByPid(pid: number, signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      `killByPid refuses a non-positive-integer pid (${pid}) — kill by explicit PID only`,
    )
  }
  try {
    process.kill(pid, signal)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw err
  }
}
