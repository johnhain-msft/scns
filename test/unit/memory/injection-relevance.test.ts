/**
 * Prompt-relevance scoring for the per-prompt injection blocks (issue #75).
 *
 * The scorer decides which pending suggestions and negative rules earn a place in the
 * injected context. It must be COVERAGE of the item (not symmetric Jaccard — a long prompt
 * would drown every short item), must ignore stopword overlap ("the"/"in"/"a" shared with
 * any prompt), and must require two shared content words so a lone generic verb cannot
 * carry an off-topic item in.
 */
import { describe, it, expect } from 'vitest'
import {
  makePromptRelevanceScorer,
  injectionRelevanceEnabled,
  INJECTION_RELEVANCE_ENV,
} from '../../../src/memory/injection-relevance.js'

describe('makePromptRelevanceScorer', () => {
  const score = makePromptRelevanceScorer(
    'why does the broker heartbeat retry loop hammer the backoff',
  )

  it('scores an on-topic item positive (two or more shared content words)', () => {
    expect(score('Harden broker heartbeat retry backoff')).toBeGreaterThan(0)
  })

  it('scores a fully off-topic item zero', () => {
    expect(score('Refactor scheduler cold start catch-up')).toBe(0)
  })

  it('ranks a tighter match above a looser one (coverage, not raw match count)', () => {
    // Both share the same words with the prompt; the shorter item is covered more tightly.
    const tight = score('broker heartbeat retry')
    const loose = score('broker heartbeat retry semantics for the embedding backfill sweep')
    expect(tight).toBeGreaterThan(loose)
    expect(loose).toBeGreaterThan(0)
  })

  it('a single shared content word is NOT relevance', () => {
    // "retry" alone must not drag in an item about a different subsystem.
    expect(score('Add retry to the embedding worker spawn')).toBe(0)
  })

  it('stopword overlap scores zero', () => {
    expect(score('Why should this always be done before it can be there')).toBe(0)
  })

  it('a one-content-word item matches on that single word', () => {
    // min-shared is min(2, |item|): a one-word item cannot be asked for two words.
    expect(score('the backoff')).toBe(1)
  })

  it('matches across plural/singular forms on both sides', () => {
    const s = makePromptRelevanceScorer("don't hardcode the API secret in config queries")
    expect(s('never hardcode secrets in query strings')).toBeGreaterThan(0)
  })

  it('an item with no content words scores zero', () => {
    expect(score('')).toBe(0)
    expect(score('   ')).toBe(0)
    expect(score('the of and')).toBe(0)
  })

  it('negative-rule boilerplate ("never", "do not", "avoid") never counts as overlap', () => {
    const s = makePromptRelevanceScorer('never do this without avoiding that')
    expect(s('Never avoid doing the scheduler migration')).toBe(0)
  })

  it('plural forms of stopwords do not leak past the filter', () => {
    // "avoids" must be stopped like "avoid" — boilerplate never counts, inflected or not.
    const s = makePromptRelevanceScorer('this avoids doing that')
    expect(s('never avoids doing anything')).toBe(0)
  })
})

describe('injectionRelevanceEnabled — the flip-back lever', () => {
  it('is ON by default', () => {
    expect(injectionRelevanceEnabled({})).toBe(true)
  })

  it('is OFF only for the explicit "0"', () => {
    expect(injectionRelevanceEnabled({ [INJECTION_RELEVANCE_ENV]: '0' })).toBe(false)
    expect(injectionRelevanceEnabled({ [INJECTION_RELEVANCE_ENV]: '1' })).toBe(true)
    expect(injectionRelevanceEnabled({ [INJECTION_RELEVANCE_ENV]: 'off' })).toBe(true)
  })
})
