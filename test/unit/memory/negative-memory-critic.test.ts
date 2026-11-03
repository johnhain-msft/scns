/**
 * Integration test for the critic orchestrator + applicator filter.
 *
 * Ensures pipeline-artifact memories are suppressed by the heuristic
 * prefilter and never reach .github/copilot-instructions.md.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createVault } from '../../../src/memory/vault.js'
import { createNegativeMemoryStore } from '../../../src/memory/negative-memory-store.js'
import { runNegativeMemoryCritic } from '../../../src/memory/negative-memory-critic.js'
import { applyNegativeMemories } from '../../../src/memory/negative-memory-applicator.js'
import type { LlmCriticProvider } from '../../../src/memory/negative-memory-critic-llm.js'

describe('negative-memory-critic integration', () => {
  let tmpDir: string
  let vaultDir: string
  let projectDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crit-int-'))
    vaultDir = join(tmpDir, 'vault')
    projectDir = join(tmpDir, 'project')
    mkdirSync(vaultDir, { recursive: true })
    mkdirSync(join(projectDir, '.github'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('suppresses pipeline-artifact rules and keeps real behavioral rules', async () => {
    const vault = createVault({ rootDir: vaultDir })
    const store = createNegativeMemoryStore(vault)

    // Seed the vault with the kind of garbage currently polluting the file
    const noise = [
      'Quality gate rejected team team-sugg-9872e17a: npm test failed; npm run lint failed',
      'Quality gate rejected team brain-solo: Team produced no staged diff',
      'Quality gate rejected team team-sugg-fdb0caa8: Team produced no staged diff',
      'npm test failed',
      '[ERROR] handler crashed at line 42',
      'stop doing this',
    ]
    for (const dontRule of noise) {
      store.storeFromHeuristic({
        originalText: dontRule,
        dontRule,
        category: 'frustration',
        recommendedTarget: 'general',
        confidence: 0.85,
      })
    }

    // And seed a real, substantive behavioral rule that should be kept by the
    // LLM stage. We use a stub LLM provider so the test is deterministic.
    const realRule = store.storeFromTool({
      feedback:
        'Never fabricate evidence or claim to have performed verification steps that were not actually done',
      severity: 'high',
    })

    const stubLlm: LlmCriticProvider = {
      async judge(req) {
        return req.memories.map((m) => ({
          id: m.id,
          status: 'keep' as const,
          rationale: 'stub-keep',
        }))
      },
    }

    const result = await runNegativeMemoryCritic({ vault, llmProvider: stubLlm })
    expect(result.heuristicSuppressed).toBeGreaterThanOrEqual(noise.length)
    // The real rule should have been routed to the LLM (undecided post-heuristic).
    expect(result.llmKept).toBeGreaterThanOrEqual(1)

    const apply = applyNegativeMemories({ vault, projectRoot: projectDir })
    expect(apply.suppressedByCriticCount).toBeGreaterThanOrEqual(noise.length)
    expect(apply.appliedCount).toBe(1)

    const target = join(projectDir, '.github', 'copilot-instructions.md')
    expect(existsSync(target)).toBe(true)
    const content = readFileSync(target, 'utf-8')
    expect(content).toContain('Never fabricate evidence')
    expect(content).not.toContain('Quality gate rejected')
    expect(content).not.toContain('no staged diff')
    expect(content).not.toContain('npm test failed')

    // Re-running the critic should be a no-op (verdicts already current).
    const second = await runNegativeMemoryCritic({ vault, llmProvider: stubLlm })
    expect(second.heuristicSuppressed).toBe(0)
    expect(second.llmJudged).toBe(0)
    expect(second.skippedAlreadyReviewed).toBeGreaterThan(0)

    // Pinning a memory bypasses the critic entirely.
    store.setPinned(realRule.id, true)
    const third = await runNegativeMemoryCritic({ vault, llmProvider: stubLlm })
    // Already-current verdict means it's skipped, but the applicator still
    // honors `pinned`.
    expect(third).toBeTruthy()
    const apply2 = applyNegativeMemories({ vault, projectRoot: projectDir })
    expect(apply2.appliedCount).toBe(1)
  })

  it('null LLM provider keeps undecided memories (do no harm)', async () => {
    const vault = createVault({ rootDir: vaultDir })
    const store = createNegativeMemoryStore(vault)
    store.storeFromTool({
      feedback: 'Always verify output content not just HTTP status codes',
      severity: 'high',
    })

    const result = await runNegativeMemoryCritic({ vault })
    expect(result.llmKept).toBe(1)
    const apply = applyNegativeMemories({ vault, projectRoot: projectDir })
    expect(apply.appliedCount).toBe(1)
  })

  it('strict applicator rejects unjudged memories by default', async () => {
    const vault = createVault({ rootDir: vaultDir })
    const store = createNegativeMemoryStore(vault)
    store.storeFromTool({
      feedback: 'Always verify output content not just HTTP status codes',
      severity: 'high',
    })

    // Skip the critic — applicator should refuse to apply.
    const apply = applyNegativeMemories({ vault, projectRoot: projectDir })
    expect(apply.appliedCount).toBe(0)
    expect(apply.pendingReviewCount).toBe(1)

    // allowUnjudged opts back into legacy behavior.
    const apply2 = applyNegativeMemories({
      vault,
      projectRoot: projectDir,
      allowUnjudged: true,
    })
    expect(apply2.appliedCount).toBe(1)
  })
})
