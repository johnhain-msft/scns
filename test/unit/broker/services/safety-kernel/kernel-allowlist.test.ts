/**
 * WS-0 Safety Kernel — allowlist loader tests.
 *
 * The allowlist is human-owned data. It ships EMPTY (= deny-all) and the
 * loader FAILS CLOSED: any missing/corrupt/garbage input yields an empty
 * allowlist, never an open one. Also asserts the SHIPPED file is empty so
 * a future accidental entry is caught by CI.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  emptyAllowlist,
  allowlistFrom,
  loadAllowlist,
} from '../../../../../src/broker/services/safety-kernel/kernel-allowlist.js'
import { SAFETY_ALLOWLIST_PATH } from '../../../../../src/broker/services/safety-kernel/protected-paths.js'

describe('kernel-allowlist', () => {
  it('emptyAllowlist denies all (no egress hosts, no spend APIs)', () => {
    const a = emptyAllowlist()
    expect(a.egressHosts.size).toBe(0)
    expect(a.spendApis.size).toBe(0)
  })

  it('allowlistFrom normalizes hosts to lowercase', () => {
    const a = allowlistFrom({ hosts: ['API.GitHub.com'], spendApis: ['API.OpenAI.com'] })
    expect(a.egressHosts.has('api.github.com')).toBe(true)
    expect(a.spendApis.has('api.openai.com')).toBe(true)
  })

  it('loadAllowlist returns empty when the file is missing (fail-closed)', () => {
    const a = loadAllowlist('/no/such/file.json', {
      readFile: () => {
        throw new Error('ENOENT')
      },
    })
    expect(a.egressHosts.size).toBe(0)
    expect(a.spendApis.size).toBe(0)
  })

  it('loadAllowlist returns empty for corrupt JSON (fail-closed)', () => {
    const a = loadAllowlist('x', { readFile: () => '{ not json ]' })
    expect(a.egressHosts.size).toBe(0)
  })

  it('loadAllowlist ignores non-array / junk fields (fail-closed)', () => {
    const a = loadAllowlist('x', { readFile: () => JSON.stringify({ hosts: 'evil.com', spendApis: 42 }) })
    expect(a.egressHosts.size).toBe(0)
    expect(a.spendApis.size).toBe(0)
  })

  it('loadAllowlist reads a well-formed allowlist', () => {
    const a = loadAllowlist('x', { readFile: () => JSON.stringify({ hosts: ['api.github.com'], spendApis: [] }) })
    expect(a.egressHosts.has('api.github.com')).toBe(true)
  })

  it('the SHIPPED config/safety-allowlist.json is EMPTY (deny-all)', () => {
    const raw = readFileSync(resolve(SAFETY_ALLOWLIST_PATH), 'utf-8')
    const parsed = JSON.parse(raw) as { hosts?: unknown; spendApis?: unknown }
    expect(Array.isArray(parsed.hosts) ? parsed.hosts.length : 0).toBe(0)
    expect(Array.isArray(parsed.spendApis) ? parsed.spendApis.length : 0).toBe(0)
  })
})
