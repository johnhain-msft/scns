import { describe, it, expect } from 'vitest'
import { createSecretSanitizer } from '../../../src/observe/secret-sanitizer.js'
import type { SecretType } from '../../../src/observe/secret-sanitizer.js'

describe('createSecretSanitizer', () => {
  describe('sanitize — token detection', () => {
    it('redacts Bearer tokens', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('Authorization: Bearer abc123def456.token-value')).toBe(
        'Authorization: [REDACTED]',
      )
    })

    it('redacts GitHub tokens (ghp_)', () => {
      const s = createSecretSanitizer()
      const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
      expect(s.sanitize(`token: ${token}`)).toBe('token: [REDACTED]')
    })

    it('redacts GitHub tokens (gho_)', () => {
      const s = createSecretSanitizer()
      const token = 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
      expect(s.sanitize(`oauth: ${token}`)).toBe('oauth: [REDACTED]')
    })

    it('redacts AWS access keys (AKIA)', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('key: AKIAIOSFODNN7EXAMPLE')).toBe('key: [REDACTED]')
    })

    it('redacts Slack tokens (xoxb-)', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('bot: xoxb-123456789-abcdef')).toBe('bot: [REDACTED]')
    })

    it('redacts Slack tokens (xoxp-)', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('user: xoxp-999888777-aaabbb')).toBe('user: [REDACTED]')
    })

    it('redacts JWT tokens', () => {
      const s = createSecretSanitizer()
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123signature'
      expect(s.sanitize(`auth: ${jwt}`)).toBe('auth: [REDACTED]')
    })

    it('redacts API keys (sk-)', () => {
      const s = createSecretSanitizer()
      const key = 'sk-abcdefghijklmnopqrstuvwxyz1234567890'
      expect(s.sanitize(`openai: ${key}`)).toBe('openai: [REDACTED]')
    })

    it('redacts API keys (sk_live_)', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('stripe: sk_live_abc123def456')).toBe('stripe: [REDACTED]')
    })

    it('redacts API keys (sk_test_)', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('test: sk_test_xyz789')).toBe('test: [REDACTED]')
    })
  })

  describe('sanitize — credential patterns', () => {
    it('redacts password assignments (password=)', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('password=mysecret123')).toBe('[REDACTED]')
    })

    it('redacts password assignments (secret:)', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('config secret: very_secret_value')).toBe('config [REDACTED]')
    })

    it('redacts password assignments (passwd=)', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('db passwd=abc123')).toBe('db [REDACTED]')
    })

    it('redacts SSH private keys (multiline)', () => {
      const s = createSecretSanitizer()
      const sshKey = [
        '-----BEGIN RSA PRIVATE KEY-----',
        'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy5AoE2l',
        '-----END RSA PRIVATE KEY-----',
      ].join('\n')
      const text = `key:\n${sshKey}\nend`
      const result = s.sanitize(text)
      expect(result).toBe('key:\n[REDACTED]\nend')
    })

    it('redacts OPENSSH private keys', () => {
      const s = createSecretSanitizer()
      const sshKey = [
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'b3BlbnNzaC1rZXktdjEAAAAA',
        '-----END OPENSSH PRIVATE KEY-----',
      ].join('\n')
      expect(s.sanitize(sshKey)).toBe('[REDACTED]')
    })
  })

  describe('sanitize — connection strings & env vars', () => {
    it('redacts postgres connection strings', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('db: postgres://admin:s3cr3t@db.example.com:5432/mydb')).toBe(
        'db: [REDACTED]',
      )
    })

    it('redacts mongodb connection strings', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('mongodb://root:pass@mongo.host:27017/app')).toBe('[REDACTED]')
    })

    it('redacts mysql connection strings', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('mysql://user:pw@localhost:3306/db')).toBe('[REDACTED]')
    })

    it('redacts redis connection strings', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('redis://default:secret@cache.host:6379')).toBe('[REDACTED]')
    })

    it('redacts env var secret exports', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('export SECRET_KEY=my_super_secret')).toBe('[REDACTED]')
    })

    it('redacts Azure SharedAccessKey', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('conn: SharedAccessKey=abc123DEF456+ghi/789=')).toBe('conn: [REDACTED]')
    })

    it('redacts generic hex secrets (32+ chars)', () => {
      const s = createSecretSanitizer()
      const hex = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
      expect(s.sanitize(`hash: ${hex}`)).toBe('hash: [REDACTED]')
    })
  })

  describe('sanitize — edge cases', () => {
    it('handles multiple secrets in one string', () => {
      const s = createSecretSanitizer()
      const text = 'key=AKIAIOSFODNN7EXAMPLE token=xoxb-123-abc'
      const result = s.sanitize(text)
      expect(result).not.toContain('AKIA')
      expect(result).not.toContain('xoxb')
    })

    it('returns empty string unchanged', () => {
      const s = createSecretSanitizer()
      expect(s.sanitize('')).toBe('')
    })

    it('returns clean text unchanged', () => {
      const s = createSecretSanitizer()
      const text = 'Hello world, no secrets here'
      expect(s.sanitize(text)).toBe(text)
    })

    it('does not flag variable names that resemble keys', () => {
      const s = createSecretSanitizer()
      const text = 'const apiKey = fetchKey()'
      expect(s.sanitize(text)).toBe(text)
    })

    it('is idempotent — re-sanitizing produces same result', () => {
      const s = createSecretSanitizer()
      const text = 'Bearer abc123def456.token-value'
      const first = s.sanitize(text)
      const second = s.sanitize(first)
      expect(second).toBe(first)
    })

    it('handles all-secret text', () => {
      const s = createSecretSanitizer()
      const text = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
      expect(s.sanitize(text)).toBe('[REDACTED]')
    })

    it('uses custom replacement string', () => {
      const s = createSecretSanitizer({ replacement: '***' })
      expect(s.sanitize('Bearer abc123def456')).toBe('***')
    })

    it('applies extra custom patterns', () => {
      const s = createSecretSanitizer({
        extraPatterns: [/my-custom-secret-\d+/g],
      })
      expect(s.sanitize('Found: my-custom-secret-12345')).toBe('Found: [REDACTED]')
    })
  })

  describe('containsSecrets', () => {
    it('returns true when secrets are present', () => {
      const s = createSecretSanitizer()
      expect(s.containsSecrets('Bearer abc123token')).toBe(true)
      expect(s.containsSecrets('AKIAIOSFODNN7EXAMPLE')).toBe(true)
    })

    it('returns false for clean text', () => {
      const s = createSecretSanitizer()
      expect(s.containsSecrets('Hello, world!')).toBe(false)
      expect(s.containsSecrets('')).toBe(false)
    })
  })

  describe('detectSecrets', () => {
    it('returns correct secret types', () => {
      const s = createSecretSanitizer()
      const detections = s.detectSecrets('Bearer abc123token')
      expect(detections.length).toBeGreaterThanOrEqual(1)
      expect(detections[0]!.type).toBe('bearer-token' satisfies SecretType)
    })

    it('returns correct index and length', () => {
      const s = createSecretSanitizer()
      const text = 'key: AKIAIOSFODNN7EXAMPLE'
      const detections = s.detectSecrets(text)
      expect(detections.length).toBe(1)
      expect(detections[0]!.index).toBe(5)
      expect(detections[0]!.length).toBe(20)
    })

    it('detects multiple secret types', () => {
      const s = createSecretSanitizer()
      const text = 'Bearer abc123 and AKIAIOSFODNN7EXAMPLE'
      const detections = s.detectSecrets(text)
      expect(detections.length).toBe(2)
      const types = detections.map((d) => d.type)
      expect(types).toContain('bearer-token')
      expect(types).toContain('aws-key')
    })

    it('returns empty array for clean text', () => {
      const s = createSecretSanitizer()
      expect(s.detectSecrets('nothing secret')).toEqual([])
    })

    it('detects custom pattern secrets as "custom" type', () => {
      const s = createSecretSanitizer({
        extraPatterns: [/CUSTOM_[A-Z]{10}/g],
      })
      const detections = s.detectSecrets('here: CUSTOM_ABCDEFGHIJ')
      expect(detections.length).toBe(1)
      expect(detections[0]!.type).toBe('custom')
    })
  })
})
