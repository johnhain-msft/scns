import { join, dirname } from 'node:path'
import { resolveScnsHome } from '../shared/scns-home.js'
import { mkdirSync } from 'node:fs'

// ── Helpers ───────────────────────────────────────────────────

export function getDefaultTelemetryPath(): string {
  return join(resolveScnsHome(), '.scns', 'telemetry', 'copilot-otel.jsonl')
}

export function ensureTelemetryDir(filePath?: string): void {
  const target = filePath ?? getDefaultTelemetryPath()
  mkdirSync(dirname(target), { recursive: true })
}

// ── Config detection ──────────────────────────────────────────

export interface ExistingTelemetryConfig {
  readonly configured: boolean
  readonly filePath: string | null
  readonly contentCapture: boolean
}

export function detectExistingConfig(): ExistingTelemetryConfig {
  const filePath = process.env['COPILOT_OTEL_FILE_EXPORTER_PATH'] ?? null
  const enabled = process.env['COPILOT_OTEL_ENABLED'] === 'true'
  const contentCapture =
    process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'] === 'true'

  return {
    configured: filePath !== null || enabled,
    filePath,
    contentCapture,
  }
}

// ── Env block generation ──────────────────────────────────────

export interface TelemetryEnvOptions {
  readonly filePath?: string
  readonly contentCapture?: boolean
}

export function generateTelemetryEnvBlock(options?: TelemetryEnvOptions): string {
  // This block is a POSIX-shell rc snippet (`export ...`), so the embedded
  // path always uses forward slashes: backslashes inside double quotes are
  // escape characters to bash/zsh, and Node/Copilot accept `/` on win32 too.
  const filePath = (options?.filePath ?? getDefaultTelemetryPath()).replaceAll('\\', '/')
  const contentCapture = options?.contentCapture ?? true

  const lines: string[] = [
    '# SCNS Copilot CLI Telemetry',
    `export COPILOT_OTEL_FILE_EXPORTER_PATH="${filePath}"`,
    'export COPILOT_OTEL_ENABLED=true',
  ]

  if (contentCapture) {
    lines.push('export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true')
  }

  // SCNS ingestion vars (so loadOtelConfig picks up the file path)
  lines.push(`export OTEL_SCNS_FILE_PATH="${filePath}"`)
  lines.push('export OTEL_SCNS_ENABLED=true')

  return lines.join('\n') + '\n'
}
