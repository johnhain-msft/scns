import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { resolveScnsHome } from '../../../src/shared/scns-home.js'
import {
  resolveTelemetryRotationConfig,
  DEFAULT_TELEMETRY_MAX_BYTES,
  DEFAULT_TELEMETRY_RETAIN_COUNT,
} from '../../../src/retention/telemetry-rotator.js'

describe('resolveTelemetryRotationConfig', () => {
  it('returns defaults when nothing is provided and env is empty', () => {
    const cfg = resolveTelemetryRotationConfig(undefined, {})
    expect(cfg.filePath).toBe(join(resolveScnsHome(), '.scns', 'telemetry', 'copilot-otel.jsonl'))
    expect(cfg.maxBytes).toBe(DEFAULT_TELEMETRY_MAX_BYTES)
    expect(cfg.retainCount).toBe(DEFAULT_TELEMETRY_RETAIN_COUNT)
  })

  it('honors SCNS_TELEMETRY_FILE_PATH from env', () => {
    const cfg = resolveTelemetryRotationConfig(undefined, {
      SCNS_TELEMETRY_FILE_PATH: '/tmp/scns-test/otel.jsonl',
    })
    expect(cfg.filePath).toBe('/tmp/scns-test/otel.jsonl')
  })

  it('honors SCNS_TELEMETRY_MAX_BYTES from env', () => {
    const cfg = resolveTelemetryRotationConfig(undefined, {
      SCNS_TELEMETRY_MAX_BYTES: '2048',
    })
    expect(cfg.maxBytes).toBe(2048)
  })

  it('honors SCNS_TELEMETRY_RETAIN_COUNT from env', () => {
    const cfg = resolveTelemetryRotationConfig(undefined, {
      SCNS_TELEMETRY_RETAIN_COUNT: '10',
    })
    expect(cfg.retainCount).toBe(10)
  })

  it('per-call overrides win over env', () => {
    const cfg = resolveTelemetryRotationConfig(
      { filePath: '/over/ride.jsonl', maxBytes: 99, retainCount: 1 },
      {
        SCNS_TELEMETRY_FILE_PATH: '/env/path.jsonl',
        SCNS_TELEMETRY_MAX_BYTES: '8888',
        SCNS_TELEMETRY_RETAIN_COUNT: '4',
      },
    )
    expect(cfg.filePath).toBe('/over/ride.jsonl')
    expect(cfg.maxBytes).toBe(99)
    expect(cfg.retainCount).toBe(1)
  })

  it('ignores invalid numerics (zero, negative, non-numeric) and falls back to defaults', () => {
    const cfg = resolveTelemetryRotationConfig(undefined, {
      SCNS_TELEMETRY_MAX_BYTES: '0',
      SCNS_TELEMETRY_RETAIN_COUNT: 'banana',
    })
    expect(cfg.maxBytes).toBe(DEFAULT_TELEMETRY_MAX_BYTES)
    expect(cfg.retainCount).toBe(DEFAULT_TELEMETRY_RETAIN_COUNT)

    const cfg2 = resolveTelemetryRotationConfig(undefined, {
      SCNS_TELEMETRY_MAX_BYTES: '-5',
    })
    expect(cfg2.maxBytes).toBe(DEFAULT_TELEMETRY_MAX_BYTES)
  })

  it('treats an empty env value as absent (uses default)', () => {
    const cfg = resolveTelemetryRotationConfig(undefined, {
      SCNS_TELEMETRY_FILE_PATH: '',
      SCNS_TELEMETRY_MAX_BYTES: '',
    })
    expect(cfg.filePath).toBe(join(resolveScnsHome(), '.scns', 'telemetry', 'copilot-otel.jsonl'))
    expect(cfg.maxBytes).toBe(DEFAULT_TELEMETRY_MAX_BYTES)
  })
})
