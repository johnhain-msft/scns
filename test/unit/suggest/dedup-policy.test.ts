/**
 * P8 — Suggestion volume tuning: time-windowed dedup.
 *
 * Problem: `shouldSkip` originally checks every persisted suggestion
 * (any status, any age). With 27 OTel sessions producing repeating
 * patterns and ~100+ historical suggestions across all statuses, EVERY
 * new tick gets count:0 — the templateFamily dedup matches forever.
 *
 * Spec (new optional knob `dedupWindowDays`):
 *   - undefined / 0 → legacy behavior: dedup against ALL stored
 *     suggestions regardless of age (no regression for callers that
 *     don't opt in).
 *   - positive N    → dedup only against (a) ACTIVE states forever
 *     (pending, approved, in-progress, needs-human, blocked-autonomy)
 *     AND (b) terminal states within the last N days.
 *   - User-rejected titles (store.getRejectedTitles()) are STILL
 *     respected forever — never re-surface what the user said no to.
 *
 * Active vs terminal partitioning is the key insight: a pattern the
 * user implemented 30 days ago can legitimately re-fire if fresh
 * evidence accumulates, but a currently-pending duplicate shouldn't
 * spam the dashboard.
 */
import { describe, it, expect } from 'vitest'
import { isFamilyDedupped } from '../../../src/suggest/dedup-policy.js'
import type { Suggestion } from '../../../src/suggest/types.js'

function suggestion(
  partial: Pick<Suggestion, 'id' | 'title' | 'type' | 'status' | 'updatedAt'>,
): Suggestion {
  return {
    id: partial.id,
    title: partial.title,
    type: partial.type,
    status: partial.status,
    confidence: 0.5,
    actionable: true,
    estimatedComplexity: 'solo',
    description: '',
    evidence: [],
    tags: [],
    createdAt: partial.updatedAt,
    updatedAt: partial.updatedAt,
  }
}

describe('isFamilyDedupped — legacy behavior (windowDays undefined)', () => {
  it('returns true when ANY stored suggestion has the same family + type', () => {
    const stored: Suggestion[] = [
      suggestion({
        id: 'a',
        title: 'Create py linting automation',
        type: 'automation',
        status: 'archive',
        updatedAt: '2020-01-01T00:00:00.000Z', // ancient
      }),
    ]
    expect(
      isFamilyDedupped({
        title: 'Create py linting automation',
        type: 'automation',
        stored,
        nowMs: Date.now(),
      }),
    ).toBe(true)
  })

  it('returns false when no family match', () => {
    const stored: Suggestion[] = [
      suggestion({
        id: 'a',
        title: 'Add jest tests',
        type: 'instruction',
        status: 'pending',
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ]
    expect(
      isFamilyDedupped({
        title: 'Create py linting automation',
        type: 'automation',
        stored,
        nowMs: Date.now(),
      }),
    ).toBe(false)
  })

  it('returns false on different type', () => {
    const stored: Suggestion[] = [
      suggestion({
        id: 'a',
        title: 'Foo',
        type: 'automation',
        status: 'pending',
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ]
    expect(
      isFamilyDedupped({
        title: 'Foo',
        type: 'instruction',
        stored,
        nowMs: Date.now(),
      }),
    ).toBe(false)
  })
})

describe('isFamilyDedupped — windowed behavior (windowDays=14)', () => {
  const now = new Date('2026-06-03T00:00:00.000Z').getTime()
  const daysAgo = (d: number): string => new Date(now - d * 86_400_000).toISOString()

  it('ACTIVE statuses always dedup (regardless of age)', () => {
    for (const status of [
      'pending',
      'approved',
      'in-progress',
      'needs-human',
      'blocked-autonomy',
    ] as const) {
      const stored: Suggestion[] = [
        suggestion({
          id: 'a',
          title: 'Foo',
          type: 'automation',
          status,
          updatedAt: daysAgo(500), // ancient but still ACTIVE
        }),
      ]
      expect(
        isFamilyDedupped({
          title: 'Foo',
          type: 'automation',
          stored,
          nowMs: now,
          dedupWindowDays: 14,
        }),
      ).toBe(true)
    }
  })

  it('TERMINAL statuses within window dedup', () => {
    const stored: Suggestion[] = [
      suggestion({
        id: 'a',
        title: 'Foo',
        type: 'automation',
        status: 'archive',
        updatedAt: daysAgo(7), // within 14-day window
      }),
    ]
    expect(
      isFamilyDedupped({
        title: 'Foo',
        type: 'automation',
        stored,
        nowMs: now,
        dedupWindowDays: 14,
      }),
    ).toBe(true)
  })

  it('TERMINAL statuses outside window do NOT dedup (re-surface allowed)', () => {
    for (const status of ['archive', 'implemented', 'failed'] as const) {
      const stored: Suggestion[] = [
        suggestion({
          id: 'a',
          title: 'Foo',
          type: 'automation',
          status,
          updatedAt: daysAgo(30), // older than 14d window
        }),
      ]
      expect(
        isFamilyDedupped({
          title: 'Foo',
          type: 'automation',
          stored,
          nowMs: now,
          dedupWindowDays: 14,
        }),
      ).toBe(false)
    }
  })

  it('REJECTED ALWAYS dedups (forever — respect user "no")', () => {
    const stored: Suggestion[] = [
      suggestion({
        id: 'a',
        title: 'Foo',
        type: 'automation',
        status: 'rejected',
        updatedAt: daysAgo(500), // ancient but rejected — STILL skip
      }),
    ]
    expect(
      isFamilyDedupped({
        title: 'Foo',
        type: 'automation',
        stored,
        nowMs: now,
        dedupWindowDays: 14,
      }),
    ).toBe(true)
  })

  it('mixed corpus — only matches dedup-eligible entries', () => {
    const stored: Suggestion[] = [
      suggestion({
        id: 'a',
        title: 'Foo',
        type: 'automation',
        status: 'archive',
        updatedAt: daysAgo(60), // old archive → NOT a match anymore
      }),
      suggestion({
        id: 'b',
        title: 'Bar',
        type: 'automation',
        status: 'pending', // active but different family
        updatedAt: daysAgo(1),
      }),
    ]
    expect(
      isFamilyDedupped({
        title: 'Foo',
        type: 'automation',
        stored,
        nowMs: now,
        dedupWindowDays: 14,
      }),
    ).toBe(false)
  })

  it('case-insensitive family match', () => {
    const stored: Suggestion[] = [
      suggestion({
        id: 'a',
        title: 'create PY linting automation',
        type: 'automation',
        status: 'pending',
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ]
    expect(
      isFamilyDedupped({
        title: 'Create py linting automation',
        type: 'automation',
        stored,
        nowMs: now,
        dedupWindowDays: 14,
      }),
    ).toBe(true)
  })
})
