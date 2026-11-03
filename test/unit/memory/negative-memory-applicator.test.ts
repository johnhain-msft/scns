/**
 * Tests for negative memory applicator — applies learned "don't do this"
 * rules to .github/copilot-instructions.md as a managed block.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { createVault } from '../../../src/memory/vault.js'
import {
  applyNegativeMemories,
  buildManagedBlock,
  extractManagedBlock,
  BLOCK_START,
  BLOCK_END,
} from '../../../src/memory/negative-memory-applicator.js'

describe('negative-memory-applicator', () => {
  let tmpDir: string
  let vaultDir: string
  let projectDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'neg-apply-test-'))
    vaultDir = join(tmpDir, 'vault')
    projectDir = join(tmpDir, 'project')
    mkdirSync(vaultDir, { recursive: true })
    mkdirSync(join(projectDir, '.github'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedMemory(
    vault: ReturnType<typeof createVault>,
    overrides: {
      id?: string
      dontRule?: string
      confidence?: number
      target?: string
      targetApplied?: boolean
    } = {},
  ) {
    const id = overrides.id ?? `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const confidence = overrides.confidence ?? 0.9
    const target = overrides.target ?? 'general'
    const applied = overrides.targetApplied ?? false
    const rule = overrides.dontRule ?? 'Do not mock the thing being tested'

    const content = `---
id: ${id}
dontRule: ${rule}
category: frustration
target: ${target}
confidence: ${confidence}
source: heuristic
targetApplied: ${applied}
createdAt: 2026-01-01T00:00:00.000Z
---
Original feedback text`

    vault.write(`negative/${id}.md`, content)
    return id
  }

  describe('buildManagedBlock', () => {
    it('generates a fenced block with dont rules', () => {
      const block = buildManagedBlock([
        'Do not claim functionality works without live verification',
        'Never skip manual testing before declaring done',
      ])
      expect(block).toContain(BLOCK_START)
      expect(block).toContain(BLOCK_END)
      expect(block).toContain('- Do not claim functionality works without live verification')
      expect(block).toContain('- Never skip manual testing before declaring done')
    })

    it('returns empty string for empty rules', () => {
      expect(buildManagedBlock([])).toBe('')
    })

    it('deduplicates identical rules', () => {
      const block = buildManagedBlock([
        'Do not mock the thing being tested',
        'Do not mock the thing being tested',
      ])
      const lines = block.split('\n').filter((l) => l.startsWith('- '))
      expect(lines).toHaveLength(1)
    })
  })

  describe('extractManagedBlock', () => {
    it('extracts existing managed block from file content', () => {
      const content = `# Instructions

Some existing content.

${BLOCK_START}
## Things to AVOID (learned from experience)

- Do not do X
${BLOCK_END}

More content below.`
      const result = extractManagedBlock(content)
      expect(result.before).toBe('# Instructions\n\nSome existing content.\n\n')
      expect(result.block).toContain('Do not do X')
      expect(result.after).toBe('\n\nMore content below.')
    })

    it('returns full content as "before" when no block exists', () => {
      const content = '# Instructions\n\nSome content.'
      const result = extractManagedBlock(content)
      expect(result.before).toBe(content)
      expect(result.block).toBe('')
      expect(result.after).toBe('')
    })

    it('handles file with only the managed block', () => {
      const block = buildManagedBlock(['Do not X'])
      const result = extractManagedBlock(block)
      expect(result.before).toBe('')
      expect(result.block).toContain('Do not X')
      expect(result.after).toBe('')
    })
  })

  describe('applyNegativeMemories', () => {
    it('creates copilot-instructions.md if it does not exist', () => {
      const vault = createVault({ rootDir: vaultDir })
      seedMemory(vault, { id: 'mem-1', dontRule: 'Do not skip manual tests' })

      const result = applyNegativeMemories({
        vault,
        projectRoot: projectDir,
        minConfidence: 0.7,
        allowUnjudged: true,
      })

      expect(result.appliedCount).toBe(1)
      expect(result.skippedCount).toBe(0)

      const filePath = join(projectDir, '.github', 'copilot-instructions.md')
      expect(existsSync(filePath)).toBe(true)
      const content = readFileSync(filePath, 'utf-8')
      expect(content).toContain('Do not skip manual tests')
      expect(content).toContain(BLOCK_START)
      expect(content).toContain(BLOCK_END)
    })

    it('appends managed block to existing file preserving content', () => {
      const existingContent = '# Project Instructions\n\nUse TypeScript strict mode.\n'
      writeFileSync(join(projectDir, '.github', 'copilot-instructions.md'), existingContent)

      const vault = createVault({ rootDir: vaultDir })
      seedMemory(vault, { id: 'mem-2', dontRule: 'Never use console.log' })

      applyNegativeMemories({
        vault,
        projectRoot: projectDir,
        minConfidence: 0.7,
        allowUnjudged: true,
      })

      const content = readFileSync(join(projectDir, '.github', 'copilot-instructions.md'), 'utf-8')
      expect(content).toContain('# Project Instructions')
      expect(content).toContain('Use TypeScript strict mode.')
      expect(content).toContain('Never use console.log')
    })

    it('replaces existing managed block on re-run (idempotent)', () => {
      const vault = createVault({ rootDir: vaultDir })
      seedMemory(vault, { id: 'mem-3', dontRule: 'Do not X' })

      // First run
      applyNegativeMemories({
        vault,
        projectRoot: projectDir,
        minConfidence: 0.7,
        allowUnjudged: true,
      })

      // Add another memory
      seedMemory(vault, { id: 'mem-4', dontRule: 'Do not Y' })

      // Second run — should regenerate entire block
      const result = applyNegativeMemories({
        vault,
        projectRoot: projectDir,
        minConfidence: 0.7,
        allowUnjudged: true,
      })
      expect(result.appliedCount).toBe(2)

      const content = readFileSync(join(projectDir, '.github', 'copilot-instructions.md'), 'utf-8')
      expect(content).toContain('Do not X')
      expect(content).toContain('Do not Y')

      // Should only have ONE managed block (not two)
      const startCount = (
        content.match(new RegExp(BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []
      ).length
      expect(startCount).toBe(1)
    })

    it('filters out low-confidence memories', () => {
      const vault = createVault({ rootDir: vaultDir })
      seedMemory(vault, { id: 'high-conf', dontRule: 'Do not X', confidence: 0.9 })
      seedMemory(vault, { id: 'low-conf', dontRule: 'Maybe not Y', confidence: 0.5 })

      const result = applyNegativeMemories({
        vault,
        projectRoot: projectDir,
        minConfidence: 0.7,
        allowUnjudged: true,
      })
      expect(result.appliedCount).toBe(1)
      expect(result.skippedCount).toBe(1)

      const content = readFileSync(join(projectDir, '.github', 'copilot-instructions.md'), 'utf-8')
      expect(content).toContain('Do not X')
      expect(content).not.toContain('Maybe not Y')
    })

    it('marks vault files as applied with appliedTo path', () => {
      const vault = createVault({ rootDir: vaultDir })
      const memId = seedMemory(vault, { id: 'apply-mark', dontRule: 'Do not Z' })

      applyNegativeMemories({
        vault,
        projectRoot: projectDir,
        minConfidence: 0.7,
        allowUnjudged: true,
      })

      // Re-read the vault file
      const file = vault.read(`negative/${memId}.md`)
      expect(file).not.toBeNull()
      expect(file!.content).toContain('targetApplied: true')
      expect(file!.content).toContain('appliedTo: .github/copilot-instructions.md')
    })

    it('handles all target types mapping to copilot-instructions.md', () => {
      const vault = createVault({ rootDir: vaultDir })
      seedMemory(vault, { id: 't1', dontRule: 'Rule from instructions', target: 'instructions' })
      seedMemory(vault, {
        id: 't2',
        dontRule: 'Rule from custom-instruction',
        target: 'custom-instruction',
      })
      seedMemory(vault, { id: 't3', dontRule: 'Rule from general', target: 'general' })
      seedMemory(vault, {
        id: 't4',
        dontRule: 'Rule from agent-profile',
        target: 'agent-profile',
      })

      const result = applyNegativeMemories({
        vault,
        projectRoot: projectDir,
        minConfidence: 0.7,
        allowUnjudged: true,
      })
      expect(result.appliedCount).toBe(4)

      const content = readFileSync(join(projectDir, '.github', 'copilot-instructions.md'), 'utf-8')
      expect(content).toContain('Rule from instructions')
      expect(content).toContain('Rule from custom-instruction')
      expect(content).toContain('Rule from general')
      expect(content).toContain('Rule from agent-profile')
    })

    it('returns zero counts when no memories exist', () => {
      const vault = createVault({ rootDir: vaultDir })
      const result = applyNegativeMemories({
        vault,
        projectRoot: projectDir,
        minConfidence: 0.7,
        allowUnjudged: true,
      })
      expect(result.appliedCount).toBe(0)
      expect(result.skippedCount).toBe(0)
    })

    it('does not write file when no eligible memories', () => {
      const vault = createVault({ rootDir: vaultDir })
      seedMemory(vault, { id: 'low-only', dontRule: 'Low confidence', confidence: 0.3 })

      applyNegativeMemories({
        vault,
        projectRoot: projectDir,
        minConfidence: 0.7,
        allowUnjudged: true,
      })

      const filePath = join(projectDir, '.github', 'copilot-instructions.md')
      expect(existsSync(filePath)).toBe(false)
    })

    it('preserves content after the managed block', () => {
      const before = '# Instructions\n\nAbove.\n'
      const after = '\n\n## Other Section\n\nBelow content.'
      const existingContent = `${before}${BLOCK_START}\n## Things to AVOID (learned from experience)\n\n- Old rule\n${BLOCK_END}${after}`
      writeFileSync(join(projectDir, '.github', 'copilot-instructions.md'), existingContent)

      const vault = createVault({ rootDir: vaultDir })
      seedMemory(vault, { id: 'new-rule', dontRule: 'New rule' })

      applyNegativeMemories({
        vault,
        projectRoot: projectDir,
        minConfidence: 0.7,
        allowUnjudged: true,
      })

      const content = readFileSync(join(projectDir, '.github', 'copilot-instructions.md'), 'utf-8')
      expect(content).toContain('# Instructions')
      expect(content).toContain('Above.')
      expect(content).toContain('New rule')
      expect(content).toContain('## Other Section')
      expect(content).toContain('Below content.')
      expect(content).not.toContain('Old rule')
    })

    it('does not double-apply already-applied memories when block is regenerated', () => {
      const vault = createVault({ rootDir: vaultDir })
      seedMemory(vault, { id: 'already', dontRule: 'Already applied', targetApplied: true })
      seedMemory(vault, { id: 'new-one', dontRule: 'New one', targetApplied: false })

      const result = applyNegativeMemories({
        vault,
        projectRoot: projectDir,
        minConfidence: 0.7,
        allowUnjudged: true,
      })
      // Both should be in the block (full regeneration includes all eligible)
      expect(result.appliedCount).toBe(2)

      const content = readFileSync(join(projectDir, '.github', 'copilot-instructions.md'), 'utf-8')
      expect(content).toContain('Already applied')
      expect(content).toContain('New one')
    })
  })
})
