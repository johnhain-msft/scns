/**
 * DEFECT (2026-09-21): "Create js linting automation" was proposed for a repo that ALREADY lints
 * JavaScript.
 *
 * `generateAutomationSuggestions` picked the dominant file extension out of `fileTypeCounts` and
 * emitted a linting proposal from that count ALONE. It never looked at the working tree, so with
 * `eslint.config.js` committed at the repo root — plus `lint` / `lint:fix` npm scripts and `eslint`
 * in devDependencies — it still emitted:
 *
 *   "Create js linting automation — File type '.js' changed 4 times. A linting automation could
 *    enforce standards."
 *
 * That proposal was approved and spun up a full implementer/QA team to build a linter that was
 * already on disk. This is the SAME class as the LSP defect fixed in `lsp-servers.ts`
 * (`readConfiguredLspServerIds`): a proposal derived from activity counts with no read-back of the
 * state it proposes to create.
 *
 * The check must be EXTENSION-SCOPED, not a blanket "repo has a linter" mute — an ESLint config
 * says nothing about Python, so a dominant `.py` must still be proposable. And it must FAIL OPEN:
 * an unreadable or malformed config suppresses nothing, because a wasted review is recoverable
 * while a silently-swallowed proposal is invisible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfiguredLintExtensions } from '../../../src/suggest/linter-config.js'
import { createSuggestionGenerator } from '../../../src/suggest/generator.js'
import { createConfidenceScorer } from '../../../src/suggest/confidence.js'
import { createEvidenceGatherer } from '../../../src/suggest/evidence.js'
import type { Suggestion, SuggestionType } from '../../../src/suggest/types.js'
import type { ProjectFocusPattern } from '../../../src/observe/pattern-detector.js'

let repoDir: string

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'scns-lint-configured-'))
})

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const abs = join(repoDir, relPath)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, contents, 'utf8')
}

// ── The read-back primitive ────────────────────────────────────────

describe('readConfiguredLintExtensions', () => {
  it('reports the JS/TS family as covered when an ESLint flat config is present', () => {
    write('eslint.config.js', 'export default []')

    const exts = readConfiguredLintExtensions(repoDir)

    expect(exts.has('js')).toBe(true)
    expect(exts.has('jsx')).toBe(true)
    expect(exts.has('mjs')).toBe(true)
    expect(exts.has('cjs')).toBe(true)
    expect(exts.has('ts')).toBe(true)
    expect(exts.has('tsx')).toBe(true)
  })

  it('does NOT report unrelated languages as covered by an ESLint config', () => {
    write('eslint.config.js', 'export default []')

    const exts = readConfiguredLintExtensions(repoDir)

    expect(exts.has('py')).toBe(false)
    expect(exts.has('go')).toBe(false)
    expect(exts.has('rs')).toBe(false)
  })

  it('recognises a legacy .eslintrc.json config', () => {
    write('.eslintrc.json', '{ "rules": {} }')
    expect(readConfiguredLintExtensions(repoDir).has('js')).toBe(true)
  })

  it('recognises ESLint configured through the package.json eslintConfig key', () => {
    write('package.json', JSON.stringify({ name: 'x', eslintConfig: { rules: {} } }))
    expect(readConfiguredLintExtensions(repoDir).has('js')).toBe(true)
  })

  it('recognises Ruff configured through a [tool.ruff] table in pyproject.toml', () => {
    write('pyproject.toml', '[project]\nname = "x"\n\n[tool.ruff]\nline-length = 100\n')

    const exts = readConfiguredLintExtensions(repoDir)

    expect(exts.has('py')).toBe(true)
    expect(exts.has('js')).toBe(false)
  })

  it('does not treat a pyproject.toml with no linter table as lint coverage', () => {
    write('pyproject.toml', '[project]\nname = "x"\n')
    expect(readConfiguredLintExtensions(repoDir).has('py')).toBe(false)
  })

  it('recognises golangci-lint and RuboCop from their canonical config files', () => {
    write('.golangci.yml', 'linters:\n  enable: [govet]\n')
    write('.rubocop.yml', 'AllCops:\n  NewCops: enable\n')

    const exts = readConfiguredLintExtensions(repoDir)

    expect(exts.has('go')).toBe(true)
    expect(exts.has('rb')).toBe(true)
  })

  it('returns an empty set for a repo with no linter configured at all', () => {
    write('package.json', JSON.stringify({ name: 'x' }))
    expect(readConfiguredLintExtensions(repoDir).size).toBe(0)
  })

  it('returns an empty set for a directory that does not exist (fail-open)', () => {
    expect(readConfiguredLintExtensions(join(repoDir, 'nope', 'missing')).size).toBe(0)
  })

  it('fails open rather than throwing when package.json is malformed JSON', () => {
    write('package.json', '{ this is not json')
    expect(() => readConfiguredLintExtensions(repoDir)).not.toThrow()
    expect(readConfiguredLintExtensions(repoDir).has('js')).toBe(false)
  })
})

// ── Generator wiring: the read-back is inert unless the generator consults it ──

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
    updateStatus(id: string, newStatus: string): Suggestion | null {
      const s = suggestions.get(id)
      if (!s) return null
      const updated = { ...s, status: newStatus, updatedAt: new Date().toISOString() }
      suggestions.set(id, updated)
      return updated
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

/** Only the dominant-file-type lever is populated, so a lint proposal is the ONLY possible output. */
function lintOnlyFocus(ext: string, count: number): ProjectFocusPattern {
  return {
    repoCounts: new Map(),
    topRepos: [],
    fileTypeCounts: new Map([[ext, count]]),
    recentFocus: null,
    repoActivityCounts: new Map(),
  } as ProjectFocusPattern
}

function lintTitlesFor(ext: string, count: number): readonly string[] {
  const gen = createSuggestionGenerator(
    {
      scorer: createConfidenceScorer(),
      evidenceGatherer: createEvidenceGatherer(),
      store: createMockStore(),
    },
    { minimumConfidence: 0, repoDir },
  )
  return gen
    .generateAutomationSuggestions(lintOnlyFocus(ext, count), 7)
    .filter((s) => s.title.toLowerCase().includes('linting automation'))
    .map((s) => s.title)
}

describe('generateAutomationSuggestions — linting proposals respect the repo on disk', () => {
  // POSITIVE CONTROL. Without this the negative case below could pass for the wrong reason
  // (e.g. the suggestion suppressed by confidence, dedup, or a broken fixture).
  it('proposes js linting automation when the repo configures NO linter', () => {
    expect(lintTitlesFor('js', 4)).toEqual(['Create js linting automation'])
  })

  // The exact defect: this is the proposal that spun up a team for work already on disk.
  it('does NOT propose js linting automation when eslint.config.js is already committed', () => {
    write('eslint.config.js', 'export default []')
    expect(lintTitlesFor('js', 4)).toEqual([])
  })

  it('suppresses ts as well, since the same ESLint config covers TypeScript', () => {
    write('eslint.config.js', 'export default []')
    expect(lintTitlesFor('ts', 80)).toEqual([])
  })

  // Extension-scoped, not a blanket mute: ESLint says nothing about Python.
  it('still proposes py linting automation when only ESLint is configured', () => {
    write('eslint.config.js', 'export default []')
    expect(lintTitlesFor('py', 40)).toEqual(['Create py linting automation'])
  })

  it('suppresses py once Ruff is configured in pyproject.toml', () => {
    write('pyproject.toml', '[tool.ruff]\nline-length = 100\n')
    expect(lintTitlesFor('py', 40)).toEqual([])
  })

  it('leaves the non-linting automation levers untouched', () => {
    write('eslint.config.js', 'export default []')
    const gen = createSuggestionGenerator(
      {
        scorer: createConfidenceScorer(),
        evidenceGatherer: createEvidenceGatherer(),
        store: createMockStore(),
      },
      { minimumConfidence: 0, repoDir },
    )
    const focus = {
      repoCounts: new Map([['scns', 30]]),
      topRepos: ['scns'],
      fileTypeCounts: new Map([['js', 4]]),
      recentFocus: 'scns',
      repoActivityCounts: new Map([['scns', 80]]),
    } as ProjectFocusPattern

    const titles = gen.generateAutomationSuggestions(focus, 7).map((s) => s.title)

    expect(titles).toContain('Create build/deploy automation for scns')
    expect(titles).toContain('Create workflow for scns')
    expect(titles.some((t) => t.includes('linting automation'))).toBe(false)
  })
})
