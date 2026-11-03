import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveScnsHome } from '../../../src/shared/scns-home.js'
import {
  generateTelemetryEnvBlock,
  detectExistingConfig,
  getDefaultTelemetryPath,
  ensureTelemetryDir,
} from '../../../src/otel/auto-config.js'

describe('auto-config', () => {
  // ── generateTelemetryEnvBlock ─────────────────────────────────

  describe('generateTelemetryEnvBlock', () => {
    it('generates correct env block with defaults (content capture ON in 13.12.8)', () => {
      const block = generateTelemetryEnvBlock()

      expect(block).toContain('# SCNS Copilot CLI Telemetry')
      expect(block).toContain('export COPILOT_OTEL_FILE_EXPORTER_PATH=')
      expect(block).toContain('.scns/telemetry/copilot-otel.jsonl')
      expect(block).toContain('export COPILOT_OTEL_ENABLED=true')
      // Default: content capture ON (flipped in 13.12.8)
      expect(block).toContain('export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true')

      // SCNS ingestion env vars
      expect(block).toContain('export OTEL_SCNS_FILE_PATH=')
      expect(block).toContain('export OTEL_SCNS_ENABLED=true')
    })

    it('generates correct env block with custom path', () => {
      const customPath = '/custom/path/otel.jsonl'
      const block = generateTelemetryEnvBlock({ filePath: customPath })

      expect(block).toContain(`export COPILOT_OTEL_FILE_EXPORTER_PATH="${customPath}"`)
      expect(block).toContain(`export OTEL_SCNS_FILE_PATH="${customPath}"`)
    })

    it('includes content capture flag when enabled', () => {
      const block = generateTelemetryEnvBlock({ contentCapture: true })

      expect(block).toContain('export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true')
    })

    it('omits content capture line when disabled', () => {
      const block = generateTelemetryEnvBlock({ contentCapture: false })

      expect(block).not.toContain('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT')
    })
  })

  // ── detectExistingConfig ──────────────────────────────────────

  describe('detectExistingConfig', () => {
    const savedEnv: Record<string, string | undefined> = {}

    beforeEach(() => {
      savedEnv['COPILOT_OTEL_FILE_EXPORTER_PATH'] = process.env['COPILOT_OTEL_FILE_EXPORTER_PATH']
      savedEnv['COPILOT_OTEL_ENABLED'] = process.env['COPILOT_OTEL_ENABLED']
      savedEnv['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'] =
        process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT']
    })

    afterEach(() => {
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = val
        }
      }
    })

    it('returns configured: false when no env vars set', () => {
      delete process.env['COPILOT_OTEL_FILE_EXPORTER_PATH']
      delete process.env['COPILOT_OTEL_ENABLED']
      delete process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT']

      const result = detectExistingConfig()
      expect(result.configured).toBe(false)
      expect(result.filePath).toBeNull()
      expect(result.contentCapture).toBe(false)
    })

    it('returns configured: true with filePath when set', () => {
      process.env['COPILOT_OTEL_FILE_EXPORTER_PATH'] = '/some/path.jsonl'
      process.env['COPILOT_OTEL_ENABLED'] = 'true'

      const result = detectExistingConfig()
      expect(result.configured).toBe(true)
      expect(result.filePath).toBe('/some/path.jsonl')
    })

    it('detects content capture setting', () => {
      process.env['COPILOT_OTEL_FILE_EXPORTER_PATH'] = '/some/path.jsonl'
      process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'] = 'true'

      const result = detectExistingConfig()
      expect(result.contentCapture).toBe(true)
    })
  })

  // ── getDefaultTelemetryPath ───────────────────────────────────

  describe('getDefaultTelemetryPath', () => {
    it('returns correct path under home directory', () => {
      const expected = join(resolveScnsHome(), '.scns', 'telemetry', 'copilot-otel.jsonl')
      expect(getDefaultTelemetryPath()).toBe(expected)
    })
  })

  // ── ensureTelemetryDir ────────────────────────────────────────

  describe('ensureTelemetryDir', () => {
    let tempDir: string

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'scns-ac-test-'))
    })

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true })
    })

    it('creates directory for default path', () => {
      const customPath = join(tempDir, 'nested', 'deep', 'otel.jsonl')
      ensureTelemetryDir(customPath)

      expect(existsSync(join(tempDir, 'nested', 'deep'))).toBe(true)
    })

    it('is idempotent — calling twice does not throw', () => {
      const customPath = join(tempDir, 'dir', 'otel.jsonl')
      ensureTelemetryDir(customPath)
      ensureTelemetryDir(customPath) // should not throw
    })
  })
})
