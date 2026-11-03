import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadOtelConfig, getOtelActivationStatus } from '../../../src/otel/config.js'

describe('otel config', () => {
  const savedEnv: Record<string, string | undefined> = {}

  const OTEL_ENV_KEYS = [
    'OTEL_SCNS_ENABLED',
    'OTEL_SCNS_FILE_PATH',
    'OTEL_SCNS_RETENTION_DAYS',
    'OTEL_SCNS_MAX_SPANS_PER_TRACE',
    'OTEL_SCNS_POLL_INTERVAL_MS',
    'COPILOT_OTEL_FILE_EXPORTER_PATH',
  ]

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key]
    process.env[key] = value
  }

  beforeEach(() => {
    for (const key of OTEL_ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    for (const key of Object.keys(savedEnv)) {
      delete savedEnv[key]
    }
  })

  it('returns frozen defaults when no env vars set (enabled by default in 13.12.8)', () => {
    const config = loadOtelConfig()
    expect(config.enabled).toBe(true)
    expect(config.filePath).toBeNull()
    expect(config.retentionDays).toBe(7)
    expect(config.maxSpansPerTrace).toBe(1000)
    expect(config.pollIntervalMs).toBe(1000)
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('can be explicitly disabled with OTEL_SCNS_ENABLED=false', () => {
    setEnv('OTEL_SCNS_ENABLED', 'false')
    const config = loadOtelConfig()
    expect(config.enabled).toBe(false)
  })

  it('enables when OTEL_SCNS_ENABLED=true', () => {
    setEnv('OTEL_SCNS_ENABLED', 'true')
    const config = loadOtelConfig()
    expect(config.enabled).toBe(true)
  })

  it('auto-enables when OTEL_SCNS_FILE_PATH is set', () => {
    setEnv('OTEL_SCNS_FILE_PATH', '/path/to/traces.jsonl')
    const config = loadOtelConfig()
    expect(config.enabled).toBe(true)
    expect(config.filePath).toBe('/path/to/traces.jsonl')
  })

  it('auto-enables when COPILOT_OTEL_FILE_EXPORTER_PATH is set', () => {
    setEnv('COPILOT_OTEL_FILE_EXPORTER_PATH', '/copilot/otel.jsonl')
    const config = loadOtelConfig()
    expect(config.enabled).toBe(true)
    expect(config.filePath).toBe('/copilot/otel.jsonl')
  })

  it('prefers OTEL_SCNS_FILE_PATH over COPILOT_OTEL_FILE_EXPORTER_PATH', () => {
    setEnv('OTEL_SCNS_FILE_PATH', '/scns/path.jsonl')
    setEnv('COPILOT_OTEL_FILE_EXPORTER_PATH', '/copilot/path.jsonl')
    const config = loadOtelConfig()
    expect(config.filePath).toBe('/scns/path.jsonl')
  })

  it('reads retentionDays from env var', () => {
    setEnv('OTEL_SCNS_RETENTION_DAYS', '30')
    const config = loadOtelConfig()
    expect(config.retentionDays).toBe(30)
  })

  it('reads pollIntervalMs from env var', () => {
    setEnv('OTEL_SCNS_POLL_INTERVAL_MS', '5000')
    const config = loadOtelConfig()
    expect(config.pollIntervalMs).toBe(5000)
  })

  it('reads maxSpansPerTrace from env var', () => {
    setEnv('OTEL_SCNS_MAX_SPANS_PER_TRACE', '500')
    const config = loadOtelConfig()
    expect(config.maxSpansPerTrace).toBe(500)
  })

  it('uses defaults for invalid env values', () => {
    setEnv('OTEL_SCNS_RETENTION_DAYS', 'not-a-number')
    setEnv('OTEL_SCNS_POLL_INTERVAL_MS', '-1')
    const config = loadOtelConfig()
    expect(config.retentionDays).toBe(7)
    expect(config.pollIntervalMs).toBe(1000)
  })

  describe('getOtelActivationStatus', () => {
    it('returns unconfigured when explicitly disabled and no file path', () => {
      setEnv('OTEL_SCNS_ENABLED', 'false')
      const config = loadOtelConfig()
      expect(getOtelActivationStatus(config)).toBe('unconfigured')
    })

    it('returns configured when file path set but no spans', () => {
      setEnv('OTEL_SCNS_FILE_PATH', '/path.jsonl')
      const config = loadOtelConfig()
      expect(getOtelActivationStatus(config, false)).toBe('configured')
    })

    it('returns active when spans have been ingested', () => {
      setEnv('OTEL_SCNS_FILE_PATH', '/path.jsonl')
      const config = loadOtelConfig()
      expect(getOtelActivationStatus(config, true)).toBe('active')
    })
  })
})
