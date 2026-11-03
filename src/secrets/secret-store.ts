/**
 * Phase 13.12.17 — Credential vault.
 *
 * A minimal filesystem-backed store for secrets the brain needs to hand to
 * spawned agents (service passwords, API keys, etc.). At-rest security this
 * phase is filesystem perms only: directory 0700, files 0600, and the reader
 * refuses any secret whose file is owned by a different uid or has broader
 * permissions than 0600.
 *
 * Keys are flat strings like "instagram.password". Values are opaque strings.
 * No crypto. No key hierarchy. No dashboard surface — fetching is only via
 * the internal-token-guarded broker route and the spawned-agent env.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  unlinkSync,
  existsSync,
  chmodSync,
} from 'node:fs'
import { join } from 'node:path'

export interface SecretMetadata {
  readonly key: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sizeBytes: number
}

export interface SecretStore {
  /** Write-or-update a secret. Enforces 0600 on the file. */
  set(key: string, value: string): void
  /** Read a secret. Throws if perms are broader than 0600 or file is not owned by uid. */
  get(key: string): string | null
  /** List keys only (never values). */
  list(): readonly SecretMetadata[]
  /** Delete a secret. Returns true if a file was removed. */
  delete(key: string): boolean
  /** Absolute directory under which secrets are stored. Exposed for tests/logging. */
  readonly rootDir: string
}

export interface SecretStoreOptions {
  readonly rootDir: string
  /** Optional uid check override for tests. Defaults to process.getuid?.(). */
  readonly uid?: number
  /** When true, skip owner/uid checks (tests only). */
  readonly skipUidCheck?: boolean
  /** Platform override for tests; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
}

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

/** True if `k` is a safe flat-string key. Rejects path traversal, empties, overlong. */
export function isValidKey(k: string): boolean {
  if (typeof k !== 'string') return false
  if (!KEY_RE.test(k)) return false
  if (k.includes('/') || k.includes('\\') || k.includes('..')) return false
  return true
}

function assertValidKey(k: string): void {
  if (!isValidKey(k)) {
    throw new Error(
      `Invalid secret key: ${JSON.stringify(k)}. Use [a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}.`,
    )
  }
}

export function createSecretStore(options: SecretStoreOptions): SecretStore {
  const rootDir = options.rootDir
  const skipUidCheck = options.skipUidCheck === true
  const platform = options.platform ?? process.platform
  const expectedUid =
    options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)

  mkdirSync(rootDir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(rootDir, 0o700)
  } catch {
    // best-effort
  }

  function pathFor(key: string): string {
    assertValidKey(key)
    return join(rootDir, key)
  }

  function enforceReadablePerms(absPath: string, key: string): void {
    const st = statSync(absPath)
    const perms = st.mode & 0o777
    // POSIX mode bits are meaningless on NTFS (`mode & 0o777` reads 0o666 for
    // every writable file) — without this guard no secret was EVER readable on
    // Windows. Windows relies on default NTFS ACLs (the profile dir is
    // owner-scoped), matching the internal-token reader's stance.
    if (platform !== 'win32' && perms !== 0o600) {
      throw new Error(
        `Refusing to read secret ${key}: file mode is ${perms.toString(8)} (expected 600). ` +
          `Fix with: chmod 600 ${absPath}`,
      )
    }
    if (!skipUidCheck && expectedUid !== undefined && st.uid !== expectedUid) {
      throw new Error(
        `Refusing to read secret ${key}: file owner uid=${st.uid} does not match current uid=${expectedUid}.`,
      )
    }
  }

  return {
    rootDir,

    set(key: string, value: string): void {
      if (typeof value !== 'string') {
        throw new Error('Secret value must be a string')
      }
      const p = pathFor(key)
      writeFileSync(p, value, { mode: 0o600 })
      chmodSync(p, 0o600)
    },

    get(key: string): string | null {
      const p = pathFor(key)
      if (!existsSync(p)) return null
      enforceReadablePerms(p, key)
      return readFileSync(p, 'utf-8')
    },

    list(): readonly SecretMetadata[] {
      if (!existsSync(rootDir)) return []
      const entries = readdirSync(rootDir)
      const out: SecretMetadata[] = []
      for (const name of entries) {
        if (!isValidKey(name)) continue // skip stray files like .DS_Store
        const abs = join(rootDir, name)
        let st
        try {
          st = statSync(abs)
        } catch {
          continue
        }
        if (!st.isFile()) continue
        out.push({
          key: name,
          createdAt: st.birthtime.toISOString(),
          updatedAt: st.mtime.toISOString(),
          sizeBytes: st.size,
        })
      }
      return out.sort((a, b) => a.key.localeCompare(b.key))
    },

    delete(key: string): boolean {
      const p = pathFor(key)
      if (!existsSync(p)) return false
      unlinkSync(p)
      return true
    },
  }
}
