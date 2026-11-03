import { describe, it, expect } from 'vitest'
import { classifyIntent } from '../../../src/memory/intent.js'
import type { GazetteerEntry } from '../../../src/memory/entities/gazetteer.js'

describe('classifyIntent (M1.2 deterministic intent classifier)', () => {
  describe('WHY intent — causal questions', () => {
    it('labels "why" questions WHY', () => {
      expect(classifyIntent('why did the broker crash')).toBe('WHY')
    })

    it('labels because / caused / due to / root cause / reason WHY', () => {
      expect(classifyIntent('the merge failed because of a dirty tree')).toBe('WHY')
      expect(classifyIntent('what caused the regression')).toBe('WHY')
      expect(classifyIntent('the timeout was due to model load')).toBe('WHY')
      expect(classifyIntent('find the root cause of the failure')).toBe('WHY')
      expect(classifyIntent('the reason the test flaked')).toBe('WHY')
    })

    it('WHY takes precedence over WHEN and ENTITY', () => {
      // contains "when" (WHEN marker) AND "broker" (entity) AND "why" → WHY wins
      expect(classifyIntent('why did the broker restart when it booted')).toBe('WHY')
    })
  })

  describe('WHEN intent — temporal questions', () => {
    it('labels when / before / after / recently / last WHEN', () => {
      expect(classifyIntent('when did the dream daemon run')).toBe('WHEN')
      expect(classifyIntent('what happened before the deploy')).toBe('WHEN')
      expect(classifyIntent('the state after the rebuild')).toBe('WHEN')
      expect(classifyIntent('what did we change recently')).toBe('WHEN')
      expect(classifyIntent('the last successful run')).toBe('WHEN')
    })

    it('WHEN takes precedence over ENTITY', () => {
      // 'broker' is an entity; the "when"/"last" markers make this temporal
      expect(classifyIntent('when was the broker last restarted')).toBe('WHEN')
    })

    it('does not fire WHEN on in-word matches (boundary-aware)', () => {
      // 'lastly' embeds 'last' but must NOT be read as a temporal marker;
      // it still contains the 'gazetteer' entity → ENTITY, never WHEN.
      expect(classifyIntent('lastly we shipped the gazetteer')).not.toBe('WHEN')
    })
  })

  describe('ENTITY intent — gazetteer hit, no WHY/WHEN markers', () => {
    it('labels a bare entity mention ENTITY', () => {
      expect(classifyIntent('broker')).toBe('ENTITY')
      expect(classifyIntent('tell me about the auto-merger')).toBe('ENTITY')
    })

    it('resolves aliases as entity hits', () => {
      expect(classifyIntent('dream daemon behavior')).toBe('ENTITY') // alias of dream-daemon
      expect(classifyIntent('how does hybrid search rank')).toBe('ENTITY') // alias of memory-search
    })
  })

  describe('DEFAULT intent', () => {
    it('labels a query with no markers and no entity DEFAULT', () => {
      expect(classifyIntent('how do I configure logging levels')).toBe('DEFAULT')
    })

    it('empty / whitespace → DEFAULT', () => {
      expect(classifyIntent('')).toBe('DEFAULT')
      expect(classifyIntent('   ')).toBe('DEFAULT')
    })
  })

  describe('robustness', () => {
    it('is case-insensitive', () => {
      expect(classifyIntent('WHY DID IT FAIL')).toBe('WHY')
      expect(classifyIntent('BROKER')).toBe('ENTITY')
    })

    it('tolerates trailing punctuation', () => {
      expect(classifyIntent('why?')).toBe('WHY')
      expect(classifyIntent('when, exactly?')).toBe('WHEN')
    })

    it('honors a custom gazetteer for ENTITY detection', () => {
      const gaz: readonly GazetteerEntry[] = [
        { canonical: 'widget', kind: 'concept', aliases: ['widgets'] },
      ]
      expect(classifyIntent('the widget broke', gaz)).toBe('ENTITY')
      // a default-gazetteer entity is NOT recognized under the custom gazetteer
      expect(classifyIntent('the broker', gaz)).toBe('DEFAULT')
    })
  })
})
