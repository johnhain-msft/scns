/**
 * Phase 13.12.34 — Negative-memories preservation across the QG cycle.
 *
 * Postmortem (team ca3ecfec, 2026-05-15): all 5 learned guardrail rules
 * vanished from `.github/copilot-instructions.md` during a self-improve
 * cycle. Those rules — "Do not claim functionality works without live
 * verification", "Never fabricate evidence", "Do not skip manual
 * testing", etc. — were exactly the safety rails meant to catch the
 * poison-pill branches that resulted from this same cycle.
 *
 * Two-layer defense:
 *   1) Applicator (`applyNegativeMemories`) — refuse to erase a
 *      non-empty existing block when the vault is transiently empty.
 *      Tested below in describe('applyNegativeMemories preservation').
 *   2) QG arbiter (`checkNegativeMemoriesPreserved`) — refuse to
 *      commit a worktree whose diff would empty the block. Tested
 *      below in describe('checkNegativeMemoriesPreserved').
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createVault } from '../../../src/memory/vault.js'
import {
  applyNegativeMemories,
  BLOCK_START,
  BLOCK_END,
} from '../../../src/memory/negative-memory-applicator.js'
import {
  checkNegativeMemoriesPreserved,
  type RunResult,
} from '../../../src/broker/services/quality-gate-arbiter.js'

// ──────────────────────────────────────────────────────────────────────
// Part 1 — Applicator preservation behavior
// ──────────────────────────────────────────────────────────────────────

describe('applyNegativeMemories preservation (Phase 13.12.34)', () => {
  let tmpDir: string
  let vaultDir: string
  let projectDir: string
  let targetFile: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'neg-preserve-'))
    vaultDir = join(tmpDir, 'vault')
    projectDir = join(tmpDir, 'project')
    targetFile = join(projectDir, '.github/copilot-instructions.md')
    mkdirSync(vaultDir, { recursive: true })
    mkdirSync(join(projectDir, '.github'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("does NOT erase an existing non-empty block when vault has 0 eligible memories", () => {
    // Seed: file already has 5 rules from prior runs (the production state
    // we want to defend).
    const preExisting = [
      'Before content here.',
      '',
      BLOCK_START,
      '## Things to AVOID (learned from experience)',
      '',
      '- Do not claim functionality works without live verification',
      '- Always verify output content, not just HTTP status codes',
      '- Never fabricate evidence',
      '- Do not skip manual testing',
      '- Never claim work is done without running tests',
      BLOCK_END,
      '',
      'After content here.',
      '',
    ].join('\n')
    writeFileSync(targetFile, preExisting, 'utf-8')

    // Vault is EMPTY — no eligible memories.
    const vault = createVault({ rootDir: vaultDir })
    const result = applyNegativeMemories({ vault, projectRoot: projectDir })

    // The applicator must refuse to erase the existing block.
    expect(result.appliedCount).toBe(0)
    const after = readFileSync(targetFile, 'utf-8')
    expect(after).toContain('Do not claim functionality works without live verification')
    expect(after).toContain('Never fabricate evidence')
    expect(after).toContain(BLOCK_START)
    expect(after).toContain(BLOCK_END)
    // File should be unchanged byte-for-byte.
    expect(after).toBe(preExisting)
  })

  it('allows the legacy zero-eligible no-op when existing block is already empty', () => {
    // File has empty managed block markers but no rules — the initial
    // state after `rewriteEmptyBlock` runs. The applicator should still
    // be a no-op (not crash) and the markers should remain.
    const emptyBlocked = `${BLOCK_START}\n${BLOCK_END}\n`
    writeFileSync(targetFile, emptyBlocked, 'utf-8')

    const vault = createVault({ rootDir: vaultDir })
    const result = applyNegativeMemories({ vault, projectRoot: projectDir })

    expect(result.appliedCount).toBe(0)
    const after = readFileSync(targetFile, 'utf-8')
    expect(after).toContain(BLOCK_START)
    expect(after).toContain(BLOCK_END)
  })

  it('allows the legacy zero-eligible no-op when target file does not exist', () => {
    // No file at all — applicator should not blow up and should not
    // create a file (no rules to apply).
    const vault = createVault({ rootDir: vaultDir })
    const result = applyNegativeMemories({ vault, projectRoot: projectDir })
    expect(result.appliedCount).toBe(0)
    // No error.
    expect(result.errors).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────
// Part 2 — QG arbiter postcheck
// ──────────────────────────────────────────────────────────────────────

const WITH_RULES = [
  BLOCK_START,
  '## Things to AVOID',
  '- Rule one',
  '- Rule two',
  BLOCK_END,
].join('\n')

const EMPTY_MARKERS = `${BLOCK_START}\n${BLOCK_END}`

function fakeRun(headContent: string | null): (cmd: string, cwd: string) => RunResult {
  return (cmd: string) => {
    if (cmd.startsWith('git show HEAD:.github/copilot-instructions.md')) {
      if (headContent == null) {
        return { ok: false, code: 128, stdout: '', stderr: 'fatal: not in HEAD' }
      }
      return { ok: true, stdout: headContent, stderr: '' }
    }
    return { ok: false, code: 1, stdout: '', stderr: 'unexpected cmd' }
  }
}

function fakeFs(wtContent: string | null): {
  existsSync: (p: string) => boolean
  readFileSync: (p: string) => string
} {
  return {
    existsSync: () => wtContent != null,
    readFileSync: () => (wtContent == null ? '' : wtContent),
  }
}

describe('checkNegativeMemoriesPreserved (Phase 13.12.34)', () => {
  it('passes when HEAD has no file (nothing to preserve)', () => {
    const result = checkNegativeMemoriesPreserved(
      fakeRun(null),
      '/tmp/wt',
      fakeFs('whatever'),
    )
    expect(result.ok).toBe(true)
  })

  it('passes when HEAD has no managed block (nothing to preserve)', () => {
    const result = checkNegativeMemoriesPreserved(
      fakeRun('# README\nno block here\n'),
      '/tmp/wt',
      fakeFs('# different content'),
    )
    expect(result.ok).toBe(true)
  })

  it('passes when HEAD block is empty (no rules to lose)', () => {
    const result = checkNegativeMemoriesPreserved(
      fakeRun(EMPTY_MARKERS),
      '/tmp/wt',
      fakeFs(EMPTY_MARKERS),
    )
    expect(result.ok).toBe(true)
  })

  it('passes when both HEAD and worktree have non-empty blocks (preserved)', () => {
    const result = checkNegativeMemoriesPreserved(
      fakeRun(WITH_RULES),
      '/tmp/wt',
      fakeFs(WITH_RULES),
    )
    expect(result.ok).toBe(true)
  })

  it('passes when worktree reduces rules but keeps non-empty block (legitimate suppress)', () => {
    const reduced = [BLOCK_START, '- Rule one only', BLOCK_END].join('\n')
    const result = checkNegativeMemoriesPreserved(
      fakeRun(WITH_RULES),
      '/tmp/wt',
      fakeFs(reduced),
    )
    expect(result.ok).toBe(true)
  })

  it('FAILS when worktree file is missing entirely', () => {
    const result = checkNegativeMemoriesPreserved(
      fakeRun(WITH_RULES),
      '/tmp/wt',
      fakeFs(null),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.finding).toContain('deleted in worktree')
    }
  })

  it('FAILS when worktree file lost the block markers entirely', () => {
    const result = checkNegativeMemoriesPreserved(
      fakeRun(WITH_RULES),
      '/tmp/wt',
      fakeFs('# README only\nno markers anywhere\n'),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.finding).toContain('lost negative-memories block markers')
    }
  })

  it('FAILS when worktree has markers but inner content emptied (the ca3ecfec footprint)', () => {
    const result = checkNegativeMemoriesPreserved(
      fakeRun(WITH_RULES),
      '/tmp/wt',
      fakeFs(EMPTY_MARKERS),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.finding).toContain('emptied')
      expect(result.finding).toContain('refusing to commit erasure')
    }
  })

  it('FAILS when worktree has only opening marker (corruption)', () => {
    const corrupt = `${BLOCK_START}\nsome content but no end marker`
    const result = checkNegativeMemoriesPreserved(
      fakeRun(WITH_RULES),
      '/tmp/wt',
      fakeFs(corrupt),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.finding).toContain('lost negative-memories block markers')
    }
  })
})
