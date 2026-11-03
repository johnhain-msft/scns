import { describe, it, expect } from 'vitest'
import { extractTagProposals, tokenize } from '../../../src/suggest/extractors/tag-suggestion-extractor.js'
import { rejectionSignature } from '../../../src/memory/tag-rejections.js'
import type { Lesson } from '../../../src/memory/lessons.js'

function lesson(
  id: string,
  body: string,
  tags: string[] = [],
  scope: 'global' | 'project' | 'agent' = 'project',
  project = 'scns',
): Lesson {
  return {
    frontmatter: {
      id,
      scope,
      ...(scope === 'project' ? { project } : {}),
      tags,
      appliesTo: [],
      createdAt: '2026-04-19T00:00:00Z',
    },
    body,
    path: `${id}.md`,
  }
}

describe('tag suggestion extractor (13.12.12)', () => {
  it('tokenize drops stopwords and short tokens', () => {
    const toks = tokenize('The API had a rate limit error when calling retry logic')
    expect(toks).not.toContain('the')
    expect(toks).not.toContain('a')
    expect(toks).toContain('rate')
    expect(toks).toContain('limit')
    expect(toks).toContain('error')
  })

  it('tokenize drops generic form/UI vocabulary (field/form/page) so they cannot become tags', () => {
    // Regression: the brain previously proposed "field" as a global tag
    // after seeing incidental prose like "a field that's 3 points off" and
    // "each field" across PDF / meta lessons. These words are too generic
    // to carry semantic meaning as tags.
    const toks = tokenize(
      'Each field must fit within its box on every page of the form; fields, forms, and pages all count.',
    )
    expect(toks).not.toContain('field')
    expect(toks).not.toContain('fields')
    expect(toks).not.toContain('form')
    expect(toks).not.toContain('forms')
    expect(toks).not.toContain('page')
    expect(toks).not.toContain('pages')
  })

  it('does NOT propose "field" as a tag even when it clusters across lessons', () => {
    const lessons = [
      lesson('meta-close-enough', "A field that's 3 points off in code is invisible."),
      lesson('meta-verification', 'Zoom into each field to verify alignment.'),
      lesson('pdf-overlay', 'Use PDF form fields (AcroForm) when possible.'),
      lesson('pdf-bias', 'Is each field precisely within its box or line?'),
    ]
    const out = extractTagProposals(lessons, { minClusterSize: 3 })
    expect(out.find((c) => c.tagName === 'field')).toBeUndefined()
    expect(out.find((c) => c.tagName === 'fields')).toBeUndefined()
  })

  it('tokenize drops generic verification vocabulary (check/checks/checking/checked)', () => {
    // Regression: the brain proposed "check" as a project tag after seeing
    // "double-check", "sanity check", and "check if" across verification /
    // PDF-quality lessons. The verb "check" is too generic to carry
    // semantic meaning as a tag.
    const toks = tokenize(
      'Always double-check the output; run a sanity check and verify that each checked field has been checking the latest state.',
    )
    expect(toks).not.toContain('check')
    expect(toks).not.toContain('checks')
    expect(toks).not.toContain('checked')
    expect(toks).not.toContain('checking')
  })

  it('does NOT propose "check" as a tag even when it clusters across lessons', () => {
    // Mirrors the real-world cluster (meta-lesson-verification-honesty,
    // pdf-generation-self-verification-bias, pdf-text-overlay-quality-lesson)
    // that the brain tried to tag as "check".
    const lessons = [
      lesson(
        'meta-lesson-verification-honesty',
        'Never claim verification without a real check; double-check output before signing off.',
      ),
      lesson(
        'pdf-generation-self-verification-bias',
        'Sanity check each generated page and check that the layout has not drifted.',
      ),
      lesson(
        'pdf-text-overlay-quality-lesson',
        'Visually check overlay alignment; a quick check can save hours of rework.',
      ),
    ]
    const out = extractTagProposals(lessons, { minClusterSize: 3 })
    expect(out.find((c) => c.tagName === 'check')).toBeUndefined()
    expect(out.find((c) => c.tagName === 'checks')).toBeUndefined()
    expect(out.find((c) => c.tagName === 'checking')).toBeUndefined()
    expect(out.find((c) => c.tagName === 'checked')).toBeUndefined()
  })

  it('tokenize drops generic prompting vocabulary (prompt/prompts/prompting/prompted)', () => {
    // Regression: the brain proposed "prompt" as a global tag after seeing
    // the "PROMPTING META-LESSON:" header and loose prose like "the user
    // had to prompt me TWICE" across PDF / meta lessons. The word "prompt"
    // is used here in its generic English sense (to nudge / to ask again),
    // not as a cohesive technical topic, and is too polysemous to carry
    // semantic meaning as a tag.
    const toks = tokenize(
      'PROMPTING META-LESSON: when the user had to prompt me twice, the prompts made it clear; each time I was prompted I should have re-prompted myself.',
    )
    expect(toks).not.toContain('prompt')
    expect(toks).not.toContain('prompts')
    expect(toks).not.toContain('prompted')
    expect(toks).not.toContain('prompting')
  })

  it('does NOT propose "prompt" as a tag even when it clusters across lessons', () => {
    // Mirrors the real-world cluster (meta-lesson-verification-honesty,
    // pdf-generation-self-verification-bias, meta-lesson-close-enough-trap)
    // that the brain tried to tag as "prompt".
    const lessons = [
      lesson(
        'meta-lesson-verification-honesty',
        'PROMPTING META-LESSON: when user says "open the file and verify it" they mean adversarial verification, not just a screenshot.',
        [],
        'global',
      ),
      lesson(
        'pdf-generation-self-verification-bias',
        'The user had to prompt me TWICE to actually look critically at the output.',
        [],
        'project',
      ),
      lesson(
        'meta-lesson-close-enough-trap',
        'PROMPTING META-LESSON: close enough is a trap for physical outputs, the user explicitly prompted further iteration.',
        [],
        'global',
      ),
    ]
    const out = extractTagProposals(lessons, { minClusterSize: 3 })
    expect(out.find((c) => c.tagName === 'prompt')).toBeUndefined()
    expect(out.find((c) => c.tagName === 'prompts')).toBeUndefined()
    expect(out.find((c) => c.tagName === 'prompting')).toBeUndefined()
    expect(out.find((c) => c.tagName === 'prompted')).toBeUndefined()
  })

  it('proposes a tag for a cluster of ≥3 untagged lessons sharing a token', () => {
    const lessons = [
      lesson('rate-lim-a', 'Always handle rate limiting errors with exponential backoff.'),
      lesson('rate-lim-b', 'When we hit rate limiting our retries help recovery.'),
      lesson('rate-lim-c', 'Respect provider rate limiting and throttle requests.'),
      lesson('unrelated', 'A short note about files and paths.'),
    ]
    const out = extractTagProposals(lessons, { minClusterSize: 3 })
    // Phase 13.12.25: tokens are now stem-dedup'd, so "limiting" clusters
    // appear as the shortest raw form seen — here "limit" (once stemmed
    // merge with "limits" etc). "rate" is its own cluster.
    const rate = out.find((c) => c.tagName === 'rate')
    const limit = out.find((c) => c.tagName === 'limit' || c.tagName === 'limiting')
    expect(rate || limit).toBeDefined()
    const pick = rate ?? limit!
    expect(pick.candidateLessonIds.sort()).toEqual(['rate-lim-a', 'rate-lim-b', 'rate-lim-c'])
    expect(pick.scope).toBe('project')
    expect(pick.project).toBe('scns')
  })

  it('proposes "screenshot" as a legitimate tag across verification / PDF-quality lessons', () => {
    // Regression: unlike the generic-vocabulary rejections above
    // (field / check / prompt), "screenshot" is a concrete technical noun
    // with a single meaning — a captured image of the screen used as a
    // verification artifact. It appears in the real-world cluster
    // (meta-lesson-verification-honesty, pdf-generation-self-verification-bias,
    // pdf-text-overlay-quality-lesson) as a cohesive topic, and was
    // approved via the SCNS suggestion pipeline as a new global tag.
    // This test pins that acceptance so future stop-word additions don't
    // accidentally start filtering it out.
    const lessons = [
      lesson(
        'meta-lesson-verification-honesty',
        'When the user says "verify it" they mean adversarial verification, not render a screenshot and confirm.',
        [],
        'global',
      ),
      lesson(
        'pdf-generation-self-verification-bias',
        'Full-page screenshots at 150 DPI hide subtle misalignment during self-verification.',
        [],
        'project',
      ),
      lesson(
        'pdf-text-overlay-quality-lesson',
        'Interpreting screenshots at 150-200 DPI is insufficient; use higher-DPI screenshot checks on zoomed regions.',
        [],
        'project',
      ),
    ]
    const out = extractTagProposals(lessons, { minClusterSize: 3 })
    const shot = out.find((c) => c.tagName === 'screenshot' || c.tagName === 'screenshots')
    expect(shot).toBeDefined()
    expect(shot!.candidateLessonIds.sort()).toEqual([
      'meta-lesson-verification-honesty',
      'pdf-generation-self-verification-bias',
      'pdf-text-overlay-quality-lesson',
    ])
  })

  it('does NOT propose a tag that is already on every clustered lesson', () => {
    const lessons = [
      lesson('a', 'Handle auth flows', ['auth']),
      lesson('b', 'Plan auth sequences', ['auth']),
      lesson('c', 'Review auth policies', ['auth']),
    ]
    const out = extractTagProposals(lessons, { minClusterSize: 3 })
    expect(out.find((c) => c.tagName === 'auth')).toBeUndefined()
  })

  it('skips tokens already in the known taxonomy', () => {
    const lessons = [
      lesson('a', 'caching strategy one'),
      lesson('b', 'caching strategy two'),
      lesson('c', 'caching strategy three'),
    ]
    const out = extractTagProposals(lessons, {
      minClusterSize: 3,
      knownTags: new Set(['caching', 'strategy']),
    })
    expect(out.find((c) => c.tagName === 'caching')).toBeUndefined()
    expect(out.find((c) => c.tagName === 'strategy')).toBeUndefined()
  })

  it('consults rejection signatures and does not re-propose same shape', () => {
    const lessons = [
      lesson('l1', 'retries help with flaky tests'),
      lesson('l2', 'retries smooth rate limits'),
      lesson('l3', 'retries make pipelines resilient'),
    ]
    const firstRun = extractTagProposals(lessons, { minClusterSize: 3 })
    const rejectedTag = firstRun.find((c) => c.tagName === 'retries')
    expect(rejectedTag).toBeDefined()
    const sig = rejectionSignature('retries', rejectedTag!.candidateLessonIds)
    const secondRun = extractTagProposals(lessons, {
      minClusterSize: 3,
      rejectedSignatures: new Set([sig]),
    })
    expect(secondRun.find((c) => c.tagName === 'retries')).toBeUndefined()
  })

  it('orphan lessons with no shared vocabulary produce no proposals', () => {
    const lessons = [
      lesson('x', 'apple pear quiver'),
      lesson('y', 'mandarin umbrella wizard'),
      lesson('z', 'slippers garden octopus'),
    ]
    const out = extractTagProposals(lessons, { minClusterSize: 3 })
    expect(out).toEqual([])
  })

  it('claimed-lesson deduplication: stronger cluster claims its lessons', () => {
    // Same three lessons share two common tokens — only the strongest
    // (first alphabetically when tied) should be proposed, no double-tagging.
    const lessons = [
      lesson('p1', 'caching reduces latency in pipelines'),
      lesson('p2', 'caching layer cut pipeline errors'),
      lesson('p3', 'caching helps pipeline throughput'),
    ]
    const out = extractTagProposals(lessons, { minClusterSize: 3 })
    const total = out.reduce((sum, c) => sum + c.candidateLessonIds.length, 0)
    expect(total).toBeLessThanOrEqual(3)
  })
})
