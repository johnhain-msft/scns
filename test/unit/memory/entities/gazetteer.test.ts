import { describe, it, expect } from 'vitest'
import {
  SCNS_GAZETTEER,
  matchEntities,
  canonicalize,
  type GazetteerEntry,
} from '../../../../src/memory/entities/gazetteer.js'

describe('SCNS gazetteer', () => {
  it('is a non-empty curated catalog with unique canonical names', () => {
    expect(SCNS_GAZETTEER.length).toBeGreaterThan(5)
    const names = SCNS_GAZETTEER.map((e) => e.canonical)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every entry has a valid kind and lowercase canonical', () => {
    const kinds = new Set(['component', 'agent', 'artifact', 'concept'])
    for (const e of SCNS_GAZETTEER) {
      expect(kinds.has(e.kind)).toBe(true)
      expect(e.canonical).toBe(e.canonical.toLowerCase())
    }
  })

  describe('canonicalize (alias → canonical)', () => {
    it('maps the canonical form to itself', () => {
      expect(canonicalize('auto-merger')).toBe('auto-merger')
    })

    it('maps known aliases to the canonical name', () => {
      expect(canonicalize('automerger')).toBe('auto-merger')
      expect(canonicalize('auto merger')).toBe('auto-merger')
    })

    it('is case-insensitive and trims whitespace', () => {
      expect(canonicalize('  Auto-Merger ')).toBe('auto-merger')
      expect(canonicalize('DREAM DAEMON')).toBe('dream-daemon')
    })

    it('returns undefined for an unknown surface form', () => {
      expect(canonicalize('totally-unknown-thing')).toBeUndefined()
    })
  })

  describe('matchEntities (deterministic extraction)', () => {
    it('finds a canonical entity mentioned in free text', () => {
      const got = matchEntities('the auto-merger refuses to merge a dirty working tree')
      expect(got.map((m) => m.canonical)).toContain('auto-merger')
    })

    it('resolves an alias to its canonical entity', () => {
      const got = matchEntities('the dream daemon ran at 03:00 and consolidated memory')
      const names = got.map((m) => m.canonical)
      expect(names).toContain('dream-daemon')
    })

    it('returns each canonical entity at most once even on repeated mentions', () => {
      const got = matchEntities('broker broker broker on port 3456 — the broker is up')
      const brokerHits = got.filter((m) => m.canonical === 'broker')
      expect(brokerHits).toHaveLength(1)
    })

    it('does not match a gazetteer term embedded inside a larger word', () => {
      // 'search' must not match inside 'researcher'; 'broker' not inside 'brokerage-x'
      const got = matchEntities('the researcher studied brokerages')
      const names = got.map((m) => m.canonical)
      expect(names).not.toContain('memory-search')
      expect(names).not.toContain('broker')
    })

    it('matches multiple distinct entities in one passage', () => {
      const got = matchEntities(
        'the indexer feeds the broker; the quality-gate blocks a bad diff',
      )
      const names = got.map((m) => m.canonical)
      expect(names).toContain('indexer')
      expect(names).toContain('broker')
      expect(names).toContain('quality-gate')
    })

    it('returns empty for text with no known entities', () => {
      expect(matchEntities('the quick brown fox jumped')).toEqual([])
    })

    it('honours a custom gazetteer argument', () => {
      const custom: GazetteerEntry[] = [
        { canonical: 'widget', kind: 'concept', aliases: ['widgets', 'wgt'] },
      ]
      const got = matchEntities('a wgt and two widgets', custom)
      expect(got.map((m) => m.canonical)).toEqual(['widget'])
    })

    it('is deterministic: same input → same ordered output', () => {
      const text = 'the broker, the indexer, and the dream daemon'
      expect(matchEntities(text)).toEqual(matchEntities(text))
    })
  })
})
