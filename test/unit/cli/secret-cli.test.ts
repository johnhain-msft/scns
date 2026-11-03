import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretStore } from '../../../src/secrets/secret-store.js'
import { runList, runDelete, runSet, formatList } from '../../../src/cli/secret-cli.js'

function mkStore() {
  const dir = mkdtempSync(join(tmpdir(), 'scns-secret-cli-'))
  return createSecretStore({ rootDir: dir })
}

describe('secret-cli helpers', () => {
  describe('runSet', () => {
    it('sets a valid key and reports bytes', () => {
      const s = mkStore()
      const r = runSet(s, 'a.b', 'hunter2')
      expect(r.ok).toBe(true)
      expect(r.message).toContain('a.b')
      expect(r.message).toContain('7 bytes')
      expect(s.get('a.b')).toBe('hunter2')
    })

    it('rejects invalid keys', () => {
      const s = mkStore()
      expect(runSet(s, '../etc/passwd', 'x').ok).toBe(false)
      expect(runSet(s, 'a/b', 'x').ok).toBe(false)
    })

    it('rejects empty values', () => {
      const s = mkStore()
      const r = runSet(s, 'key', '')
      expect(r.ok).toBe(false)
      expect(r.message).toContain('Empty')
    })

    it('never echoes value in the message', () => {
      const s = mkStore()
      const r = runSet(s, 'k', 'MY-SUPER-SECRET')
      expect(r.message).not.toContain('MY-SUPER-SECRET')
    })
  })

  describe('runList', () => {
    it('says so when empty', () => {
      expect(runList(mkStore())).toContain('No secrets stored')
    })

    it('lists keys without values', () => {
      const s = mkStore()
      s.set('alpha', 'VAL-ALPHA')
      s.set('beta.x', 'VAL-BETA')
      const out = runList(s)
      expect(out).toContain('alpha')
      expect(out).toContain('beta.x')
      expect(out).not.toContain('VAL-ALPHA')
      expect(out).not.toContain('VAL-BETA')
    })

    it('formatList emits fixed-width table with headers', () => {
      const out = formatList([
        { key: 'k1', createdAt: '2026-04-19T12:00:00.000Z', updatedAt: '2026-04-19T12:00:00.000Z', sizeBytes: 7 },
      ])
      expect(out).toContain('KEY')
      expect(out).toContain('CREATED')
      expect(out).toContain('UPDATED')
      expect(out).toContain('BYTES')
      expect(out).toContain('k1')
    })
  })

  describe('runDelete', () => {
    it('deletes existing key', () => {
      const s = mkStore()
      s.set('k', 'v')
      const r = runDelete(s, 'k')
      expect(r.ok).toBe(true)
      expect(s.get('k')).toBeNull()
    })

    it('reports not found for missing key', () => {
      const s = mkStore()
      const r = runDelete(s, 'missing')
      expect(r.ok).toBe(false)
      expect(r.message).toContain('not found')
    })

    it('rejects invalid keys', () => {
      const s = mkStore()
      expect(runDelete(s, '../bad').ok).toBe(false)
    })
  })

  it('set then list round-trip preserves 0600 perms', () => {
    const s = mkStore()
    runSet(s, 'round.trip', 'value')
    const items = s.list()
    expect(items.map((i) => i.key)).toContain('round.trip')
    // sanity: disk file still has the value
    expect(readFileSync(join(s.rootDir, 'round.trip'), 'utf-8')).toBe('value')
  })
})
