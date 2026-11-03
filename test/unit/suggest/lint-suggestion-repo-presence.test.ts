/**
 * LINT-SUGGESTION REPO PRESENCE — a lint automation must target a file type the repo ACTUALLY has.
 *
 * `fileTypeCounts` is built in `pattern-detector.ts` from EVERY file observation across EVERY
 * watched directory, with no repo scoping:
 *
 *     for (const obs of fileObs) {
 *       const extTag = obs.tags.find((t) => t.startsWith('ext:'))
 *       if (extTag) incrementMap(fileTypeCounts, extTag.slice(4))
 *     }
 *
 * The automation suggestion built from that global histogram is then dispatched against ONE
 * working directory. So a dominant extension earned in some other watched project produces a
 * confident, well-evidenced suggestion to lint a language the target repo does not contain.
 *
 * Observed: "Create py linting automation — File type '.py' changed 2753 times" was dispatched
 * against the scns repo, which has ZERO tracked `.py` files (`git log --all -- '*.py'` → 0). The
 * only `.py` anywhere in the tree is a vendored `dashboard/node_modules/flatted/python/flatted.py`.
 *
 * The Phase 13.12.25 `LINTABLE_SOURCE_EXTS` guard fixed the adjacent half of this bug — it stopped
 * `png`/`tsbuildinfo` noise by asking "is this a source extension?" — but `py` passes that check.
 * Nothing asked the load-bearing question: "is this extension present in the repo we are about to
 * send an agent to?"
 *
 * These tests assert the CROSS-SOURCE fact: the histogram is global, the target is one repo, and
 * emission requires agreement between them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createSuggestionGenerator } from '../../../src/suggest/generator.js'
import { createConfidenceScorer } from '../../../src/suggest/confidence.js'
import { createEvidenceGatherer } from '../../../src/suggest/evidence.js'
import { collectRepoFileTypes } from '../../../src/suggest/repo-file-types.js'
import type { Suggestion, SuggestionType } from '../../../src/suggest/types.js'
import type { ProjectFocusPattern } from '../../../src/observe/pattern-detector.js'

function createMockStore() {
  const suggestions = new Map<string, Suggestion>()
  return {
    save(s: Suggestion): void {
      suggestions.set(s.id, s)
    },
    get(id: string): Suggestion | null {
      return suggestions.get(id) ?? null
    },
    list(status?: string): readonly Suggestion[] {
      const all = [...suggestions.values()]
      return status ? all.filter((s) => s.status === status) : all
    },
    updateStatus(): Suggestion | null {
      return null
    },
    findSimilar(_title: string, _type: SuggestionType): Suggestion | null {
      return null
    },
    getRejectedTitles(): readonly string[] {
      return []
    },
    remove(id: string): boolean {
      return suggestions.delete(id)
    },
  }
}

function makeProjectPattern(overrides?: Partial<ProjectFocusPattern>): ProjectFocusPattern {
  return {
    repoCounts: new Map([['scns', 30]]),
    topRepos: ['scns'],
    fileTypeCounts: new Map([['ts', 50]]),
    recentFocus: 'scns',
    repoActivityCounts: new Map([['scns', 80]]),
    ...overrides,
  }
}

function makeGenerator(repoFileTypes?: ReadonlySet<string>) {
  return createSuggestionGenerator(
    {
      scorer: createConfidenceScorer(),
      evidenceGatherer: createEvidenceGatherer(),
      store: createMockStore(),
    },
    // `repoDir` pinned to an empty temp dir: these tests isolate the PRESENCE gate, and the
    // sibling already-configured-linter gate (2026-09-21) reads linter config from `repoDir`
    // (default `process.cwd()` — this repo, which really does lint `ts` and would suppress
    // the positive controls for reasons unrelated to presence).
    { minimumConfidence: 0.3, repoFileTypes, repoDir: neutralRepoDir },
  )
}

const neutralRepoDir = mkdtempSync(join(tmpdir(), 'scns-lint-presence-neutral-'))

const lintTitles = (suggestions: readonly Suggestion[]): readonly string[] =>
  suggestions.map((s) => s.title).filter((t) => t.includes('linting automation'))

describe('lint suggestion requires the file type to exist in the target repo', () => {
  describe('the reported defect', () => {
    it('does NOT suggest py linting for a repo with no Python files', () => {
      // The exact observed histogram: .py dominant globally, earned in another watched project.
      const pattern = makeProjectPattern({
        fileTypeCounts: new Map([
          ['py', 2753],
          ['ts', 400],
        ]),
      })
      // The target repo is TypeScript-only — this is what scns actually contains.
      const suggestions = makeGenerator(
        new Set(['ts', 'json', 'md']),
      ).generateAutomationSuggestions(pattern, 7)

      expect(lintTitles(suggestions)).not.toContain('Create py linting automation')
      expect(lintTitles(suggestions)).toEqual([])
    })

    it('does not fall back to the next-ranked type either (absence is not a re-roll)', () => {
      // Suppressing the dominant type must not silently promote a runner-up: the suggestion's
      // stated evidence ("changed N times") belongs to the dominant type, so a substituted
      // runner-up would ship a true count attached to the wrong claim.
      const pattern = makeProjectPattern({
        fileTypeCounts: new Map([
          ['py', 2753],
          ['rb', 900],
        ]),
      })
      const suggestions = makeGenerator(new Set(['ts'])).generateAutomationSuggestions(pattern, 7)

      expect(lintTitles(suggestions)).toEqual([])
    })
  })

  describe('positive control — the feature still works when it is true', () => {
    it('DOES suggest ts linting when the repo actually contains TypeScript', () => {
      const pattern = makeProjectPattern({ fileTypeCounts: new Map([['ts', 500]]) })
      const suggestions = makeGenerator(new Set(['ts', 'json'])).generateAutomationSuggestions(
        pattern,
        7,
      )

      expect(lintTitles(suggestions)).toContain('Create ts linting automation')
    })

    it('DOES suggest py linting for a repo that genuinely is Python', () => {
      const pattern = makeProjectPattern({ fileTypeCounts: new Map([['py', 2753]]) })
      const suggestions = makeGenerator(new Set(['py', 'toml'])).generateAutomationSuggestions(
        pattern,
        7,
      )

      expect(lintTitles(suggestions)).toContain('Create py linting automation')
    })

    it('leaves non-lint automation suggestions untouched', () => {
      const pattern = makeProjectPattern({ fileTypeCounts: new Map([['py', 2753]]) })
      const suggestions = makeGenerator(new Set(['ts'])).generateAutomationSuggestions(pattern, 7)

      // The build/deploy + workflow suggestions do not depend on file-type presence.
      expect(suggestions.length).toBeGreaterThan(0)
      expect(suggestions.some((s) => s.title.includes('scns'))).toBe(true)
    })
  })

  describe('back-compat — no presence index available', () => {
    it('emits as before when repoFileTypes is undefined (no index ⇒ no veto)', () => {
      const pattern = makeProjectPattern({ fileTypeCounts: new Map([['py', 2753]]) })
      const suggestions = makeGenerator(undefined).generateAutomationSuggestions(pattern, 7)

      expect(lintTitles(suggestions)).toContain('Create py linting automation')
    })
  })

  describe('collectRepoFileTypes — the real presence index', () => {
    let repo: string

    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), 'scns-lint-presence-'))
      execFileSync('git', ['init', '-q'], { cwd: repo })
    })

    afterEach(() => {
      rmSync(repo, { recursive: true, force: true })
    })

    const commitAll = (): void => {
      execFileSync('git', ['add', '-A'], { cwd: repo })
      execFileSync(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed'],
        { cwd: repo },
      )
    }

    it('reports extensions that are tracked in the repo', () => {
      writeFileSync(join(repo, 'main.ts'), 'export const a = 1\n')
      writeFileSync(join(repo, 'conf.json'), '{}\n')
      commitAll()

      const types = collectRepoFileTypes(repo)
      expect(types.has('ts')).toBe(true)
      expect(types.has('json')).toBe(true)
      expect(types.has('py')).toBe(false)
    })

    it('does NOT count vendored dependencies as repo source', () => {
      // The precise trap in scns: the ONLY .py in the tree is
      // dashboard/node_modules/flatted/python/flatted.py. A naive recursive scan would
      // "confirm" Python and re-emit the bogus suggestion.
      writeFileSync(join(repo, 'main.ts'), 'export const a = 1\n')
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
      mkdirSync(join(repo, 'node_modules', 'flatted', 'python'), { recursive: true })
      writeFileSync(join(repo, 'node_modules', 'flatted', 'python', 'flatted.py'), 'x = 1\n')
      commitAll()

      const types = collectRepoFileTypes(repo)
      expect(types.has('ts')).toBe(true)
      expect(types.has('py')).toBe(false)
    })

    it('returns an empty set for a non-repo path rather than throwing', () => {
      const plain = mkdtempSync(join(tmpdir(), 'scns-not-a-repo-'))
      try {
        expect(collectRepoFileTypes(plain).size).toBe(0)
      } finally {
        rmSync(plain, { recursive: true, force: true })
      }
    })

    it('indexes THIS repo as TypeScript-bearing and Python-free (the live case)', () => {
      const types = collectRepoFileTypes(process.cwd())
      expect(types.has('ts')).toBe(true)
      expect(types.has('py')).toBe(false)
    })
  })
})
