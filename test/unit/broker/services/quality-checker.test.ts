import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import type { TestDb } from '../../../helpers/db-harness.js'
import {
  createQualityChecker,
  evaluateRubric,
} from '../../../../src/broker/services/quality-checker.js'

let testDb: TestDb

beforeEach(() => {
  testDb = createBrokerTestDb()
})

afterEach(() => {
  testDb.close()
})

describe('QualityChecker', () => {
  describe('check()', () => {
    it('passes output with no issues and high score', () => {
      const checker = createQualityChecker(testDb.db)
      const result = checker.check({
        output: 'All 50 tests pass. Build clean. Lint clean. Manual verification complete.',
        taskType: 'implementation',
      })

      expect(result.passed).toBe(true)
      expect(result.score).toBeGreaterThanOrEqual(0.6)
      expect(result.findings).toHaveLength(0)
      expect(result.id).toBeDefined()
    })

    it('fails output with test failures', () => {
      const checker = createQualityChecker(testDb.db)
      const result = checker.check({
        output: '3 tests fail. TypeError in auth.ts. Did not run manual verification.',
        taskType: 'implementation',
      })

      expect(result.passed).toBe(false)
      expect(result.findings.length).toBeGreaterThan(0)
      expect(result.findings.some((f) => f.toLowerCase().includes('test'))).toBe(true)
    })

    it('detects build errors', () => {
      const checker = createQualityChecker(testDb.db)
      const result = checker.check({
        output: 'Build failed with 2 errors. TS2345: Argument of type string is not assignable.',
        taskType: 'implementation',
      })

      expect(result.passed).toBe(false)
      expect(result.findings.some((f) => f.toLowerCase().includes('build'))).toBe(true)
    })

    it('detects lint errors', () => {
      const checker = createQualityChecker(testDb.db)
      const result = checker.check({
        output: 'ESLint: 5 problems (3 errors, 2 warnings). Tests pass. Build clean.',
        taskType: 'implementation',
      })

      expect(result.passed).toBe(false)
      expect(result.findings.some((f) => f.toLowerCase().includes('lint'))).toBe(true)
    })

    it('detects TypeErrors/runtime errors', () => {
      const checker = createQualityChecker(testDb.db)
      const result = checker.check({
        output: 'TypeError: Cannot read properties of undefined. Tests pass otherwise.',
        taskType: 'implementation',
      })

      expect(result.passed).toBe(false)
      expect(result.findings.some((f) => f.toLowerCase().includes('error'))).toBe(true)
    })

    it('passes clean output for refactor task type', () => {
      const checker = createQualityChecker(testDb.db)
      const result = checker.check({
        output: 'Refactoring complete. All tests pass. No behavior changes.',
        taskType: 'refactor',
      })

      expect(result.passed).toBe(true)
      expect(result.score).toBeGreaterThanOrEqual(0.6)
    })

    it('associates quality check with session ID', () => {
      const checker = createQualityChecker(testDb.db)
      const result = checker.check({
        sessionId: 'sess-123',
        output: 'All tests pass.',
        taskType: 'implementation',
      })

      expect(result.id).toBeDefined()

      // Verify persisted in DB
      const row = testDb.db
        .prepare('SELECT * FROM quality_checks WHERE id = ?')
        .get(result.id) as Record<string, unknown>
      expect(row).toBeDefined()
      expect(row.session_id).toBe('sess-123')
      expect(row.passed).toBe(1)
    })

    it('persists result to quality_checks table', () => {
      const checker = createQualityChecker(testDb.db)
      const result = checker.check({
        sessionId: 'sess-abc',
        output: '2 tests fail. Build errors.',
        taskType: 'implementation',
      })

      const row = testDb.db
        .prepare('SELECT * FROM quality_checks WHERE id = ?')
        .get(result.id) as Record<string, unknown>

      expect(row).toBeDefined()
      expect(row.session_id).toBe('sess-abc')
      expect(row.passed).toBe(0)
      expect(row.score).toBe(result.score)
      const findings = JSON.parse(row.findings as string) as string[]
      expect(findings.length).toBeGreaterThan(0)
    })

    it('returns findings as actionable strings', () => {
      const checker = createQualityChecker(testDb.db)
      const result = checker.check({
        output: '5 tests fail. Build failed. ESLint 3 errors. TypeError in module.',
        taskType: 'implementation',
      })

      expect(result.findings.length).toBeGreaterThanOrEqual(2)
      for (const finding of result.findings) {
        expect(typeof finding).toBe('string')
        expect(finding.length).toBeGreaterThan(0)
      }
    })

    it('configurable pass threshold', () => {
      const checker = createQualityChecker(testDb.db, { passThreshold: 0.9 })
      // Output with lint warnings — score will be < 1.0 but > 0.6 normally
      const result = checker.check({
        output: 'Tests pass. Build clean. ESLint: 2 problems (2 errors, 0 warnings).',
        taskType: 'implementation',
      })

      // With findings, passed should be false regardless of threshold
      expect(result.passed).toBe(false)
      expect(result.findings.length).toBeGreaterThan(0)
    })

    it('retrieves quality checks by session', () => {
      const checker = createQualityChecker(testDb.db)
      checker.check({ sessionId: 'sess-x', output: 'All tests pass.', taskType: 'implementation' })
      checker.check({
        sessionId: 'sess-x',
        output: '2 tests fail.',
        taskType: 'implementation',
      })
      checker.check({
        sessionId: 'sess-y',
        output: 'Build clean.',
        taskType: 'implementation',
      })

      const checks = checker.getBySession('sess-x')
      expect(checks).toHaveLength(2)
      expect(checks.every((c) => c.session_id === 'sess-x')).toBe(true)
    })
  })

  // ── no-unresolved rubric: regex precision ────────────────────────────
  //
  // Reproduction-first guard (task 70, postmortem of qc=923720a5 et al).
  // The original `/stub/i`, `/not\s+implement/i`, bare `/FIXME/i`,
  // `/HACK/i` patterns over-matched benign vitest test names and ordinary
  // English phrasing in build/test/lint stdout streams, causing
  // permanent QG=false verdicts with score=0.9 and a single spurious
  // "Unresolved issues" finding on otherwise green runs.
  //
  // These tests assert the post-fix behavior: only genuine source-code
  // marker forms (comment-prefixed TODO/FIXME/HACK and narrow stub
  // descriptors) should fire. Benign occurrences of the substring "stub"
  // or non-whitespaced "notImplementedYet" identifiers must not.
  describe('no-unresolved rubric — regex precision', () => {
    function findingsFor(output: string): readonly string[] {
      return evaluateRubric(output, 'implementation').findings
    }

    function unresolved(findings: readonly string[]): boolean {
      return findings.some((f) => f.toLowerCase().includes('unresolved'))
    }

    // ── BENIGN inputs that must NOT fire the no-unresolved rubric ──
    // These reproduce the qc=923720a5 false positive: the offending
    // vitest test-name fragment from browser-skill-runner.test.ts.
    it('benign: vitest test name "runPlan (forced stub mode)" must not fire', () => {
      const output =
        '✓ browser-automation skill runner > runPlan (forced stub mode) > writes plan.json'
      expect(unresolved(findingsFor(output))).toBe(false)
    })

    it('benign: prose "using stub server" must not fire', () => {
      const output = 'Configured fake transport using stub server endpoint at 127.0.0.1:0'
      expect(unresolved(findingsFor(output))).toBe(false)
    })

    it('benign: identifier "notImplementedYet()" (no whitespace) must not fire', () => {
      const output = 'invoking helper notImplementedYet() returned undefined'
      expect(unresolved(findingsFor(output))).toBe(false)
    })

    // ── GENUINE source-code markers that MUST fire ──
    it('genuine: "// stub implementation — fill in later" must fire', () => {
      const output = '  // stub implementation — fill in later\n  return null'
      expect(unresolved(findingsFor(output))).toBe(true)
    })

    it('genuine: "// HACK: bypass" must fire', () => {
      const output = 'src/util.ts:42:  // HACK: bypass auth check for now'
      expect(unresolved(findingsFor(output))).toBe(true)
    })

    it('genuine: "// FIXME urgent" must fire', () => {
      const output = '  // FIXME urgent: handle null case before shipping'
      expect(unresolved(findingsFor(output))).toBe(true)
    })

    // Preserve the canonical intent phrase that quality-gate-arbiter.test.ts
    // L343 ("tests green TODO: fix later") relies on.
    it('preserves canonical "TODO: fix later" intent phrase match', () => {
      expect(unresolved(findingsFor('tests green TODO: fix later'))).toBe(true)
    })
  })
})
