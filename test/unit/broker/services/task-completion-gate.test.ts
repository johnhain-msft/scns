/**
 * WS G — services-level tests for evaluateCompletionGate freshness check.
 *
 * Freshness only applies to the staged-diff path (path 2). The handoff
 * path (path 1) and ownerless rejection are not affected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createSession } from '../../../../src/broker/storage/repositories/session-repository.js'
import {
  createHandoff,
  createQualityCheck,
} from '../../../../src/broker/storage/repositories/quality-repository.js'
import { evaluateCompletionGate } from '../../../../src/broker/services/task-completion-gate.js'
import type Database from 'better-sqlite3'

const WORKING_DIR = '/tmp/freshness-test'

function registerOwner(db: Database.Database, id: string): void {
  createSession(db, {
    id,
    purpose: 'freshness test',
    working_dir: WORKING_DIR,
    worktree: null,
  })
}

describe('evaluateCompletionGate (services-level)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => {
    closeDatabase(db)
  })

  describe('backwards compatibility (no dispatchStartedAt)', () => {
    it('allows when staged diff exists and no dispatchStartedAt is supplied', () => {
      registerOwner(db, 's-bc-1')
      const result = evaluateCompletionGate(db, 's-bc-1', () => true)
      expect(result.allowed).toBe(true)
      expect(result.reason).toMatch(/staged diff/i)
    })

    it('rejects when no staged diff and no handoff (existing behaviour)', () => {
      registerOwner(db, 's-bc-2')
      const result = evaluateCompletionGate(db, 's-bc-2', () => false)
      expect(result.allowed).toBe(false)
    })
  })

  describe('freshness check (with dispatchStartedAt)', () => {
    const dispatch = new Date('2026-05-09T12:00:00Z')

    it('rejects with stale_diff when every staged file mtime predates dispatchStartedAt', () => {
      registerOwner(db, 's-fresh-1')
      const result = evaluateCompletionGate(db, 's-fresh-1', () => true, {
        dispatchStartedAt: dispatch,
        stagedFileMtimeCollector: () =>
          new Map([
            ['src/a.ts', new Date('2026-05-09T11:00:00Z')],
            ['src/b.ts', new Date('2026-05-09T10:00:00Z')],
          ]),
      })
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('stale_diff')
    })

    it('allows when at least one staged file mtime is at-or-after dispatchStartedAt', () => {
      registerOwner(db, 's-fresh-2')
      const result = evaluateCompletionGate(db, 's-fresh-2', () => true, {
        dispatchStartedAt: dispatch,
        stagedFileMtimeCollector: () =>
          new Map([
            ['src/a.ts', new Date('2026-05-09T11:00:00Z')],
            ['src/b.ts', new Date('2026-05-09T12:30:00Z')],
          ]),
      })
      expect(result.allowed).toBe(true)
    })

    it('allows when staged diff is fresh (collector returns empty — no evidence of staleness)', () => {
      registerOwner(db, 's-fresh-3')
      const result = evaluateCompletionGate(db, 's-fresh-3', () => true, {
        dispatchStartedAt: dispatch,
        stagedFileMtimeCollector: () => new Map(),
      })
      expect(result.allowed).toBe(true)
    })

    it('does not run freshness check on the handoff path (handoff allows independently)', () => {
      registerOwner(db, 's-fresh-4')
      createHandoff(db, { session_id: 's-fresh-4', progress: 'done' })
      createQualityCheck(db, {
        session_id: 's-fresh-4',
        output: 'ok',
        passed: true,
        score: 1,
        findings: [],
      })
      let collectorCalled = false
      const result = evaluateCompletionGate(db, 's-fresh-4', () => false, {
        dispatchStartedAt: dispatch,
        stagedFileMtimeCollector: () => {
          collectorCalled = true
          return new Map()
        },
      })
      expect(result.allowed).toBe(true)
      expect(collectorCalled).toBe(false)
    })

    it('does not invoke collector when there is no staged diff to evaluate', () => {
      registerOwner(db, 's-fresh-5')
      let collectorCalled = false
      const result = evaluateCompletionGate(db, 's-fresh-5', () => false, {
        dispatchStartedAt: dispatch,
        stagedFileMtimeCollector: () => {
          collectorCalled = true
          return new Map()
        },
      })
      expect(result.allowed).toBe(false)
      expect(collectorCalled).toBe(false)
    })
  })

  // ── WS M (Phase 13.13.x) — strict dispatch_id attribution ─────────────
  describe('WS M dispatch_id resolution', () => {
    it('resolves dispatchStartedAt from a dispatchId via the injected resolver and applies stale_diff', () => {
      registerOwner(db, 's-wsm-1')
      const startedAt = new Date('2026-05-12T12:00:00Z')
      let resolved: string | null = null
      const result = evaluateCompletionGate(db, 's-wsm-1', () => true, {
        dispatchId: 'dispatch-XYZ',
        resolveDispatchStartedAt: (id) => {
          resolved = id
          return startedAt
        },
        stagedFileMtimeCollector: () =>
          new Map([
            ['src/a.ts', new Date('2026-05-12T10:00:00Z')],
            ['src/b.ts', new Date('2026-05-12T11:30:00Z')],
          ]),
      })
      expect(resolved).toBe('dispatch-XYZ')
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('stale_diff')
    })

    it('prefers explicit dispatchStartedAt over dispatchId-resolved value when both supplied', () => {
      registerOwner(db, 's-wsm-2')
      let resolverCalled = false
      const explicit = new Date('2026-05-12T12:00:00Z')
      const result = evaluateCompletionGate(db, 's-wsm-2', () => true, {
        dispatchStartedAt: explicit,
        dispatchId: 'dispatch-XYZ',
        resolveDispatchStartedAt: () => {
          resolverCalled = true
          return new Date('1990-01-01')
        },
        stagedFileMtimeCollector: () =>
          new Map([['src/a.ts', new Date('2026-05-12T11:00:00Z')]]),
      })
      expect(resolverCalled).toBe(false)
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('stale_diff')
    })

    it('skips freshness check when dispatchId resolver returns null (no dispatch known)', () => {
      registerOwner(db, 's-wsm-3')
      const result = evaluateCompletionGate(db, 's-wsm-3', () => true, {
        dispatchId: 'unknown-dispatch',
        resolveDispatchStartedAt: () => null,
        stagedFileMtimeCollector: () =>
          new Map([['src/a.ts', new Date('1990-01-01')]]),
      })
      expect(result.allowed).toBe(true)
    })
  })
})
