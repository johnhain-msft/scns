import { describe, it, expect } from 'vitest'
import { mkdtempSync, statSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureInternalToken } from '../../../src/secrets/internal-token.js'

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'scns-internal-token-'))
}

describe('internal-token', () => {
  it('generates a 64-hex token on first call and writes 0600', () => {
    const dir = mkTmp()
    const path = join(dir, '.internal-token')
    const token = ensureInternalToken({ path })
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    if (process.platform !== 'win32') {
      // NTFS reports 0o666 regardless of the mode passed to writeFileSync.
      const st = statSync(path)
      expect(st.mode & 0o777).toBe(0o600)
    }
    expect(readFileSync(path, 'utf-8')).toBe(token)
  })

  it('returns existing token on second call when file is well-formed', () => {
    const dir = mkTmp()
    const path = join(dir, '.internal-token')
    const first = ensureInternalToken({ path })
    const second = ensureInternalToken({ path })
    expect(second).toBe(first)
  })

  // skipIf: on a real win32 host the DEFAULT platform takes the win32 branch,
  // which deliberately ignores mode bits — the injected-platform describe
  // below covers both branches on every host.
  it.skipIf(process.platform === 'win32')('regenerates when existing file has wrong perms', () => {
    const dir = mkTmp()
    const path = join(dir, '.internal-token')
    const first = ensureInternalToken({ path })
    chmodSync(path, 0o644)
    const second = ensureInternalToken({ path })
    expect(second).not.toBe(first)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('regenerates when existing contents are malformed', () => {
    const dir = mkTmp()
    const path = join(dir, '.internal-token')
    writeFileSync(path, 'not-a-token', { mode: 0o600 })
    const t = ensureInternalToken({ path })
    expect(t).toMatch(/^[0-9a-f]{64}$/)
  })

  it('forceRegenerate replaces a valid token', () => {
    const dir = mkTmp()
    const path = join(dir, '.internal-token')
    const first = ensureInternalToken({ path })
    const second = ensureInternalToken({ path, forceRegenerate: true })
    expect(second).not.toBe(first)
  })
})

// ── WI-1(c): win32 branch — POSIX 0600 perms are meaningless on NTFS ──────
// On Windows `stat().mode & 0o777` is never 0o600, so without the platform
// guard the broker would silently mint a NEW token on every restart, breaking
// the token embedded in the installed Copilot extension and any in-flight
// agent that cached it.

describe('internal-token — win32 branch (injected platform)', () => {
  it('reuses a well-formed existing token without the perms gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scns-token-win32-'))
    const path = join(dir, '.internal-token')
    try {
      const first = ensureInternalToken({ path, skipUidCheck: true, platform: 'win32' })
      // Simulate NTFS reality: whatever mode the file has, it is not 0o600.
      chmodSync(path, 0o644)
      const second = ensureInternalToken({ path, skipUidCheck: true, platform: 'win32' })
      expect(second).toBe(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still regenerates on malformed contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scns-token-win32-'))
    const path = join(dir, '.internal-token')
    try {
      writeFileSync(path, 'not-a-token')
      const token = ensureInternalToken({ path, skipUidCheck: true, platform: 'win32' })
      expect(token).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('posix branch still enforces the 0600 perms gate (unchanged)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scns-token-posix-'))
    const path = join(dir, '.internal-token')
    try {
      // Inject the posix platform explicitly so this stays a posix-branch test
      // even on a win32 host (where the default would take the win32 branch).
      // posix hosts see the chmodded 0o644, win32 hosts read 0o666 — both are
      // ≠0600, so the gate must force regeneration either way.
      const first = ensureInternalToken({ path, skipUidCheck: true, platform: 'linux' })
      chmodSync(path, 0o644)
      const second = ensureInternalToken({ path, skipUidCheck: true, platform: 'linux' })
      expect(second).not.toBe(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
