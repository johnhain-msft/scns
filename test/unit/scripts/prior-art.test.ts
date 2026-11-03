/**
 * T027 [US3] (specs/001-learning-memory-loop) — prior-art-first is ENFORCED, not aspirational
 * (Constitution V, FR-010, SC-007): the annotated bibliography must exist IN-REPO with the six
 * mandated areas each mapped to an adopt-vs-build call, and the routing/learning design modules must
 * actually cite it. Reuse over reinvention is a merge gate, so this suite is the tripwire.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const bibliographyPath = join(repoRoot, 'docs', 'PRIOR_ART.md')

describe('T027 — the annotated prior-art bibliography exists in-repo (docs/PRIOR_ART.md)', () => {
  it('exists — the file every design header cites must not be a dead reference', () => {
    expect(existsSync(bibliographyPath)).toBe(true)
  })

  it('covers all six mandated areas with explicit adopt-vs-build calls', () => {
    const bib = readFileSync(bibliographyPath, 'utf8')
    for (const area of [
      /adaptive[- ]retrieval routing|adaptive[- ]rag/i,
      /router[- ]over[- ]retrievers|routerretriever/i,
      /bandit|off[- ]policy/i,
      /self[- ]rag/i,
      /preference[- ]optimization|kto/i,
      /episodic|case[- ]based|been[- ]here[- ]before/i,
    ]) {
      expect(bib).toMatch(area)
    }
    expect(bib).toMatch(/adopt/i)
    expect(bib).toMatch(/build/i)
  })

  it('cites the load-bearing verified papers (the legos the design assembles)', () => {
    const bib = readFileSync(bibliographyPath, 'utf8')
    for (const arxivId of ['2403.14403', '1103.4601', '2402.01306', '2310.11511', '1908.04734']) {
      expect(bib, `must cite arXiv:${arxivId}`).toContain(arxivId)
    }
  })
})

describe('T027 — the routing/learning design CITES the bibliography (SC-007)', () => {
  const designFiles = [
    'src/memory/arm-router.ts',
    'src/memory/explore-router.ts',
    'src/reward/kto-learner.ts',
    'src/reward/dr-estimator.ts',
  ]
  for (const f of designFiles) {
    it(`${f} references PRIOR_ART`, () => {
      const src = readFileSync(join(repoRoot, f), 'utf8')
      expect(src).toMatch(/PRIOR_ART/)
    })
  }
})

describe('T027 — the spec-side catalogue (research.md Part C) stays present when the spec tree exists', () => {
  const specResearch = resolve(repoRoot, '..', 'specs', '001-learning-memory-loop', 'research.md')
  const run = existsSync(specResearch) ? it : it.skip
  run('research.md carries the Part C annotated catalogue', () => {
    const research = readFileSync(specResearch, 'utf8')
    expect(research).toMatch(/Part C — Prior-art annotated bibliography/)
    expect(research).toMatch(/adopt-vs-build summary/i)
  })
})
