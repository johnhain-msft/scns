/**
 * Phase 13.12.16 — `scns suggest` CLI helpers.
 * Tests exercise each action against a real filesystem store in a temp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSuggestionStore } from '../../../src/suggest/suggestion-store.js'
import type { Suggestion } from '../../../src/suggest/types.js'
import {
  runList,
  runDelete,
  runRetry,
  runDismiss,
  runRepromote,
  formatList,
} from '../../../src/cli/suggest.js'

function make(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id:
      overrides.id ??
      '11111111-2222-3333-4444-555555555555',
    type: 'automation',
    title: 'A helpful automation',
    description: 'desc',
    status: 'pending',
    confidence: 0.8,
    evidence: [],
    tags: [],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    actionable: true,
    estimatedComplexity: 'solo',
    attemptCount: 0,
    lastError: null,
    lastAttemptAt: null,
    nextRetryAt: null,
    ...overrides,
  }
}

describe('scns suggest CLI helpers (Phase 13.12.16)', () => {
  let root: string
  let store: ReturnType<typeof createSuggestionStore>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scns-cli-suggest-'))
    store = createSuggestionStore({ rootDir: root })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  describe('list', () => {
    it('returns empty-state message when nothing matches', () => {
      expect(runList(store, { status: 'failed' })).toContain('No suggestions')
    })

    it('lists by status', () => {
      store.save(make({ id: 'aaaaaaaa-0000-0000-0000-000000000001' }))
      store.save(make({ id: 'aaaaaaaa-0000-0000-0000-000000000002' }))
      const out = runList(store, { status: 'pending' })
      expect(out).toContain('aaaaaaaa-0000-0000-0000-000000000001')
      expect(out).toContain('aaaaaaaa-0000-0000-0000-000000000002')
    })

    it('filters by type', () => {
      store.save(make({ id: 'bbbbbbbb-0000-0000-0000-000000000001', type: 'skill' }))
      store.save(
        make({ id: 'bbbbbbbb-0000-0000-0000-000000000002', type: 'automation' }),
      )
      const out = runList(store, { type: 'skill' })
      expect(out).toContain('bbbbbbbb-0000-0000-0000-000000000001')
      expect(out).not.toContain('bbbbbbbb-0000-0000-0000-000000000002')
    })

    it('formatList renders an aligned table', () => {
      const s = make({ id: 'cccccccc-0000-0000-0000-000000000001' })
      const out = formatList([s])
      expect(out).toContain('ID')
      expect(out).toContain('STATUS')
      expect(out).toContain(s.id)
      expect(out).toContain(s.status)
    })
  })

  describe('delete', () => {
    it('removes the file and returns ok', () => {
      const s = make({ id: 'dddddddd-0000-0000-0000-000000000001' })
      store.save(s)
      const result = runDelete(store, s.id)
      expect(result.ok).toBe(true)
      expect(result.message).toContain(s.id)
      expect(existsSync(join(root, 'pending', `${s.id}.md`))).toBe(false)
    })

    it('returns error for unknown id', () => {
      const r = runDelete(store, '00000000-0000-0000-0000-000000000000')
      expect(r.ok).toBe(false)
      expect(r.message).toContain('not found')
    })
  })

  describe('retry', () => {
    it('only works on failed', () => {
      const s = make({ id: 'eeeeeeee-0000-0000-0000-000000000001' })
      store.save(s)
      const r = runRetry(store, s.id)
      expect(r.ok).toBe(false)
      expect(r.message).toContain('not failed')
    })

    it('resets a failed suggestion', () => {
      const s = make({ id: 'eeeeeeee-0000-0000-0000-000000000002' })
      store.save(s)
      store.updateStatus(s.id, 'approved')
      const base = Date.now()
      for (let i = 0; i < 5; i++) store.recordFailure(s.id, 'boom', base + i)
      expect(store.get(s.id)!.status).toBe('failed')

      const r = runRetry(store, s.id)
      expect(r.ok).toBe(true)
      const reloaded = store.get(s.id)!
      expect(reloaded.status).toBe('approved')
      expect(reloaded.attemptCount).toBe(0)
      expect(reloaded.lastError).toBeNull()
    })
  })

  describe('dismiss', () => {
    it('moves to rejected with reason', () => {
      const s = make({ id: 'ffffffff-0000-0000-0000-000000000001' })
      store.save(s)
      const r = runDismiss(store, s.id)
      expect(r.ok).toBe(true)
      const reloaded = store.get(s.id)!
      expect(reloaded.status).toBe('rejected')
      expect(reloaded.reviewReason).toBe('dismissed by user')
    })

    it('errors on unknown id', () => {
      const r = runDismiss(store, '00000000-0000-0000-0000-000000000000')
      expect(r.ok).toBe(false)
    })
  })

  describe('repromote', () => {
    it('only works on needs-human', () => {
      const s = make({ id: 'a1111111-0000-0000-0000-000000000001' })
      store.save(s)
      const r = runRepromote(store, s.id)
      expect(r.ok).toBe(false)
      expect(r.message).toContain('not needs-human')
    })

    it('moves needs-human → pending', () => {
      const s = make({ id: 'a1111111-0000-0000-0000-000000000002' })
      store.save(s)
      store.updateStatus(s.id, 'needs-human', 'please review')
      const r = runRepromote(store, s.id)
      expect(r.ok).toBe(true)
      expect(store.get(s.id)!.status).toBe('pending')
    })
  })
})
