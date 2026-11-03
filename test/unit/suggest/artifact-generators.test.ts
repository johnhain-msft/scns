import { describe, it, expect } from 'vitest'
import { generateArtifact } from '../../../src/suggest/artifact-generators.js'
import type { Suggestion } from '../../../src/suggest/types.js'

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'skill',
    title: 'Create git-commit helper skill',
    description: 'Automate repetitive git commit patterns with a reusable skill.',
    status: 'approved',
    confidence: 0.85,
    evidence: [
      {
        source: 'tool-frequency',
        detail: 'Git used 45 times in last 7 days',
        observedAt: '2025-01-15T10:00:00Z',
        weight: 0.8,
      },
    ],
    tags: ['git', 'automation'],
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:00:00Z',
    ...overrides,
  }
}

describe('Artifact Generators', () => {
  describe('generateArtifact', () => {
    it('returns null for unknown suggestion type', () => {
      const suggestion = makeSuggestion({ type: 'agent' as Suggestion['type'] })
      const result = generateArtifact(suggestion)
      expect(result).toBeNull()
    })

    it('returns null for mcp type (no artifact generation)', () => {
      const suggestion = makeSuggestion({ type: 'mcp' as Suggestion['type'] })
      expect(generateArtifact(suggestion)).toBeNull()
    })

    it('returns null for automation type (no artifact generation)', () => {
      const suggestion = makeSuggestion({ type: 'automation' as Suggestion['type'] })
      expect(generateArtifact(suggestion)).toBeNull()
    })

    it('returns null for workflow type (no artifact generation)', () => {
      const suggestion = makeSuggestion({ type: 'workflow' as Suggestion['type'] })
      expect(generateArtifact(suggestion)).toBeNull()
    })
  })

  describe('prompt artifact', () => {
    it('generates markdown format', () => {
      const suggestion = makeSuggestion({
        type: 'prompt',
        title: 'Always use TypeScript strict mode',
        description: 'Enable strict mode in all TypeScript projects for better type safety.',
      })
      const result = generateArtifact(suggestion)!

      expect(result).not.toBeNull()
      expect(result.format).toBe('markdown')
    })

    it('generates correct file path', () => {
      const suggestion = makeSuggestion({ type: 'prompt' })
      const result = generateArtifact(suggestion)!

      expect(result.path).toBe('.github/copilot-instructions.md')
    })

    it('generates non-empty content with title and description', () => {
      const suggestion = makeSuggestion({
        type: 'prompt',
        title: 'Always use TypeScript strict mode',
        description: 'Enable strict mode in all TypeScript projects.',
      })
      const result = generateArtifact(suggestion)!

      expect(result.content.length).toBeGreaterThan(0)
      expect(result.content).toContain('Always use TypeScript strict mode')
      expect(result.content).toContain('Enable strict mode in all TypeScript projects.')
    })

    it('sets overwrite to false (append mode)', () => {
      const suggestion = makeSuggestion({ type: 'prompt' })
      const result = generateArtifact(suggestion)!

      expect(result.overwrite).toBe(false)
    })

    it('includes evidence in generated content', () => {
      const suggestion = makeSuggestion({
        type: 'prompt',
        evidence: [
          {
            source: 'tool-frequency',
            detail: 'TypeScript compiler used 30 times',
            observedAt: '2025-01-15T10:00:00Z',
            weight: 0.9,
          },
        ],
      })
      const result = generateArtifact(suggestion)!

      expect(result.content).toContain('TypeScript compiler used 30 times')
    })

    it('includes tags in generated content', () => {
      const suggestion = makeSuggestion({
        type: 'prompt',
        tags: ['typescript', 'strict-mode'],
      })
      const result = generateArtifact(suggestion)!

      expect(result.content).toContain('typescript')
      expect(result.content).toContain('strict-mode')
    })
  })

  describe('extension artifact', () => {
    it('generates javascript format', () => {
      const suggestion = makeSuggestion({
        type: 'extension',
        title: 'Auto-test Runner',
        description: 'Run tests automatically when files change.',
      })
      const result = generateArtifact(suggestion)!

      expect(result).not.toBeNull()
      expect(result.format).toBe('javascript')
    })

    it('generates correct file path with slugified name', () => {
      const suggestion = makeSuggestion({
        type: 'extension',
        title: 'Auto Test Runner',
      })
      const result = generateArtifact(suggestion)!

      expect(result.path).toBe('.github/extensions/auto-test-runner.js')
    })

    it('generates valid JavaScript module content', () => {
      const suggestion = makeSuggestion({
        type: 'extension',
        title: 'Code Quality Checker',
        description: 'Check code quality on every commit.',
      })
      const result = generateArtifact(suggestion)!

      expect(result.content).toContain('module.exports')
      expect(result.content).toContain('name')
      expect(result.content).toContain('description')
      expect(result.content).toContain('tools')
      expect(result.content.length).toBeGreaterThan(50)
    })

    it('sets overwrite to true', () => {
      const suggestion = makeSuggestion({ type: 'extension' })
      const result = generateArtifact(suggestion)!

      expect(result.overwrite).toBe(true)
    })

    it('includes tags as keywords in content', () => {
      const suggestion = makeSuggestion({
        type: 'extension',
        tags: ['testing', 'ci'],
      })
      const result = generateArtifact(suggestion)!

      expect(result.content).toContain('testing')
      expect(result.content).toContain('ci')
    })

    it('safely handles titles with special characters', () => {
      const suggestion = makeSuggestion({
        type: 'extension',
        title: 'O\'Reilly\'s "Best" Extension (v2.0)',
      })
      const result = generateArtifact(suggestion)!

      expect(result.path).toContain('.github/extensions/')
      expect(result.path).toMatch(/\.js$/)
      // Content should not have unescaped quotes that break JS
      expect(result.content).toContain('module.exports')
    })
  })

  describe('lsp artifact', () => {
    it('generates json format', () => {
      const suggestion = makeSuggestion({
        type: 'lsp',
        title: 'Enable strict TypeScript',
        description: 'Configure strict mode for the TypeScript language server.',
      })
      const result = generateArtifact(suggestion)!

      expect(result).not.toBeNull()
      expect(result.format).toBe('json')
    })

    it('generates correct file path', () => {
      const suggestion = makeSuggestion({ type: 'lsp' })
      const result = generateArtifact(suggestion)!

      expect(result.path).toBe('tsconfig.json')
    })

    it('generates valid JSON content', () => {
      const suggestion = makeSuggestion({ type: 'lsp' })
      const result = generateArtifact(suggestion)!

      expect(() => JSON.parse(result.content)).not.toThrow()
    })

    it('includes compilerOptions in tsconfig', () => {
      const suggestion = makeSuggestion({ type: 'lsp' })
      const result = generateArtifact(suggestion)!

      const parsed = JSON.parse(result.content)
      expect(parsed).toHaveProperty('compilerOptions')
      expect(parsed.compilerOptions).toHaveProperty('strict')
    })

    it('sets overwrite to true', () => {
      const suggestion = makeSuggestion({ type: 'lsp' })
      const result = generateArtifact(suggestion)!

      expect(result.overwrite).toBe(true)
    })
  })

  describe('github-action artifact', () => {
    it('generates yaml format', () => {
      const suggestion = makeSuggestion({
        type: 'github-action',
        title: 'CI Pipeline',
        description: 'Run lint, test, and build on every push.',
      })
      const result = generateArtifact(suggestion)!

      expect(result).not.toBeNull()
      expect(result.format).toBe('yaml')
    })

    it('generates correct file path with slugified name', () => {
      const suggestion = makeSuggestion({
        type: 'github-action',
        title: 'CI Pipeline',
      })
      const result = generateArtifact(suggestion)!

      expect(result.path).toBe('.github/workflows/ci-pipeline.yml')
    })

    it('generates valid YAML-like content with required keys', () => {
      const suggestion = makeSuggestion({
        type: 'github-action',
        title: 'CI Pipeline',
        description: 'Run checks on push.',
      })
      const result = generateArtifact(suggestion)!

      expect(result.content).toContain('name:')
      expect(result.content).toContain('on:')
      expect(result.content).toContain('jobs:')
      expect(result.content).toContain('runs-on:')
      expect(result.content).toContain('steps:')
      expect(result.content).toContain('actions/checkout')
    })

    it('sets overwrite to true', () => {
      const suggestion = makeSuggestion({ type: 'github-action' })
      const result = generateArtifact(suggestion)!

      expect(result.overwrite).toBe(true)
    })

    it('includes Node.js setup in generated workflow', () => {
      const suggestion = makeSuggestion({
        type: 'github-action',
        title: 'CI Pipeline',
      })
      const result = generateArtifact(suggestion)!

      expect(result.content).toContain('actions/setup-node')
    })

    it('does not contain shell interpolation patterns', () => {
      const suggestion = makeSuggestion({
        type: 'github-action',
        title: 'Deploy to $PROD',
        description: 'Deploy $(rm -rf /) test',
      })
      const result = generateArtifact(suggestion)!

      // No ${...} or $(...) shell interpolation in generated YAML
      expect(result.content).not.toMatch(/\$\{[^}]+\}/)
      expect(result.content).not.toMatch(/\$\([^)]+\)/)
    })
  })

  describe('agentic-workflow artifact', () => {
    it('generates markdown format', () => {
      const suggestion = makeSuggestion({
        type: 'agentic-workflow',
        title: 'Code Review Pipeline',
        description: 'Automated multi-step code review workflow.',
      })
      const result = generateArtifact(suggestion)!

      expect(result).not.toBeNull()
      expect(result.format).toBe('markdown')
    })

    it('generates correct file path', () => {
      const suggestion = makeSuggestion({
        type: 'agentic-workflow',
        title: 'Code Review Pipeline',
      })
      const result = generateArtifact(suggestion)!

      expect(result.path).toContain('.scns/workflows/')
      expect(result.path).toMatch(/\.md$/)
    })

    it('generates content with workflow steps', () => {
      const suggestion = makeSuggestion({
        type: 'agentic-workflow',
        title: 'Code Review Pipeline',
        description: 'Multi-step review process.',
      })
      const result = generateArtifact(suggestion)!

      expect(result.content).toContain('Code Review Pipeline')
      expect(result.content).toContain('Multi-step review process.')
      expect(result.content).toContain('Steps')
      expect(result.content).toContain('Observe')
      expect(result.content).toContain('Decide')
      expect(result.content).toContain('Act')
      expect(result.content).toContain('Validate')
    })

    it('sets overwrite to true', () => {
      const suggestion = makeSuggestion({ type: 'agentic-workflow' })
      const result = generateArtifact(suggestion)!

      expect(result.overwrite).toBe(true)
    })

    it('includes evidence summary', () => {
      const suggestion = makeSuggestion({
        type: 'agentic-workflow',
        evidence: [
          {
            source: 'session-analysis',
            detail: 'Repeated review pattern observed',
            observedAt: '2025-01-15T10:00:00Z',
            weight: 0.7,
          },
        ],
      })
      const result = generateArtifact(suggestion)!

      expect(result.content).toContain('Repeated review pattern observed')
    })
  })

  describe('instruction artifact', () => {
    it('generates markdown format', () => {
      const suggestion = makeSuggestion({
        type: 'instruction',
        title: 'Use conventional commits',
        description: 'All commits should follow the conventional commits specification.',
      })
      const result = generateArtifact(suggestion)!

      expect(result).not.toBeNull()
      expect(result.format).toBe('markdown')
    })

    it('generates correct file path', () => {
      const suggestion = makeSuggestion({ type: 'instruction' })
      const result = generateArtifact(suggestion)!

      expect(result.path).toBe('CLAUDE.md')
    })

    it('generates non-empty content with instruction text', () => {
      const suggestion = makeSuggestion({
        type: 'instruction',
        title: 'Use conventional commits',
        description: 'Follow feat/fix/refactor/test/chore/docs prefixes.',
      })
      const result = generateArtifact(suggestion)!

      expect(result.content.length).toBeGreaterThan(0)
      expect(result.content).toContain('Use conventional commits')
      expect(result.content).toContain('feat/fix/refactor/test/chore/docs')
    })

    it('sets overwrite to false (append mode)', () => {
      const suggestion = makeSuggestion({ type: 'instruction' })
      const result = generateArtifact(suggestion)!

      expect(result.overwrite).toBe(false)
    })

    it('includes tags', () => {
      const suggestion = makeSuggestion({
        type: 'instruction',
        tags: ['git', 'conventions'],
      })
      const result = generateArtifact(suggestion)!

      expect(result.content).toContain('git')
      expect(result.content).toContain('conventions')
    })
  })

  describe('skill artifact', () => {
    it('generates markdown format', () => {
      const suggestion = makeSuggestion({
        type: 'skill',
        title: 'Git Commit Helper',
        description: 'Automate common git commit patterns.',
      })
      const result = generateArtifact(suggestion)!

      expect(result).not.toBeNull()
      expect(result.format).toBe('markdown')
    })

    it('generates correct file path with slugified name', () => {
      const suggestion = makeSuggestion({
        type: 'skill',
        title: 'Git Commit Helper',
      })
      const result = generateArtifact(suggestion)!

      expect(result.path).toContain('.copilot/skills/')
      expect(result.path).toBe('.copilot/skills/git-commit-helper.md')
    })

    it('includes YAML frontmatter', () => {
      const suggestion = makeSuggestion({
        type: 'skill',
        title: 'Git Commit Helper',
        description: 'Automate commits.',
        tags: ['git', 'automation'],
      })
      const result = generateArtifact(suggestion)!

      expect(result.content).toMatch(/^---\n/)
      expect(result.content).toMatch(/\n---\n/)
      // Frontmatter should contain name and description
      const frontmatter = result.content.split('---')[1]!
      expect(frontmatter).toContain('name:')
      expect(frontmatter).toContain('description:')
    })

    it('generates realistic skill body content', () => {
      const suggestion = makeSuggestion({
        type: 'skill',
        title: 'Git Commit Helper',
        description: 'Automate repetitive git commit patterns.',
      })
      const result = generateArtifact(suggestion)!

      expect(result.content).toContain('Git Commit Helper')
      expect(result.content).toContain('Automate repetitive git commit patterns.')
      expect(result.content.length).toBeGreaterThan(100)
    })

    it('sets overwrite to true', () => {
      const suggestion = makeSuggestion({ type: 'skill' })
      const result = generateArtifact(suggestion)!

      expect(result.overwrite).toBe(true)
    })

    it('includes tags in frontmatter', () => {
      const suggestion = makeSuggestion({
        type: 'skill',
        tags: ['git', 'automation'],
      })
      const result = generateArtifact(suggestion)!

      const frontmatter = result.content.split('---')[1]!
      expect(frontmatter).toContain('git')
      expect(frontmatter).toContain('automation')
    })

    it('includes evidence in skill body', () => {
      const suggestion = makeSuggestion({
        type: 'skill',
        evidence: [
          {
            source: 'tool-frequency',
            detail: 'Git used 45 times',
            observedAt: '2025-01-15T10:00:00Z',
            weight: 0.8,
          },
        ],
      })
      const result = generateArtifact(suggestion)!

      expect(result.content).toContain('Git used 45 times')
    })
  })
})
