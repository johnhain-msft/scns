/**
 * T007 (feature 002) — the shared evidence-capture util enforces the RESULTS_JSON / JSONL schema
 * (contracts/evidence-results.schema.md, research R7) so the fable5 §6 over-claims are structurally
 * impossible. Every rule below is exercised with a POSITIVE and a NEGATIVE control — a guard that
 * cannot fail is not a guard.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  writeFullLog,
  appendPerItem,
  computeSc004,
  assertPerArmPerCategoryComplete,
  validateResultsJson,
  resultsJsonHash,
  detHashMatch,
  type ResultsJson,
  type PerArmPerCategory,
} from '../../../scripts/lib/evidence.js'

const ARMS = ['hybrid', 'magma'] as const
const CATS = ['single_hop', 'multi_hop'] as const

function fullGrid(): PerArmPerCategory[] {
  const rows: PerArmPerCategory[] = []
  for (const arm of ARMS) for (const category of CATS) rows.push({ arm, category, accuracy: 0.7, tokens: 300 })
  return rows
}

function validResults(overrides: Partial<ResultsJson> = {}): ResultsJson {
  return {
    perArmPerCategory: fullGrid(),
    substrate: {
      materializedPerConv: 9,
      perWhyItem: 0.6,
      perConvMin: 8,
      floor: { perConv: 8, perWhyItem: 0.5 },
      preCheckOk: true,
    },
    sc004: computeSc004(281, 3370),
    armCost: { hybrid: 1200, magma: 3200 },
    judgeSigma: 0.0267,
    detRuns: 2,
    detHashMatch: true,
    ...overrides,
  }
}

describe('SC-008 structural separation — computeSc004 (FR-018)', () => {
  it('POSITIVE: derives the fraction from an EXPLICIT full-context arm', () => {
    const b = computeSc004(281, 3370)
    expect(b.briefingTok).toBe(281)
    expect(b.fullContextTok).toBe(3370)
    expect(b.fraction).toBeCloseTo(281 / 3370, 6)
  })

  it('NEGATIVE: throws when there is no full-context arm (fullContextTok <= 0)', () => {
    expect(() => computeSc004(281, 0)).toThrow(/full-context arm/i)
    expect(() => computeSc004(281, -5)).toThrow(/MUST NOT be rendered from arm-vs-arm/i)
  })

  it('has no code path that accepts armCost — arm-vs-arm cost cannot become the SC-008 denominator', () => {
    // Structural: computeSc004 accepts exactly two numeric token counts. The type signature (briefingTok,
    // fullContextTok) is the enforcement; there is deliberately no overload taking ArmCost.
    expect(computeSc004.length).toBe(2)
  })
})

describe('per-arm per-category completeness (SC-002, fable5 counts-only defect)', () => {
  it('POSITIVE: a full arm×category grid passes', () => {
    expect(() => assertPerArmPerCategoryComplete(fullGrid(), ARMS, CATS)).not.toThrow()
  })

  it('NEGATIVE: a missing cell throws naming it', () => {
    const missing = fullGrid().filter((r) => !(r.arm === 'magma' && r.category === 'multi_hop'))
    expect(() => assertPerArmPerCategoryComplete(missing, ARMS, CATS)).toThrow(/magma × multi_hop/)
  })

  it('NEGATIVE: a counts-only cell (non-finite accuracy/tokens) throws', () => {
    const bad = fullGrid().map((r) =>
      r.arm === 'hybrid' && r.category === 'single_hop' ? { ...r, accuracy: Number.NaN } : r,
    )
    expect(() => assertPerArmPerCategoryComplete(bad, ARMS, CATS)).toThrow(/finite accuracy AND tokens/)
  })
})

describe('validateResultsJson — blocks present + substrate un-elided', () => {
  it('POSITIVE: a well-formed RESULTS_JSON has zero problems', () => {
    expect(validateResultsJson(validResults())).toEqual([])
  })

  it('NEGATIVE: an elided substrate count is flagged', () => {
    const r = validResults({
      substrate: {
        materializedPerConv: Number.NaN,
        perWhyItem: 0.6,
        perConvMin: 8,
        floor: { perConv: 8, perWhyItem: 0.5 },
        preCheckOk: true,
      },
    })
    expect(validateResultsJson(r)).toContain('substrate.materializedPerConv is elided/non-finite')
  })

  it('NEGATIVE: an empty perArmPerCategory is flagged', () => {
    expect(validateResultsJson(validResults({ perArmPerCategory: [] }))).toContain(
      'perArmPerCategory is empty (SC-002 requires per-arm per-category rows)',
    )
  })
})

describe('det×2 machine verification (rule 4)', () => {
  it('POSITIVE: two identical bodies hash-match (ignoring the detHashMatch/detRuns bookkeeping)', () => {
    const a = validResults({ detHashMatch: true, detRuns: 2 })
    const b = validResults({ detHashMatch: false, detRuns: 99 })
    expect(detHashMatch(a, b)).toBe(true)
    expect(resultsJsonHash(a)).toBe(resultsJsonHash(b))
  })

  it('NEGATIVE: a changed accuracy breaks the hash match', () => {
    const a = validResults()
    const b = validResults({
      perArmPerCategory: fullGrid().map((r) =>
        r.arm === 'magma' && r.category === 'single_hop' ? { ...r, accuracy: 0.71 } : r,
      ),
    })
    expect(detHashMatch(a, b)).toBe(false)
  })
})

describe('un-truncated archival', () => {
  it('writeFullLog persists the COMPLETE stdout; appendPerItem writes one JSONL row per item', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scns-evidence-'))
    try {
      const big = Array.from({ length: 500 }, (_, i) => `item-${i} row`).join('\n')
      const logPath = join(dir, 'run.log')
      writeFullLog(logPath, big)
      expect(readFileSync(logPath, 'utf8')).toBe(big) // byte-for-byte, no head-truncation

      const jsonlPath = join(dir, 'run-items.jsonl')
      appendPerItem(jsonlPath, { arm: 'magma', category: 'temporal', score: 0.6, tokens: 42, generated_answer: 'a' })
      appendPerItem(jsonlPath, { arm: 'hybrid', category: 'single_hop', score: 0.8, tokens: 40, generated_answer: 'b' })
      const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]).arm).toBe('magma')
      expect(JSON.parse(lines[1]).score).toBe(0.8)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
