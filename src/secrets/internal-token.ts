/**
 * Phase 13.12.17 — Internal-token management.
 *
 * The broker generates a 64-char hex token at startup and persists it to
 * `~/.scns/.internal-token` (mode 0600). The token is required by
 * `POST /api/secrets/:key/fetch`. It's injected into spawned-agent env as
 * `SCNS_INTERNAL_TOKEN`, but never logged, never exposed via the dashboard.
 *
 * On restart, we prefer to preserve the existing token so in-flight agents
 * that cached it remain functional; only generate a fresh one if the file
 * is missing, malformed, or has bad perms.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, statSync, chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface InternalTokenOptions {
  readonly path: string
  /** Force regeneration even if an existing file is valid. */
  readonly forceRegenerate?: boolean
  /** Optional uid check override for tests. */
  readonly uid?: number
  readonly skipUidCheck?: boolean
  /** Platform override for tests; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
}

const HEX_64 = /^[0-9a-f]{64}$/

function generate(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Ensure an internal token file exists at `opts.path` with mode 0600,
 * returning its value. Reuses existing token if present and well-formed;
 * otherwise generates a fresh 64-hex token.
 */
export function ensureInternalToken(opts: InternalTokenOptions): string {
  const { path } = opts
  mkdirSync(dirname(path), { recursive: true })

  const platform = opts.platform ?? process.platform
  if (!opts.forceRegenerate && existsSync(path)) {
    try {
      const st = statSync(path)
      const perms = st.mode & 0o777
      const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
      const ownerOk = opts.skipUidCheck || uid === undefined || st.uid === uid
      // POSIX mode bits are meaningless on NTFS (`mode & 0o777` never reads
      // 0o600 there) — without this guard every Windows restart would mint a
      // fresh token, silently invalidating the one embedded in the installed
      // Copilot extension. Windows relies on default NTFS ACLs instead.
      const permsOk = platform === 'win32' || perms === 0o600
      if (ownerOk && permsOk) {
        const existing = readFileSync(path, 'utf-8').trim()
        if (HEX_64.test(existing)) {
          return existing
        }
      }
    } catch {
      // fall through to regeneration
    }
  }

  const token = generate()
  writeFileSync(path, token, { mode: 0o600 })
  chmodSync(path, 0o600)
  return token
}
