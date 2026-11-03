/**
 * WS-0 Safety Kernel — egress/spend signature classifier tests (pure).
 *
 * These pin the heuristic surface the runtime gates depend on. Honest
 * limitation (documented in egress-signatures.ts): command-string egress
 * detection is signature-based and can be defeated by deliberate shell
 * obfuscation — only an OS-level egress jail (Option B, scheduled L0) is
 * truly unbypassable. These tests cover the non-obfuscated surface.
 */
import { describe, it, expect } from 'vitest'
import {
  extractCommand,
  extractUrl,
  hostOf,
  isInternalControlPlane,
  isEgressAttempt,
  isSpendAttempt,
  NETWORK_VERBS,
} from '../../../../../src/broker/services/safety-kernel/egress-signatures.js'

describe('egress-signatures: hostOf', () => {
  it('extracts a lowercase host from a full URL, stripping scheme/port/path', () => {
    expect(hostOf('https://API.OpenAI.com:443/v1/chat')).toBe('api.openai.com')
    expect(hostOf('http://evil.example.com/steal')).toBe('evil.example.com')
  })
  it('treats a bare host as a host', () => {
    expect(hostOf('evil.example.com')).toBe('evil.example.com')
  })
  it('returns null for empty/garbage', () => {
    expect(hostOf('')).toBeNull()
    expect(hostOf('   ')).toBeNull()
  })
})

describe('egress-signatures: isInternalControlPlane', () => {
  it('recognizes localhost / loopback as internal (non-egress)', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '0.0.0.0']) {
      expect(isInternalControlPlane(h)).toBe(true)
    }
    expect(isInternalControlPlane('http://127.0.0.1:3456/api/health')).toBe(true)
  })
  it('treats external hosts as NOT internal', () => {
    expect(isInternalControlPlane('evil.example.com')).toBe(false)
    expect(isInternalControlPlane('https://api.openai.com/v1')).toBe(false)
  })
})

describe('egress-signatures: extractCommand / extractUrl', () => {
  it('pulls a command from the command field or rawInput', () => {
    expect(extractCommand({ command: 'npm test' })).toBe('npm test')
    expect(extractCommand({ rawInput: { command: 'curl x' } })).toBe('curl x')
    expect(extractCommand({ rawInput: { cmd: 'wget y' } })).toBe('wget y')
    expect(extractCommand({ title: 'human label only' })).toBeNull()
  })
  it('pulls a url from the url field, rawInput, or an embedded http(s) URL', () => {
    expect(extractUrl({ url: 'https://a.com/x' })).toBe('https://a.com/x')
    expect(extractUrl({ rawInput: { url: 'http://b.com' } })).toBe('http://b.com')
    expect(extractUrl({ command: 'curl https://c.com/p -o f' })).toBe('https://c.com/p')
    expect(extractUrl({ command: 'npm run build' })).toBeNull()
  })
})

describe('egress-signatures: isEgressAttempt', () => {
  it('flags fetch tool kind as egress', () => {
    expect(isEgressAttempt({ kind: 'fetch', url: 'https://evil.example.com' })).toBe(true)
  })
  it('flags an execute command containing a network verb as egress', () => {
    for (const verb of NETWORK_VERBS) {
      expect(isEgressAttempt({ kind: 'execute', command: `${verb} https://evil.example.com` })).toBe(true)
    }
  })
  it('does NOT flag ordinary non-network execute commands', () => {
    for (const cmd of ['npm test', 'npm run build', 'git status', 'node dist/cli.js', 'vitest run']) {
      expect(isEgressAttempt({ kind: 'execute', command: cmd })).toBe(false)
    }
  })
  it('does NOT flag a fetch/command that targets the internal broker (non-egress)', () => {
    expect(isEgressAttempt({ kind: 'fetch', url: 'http://127.0.0.1:3456/api/health' })).toBe(false)
    expect(isEgressAttempt({ kind: 'execute', command: 'curl http://localhost:3456/api/teams' })).toBe(false)
  })
})

describe('egress-signatures: isSpendAttempt', () => {
  it('flags a paid-API host as spend', () => {
    expect(isSpendAttempt({ kind: 'fetch', url: 'https://api.openai.com/v1/chat/completions' })).toBe(true)
    expect(isSpendAttempt({ kind: 'fetch', url: 'https://api.anthropic.com/v1/messages' })).toBe(true)
    expect(isSpendAttempt({ kind: 'fetch', url: 'https://api.stripe.com/v1/charges' })).toBe(true)
  })
  it('flags billing/checkout keyword commands as spend', () => {
    expect(isSpendAttempt({ kind: 'execute', command: 'stripe charges create --amount 5000' })).toBe(true)
  })
  it('does NOT flag ordinary work as spend', () => {
    expect(isSpendAttempt({ kind: 'execute', command: 'npm test' })).toBe(false)
    expect(isSpendAttempt({ kind: 'fetch', url: 'http://127.0.0.1:3456/api/health' })).toBe(false)
  })
})
