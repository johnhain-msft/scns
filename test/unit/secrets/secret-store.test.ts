import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, statSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretStore, isValidKey } from '../../../src/secrets/secret-store.js'

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'scns-secret-store-'))
}

// POSIX mode bits cannot be created or observed on NTFS (chmod is a no-op and
// `mode & 0o777` reads 0o666 for any writable file), so mode-assertion and
// chmod-simulation tests only mean something off-Windows. The win32 behavior
// is covered by the injected-platform describe at the bottom.
const posixOnly = it.skipIf(process.platform === 'win32')

describe('secret-store', () => {
  let root: string
  beforeEach(() => {
    root = mkTmp()
  })

  describe('isValidKey', () => {
    it('accepts flat dotted keys', () => {
      expect(isValidKey('instagram.password')).toBe(true)
      expect(isValidKey('API_KEY_1')).toBe(true)
      expect(isValidKey('x-y_z.1')).toBe(true)
    })
    it('rejects path traversal and slashes', () => {
      expect(isValidKey('../etc/passwd')).toBe(false)
      expect(isValidKey('a/b')).toBe(false)
      expect(isValidKey('a\\b')).toBe(false)
      expect(isValidKey('a..b')).toBe(false)
    })
    it('rejects empty and leading non-alnum', () => {
      expect(isValidKey('')).toBe(false)
      expect(isValidKey('.hidden')).toBe(false)
      expect(isValidKey('-lead')).toBe(false)
    })
    it('rejects overlong keys', () => {
      expect(isValidKey('a'.repeat(129))).toBe(false)
      expect(isValidKey('a'.repeat(128))).toBe(true)
    })
  })

  posixOnly('creates root dir with mode 0700', () => {
    createSecretStore({ rootDir: root })
    const st = statSync(root)
    expect(st.mode & 0o777).toBe(0o700)
  })

  posixOnly('set writes files with mode 0600', () => {
    const store = createSecretStore({ rootDir: root })
    store.set('foo.bar', 'hunter2')
    const st = statSync(join(root, 'foo.bar'))
    expect(st.mode & 0o777).toBe(0o600)
  })

  it('get returns value set earlier', () => {
    const store = createSecretStore({ rootDir: root })
    store.set('k', 'v')
    expect(store.get('k')).toBe('v')
  })

  it('get returns null for missing key', () => {
    const store = createSecretStore({ rootDir: root })
    expect(store.get('missing')).toBeNull()
  })

  it('list returns keys only (no values)', () => {
    const store = createSecretStore({ rootDir: root })
    store.set('a', 'secretA')
    store.set('b.sub', 'secretB')
    const items = store.list()
    expect(items.map((m) => m.key).sort()).toEqual(['a', 'b.sub'])
    for (const item of items) {
      const serialized = JSON.stringify(item)
      expect(serialized).not.toContain('secretA')
      expect(serialized).not.toContain('secretB')
    }
  })

  it('delete removes the file and returns true/false', () => {
    const store = createSecretStore({ rootDir: root })
    store.set('k', 'v')
    expect(store.delete('k')).toBe(true)
    expect(store.get('k')).toBeNull()
    expect(store.delete('k')).toBe(false)
  })

  it('set overwrites and keeps 0600', () => {
    const store = createSecretStore({ rootDir: root })
    store.set('k', 'v1')
    store.set('k', 'v2')
    expect(store.get('k')).toBe('v2')
    if (process.platform !== 'win32') {
      const st = statSync(join(root, 'k'))
      expect(st.mode & 0o777).toBe(0o600)
    }
  })

  posixOnly('refuses to read a world-readable file', () => {
    const store = createSecretStore({ rootDir: root })
    store.set('loose', 'data')
    chmodSync(join(root, 'loose'), 0o644)
    expect(() => store.get('loose')).toThrow(/mode is 644/)
  })

  posixOnly('refuses to read a group-readable file', () => {
    const store = createSecretStore({ rootDir: root })
    store.set('loose', 'data')
    chmodSync(join(root, 'loose'), 0o640)
    expect(() => store.get('loose')).toThrow(/expected 600/)
  })

  it('set rejects invalid keys', () => {
    const store = createSecretStore({ rootDir: root })
    expect(() => store.set('../bad', 'x')).toThrow(/Invalid secret key/)
    expect(() => store.set('a/b', 'x')).toThrow(/Invalid secret key/)
  })

  it('get rejects invalid keys', () => {
    const store = createSecretStore({ rootDir: root })
    expect(() => store.get('..')).toThrow(/Invalid secret key/)
  })

  it('list skips stray files that are not valid keys', () => {
    const store = createSecretStore({ rootDir: root })
    store.set('real', 'v')
    writeFileSync(join(root, '.DS_Store'), 'junk', { mode: 0o600 })
    const keys = store.list().map((m) => m.key)
    expect(keys).toEqual(['real'])
  })

  it('skipUidCheck disables uid enforcement (for test injection)', () => {
    const store = createSecretStore({ rootDir: root, skipUidCheck: true, uid: 999999 })
    store.set('k', 'v')
    expect(store.get('k')).toBe('v')
  })

  it('rejects read when uid does not match (simulated)', () => {
    // Can't fake ownership without root; simulate via a mismatched uid option.
    // When uid is set to a value that doesn't match the actual owner, read is refused.
    const store = createSecretStore({ rootDir: root })
    store.set('k', 'v')
    // Fresh store instance with forced mismatched uid
    const badStore = createSecretStore({ rootDir: root, uid: -1 })
    expect(() => badStore.get('k')).toThrow(/does not match/)
  })

  // WI-Windows — the perms gate is platform-forked the same way as the
  // internal-token reader: NTFS never reports 0o600, so win32 relies on the
  // profile dir's default ACLs and must NOT refuse loose-looking modes, while
  // posix keeps refusing them. Injected platforms make both branches testable
  // on every host.
  describe('win32 branch (injected platform)', () => {
    it('reads a secret even when the file mode reads loose (NTFS reality)', () => {
      const store = createSecretStore({ rootDir: root, platform: 'win32' })
      store.set('k', 'v')
      // On posix hosts this creates the exact state a Windows stat reports
      // (mode broader than 0600); on real win32 chmod is a no-op and the file
      // already reads 0o666. Either way the win32 branch must still read it.
      chmodSync(join(root, 'k'), 0o644)
      expect(store.get('k')).toBe('v')
    })

    it('posix default still enforces the perms gate (unchanged)', () => {
      const store = createSecretStore({ rootDir: root, platform: 'linux' })
      store.set('k', 'v')
      chmodSync(join(root, 'k'), 0o644)
      // Real win32 reports 0o666, posix hosts report the chmodded 0o644 —
      // both are ≠0600, so the injected-posix gate must refuse.
      expect(() => store.get('k')).toThrow(/expected 600/)
    })
  })
})
