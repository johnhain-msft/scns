import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSuggestionStore, computeNextRetryAt } from '../../../src/suggest/suggestion-store.js'
import { SuggestionStatus } from '../../../src/suggest/types.js'
import { logger } from '../../../src/shared/logger.js'
import type { Suggestion } from '../../../src/suggest/types.js'

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'skill',
    title: 'Create git-commit helper skill',
    description: 'You frequently run the same git commit pattern.',
    status: 'pending',
    confidence: 0.85,
    evidence: [
      {
        source: 'tool-frequency',
        detail: 'Git used 45 times in last 7 days',
        observedAt: '2025-01-15T10:00:00Z',
        weight: 0.8,
      },
    ],
    tags: ['git', 'automation'],
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:00:00Z',
    ...overrides,
  }
}

describe('SuggestionStore', () => {
  let rootDir: string
  let store: ReturnType<typeof createSuggestionStore>

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'scns-suggest-test-'))
    store = createSuggestionStore({ rootDir })
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  describe('save', () => {
    it('creates file in pending/ directory', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)

      const pendingDir = join(rootDir, 'pending')
      expect(existsSync(pendingDir)).toBe(true)
      const files = readdirSync(pendingDir)
      expect(files).toHaveLength(1)
      expect(files[0]).toContain(suggestion.id)
    })
  })

  describe('get', () => {
    it('retrieves by ID from any status directory', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)

      const retrieved = store.get(suggestion.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(suggestion.id)
      expect(retrieved!.title).toBe(suggestion.title)
      expect(retrieved!.confidence).toBe(suggestion.confidence)
    })

    it('returns null for unknown ID', () => {
      expect(store.get('nonexistent-id')).toBeNull()
    })
  })

  describe('list', () => {
    it('with no filter returns all suggestions', () => {
      const s1 = makeSuggestion({ id: '550e8400-e29b-41d4-a716-446655440001' })
      const s2 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440002',
        title: 'Another suggestion',
      })
      store.save(s1)
      store.save(s2)

      const all = store.list()
      expect(all).toHaveLength(2)
    })

    it('with status filter returns only matching', () => {
      const s1 = makeSuggestion({ id: '550e8400-e29b-41d4-a716-446655440001' })
      const s2 = makeSuggestion({ id: '550e8400-e29b-41d4-a716-446655440002' })
      store.save(s1)
      store.save(s2)
      store.updateStatus(s2.id, SuggestionStatus.Approved, 'Looks good')

      const pending = store.list(SuggestionStatus.Pending)
      expect(pending).toHaveLength(1)
      expect(pending[0]!.id).toBe(s1.id)

      const approved = store.list(SuggestionStatus.Approved)
      expect(approved).toHaveLength(1)
      expect(approved[0]!.id).toBe(s2.id)
    })

    it('returns empty array for empty store', () => {
      expect(store.list()).toEqual([])
    })

    it('sorts by createdAt', () => {
      const s1 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440001',
        createdAt: '2025-01-15T10:00:00Z',
      })
      const s2 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440002',
        createdAt: '2025-01-14T10:00:00Z',
      })
      const s3 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440003',
        createdAt: '2025-01-16T10:00:00Z',
      })
      store.save(s1)
      store.save(s2)
      store.save(s3)

      const all = store.list()
      expect(all[0]!.id).toBe(s2.id)
      expect(all[1]!.id).toBe(s1.id)
      expect(all[2]!.id).toBe(s3.id)
    })
  })

  describe('updateStatus', () => {
    it('moves file between directories', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)

      const updated = store.updateStatus(suggestion.id, SuggestionStatus.Approved, 'Good idea')
      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('approved')

      // Should now be in approved/ not pending/
      expect(readdirSync(join(rootDir, 'pending'))).toHaveLength(0)
      expect(readdirSync(join(rootDir, 'approved'))).toHaveLength(1)
    })

    it('sets reviewedAt and reviewReason', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)

      const updated = store.updateStatus(suggestion.id, SuggestionStatus.Rejected, 'Not useful')
      expect(updated).not.toBeNull()
      expect(updated!.reviewedAt).toBeDefined()
      expect(updated!.reviewReason).toBe('Not useful')
    })

    it('returns null for unknown ID', () => {
      expect(store.updateStatus('nonexistent', SuggestionStatus.Approved)).toBeNull()
    })
  })

  describe('findSimilar', () => {
    it('detects duplicate by title overlap', () => {
      const suggestion = makeSuggestion({ title: 'Create git commit helper skill' })
      store.save(suggestion)

      const similar = store.findSimilar('Create git commit helper skill tool', 'skill')
      expect(similar).not.toBeNull()
      expect(similar!.id).toBe(suggestion.id)
    })

    it('returns null when no match', () => {
      const suggestion = makeSuggestion({ title: 'Create git commit helper skill' })
      store.save(suggestion)

      const similar = store.findSimilar('Set up Docker deployment pipeline', 'skill')
      expect(similar).toBeNull()
    })

    it('requires same type', () => {
      const suggestion = makeSuggestion({ title: 'Create git commit helper skill' })
      store.save(suggestion)

      const similar = store.findSimilar('Create git commit helper skill', 'agent')
      expect(similar).toBeNull()
    })

    it('handles case-insensitive comparison', () => {
      const suggestion = makeSuggestion({ title: 'Create Git Commit Helper Skill' })
      store.save(suggestion)

      const similar = store.findSimilar('create git commit helper skill', 'skill')
      expect(similar).not.toBeNull()
    })
  })

  describe('getRejectedTitles', () => {
    it('returns titles from rejected/', () => {
      const s1 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440001',
        title: 'Bad idea',
      })
      const s2 = makeSuggestion({
        id: '550e8400-e29b-41d4-a716-446655440002',
        title: 'Another bad idea',
      })
      store.save(s1)
      store.save(s2)
      store.updateStatus(s1.id, SuggestionStatus.Rejected, 'Nope')
      store.updateStatus(s2.id, SuggestionStatus.Rejected, 'Also nope')

      const titles = store.getRejectedTitles()
      expect(titles).toContain('Bad idea')
      expect(titles).toContain('Another bad idea')
    })

    it('returns empty array when no rejected suggestions', () => {
      expect(store.getRejectedTitles()).toEqual([])
    })
  })

  describe('remove', () => {
    it('deletes the file', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)

      const removed = store.remove(suggestion.id)
      expect(removed).toBe(true)
      expect(store.get(suggestion.id)).toBeNull()
    })

    it('returns false for unknown ID', () => {
      expect(store.remove('nonexistent')).toBe(false)
    })
  })

  describe('directory management', () => {
    it('creates directories if missing', () => {
      const freshDir = mkdtempSync(join(tmpdir(), 'scns-suggest-fresh-'))
      try {
        const freshStore = createSuggestionStore({ rootDir: freshDir })
        freshStore.save(makeSuggestion())

        expect(existsSync(join(freshDir, 'pending'))).toBe(true)
      } finally {
        rmSync(freshDir, { recursive: true, force: true })
      }
    })
  })

  describe('malformed file handling', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    })

    afterEach(() => {
      warnSpy.mockRestore()
    })

    it('archives files with missing frontmatter delimiters and emits a one-time warn', () => {
      const pendingDir = join(rootDir, 'pending')
      store.save(makeSuggestion())
      writeFileSync(join(pendingDir, 'bad.md'), 'no frontmatter at all here', 'utf-8')

      const result = store.list(SuggestionStatus.Pending)

      expect(result).toHaveLength(1)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const [ctx, msg] = warnSpy.mock.calls[0]! as [
        { err: string; file: string; archivedTo: string },
        string,
      ]
      expect(ctx.file).toBe('bad.md')
      expect(ctx.err).toContain('frontmatter')
      expect(ctx.archivedTo).toContain(join(rootDir, 'archive'))
      expect(msg).toBe('suggestion-store: archived malformed suggestion (parse failed)')

      // Phase 13.12.25: after archival a second list() call must NOT re-warn.
      warnSpy.mockClear()
      store.list(SuggestionStatus.Pending)
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('archives files with invalid enum values', () => {
      const pendingDir = join(rootDir, 'pending')
      store.save(makeSuggestion())
      const badContent = [
        '---',
        'id: "00000000-0000-0000-0000-000000000001"',
        'title: "Malformed"',
        'type: "bogus-type-not-in-enum"',
        'status: "pending"',
        'confidence: 0.5',
        'createdAt: "2026-04-17T00:00:00.000Z"',
        'updatedAt: "2026-04-17T00:00:00.000Z"',
        '---',
        '## Description',
        'testing malformed file',
        '',
      ].join('\n')
      writeFileSync(join(pendingDir, 'bad-enum.md'), badContent, 'utf-8')

      const result = store.list(SuggestionStatus.Pending)

      expect(result).toHaveLength(1)
      expect(result[0]!.title).toBe('Create git-commit helper skill')
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const [ctx] = warnSpy.mock.calls[0]! as [{ err: string; file: string; archivedTo: string }]
      expect(ctx.file).toBe('bad-enum.md')
      expect(ctx.archivedTo).toContain('archive')
    })

    it('archives files missing required fields', () => {
      const pendingDir = join(rootDir, 'pending')
      store.save(makeSuggestion())
      const missingContent = [
        '---',
        'id: "00000000-0000-0000-0000-000000000002"',
        'title: "Missing type"',
        'status: "pending"',
        'confidence: 0.5',
        'createdAt: "2026-04-17T00:00:00.000Z"',
        'updatedAt: "2026-04-17T00:00:00.000Z"',
        '---',
        '## Description',
        'missing type field',
        '',
      ].join('\n')
      writeFileSync(join(pendingDir, 'missing-field.md'), missingContent, 'utf-8')

      const result = store.list(SuggestionStatus.Pending)

      expect(result).toHaveLength(1)
      expect(warnSpy).toHaveBeenCalledTimes(1)
    })

    it('skips *.critique.md files silently (no parse, no warn)', () => {
      const pendingDir = join(rootDir, 'pending')
      store.save(makeSuggestion())
      writeFileSync(
        join(pendingDir, 'some-id.critique.md'),
        'verdict=fail\nfindings: 3\n',
        'utf-8',
      )
      const result = store.list(SuggestionStatus.Pending)
      expect(result).toHaveLength(1)
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })

  // ── Phase 13.12.9 ──────────────────────────────────────────────────

  describe('recordFailure (Phase 13.12.9)', () => {
    it('first failure: increments attemptCount to 1, sets lastError + nextRetryAt', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)
      store.updateStatus(suggestion.id, SuggestionStatus.Approved)

      const nowMs = Date.UTC(2025, 0, 15, 10, 0, 0)
      const updated = store.recordFailure(suggestion.id, 'boom', nowMs)

      expect(updated).not.toBeNull()
      expect(updated!.attemptCount).toBe(1)
      expect(updated!.lastError).toBe('boom')
      expect(updated!.lastAttemptAt).toBe(new Date(nowMs).toISOString())
      expect(updated!.nextRetryAt).not.toBeNull()
      // 2^1 = 2 minutes
      const retryMs = new Date(updated!.nextRetryAt!).getTime()
      expect(retryMs - nowMs).toBe(2 * 60 * 1000)
      // still in approved (not yet terminal)
      expect(updated!.status).toBe('approved')
      expect(readdirSync(join(rootDir, 'approved'))).toHaveLength(1)
    })

    it('5th failure: transitions to `failed` status and moves file to failed/', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)
      store.updateStatus(suggestion.id, SuggestionStatus.Approved)

      const baseMs = Date.UTC(2025, 0, 15, 10, 0, 0)
      for (let i = 1; i <= 5; i++) {
        store.recordFailure(suggestion.id, `err-${i}`, baseMs + i * 1000)
      }

      const final = store.get(suggestion.id)
      expect(final).not.toBeNull()
      expect(final!.status).toBe('failed')
      expect(final!.attemptCount).toBe(5)
      expect(final!.lastError).toBe('err-5')
      expect(final!.nextRetryAt).toBeNull()

      expect(readdirSync(join(rootDir, 'approved'))).toHaveLength(0)
      expect(readdirSync(join(rootDir, 'failed'))).toHaveLength(1)
    })

    it('caps backoff at 1 day', () => {
      const nowMs = Date.UTC(2025, 0, 15, 10, 0, 0)
      // attempt=11 → 2^11=2048 min > 1440 min (1 day) → expect cap.
      const capIso = computeNextRetryAt(20, nowMs)
      const capMs = new Date(capIso).getTime()
      expect(capMs - nowMs).toBe(24 * 60 * 60 * 1000)
    })

    it('returns null when suggestion does not exist', () => {
      expect(store.recordFailure('missing-id', 'err')).toBeNull()
    })
  })

  describe('clearBackoff (Phase 13.12.9)', () => {
    it('clears all failure tracking on an approved suggestion', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)
      store.updateStatus(suggestion.id, SuggestionStatus.Approved)
      store.recordFailure(suggestion.id, 'err', Date.now())

      const cleared = store.clearBackoff(suggestion.id)
      expect(cleared).not.toBeNull()
      expect(cleared!.attemptCount).toBe(0)
      expect(cleared!.lastError).toBeNull()
      expect(cleared!.nextRetryAt).toBeNull()
      expect(cleared!.lastAttemptAt).toBeNull()
      expect(cleared!.status).toBe('approved')
    })

    it('moves a failed suggestion back to approved', () => {
      const suggestion = makeSuggestion()
      store.save(suggestion)
      store.updateStatus(suggestion.id, SuggestionStatus.Approved)
      const base = Date.now()
      for (let i = 0; i < 5; i++) store.recordFailure(suggestion.id, 'err', base + i)
      expect(store.get(suggestion.id)!.status).toBe('failed')

      const cleared = store.clearBackoff(suggestion.id)
      expect(cleared!.status).toBe('approved')
      expect(readdirSync(join(rootDir, 'failed'))).toHaveLength(0)
      expect(readdirSync(join(rootDir, 'approved'))).toHaveLength(1)
    })

    it('returns null for unknown ID', () => {
      expect(store.clearBackoff('missing-id')).toBeNull()
    })
  })

  describe('failed directory (Phase 13.12.9)', () => {
    it('list("failed") returns only failed items', () => {
      const s1 = makeSuggestion({ id: '550e8400-e29b-41d4-a716-446655440011' })
      const s2 = makeSuggestion({ id: '550e8400-e29b-41d4-a716-446655440012' })
      store.save(s1)
      store.save(s2)
      store.updateStatus(s1.id, SuggestionStatus.Approved)
      const base = Date.now()
      for (let i = 0; i < 5; i++) store.recordFailure(s1.id, 'err', base + i)

      const failed = store.list('failed' as SuggestionStatus)
      expect(failed).toHaveLength(1)
      expect(failed[0]!.id).toBe(s1.id)
      // s2 still pending
      expect(store.list(SuggestionStatus.Pending)).toHaveLength(1)
    })
  })

  describe('repromote (Phase 13.12.16)', () => {
    it('moves needs-human → pending and clears review fields', () => {
      const s = makeSuggestion()
      store.save(s)
      store.updateStatus(s.id, 'needs-human' as SuggestionStatus, 'awaiting decision')
      expect(readdirSync(join(rootDir, 'needs-human'))).toHaveLength(1)

      const result = store.repromote(s.id)
      expect(result).not.toBeNull()
      expect(result!.status).toBe('pending')
      expect(result!.reviewReason).toBeUndefined()
      expect(result!.reviewedAt).toBeUndefined()
      expect(readdirSync(join(rootDir, 'needs-human'))).toHaveLength(0)
      expect(readdirSync(join(rootDir, 'pending'))).toHaveLength(1)
    })

    it('returns null when suggestion not in needs-human', () => {
      const s = makeSuggestion()
      store.save(s) // pending
      expect(store.repromote(s.id)).toBeNull()
      expect(readdirSync(join(rootDir, 'pending'))).toHaveLength(1)
    })

    it('returns null for unknown id', () => {
      expect(store.repromote('nope')).toBeNull()
    })
  })

  describe('Phase 13.12.20 — in-progress lifecycle', () => {
    it('markInProgress moves file to in-progress/ and persists inflightTeamId', () => {
      const suggestion = makeSuggestion({ status: 'approved' })
      store.save(suggestion)

      const updated = store.markInProgress(suggestion.id, 'team-sugg-abc12345')
      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('in-progress')
      expect(updated!.inflightTeamId).toBe('team-sugg-abc12345')

      // File is now under in-progress/, not approved/
      expect(readdirSync(join(rootDir, 'in-progress'))).toHaveLength(1)
      expect(readdirSync(join(rootDir, 'approved'))).toHaveLength(0)
    })

    it('findByInflightTeamId returns the owning suggestion', () => {
      const a = makeSuggestion({
        id: '11111111-1111-1111-1111-111111111111',
        status: 'approved',
      })
      const b = makeSuggestion({
        id: '22222222-2222-2222-2222-222222222222',
        status: 'approved',
      })
      store.save(a)
      store.save(b)
      store.markInProgress(a.id, 'team-sugg-aaa')
      store.markInProgress(b.id, 'team-sugg-bbb')

      const found = store.findByInflightTeamId('team-sugg-bbb')
      expect(found).not.toBeNull()
      expect(found!.id).toBe(b.id)

      expect(store.findByInflightTeamId('team-sugg-unknown')).toBeNull()
    })

    it('updateStatus clears inflightTeamId when leaving in-progress', () => {
      const suggestion = makeSuggestion({ status: 'approved' })
      store.save(suggestion)
      store.markInProgress(suggestion.id, 'team-sugg-xyz')

      const moved = store.updateStatus(suggestion.id, 'implemented')
      expect(moved).not.toBeNull()
      expect(moved!.status).toBe('implemented')
      expect(moved!.inflightTeamId).toBeNull()
      expect(store.findByInflightTeamId('team-sugg-xyz')).toBeNull()
    })
  })
})
