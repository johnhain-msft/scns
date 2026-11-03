import { describe, it, expect } from 'vitest'
import {
  classifyChangeset,
  isQgInfraPath,
  QG_INFRA_EXACT_PATHS,
  QG_INFRA_PREFIXES,
} from '../../../../src/broker/services/qg-changeset-classifier.js'

describe('qg-changeset-classifier', () => {
  describe('isQgInfraPath (single-path predicate)', () => {
    it('matches every file in the exact-path list', () => {
      for (const path of QG_INFRA_EXACT_PATHS) {
        expect(isQgInfraPath(path)).toBe(true)
      }
    })

    it('matches paths under the prefix list', () => {
      for (const prefix of QG_INFRA_PREFIXES) {
        expect(isQgInfraPath(`${prefix}something.ts`)).toBe(true)
        expect(isQgInfraPath(`${prefix}with-dashes-and.numbers.42.ts`)).toBe(
          true,
        )
      }
    })

    it('does NOT match ordinary source paths', () => {
      const ordinary = [
        'src/cli.ts',
        'src/shared/logger.ts',
        'src/memory/applicator.ts',
        'README.md',
        'package.json',
        'test/unit/broker/services/auto-merger.test.ts',
        'src/broker/routes/index.ts',
        'src/broker/storage/repositories/team-repository.ts',
      ]
      for (const path of ordinary) {
        expect(isQgInfraPath(path)).toBe(false)
      }
    })

    it('rejects substring-only matches (must be a prefix or exact)', () => {
      // Looks similar but is NOT in any of the lists
      expect(isQgInfraPath('docs/src/broker/services/quality-gate.md')).toBe(
        false,
      )
      expect(isQgInfraPath('node_modules/src/broker/services/quality-gate-x')).toBe(
        false,
      )
      expect(isQgInfraPath('test/unit/broker/services/quality-gate-arbiter.test.ts')).toBe(
        false,
      )
    })

    it('handles empty and whitespace input safely', () => {
      expect(isQgInfraPath('')).toBe(false)
      // No trim — caller is responsible. Whitespace-only is "ordinary".
      expect(isQgInfraPath('   ')).toBe(false)
    })

    it('is case-sensitive (filesystem semantics)', () => {
      expect(
        isQgInfraPath('SRC/broker/services/quality-gate-arbiter.ts'),
      ).toBe(false)
    })
  })

  describe('classifyChangeset', () => {
    it('returns "ordinary" with empty lists for an empty changeset', () => {
      const result = classifyChangeset([])
      expect(result.kind).toBe('ordinary')
      expect(result.qgInfraFiles).toEqual([])
      expect(result.otherFiles).toEqual([])
    })

    it('returns "ordinary" when no QG-infra files are touched', () => {
      const result = classifyChangeset([
        'src/cli.ts',
        'src/shared/logger.ts',
        'README.md',
      ])
      expect(result.kind).toBe('ordinary')
      expect(result.qgInfraFiles).toEqual([])
      expect(result.otherFiles).toEqual([
        'src/cli.ts',
        'src/shared/logger.ts',
        'README.md',
      ])
    })

    it('returns "qg-infra" when ANY one file is QG-infrastructure', () => {
      const result = classifyChangeset([
        'src/cli.ts',
        'README.md',
        'src/broker/services/quality-gate-arbiter.ts',
        'docs/CHANGELOG.md',
      ])
      expect(result.kind).toBe('qg-infra')
      expect(result.qgInfraFiles).toEqual([
        'src/broker/services/quality-gate-arbiter.ts',
      ])
      expect(result.otherFiles).toEqual([
        'src/cli.ts',
        'README.md',
        'docs/CHANGELOG.md',
      ])
    })

    it('captures ALL QG-infra files when multiple are touched', () => {
      const result = classifyChangeset([
        'src/broker/services/quality-gate-arbiter.ts',
        'src/broker/services/auto-dispatch.ts',
        'src/broker/services/team-task-autospawner.ts',
        'src/cli.ts',
      ])
      expect(result.kind).toBe('qg-infra')
      expect(result.qgInfraFiles).toEqual([
        'src/broker/services/quality-gate-arbiter.ts',
        'src/broker/services/auto-dispatch.ts',
        'src/broker/services/team-task-autospawner.ts',
      ])
      expect(result.otherFiles).toEqual(['src/cli.ts'])
    })

    it('classifies the broker-restart script as QG-infra', () => {
      const result = classifyChangeset(['scripts/broker-restart.sh'])
      expect(result.kind).toBe('qg-infra')
      expect(result.qgInfraFiles).toEqual(['scripts/broker-restart.sh'])
    })

    it('classifies the QG arbiter itself as QG-infra (self-reference)', () => {
      const result = classifyChangeset([
        'src/broker/services/quality-gate-arbiter.ts',
      ])
      expect(result.kind).toBe('qg-infra')
    })

    it('classifies the auto-merger itself as QG-infra (self-reference)', () => {
      // Defensive: a fix to the merger gating mechanism must be human-reviewed,
      // otherwise a broken auto-merger could merge its own broken fix.
      const result = classifyChangeset([
        'src/broker/services/auto-merger.ts',
      ])
      expect(result.kind).toBe('qg-infra')
    })

    it('skips empty-string entries in the file list', () => {
      const result = classifyChangeset(['', 'src/cli.ts', ''])
      expect(result.kind).toBe('ordinary')
      expect(result.qgInfraFiles).toEqual([])
      expect(result.otherFiles).toEqual(['src/cli.ts'])
    })

    it('treats subtree matches via prefix correctly', () => {
      // Any quality-gate-* sibling counts (e.g., a future
      // quality-gate-rubric.ts companion file).
      const result = classifyChangeset([
        'src/broker/services/quality-gate-rubric.ts',
        'src/broker/services/quality-gate-prompts.ts',
      ])
      expect(result.kind).toBe('qg-infra')
      expect(result.qgInfraFiles).toEqual([
        'src/broker/services/quality-gate-rubric.ts',
        'src/broker/services/quality-gate-prompts.ts',
      ])
    })

    it('is deterministic across repeated calls (pure)', () => {
      const input = [
        'src/cli.ts',
        'src/broker/services/quality-gate-arbiter.ts',
      ]
      const a = classifyChangeset(input)
      const b = classifyChangeset(input)
      expect(a).toEqual(b)
    })
  })
})
