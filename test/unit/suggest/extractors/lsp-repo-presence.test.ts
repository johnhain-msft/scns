/**
 * LSP REPO PRESENCE — the same defect class as the `py linting automation` bug, one extractor over.
 *
 * `extractLspSuggestions` sums `observations.fileTypeCounts` to decide which language servers to
 * propose. That histogram is GLOBAL: `pattern-detector.ts` folds every file observation from every
 * watched directory into one map with no repo scoping. The resulting suggestion, though, is
 * dispatched against ONE working directory — and an LSP suggestion is *executable*, so a false
 * positive does not merely read badly, it installs and registers a language server (`pylsp`) for a
 * language the target repo does not contain.
 *
 * This is the identical root cause behind "Create py linting automation — File type '.py' changed
 * 2753 times" aimed at the scns repo (zero tracked `.py` files). The lint half is gated by
 * `GeneratorOptions.repoFileTypes`; these tests pin the LSP half.
 *
 * Note the extension-format trap: `LSP_SERVERS.fileExtensions` keys are DOTTED (`.py`), while
 * `collectRepoFileTypes` returns UNDOTTED (`py`). A presence check that forgets to normalize would
 * silently never match and veto every language — so the positive controls below are load-bearing,
 * not decoration.
 */
import { describe, it, expect } from 'vitest'
import { extractLspSuggestions } from '../../../../src/suggest/extractors/lsp-extractor.js'
import type {
  PatternSources,
  ObservationPatternData,
} from '../../../../src/suggest/extractors/types.js'

function makeObs(overrides: Partial<ObservationPatternData> = {}): ObservationPatternData {
  return {
    topApps: [],
    appCounts: new Map(),
    topRepos: [],
    repoCounts: new Map(),
    fileTypeCounts: new Map(),
    recentFocus: null,
    ...overrides,
  }
}

function sources(
  fileTypeCounts: ReadonlyMap<string, number>,
  repoFileTypes?: ReadonlySet<string>,
): PatternSources {
  return {
    observations: makeObs({ fileTypeCounts }),
    ...(repoFileTypes ? { repoFileTypes } : {}),
  }
}

const languagesOf = (result: readonly { tags: readonly string[] }[]): readonly string[] =>
  result.flatMap((c) => c.tags.filter((t) => t !== 'lsp' && t !== 'codebase-improvement'))

describe('LSP suggestions require the language to exist in the target repo', () => {
  describe('the reported defect', () => {
    it('does NOT propose a Python LSP for a repo containing no Python', () => {
      // The observed global histogram: .py dominant, earned in some other watched project.
      const result = extractLspSuggestions(
        sources(new Map([['.py', 2753]]), new Set(['ts', 'json', 'md'])),
      )

      expect(languagesOf(result)).not.toContain('python')
      expect(result).toEqual([])
    })

    it('proposes only the languages the repo actually has, not every active one', () => {
      // Both clear MIN_FILE_CHANGES globally; only TypeScript is present in this repo.
      const result = extractLspSuggestions(
        sources(
          new Map([
            ['.py', 2753],
            ['.ts', 400],
          ]),
          new Set(['ts']),
        ),
      )

      expect(languagesOf(result)).toContain('typescript')
      expect(languagesOf(result)).not.toContain('python')
    })
  })

  describe('positive controls — the feature still works when it is true', () => {
    it('DOES propose a Python LSP for a repo that genuinely is Python', () => {
      const result = extractLspSuggestions(sources(new Map([['.py', 2753]]), new Set(['py'])))

      expect(languagesOf(result)).toContain('python')
    })

    it('matches on any one of a language\u2019s extensions, not just the first', () => {
      // Python's registry entry covers .py/.pyi/.pyw — a repo of stubs is still Python.
      const result = extractLspSuggestions(sources(new Map([['.py', 2753]]), new Set(['pyi'])))

      expect(languagesOf(result)).toContain('python')
    })

    it('DOES propose a TypeScript LSP for a TypeScript repo', () => {
      const result = extractLspSuggestions(
        sources(new Map([['.ts', 500]]), new Set(['ts', 'json'])),
      )

      expect(languagesOf(result)).toContain('typescript')
    })
  })

  describe('back-compat — no presence index available', () => {
    it('emits as before when repoFileTypes is absent (no index \u21d2 no veto)', () => {
      const result = extractLspSuggestions(sources(new Map([['.py', 2753]])))

      expect(languagesOf(result)).toContain('python')
    })

    it('emits as before when the index is empty (failed to read \u21d2 no veto)', () => {
      const result = extractLspSuggestions(sources(new Map([['.py', 2753]]), new Set()))

      expect(languagesOf(result)).toContain('python')
    })
  })
})
