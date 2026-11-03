import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assessOverlap,
  scanExistingCapabilities,
  artifactNameFor,
  capabilitiesFromImplementedSuggestions,
  lspCapabilitiesFromConfig,
  type ExistingCapability,
} from '../../../src/suggest/capability-overlap.js'
import { SuggestionType, type Suggestion } from '../../../src/suggest/types.js'

function suggestion(over: Partial<Suggestion> = {}): Suggestion {
  return {
    id: '2b10b2fa-6b14-46b4-bb64-997b544c275d',
    type: SuggestionType.Extension,
    title: 'Create file-management extension',
    description: 'A file-management extension could streamline edit and create operations.',
    status: 'pending',
    confidence: 0.76,
    evidence: [],
    tags: ['extension', 'file-management'],
    createdAt: '2026-06-03T02:46:00.037Z',
    updatedAt: '2026-06-03T02:46:00.037Z',
    actionable: true,
    estimatedComplexity: 'solo',
    ...(over as object),
  } as Suggestion
}

const existing = (kind: string, name: string): ExistingCapability => ({
  kind,
  name,
  path: `/fake/${kind}/${name}`,
})

describe('artifactNameFor', () => {
  it('extracts the artifact name from a "Create X extension" title', () => {
    expect(artifactNameFor(suggestion())).toBe('file-management')
  })

  it('extracts from a "Create X helper skill" title', () => {
    const s = suggestion({
      type: SuggestionType.Skill,
      title: 'Create FaceTime helper skill',
      tags: ['skill'],
    })
    expect(artifactNameFor(s)).toBe('facetime')
  })

  it('falls back to a non-type tag when the title does not parse', () => {
    const s = suggestion({ title: 'Something unparseable', tags: ['extension', 'code-search'] })
    expect(artifactNameFor(s)).toBe('code-search')
  })
})

describe('assessOverlap — deterministic artifact scan', () => {
  it('flags an exact same-kind artifact-name match as a duplicate', () => {
    const r = assessOverlap(suggestion(), [existing('extension', 'file-management')])
    expect(r.verdict).toBe('duplicate')
    expect(r.duplicates.map((d) => d.name)).toContain('file-management')
  })

  it('normalizes separators and case when matching', () => {
    const r = assessOverlap(suggestion(), [existing('extension', 'File Management')])
    expect(r.verdict).toBe('duplicate')
  })

  // The load-bearing test. A disk scan can only see ARTIFACTS. It cannot see that the host
  // tool already edits files natively — which is the exact reason the file-management
  // proposal was unreviewable. "No artifact match" must therefore NEVER mean "novel".
  it('returns INCONCLUSIVE (not novel) when no artifact matches', () => {
    const r = assessOverlap(suggestion(), [existing('extension', 'code-search')])
    expect(r.verdict).toBe('inconclusive')
    expect(r.verdict).not.toBe('novel')
  })

  it('does not treat a same-named artifact of a different kind as a duplicate', () => {
    const r = assessOverlap(suggestion(), [existing('skill', 'file-management')])
    expect(r.verdict).toBe('inconclusive')
    expect(r.duplicates).toHaveLength(0)
  })

  it('returns inconclusive when nothing exists at all', () => {
    const r = assessOverlap(suggestion(), [])
    expect(r.verdict).toBe('inconclusive')
  })

  it('carries the considered set so the neutral LLM question is built from real data', () => {
    const all = [existing('extension', 'code-search'), existing('skill', 'commit')]
    const r = assessOverlap(suggestion(), all)
    expect(r.considered).toHaveLength(2)
  })

  it('states which capability the duplicate collides with, for the machine reason', () => {
    const r = assessOverlap(suggestion(), [existing('extension', 'file-management')])
    expect(r.reason).toContain('file-management')
  })
})

describe('scanExistingCapabilities', () => {
  it('finds artifacts on disk and labels them with their kind', () => {
    const root = mkdtempSync(join(tmpdir(), 'scns-cap-'))
    try {
      const skills = join(root, 'skills')
      mkdirSync(join(skills, 'commit'), { recursive: true })
      writeFileSync(join(skills, 'commit', 'SKILL.md'), '# commit')
      const exts = join(root, 'extensions')
      mkdirSync(exts, { recursive: true })
      writeFileSync(join(exts, 'code-search.md'), '# code-search')

      const found = scanExistingCapabilities([
        { kind: 'skill', dir: skills },
        { kind: 'extension', dir: exts },
      ])

      expect(found.map((f) => `${f.kind}:${f.name}`).sort()).toEqual([
        'extension:code-search',
        'skill:commit',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores directories that do not exist instead of throwing', () => {
    expect(() => scanExistingCapabilities([{ kind: 'skill', dir: '/no/such/dir' }])).not.toThrow()
    expect(scanExistingCapabilities([{ kind: 'skill', dir: '/no/such/dir' }])).toEqual([])
  })
})

describe('capabilitiesFromImplementedSuggestions — the system consults its own history', () => {
  it('turns an implemented lsp twin into a capability that collides with its re-proposal', () => {
    // The live case this closes: lsp ca64e7a1 (2026-09-14) duplicated 73e80eb6
    // (implemented 2026-04-17). The TypeScript server entry lives INSIDE
    // lsp-config.json, so the directory scan saw nothing and the twin surfaced
    // as "novelty unverified" — John approved already-done work and the doomed
    // implementation attempts burned a full retry budget.
    const implemented = suggestion({
      id: '73e80eb6-42c3-468f-a5f7-40b6b6951097',
      type: SuggestionType.Lsp,
      title: 'Configure TypeScript LSP (TypeScript Language Server)',
      tags: ['lsp', 'typescript'],
      status: 'implemented',
    })
    const reproposal = suggestion({
      id: 'ca64e7a1-94c7-4f39-8518-668781982ed7',
      type: SuggestionType.Lsp,
      title: 'Configure TypeScript LSP (typescript-language-server)',
      tags: ['lsp', 'typescript', 'codebase-improvement'],
    })

    const history = capabilitiesFromImplementedSuggestions([implemented])
    expect(history).toHaveLength(1)
    expect(history[0]!.kind).toBe('lsp')
    expect(history[0]!.name).toBe('typescript')

    const verdict = assessOverlap(reproposal, history)
    expect(verdict.verdict).toBe('duplicate')
    expect(verdict.reason).toContain('73e80eb6')
  })

  it('does not collide across kinds: an implemented lsp twin never blocks a skill proposal', () => {
    const implemented = suggestion({
      type: SuggestionType.Lsp,
      title: 'Configure TypeScript LSP',
      tags: ['lsp', 'typescript'],
      status: 'implemented',
    })
    const skillProposal = suggestion({
      type: SuggestionType.Skill,
      title: 'Create typescript skill',
      tags: ['skill', 'typescript'],
    })
    const verdict = assessOverlap(
      skillProposal,
      capabilitiesFromImplementedSuggestions([implemented]),
    )
    expect(verdict.verdict).toBe('inconclusive')
  })
})

describe('lspCapabilitiesFromConfig — entries inside lsp-config.json are capabilities', () => {
  it('yields one lsp capability per registered server key', () => {
    const root = mkdtempSync(join(tmpdir(), 'overlap-lspcfg-'))
    try {
      const cfg = join(root, 'lsp-config.json')
      writeFileSync(
        cfg,
        JSON.stringify({
          lspServers: {
            python: { command: 'pyright-langserver' },
            typescript: { command: 'typescript-language-server' },
          },
        }),
      )
      const caps = lspCapabilitiesFromConfig(cfg)
      expect(caps.map((c) => `${c.kind}:${c.name}`).sort()).toEqual([
        'lsp:python',
        'lsp:typescript',
      ])
      expect(caps[0]!.path).toBe(cfg)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a registered server makes the matching lsp proposal a duplicate', () => {
    const root = mkdtempSync(join(tmpdir(), 'overlap-lspcfg-'))
    try {
      const cfg = join(root, 'lsp-config.json')
      writeFileSync(cfg, JSON.stringify({ lspServers: { typescript: {} } }))
      const proposal = suggestion({
        type: SuggestionType.Lsp,
        title: 'Configure TypeScript LSP (typescript-language-server)',
        tags: ['lsp', 'typescript'],
      })
      const verdict = assessOverlap(proposal, lspCapabilitiesFromConfig(cfg))
      expect(verdict.verdict).toBe('duplicate')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('missing or malformed config yields no capabilities — absence of evidence only', () => {
    expect(lspCapabilitiesFromConfig('/no/such/lsp-config.json')).toEqual([])
    const root = mkdtempSync(join(tmpdir(), 'overlap-lspcfg-'))
    try {
      const cfg = join(root, 'lsp-config.json')
      writeFileSync(cfg, '{not json')
      expect(lspCapabilitiesFromConfig(cfg)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
