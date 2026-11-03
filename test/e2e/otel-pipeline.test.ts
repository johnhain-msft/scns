/**
 * E2E test — OTel pipeline
 *
 * Exercises the full OTel ingestion pipeline:
 *   JSONL write → file watcher poll → parse → DB insert →
 *   session extractor → summary verification.
 *
 * Uses in-memory SQLite + temp files for deterministic testing.
 */

import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createOtelFileWatcher } from '../../src/otel/file-watcher.js'
import { extractSessionSummaries, extractSessionSummary } from '../../src/otel/session-extractor.js'
import type { OtelIngestionConfig } from '../../src/otel/config.js'

// ── Helpers ──────────────────────────────────────────────────

let counter = 0

function uid(): string {
  return `${Date.now().toString(36)}${(counter++).toString(36)}`
}

interface SpanOverrides {
  readonly traceId?: string
  readonly spanId?: string
  readonly parentSpanId?: string
  readonly name?: string
  readonly startNano?: string
  readonly endNano?: string
  readonly statusCode?: number
  readonly sessionId?: string | null
  readonly attributes?: ReadonlyArray<{ key: string; value: Record<string, unknown> }>
  readonly serviceName?: string
}

/** Build a valid OTel JSONL line for a single span. */
function buildSpanJsonl(overrides: SpanOverrides = {}): string {
  const traceId = overrides.traceId ?? uid()
  const spanId = overrides.spanId ?? uid()
  const name = overrides.name ?? 'test-span'
  const startNano = overrides.startNano ?? '1700000000000000000'
  const endNano = overrides.endNano ?? '1700000060000000000'
  const statusCode = overrides.statusCode ?? 1

  const attributes = overrides.attributes ? [...overrides.attributes] : []

  const resourceAttrs: Array<{ key: string; value: Record<string, unknown> }> = [
    { key: 'service.name', value: { stringValue: overrides.serviceName ?? 'github-copilot' } },
  ]

  if (overrides.sessionId !== undefined && overrides.sessionId !== null) {
    resourceAttrs.push({ key: 'session.id', value: { stringValue: overrides.sessionId } })
  }

  const record = {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            scope: { name: 'github.copilot' },
            spans: [
              {
                traceId,
                spanId,
                ...(overrides.parentSpanId ? { parentSpanId: overrides.parentSpanId } : {}),
                name,
                startTimeUnixNano: startNano,
                endTimeUnixNano: endNano,
                status: { code: statusCode },
                attributes,
              },
            ],
          },
        ],
      },
    ],
  }

  return JSON.stringify(record)
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  const schema = readFileSync(resolve(__dirname, '../../src/otel/schema.sql'), 'utf8')
  db.exec(schema)
  return db
}

function makeConfig(filePath: string): OtelIngestionConfig {
  return {
    enabled: true,
    filePath,
    retentionDays: 7,
    maxSpansPerTrace: 1000,
    pollIntervalMs: 60_000, // won't auto-poll — we call _poll() manually
  }
}

// ── Test suite ───────────────────────────────────────────────

describe('OTel pipeline E2E', () => {
  let tempDir: string
  let db: Database.Database

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scns-otel-e2e-'))
    db = createTestDb()
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  // ── 1. Full pipeline round-trip ─────────────────────────────

  it('ingests a JSONL span and produces a session summary', () => {
    const filePath = join(tempDir, 'otel.jsonl')
    const traceId = 'trace-roundtrip-001'
    const sessionId = 'session-roundtrip-001'

    const line = buildSpanJsonl({
      traceId,
      spanId: 'span-rt-001',
      name: 'chat claude-sonnet-4',
      sessionId,
      startNano: '1700000000000000000',
      endNano: '1700000060000000000',
      statusCode: 1,
      attributes: [
        { key: 'gen_ai.usage.input_tokens', value: { intValue: '1000' } },
        { key: 'gen_ai.usage.output_tokens', value: { intValue: '500' } },
      ],
    })

    writeFileSync(filePath, line + '\n')

    const watcher = createOtelFileWatcher(makeConfig(filePath), db)
    watcher._poll()

    // Verify span in DB
    const spanCount = db.prepare('SELECT COUNT(*) AS cnt FROM otel_spans').get() as { cnt: number }
    expect(spanCount.cnt).toBe(1)

    const dbSpan = db.prepare('SELECT * FROM otel_spans WHERE trace_id = ?').get(traceId) as Record<
      string,
      unknown
    >
    expect(dbSpan.name).toBe('chat claude-sonnet-4')
    expect(dbSpan.session_id).toBe(sessionId)
    expect(dbSpan.status).toBe('OK')

    // Extract and verify session summary
    const summary = extractSessionSummary(db, sessionId)
    expect(summary).toBeDefined()
    expect(summary!.sessionId).toBe(sessionId)
    expect(summary!.spanCount).toBe(1)
    expect(summary!.models).toEqual([{ model: 'claude-sonnet-4', callCount: 1 }])
    expect(summary!.totalInputTokens).toBe(1000)
    expect(summary!.totalOutputTokens).toBe(500)
    expect(summary!.traceIds).toContain(traceId)
    expect(summary!.startTime).toBeTruthy()
    expect(summary!.endTime).toBeTruthy()
    expect(summary!.durationMs).toBeGreaterThanOrEqual(0)
  })

  // ── 2. Multiple sessions ────────────────────────────────────

  it('extracts separate summaries for different sessions', () => {
    const filePath = join(tempDir, 'otel.jsonl')

    const lines = [
      buildSpanJsonl({
        traceId: 'trace-a',
        spanId: 'span-a1',
        name: 'chat claude-sonnet-4',
        sessionId: 'session-alpha',
        startNano: '1700000000000000000',
        endNano: '1700000030000000000',
        attributes: [
          { key: 'gen_ai.usage.input_tokens', value: { intValue: '200' } },
          { key: 'gen_ai.usage.output_tokens', value: { intValue: '100' } },
        ],
      }),
      buildSpanJsonl({
        traceId: 'trace-a',
        spanId: 'span-a2',
        name: 'execute_tool bash',
        sessionId: 'session-alpha',
        startNano: '1700000030000000000',
        endNano: '1700000035000000000',
      }),
      buildSpanJsonl({
        traceId: 'trace-b',
        spanId: 'span-b1',
        name: 'chat gpt-4o',
        sessionId: 'session-beta',
        startNano: '1700000100000000000',
        endNano: '1700000160000000000',
        attributes: [
          { key: 'gen_ai.usage.input_tokens', value: { intValue: '300' } },
          { key: 'gen_ai.usage.output_tokens', value: { intValue: '150' } },
        ],
      }),
    ]

    writeFileSync(filePath, lines.join('\n') + '\n')

    const watcher = createOtelFileWatcher(makeConfig(filePath), db)
    watcher._poll()

    const summaries = extractSessionSummaries(db)
    expect(summaries.length).toBe(2)

    const ids = summaries.map((s) => s.sessionId).sort()
    expect(ids).toEqual(['session-alpha', 'session-beta'])

    const alpha = summaries.find((s) => s.sessionId === 'session-alpha')!
    expect(alpha.spanCount).toBe(2)
    expect(alpha.models).toEqual([{ model: 'claude-sonnet-4', callCount: 1 }])
    expect(alpha.tools.length).toBe(1)
    expect(alpha.tools[0]!.tool).toBe('bash')

    const beta = summaries.find((s) => s.sessionId === 'session-beta')!
    expect(beta.spanCount).toBe(1)
    expect(beta.models).toEqual([{ model: 'gpt-4o', callCount: 1 }])
  })

  // ── 3. Incremental ingestion ────────────────────────────────

  it('incrementally ingests new lines across multiple polls', () => {
    const filePath = join(tempDir, 'otel.jsonl')
    const sessionId = 'session-incremental'

    // Write first batch
    const batch1 = [
      buildSpanJsonl({
        traceId: 'trace-inc',
        spanId: 'span-inc-1',
        name: 'chat claude-sonnet-4',
        sessionId,
      }),
      buildSpanJsonl({
        traceId: 'trace-inc',
        spanId: 'span-inc-2',
        name: 'execute_tool bash',
        sessionId,
      }),
    ]
    writeFileSync(filePath, batch1.join('\n') + '\n')

    const watcher = createOtelFileWatcher(makeConfig(filePath), db)
    watcher._poll()

    let stats = watcher.getStats()
    expect(stats.spansIngested).toBe(2)

    // Write second batch (appended)
    const batch2 = [
      buildSpanJsonl({
        traceId: 'trace-inc',
        spanId: 'span-inc-3',
        name: 'execute_tool view',
        sessionId,
      }),
      buildSpanJsonl({
        traceId: 'trace-inc',
        spanId: 'span-inc-4',
        name: 'execute_tool edit',
        sessionId,
      }),
    ]
    writeFileSync(filePath, batch1.join('\n') + '\n' + batch2.join('\n') + '\n')

    watcher._poll()

    stats = watcher.getStats()
    // INSERT OR IGNORE means duplicates are silently skipped; we should have 4 total
    expect(stats.spansIngested).toBe(4)

    const spanCount = db.prepare('SELECT COUNT(*) AS cnt FROM otel_spans').get() as { cnt: number }
    expect(spanCount.cnt).toBe(4)

    const summary = extractSessionSummary(db, sessionId)!
    expect(summary.spanCount).toBe(4)
    expect(summary.tools.map((t) => t.tool).sort()).toEqual(['bash', 'edit', 'view'])
  })

  // ── 4. Model and tool extraction ────────────────────────────

  it('extracts models, tools, and MCP servers from span names', () => {
    const filePath = join(tempDir, 'otel.jsonl')
    const sessionId = 'session-extract'
    const traceId = 'trace-extract'

    const lines = [
      buildSpanJsonl({
        traceId,
        spanId: 'span-ext-1',
        name: 'chat claude-sonnet-4',
        sessionId,
        attributes: [
          { key: 'gen_ai.usage.input_tokens', value: { intValue: '100' } },
          { key: 'gen_ai.usage.output_tokens', value: { intValue: '50' } },
        ],
      }),
      buildSpanJsonl({
        traceId,
        spanId: 'span-ext-2',
        name: 'execute_tool bash',
        sessionId,
        startNano: '1700000060000000000',
        endNano: '1700000062000000000',
      }),
      buildSpanJsonl({
        traceId,
        spanId: 'span-ext-3',
        name: 'execute_tool github-mcp-server-search_code',
        sessionId,
        startNano: '1700000062000000000',
        endNano: '1700000065000000000',
      }),
    ]

    writeFileSync(filePath, lines.join('\n') + '\n')

    const watcher = createOtelFileWatcher(makeConfig(filePath), db)
    watcher._poll()

    const summary = extractSessionSummary(db, sessionId)!

    // Models
    expect(summary.models).toEqual([{ model: 'claude-sonnet-4', callCount: 1 }])

    // Tools
    const toolNames = summary.tools.map((t) => t.tool).sort()
    expect(toolNames).toEqual(['bash', 'github-mcp-server-search_code'])

    // MCP servers (extracted from tool name pattern `*-mcp-server`)
    expect(summary.mcpServers).toEqual(['github-mcp-server'])
  })

  // ── 5. Token counting ──────────────────────────────────────

  it('sums input and output tokens across chat spans', () => {
    const filePath = join(tempDir, 'otel.jsonl')
    const sessionId = 'session-tokens'
    const traceId = 'trace-tokens'

    const lines = [
      buildSpanJsonl({
        traceId,
        spanId: 'span-tok-1',
        name: 'chat claude-sonnet-4',
        sessionId,
        startNano: '1700000000000000000',
        endNano: '1700000010000000000',
        attributes: [
          { key: 'gen_ai.usage.input_tokens', value: { intValue: '1200' } },
          { key: 'gen_ai.usage.output_tokens', value: { intValue: '600' } },
        ],
      }),
      buildSpanJsonl({
        traceId,
        spanId: 'span-tok-2',
        name: 'chat claude-sonnet-4',
        sessionId,
        startNano: '1700000010000000000',
        endNano: '1700000020000000000',
        attributes: [
          { key: 'gen_ai.usage.input_tokens', value: { intValue: '800' } },
          { key: 'gen_ai.usage.output_tokens', value: { intValue: '400' } },
        ],
      }),
      // Non-chat span — tokens should NOT be counted (only chat spans count)
      buildSpanJsonl({
        traceId,
        spanId: 'span-tok-3',
        name: 'execute_tool bash',
        sessionId,
        startNano: '1700000020000000000',
        endNano: '1700000025000000000',
        attributes: [
          { key: 'gen_ai.usage.input_tokens', value: { intValue: '9999' } },
          { key: 'gen_ai.usage.output_tokens', value: { intValue: '9999' } },
        ],
      }),
    ]

    writeFileSync(filePath, lines.join('\n') + '\n')

    const watcher = createOtelFileWatcher(makeConfig(filePath), db)
    watcher._poll()

    const summary = extractSessionSummary(db, sessionId)!
    expect(summary.totalInputTokens).toBe(2000)
    expect(summary.totalOutputTokens).toBe(1000)
  })

  // ── 6. Error handling — invalid JSONL mixed with valid ──────

  it('ingests valid lines and tracks errors for invalid ones', () => {
    const filePath = join(tempDir, 'otel.jsonl')
    const sessionId = 'session-errors'

    const validLine = buildSpanJsonl({
      traceId: 'trace-err',
      spanId: 'span-err-1',
      name: 'chat claude-sonnet-4',
      sessionId,
    })

    const content =
      [
        '{ this is not valid JSON !!!',
        validLine,
        'totally broken line',
        '{"incomplete": true',
        buildSpanJsonl({
          traceId: 'trace-err',
          spanId: 'span-err-2',
          name: 'execute_tool bash',
          sessionId,
        }),
      ].join('\n') + '\n'

    writeFileSync(filePath, content)

    const watcher = createOtelFileWatcher(makeConfig(filePath), db)
    watcher._poll()

    const stats = watcher.getStats()
    expect(stats.spansIngested).toBe(2)
    expect(stats.errors).toBeGreaterThanOrEqual(2)

    const spanCount = db.prepare('SELECT COUNT(*) AS cnt FROM otel_spans').get() as { cnt: number }
    expect(spanCount.cnt).toBe(2)
  })

  // ── 7. File rotation ────────────────────────────────────────

  it('handles file rotation (delete + recreate)', () => {
    const filePath = join(tempDir, 'otel.jsonl')
    const sessionId = 'session-rotate'

    // Write initial content
    writeFileSync(
      filePath,
      buildSpanJsonl({
        traceId: 'trace-rot-old',
        spanId: 'span-rot-1',
        name: 'chat claude-sonnet-4',
        sessionId,
      }) + '\n',
    )

    const watcher = createOtelFileWatcher(makeConfig(filePath), db)
    watcher._poll()

    expect(watcher.getStats().spansIngested).toBe(1)

    // Simulate rotation: delete and recreate
    unlinkSync(filePath)
    writeFileSync(
      filePath,
      buildSpanJsonl({
        traceId: 'trace-rot-new',
        spanId: 'span-rot-2',
        name: 'execute_tool bash',
        sessionId,
      }) + '\n',
    )

    watcher._poll()

    expect(watcher.getStats().spansIngested).toBe(2)

    const spanCount = db.prepare('SELECT COUNT(*) AS cnt FROM otel_spans').get() as { cnt: number }
    expect(spanCount.cnt).toBe(2)

    // Both old and new spans should exist
    const traceIds = (
      db.prepare('SELECT DISTINCT trace_id FROM otel_spans ORDER BY trace_id').all() as Array<{
        trace_id: string
      }>
    ).map((r) => r.trace_id)
    expect(traceIds).toEqual(['trace-rot-new', 'trace-rot-old'])
  })
})
