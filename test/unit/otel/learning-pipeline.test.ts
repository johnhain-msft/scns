import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../helpers/db-harness.js'
import { createOtelTestDb } from '../../helpers/otel-db-harness.js'
import { insertSpans } from '../../../src/otel/otel-repository.js'
import type { SpanInput } from '../../../src/otel/jsonl-parser.js'
import { runLearningPipeline } from '../../../src/otel/learning-pipeline.js'
import {
  ensureLearningStateTable,
  loadLearningState,
  saveLearningState,
} from '../../../src/otel/learning-state.js'
import type { Vault } from '../../../src/memory/vault.js'

// ── Test data helpers ────────────────────────────────────────

let spanCounter = 0

function makeSpan(overrides?: Partial<SpanInput>): SpanInput {
  spanCounter++
  return {
    trace_id: 'trace-001',
    span_id: `span-${spanCounter}`,
    parent_span_id: null,
    name: 'test-span',
    kind: 'INTERNAL',
    start_time: '2024-06-15T10:00:00.000Z',
    end_time: '2024-06-15T10:00:01.000Z',
    duration_ms: 1000,
    status: 'OK',
    attributes_json: '{}',
    events_json: '[]',
    resource_json: '{}',
    session_id: null,
    ...overrides,
  }
}

function createMockVault(): Vault {
  return {
    read: vi.fn().mockReturnValue(null),
    write: vi.fn().mockReturnValue({ path: '', content: '', mtimeMs: 0, sizeBytes: 0 }),
    append: vi.fn().mockReturnValue({ path: '', content: '', mtimeMs: 0, sizeBytes: 0 }),
    remove: vi.fn().mockReturnValue(false),
    appendDailyLog: vi.fn().mockReturnValue({ path: '', content: '', mtimeMs: 0, sizeBytes: 0 }),
    listFiles: vi.fn().mockReturnValue([]),
    ensureDirs: vi.fn(),
    rootDir: '/mock-vault',
  }
}

function insertSessionSpans(
  db: import('better-sqlite3').Database,
  sessionId: string,
  startTime: string,
  opts?: { model?: string; tool?: string; errorCount?: number },
): void {
  const spans: SpanInput[] = [
    makeSpan({
      trace_id: `trace-${sessionId}`,
      session_id: sessionId,
      name: 'invoke_agent',
      start_time: startTime,
      end_time: new Date(new Date(startTime).getTime() + 60_000).toISOString(),
      duration_ms: 60_000,
    }),
  ]

  if (opts?.model) {
    spans.push(
      makeSpan({
        trace_id: `trace-${sessionId}`,
        session_id: sessionId,
        name: `chat ${opts.model}`,
        start_time: startTime,
        end_time: new Date(new Date(startTime).getTime() + 5000).toISOString(),
        duration_ms: 5000,
        attributes_json: JSON.stringify({
          'gen_ai.usage.input_tokens': 1000,
          'gen_ai.usage.output_tokens': 500,
        }),
      }),
    )
  }

  if (opts?.tool) {
    spans.push(
      makeSpan({
        trace_id: `trace-${sessionId}`,
        session_id: sessionId,
        name: `execute_tool ${opts.tool}`,
        start_time: startTime,
        end_time: new Date(new Date(startTime).getTime() + 200).toISOString(),
        duration_ms: 200,
      }),
    )
  }

  if (opts?.errorCount) {
    for (let i = 0; i < opts.errorCount; i++) {
      spans.push(
        makeSpan({
          trace_id: `trace-${sessionId}`,
          session_id: sessionId,
          name: `error-span-${i}`,
          start_time: startTime,
          status: 'ERROR',
        }),
      )
    }
  }

  insertSpans(db, spans)
}

// ── Tests ────────────────────────────────────────────────────

describe('learning-pipeline', () => {
  let testDb: TestDb
  let vault: Vault

  beforeEach(() => {
    spanCounter = 0
    testDb = createOtelTestDb()
    vault = createMockVault()
  })

  afterEach(() => {
    testDb.close()
  })

  // ── Empty DB ─────────────────────────────────────────────────

  describe('empty database', () => {
    it('returns zero results with no errors', () => {
      ensureLearningStateTable(testDb.db)
      const result = runLearningPipeline({ db: testDb.db, vault })

      expect(result.sessionsProcessed).toBe(0)
      expect(result.digestsStored).toBe(0)
      expect(result.patternsExtracted).toBeNull()
      expect(result.memoryEntriesGenerated).toBe(0)
      expect(result.errors).toHaveLength(0)
    })

    it('does not call vault methods', () => {
      ensureLearningStateTable(testDb.db)
      runLearningPipeline({ db: testDb.db, vault })

      expect(vault.write).not.toHaveBeenCalled()
      expect(vault.appendDailyLog).not.toHaveBeenCalled()
    })
  })

  // ── Sessions processed ───────────────────────────────────────

  describe('sessions processed and digests stored', () => {
    it('processes sessions and stores digests in vault', () => {
      insertSessionSpans(testDb.db, 'session-A', '2024-06-15T10:00:00.000Z', {
        model: 'claude-sonnet-4-20250514',
        tool: 'read_file',
      })
      insertSessionSpans(testDb.db, 'session-B', '2024-06-15T11:00:00.000Z', {
        model: 'claude-haiku-3.5',
      })

      const result = runLearningPipeline({ db: testDb.db, vault })

      expect(result.sessionsProcessed).toBe(2)
      expect(result.digestsStored).toBe(2)
      expect(vault.write).toHaveBeenCalledTimes(2)
    })

    it('stores digests at correct vault paths', () => {
      insertSessionSpans(testDb.db, 'session-A', '2024-06-15T10:00:00.000Z')

      runLearningPipeline({ db: testDb.db, vault })

      const writeCalls = (vault.write as ReturnType<typeof vi.fn>).mock.calls
      expect(writeCalls[0]![0]).toMatch(/^sessions\/2024-06-15\/session-A\.md$/)
    })

    it('extracts patterns and generates memory entries', () => {
      insertSessionSpans(testDb.db, 'session-A', '2024-06-15T10:00:00.000Z', {
        model: 'claude-sonnet-4-20250514',
      })

      const result = runLearningPipeline({ db: testDb.db, vault })

      expect(result.patternsExtracted).not.toBeNull()
      expect(result.patternsExtracted!.totalSessions).toBe(1)
      expect(result.memoryEntriesGenerated).toBeGreaterThan(0)
      expect(vault.appendDailyLog).toHaveBeenCalled()
    })
  })

  // ── Learning state tracking ──────────────────────────────────

  describe('learning state tracks progress', () => {
    it('saves state after successful run', () => {
      insertSessionSpans(testDb.db, 'session-A', '2024-06-15T10:00:00.000Z')

      runLearningPipeline({ db: testDb.db, vault })

      const state = loadLearningState(testDb.db)
      expect(state.totalSessionsProcessed).toBe(1)
      expect(state.lastProcessedAt).toBe('2024-06-15T10:00:00.000Z')
      expect(state.latestPatternsJson).not.toBeNull()
    })

    it('accumulates session count across runs', () => {
      insertSessionSpans(testDb.db, 'session-A', '2024-06-15T10:00:00.000Z')
      runLearningPipeline({ db: testDb.db, vault })

      insertSessionSpans(testDb.db, 'session-B', '2024-06-15T11:00:00.000Z')
      runLearningPipeline({ db: testDb.db, vault })

      const state = loadLearningState(testDb.db)
      expect(state.totalSessionsProcessed).toBe(2)
    })
  })

  // ── Incremental processing ───────────────────────────────────

  describe('subsequent runs only process new sessions', () => {
    it('skips already-processed sessions on second run', () => {
      insertSessionSpans(testDb.db, 'session-A', '2024-06-15T10:00:00.000Z')
      const firstResult = runLearningPipeline({ db: testDb.db, vault })
      expect(firstResult.sessionsProcessed).toBe(1)

      // Second run with no new data
      const secondResult = runLearningPipeline({ db: testDb.db, vault })
      expect(secondResult.sessionsProcessed).toBe(0)
      expect(secondResult.digestsStored).toBe(0)
    })

    it('picks up new sessions after cursor', () => {
      insertSessionSpans(testDb.db, 'session-A', '2024-06-15T10:00:00.000Z')
      runLearningPipeline({ db: testDb.db, vault })

      // Add new session with later start time
      insertSessionSpans(testDb.db, 'session-B', '2024-06-15T12:00:00.000Z')
      const result = runLearningPipeline({ db: testDb.db, vault })

      expect(result.sessionsProcessed).toBe(1)
      expect(result.digestsStored).toBe(1)
    })

    it('respects explicit since parameter over saved state', () => {
      insertSessionSpans(testDb.db, 'session-A', '2024-06-15T10:00:00.000Z')
      insertSessionSpans(testDb.db, 'session-B', '2024-06-15T11:00:00.000Z')
      insertSessionSpans(testDb.db, 'session-C', '2024-06-15T12:00:00.000Z')

      // Run once to set cursor
      runLearningPipeline({ db: testDb.db, vault })

      // Explicit since overrides saved state — reprocess from earlier
      const result = runLearningPipeline({
        db: testDb.db,
        vault,
        since: '2024-06-15T10:30:00.000Z',
      })

      expect(result.sessionsProcessed).toBe(2) // session-B and session-C
    })
  })

  // ── Pattern extraction ───────────────────────────────────────

  describe('pattern extraction produces memory entries', () => {
    it('generates work-schedule, tool-preferences, and model-preferences entries', () => {
      insertSessionSpans(testDb.db, 'session-A', '2024-06-15T10:00:00.000Z', {
        model: 'claude-sonnet-4-20250514',
        tool: 'read_file',
      })

      const result = runLearningPipeline({ db: testDb.db, vault })

      // patternsToMemoryEntries produces 3 entries: work-schedule, tool-preferences, model-preferences
      expect(result.memoryEntriesGenerated).toBe(3)
      expect(result.patternsExtracted!.models.primaryModel).toBe('claude-sonnet-4-20250514')
    })

    it('stores patterns JSON in learning state', () => {
      insertSessionSpans(testDb.db, 'session-A', '2024-06-15T10:00:00.000Z', {
        model: 'claude-sonnet-4-20250514',
      })

      runLearningPipeline({ db: testDb.db, vault })

      const state = loadLearningState(testDb.db)
      expect(state.latestPatternsJson).not.toBeNull()

      const stored = JSON.parse(state.latestPatternsJson!) as Record<string, unknown>
      expect(stored['totalSessions']).toBe(1)
    })
  })

  // ── Error isolation ──────────────────────────────────────────

  describe('errors in individual sessions do not block others', () => {
    it('continues processing after a vault write failure', () => {
      insertSessionSpans(testDb.db, 'session-A', '2024-06-15T10:00:00.000Z')
      insertSessionSpans(testDb.db, 'session-B', '2024-06-15T11:00:00.000Z')

      let callCount = 0
      ;(vault.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          throw new Error('Simulated write failure')
        }
        return { path: '', content: '', mtimeMs: 0, sizeBytes: 0 }
      })

      const result = runLearningPipeline({ db: testDb.db, vault })

      expect(result.sessionsProcessed).toBe(2)
      expect(result.digestsStored).toBe(1)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('Simulated write failure')
    })

    it('still extracts patterns even when some digests fail', () => {
      insertSessionSpans(testDb.db, 'session-A', '2024-06-15T10:00:00.000Z', {
        model: 'claude-sonnet-4-20250514',
      })
      insertSessionSpans(testDb.db, 'session-B', '2024-06-15T11:00:00.000Z', {
        model: 'claude-haiku-3.5',
      })

      let callCount = 0
      ;(vault.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++
        if (callCount === 1) throw new Error('vault error')
        return { path: '', content: '', mtimeMs: 0, sizeBytes: 0 }
      })

      const result = runLearningPipeline({ db: testDb.db, vault })

      // Patterns are still extracted from all summaries, even if storage failed
      expect(result.patternsExtracted).not.toBeNull()
      expect(result.patternsExtracted!.totalSessions).toBe(2)
    })

    it('only advances cursor for successfully stored digests', () => {
      insertSessionSpans(testDb.db, 'session-A', '2024-06-15T10:00:00.000Z')
      insertSessionSpans(testDb.db, 'session-B', '2024-06-15T11:00:00.000Z')

      // All writes fail
      ;(vault.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('all writes fail')
      })

      runLearningPipeline({ db: testDb.db, vault })

      // State should NOT be updated since no digests succeeded
      const state = loadLearningState(testDb.db)
      expect(state.totalSessionsProcessed).toBe(0)
      expect(state.lastProcessedAt).toBeNull()
    })
  })
})

// ── Learning state unit tests ──────────────────────────────────

describe('learning-state', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createOtelTestDb()
    ensureLearningStateTable(testDb.db)
  })

  afterEach(() => {
    testDb.close()
  })

  it('returns default state when table is empty', () => {
    const state = loadLearningState(testDb.db)
    expect(state.lastProcessedAt).toBeNull()
    expect(state.totalSessionsProcessed).toBe(0)
    expect(state.totalPatternsExtracted).toBe(0)
    expect(state.latestPatternsJson).toBeNull()
  })

  it('round-trips saved state', () => {
    const saved = {
      lastProcessedAt: '2024-06-15T12:00:00.000Z',
      totalSessionsProcessed: 42,
      totalPatternsExtracted: 10,
      latestPatternsJson: '{"totalSessions":42}',
    }
    saveLearningState(testDb.db, saved)

    const loaded = loadLearningState(testDb.db)
    expect(loaded.lastProcessedAt).toBe(saved.lastProcessedAt)
    expect(loaded.totalSessionsProcessed).toBe(42)
    expect(loaded.totalPatternsExtracted).toBe(10)
    expect(loaded.latestPatternsJson).toBe('{"totalSessions":42}')
  })

  it('upserts existing values', () => {
    saveLearningState(testDb.db, {
      lastProcessedAt: '2024-01-01T00:00:00.000Z',
      totalSessionsProcessed: 5,
      totalPatternsExtracted: 2,
      latestPatternsJson: null,
    })
    saveLearningState(testDb.db, {
      lastProcessedAt: '2024-06-15T12:00:00.000Z',
      totalSessionsProcessed: 10,
      totalPatternsExtracted: 5,
      latestPatternsJson: '{"test":true}',
    })

    const loaded = loadLearningState(testDb.db)
    expect(loaded.lastProcessedAt).toBe('2024-06-15T12:00:00.000Z')
    expect(loaded.totalSessionsProcessed).toBe(10)
    expect(loaded.totalPatternsExtracted).toBe(5)
    expect(loaded.latestPatternsJson).toBe('{"test":true}')
  })

  it('ensureLearningStateTable is idempotent', () => {
    ensureLearningStateTable(testDb.db)
    ensureLearningStateTable(testDb.db)
    // Should not throw
    const state = loadLearningState(testDb.db)
    expect(state.totalSessionsProcessed).toBe(0)
  })
})
