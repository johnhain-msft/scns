/**
 * Quality checker service — rubric-based quality evaluation.
 * Evaluates session output text against configurable rubric entries.
 * Each entry has regex patterns (negative = failures) and a weight.
 * Score is the weighted average of passing rubrics (0-1).
 */

import type Database from 'better-sqlite3'
import {
  createQualityCheck,
  findQualityChecksBySession,
} from '../storage/repositories/quality-repository.js'
import type { QualityCheck } from '../types.js'

// ── Types ────────────────────────────────────────────────────────────

export interface QualityCheckInput {
  readonly sessionId?: string
  readonly output: string
  readonly taskType: string
}

export interface QualityCheckResult {
  readonly id: string
  readonly passed: boolean
  readonly score: number
  readonly findings: readonly string[]
}

export interface QualityCheckerOptions {
  readonly passThreshold?: number
}

export interface QualityChecker {
  check(input: QualityCheckInput): QualityCheckResult
  getBySession(sessionId: string): readonly QualityCheck[]
}

// ── Rubric definitions ───────────────────────────────────────────────

interface RubricEntry {
  readonly name: string
  readonly weight: number
  /** Patterns that indicate failure when matched */
  readonly failPatterns: readonly RegExp[]
  /** Finding message when this rubric fails */
  readonly findingMessage: string
}

const IMPLEMENTATION_RUBRIC: readonly RubricEntry[] = [
  {
    name: 'tests-passing',
    weight: 0.3,
    failPatterns: [
      /\d+\s+tests?\s+fail/i,
      /test\s+failure/i,
      /tests?\s+failed/i,
      /FAIL\s+\w/,
      /failing\s+tests?/i,
    ],
    findingMessage: 'Test failures detected in output',
  },
  {
    name: 'build-clean',
    weight: 0.25,
    failPatterns: [
      /build\s+fail/i,
      /compilation\s+error/i,
      /TS\d{4}:/,
      /SyntaxError:/,
      /build\s+error/i,
    ],
    findingMessage: 'Build errors detected in output',
  },
  {
    name: 'no-runtime-errors',
    weight: 0.2,
    failPatterns: [
      /TypeError:/,
      /ReferenceError:/,
      /RangeError:/,
      /Cannot read propert/i,
      /is not a function/i,
      /is not defined/i,
    ],
    findingMessage: 'Runtime errors detected in output',
  },
  {
    name: 'lint-clean',
    weight: 0.15,
    failPatterns: [
      /eslint.*\d+\s+error/i,
      /lint.*error/i,
      /\d+\s+problems?\s*\(\d+\s+errors?/i,
    ],
    findingMessage: 'Lint errors detected in output',
  },
  {
    name: 'no-unresolved',
    weight: 0.1,
    // Task 70 — postmortem of qc=923720a5, qc=dafaba9b, and three earlier
    // identical failures on this team. The previous patterns (`/stub/i`,
    // `/not\s+implement/i`, bare `/FIXME/i`, `/HACK/i`, `/TODO:\s*fix/i`)
    // matched against the concatenated build+test+lint stdout/stderr
    // stream and false-fired on benign occurrences — most notably the
    // vitest test name "runPlan (forced stub mode)" from
    // test/unit/suggest/browser-skill-runner.test.ts, where `/stub/i`
    // tripped on the word "stub" inside the test title. That produced a
    // permanent QG=false verdict (score=0.9, exactly 0.1 weight
    // subtracted, one finding) on otherwise green runs.
    //
    // The prior bootstrap fix (test/vitest.setup.ts → SCNS_LOG_LEVEL=
    // silent) only addressed pino log echo leakage; the test-name leak
    // is an independent failure mode requiring regex tightening.
    //
    // New patterns require source-code marker context:
    //   1. Comment-prefixed TODO/FIXME/HACK after a real comment opener
    //      — `// TODO`, `# FIXME`, `/* HACK`, or JSDoc `* TODO`.
    //      Adjacency of the comment opener is enforced so prose like
    //      "the hackathon was fun" cannot fire.
    //   2. The canonical intent phrase `TODO: <action>` (fix / implement
    //      / address / remove / cleanup) — preserved so
    //      quality-gate-arbiter.test.ts L343 ("tests green TODO: fix
    //      later") continues to fire.
    //   3. Narrow stub markers: `stub <noun>` where the noun is one of
    //      a small set indicating placeholder code
    //      (implementation/impl/function/method/placeholder/here/out/
    //      version). Benign forms like "stub mode" or "stub server" do
    //      NOT match.
    failPatterns: [
      // Line/inline comments: `// TODO|FIXME|HACK`. Preceded by start
      // of input or a non-word, non-`:`, non-`/` char to keep URLs
      // (https://...) and path fragments (/usr/lib//...) from firing.
      /(?:^|[^\w:/])\/\/\s*(?:TODO|FIXME|HACK)\b/m,
      // Shell/Python-style comments: `# TODO|FIXME|HACK`.
      /(?:^|[^\w])#\s*(?:TODO|FIXME|HACK)\b/m,
      // Block-comment opener: `/* TODO ...`.
      /\/\*\s*(?:TODO|FIXME|HACK)\b/,
      // JSDoc-style block-comment continuation: lines starting with `*`.
      /^\s*\*\s*(?:TODO|FIXME|HACK)\b/m,
      // Canonical intent phrase regardless of comment prefix.
      /\bTODO:\s*(?:fix|implement|address|remove|cleanup)\b/i,
      // Narrow stub markers: `stub <placeholder-noun>` only. The noun
      // list intentionally excludes "mode", "server", "data", etc. so
      // vitest test names and ordinary English prose do not false-fire.
      /\bstub(?:bed)?\s+(?:implementation|impl|function|method|placeholder|here|out|version)\b/i,
    ],
    findingMessage: 'Unresolved issues (TODO/FIXME/HACK) detected in output',
  },
]

const REFACTOR_RUBRIC: readonly RubricEntry[] = [
  {
    name: 'tests-passing',
    weight: 0.4,
    failPatterns: [
      /\d+\s+tests?\s+fail/i,
      /test\s+failure/i,
      /tests?\s+failed/i,
      /FAIL\s+\w/,
    ],
    findingMessage: 'Test failures detected — refactor may have broken behavior',
  },
  {
    name: 'build-clean',
    weight: 0.3,
    failPatterns: [
      /build\s+fail/i,
      /compilation\s+error/i,
      /TS\d{4}:/,
    ],
    findingMessage: 'Build errors detected in output',
  },
  {
    name: 'no-runtime-errors',
    weight: 0.2,
    failPatterns: [
      /TypeError:/,
      /ReferenceError:/,
      /Cannot read propert/i,
    ],
    findingMessage: 'Runtime errors detected in output',
  },
  {
    name: 'lint-clean',
    weight: 0.1,
    failPatterns: [
      /eslint.*\d+\s+error/i,
      /\d+\s+problems?\s*\(\d+\s+errors?/i,
    ],
    findingMessage: 'Lint errors detected in output',
  },
]

function getRubric(taskType: string): readonly RubricEntry[] {
  switch (taskType) {
    case 'refactor':
      return REFACTOR_RUBRIC
    default:
      return IMPLEMENTATION_RUBRIC
  }
}

/**
 * Pure rubric evaluation — no DB side effects. Used by the Phase 13.5
 * quality gate arbiter to combine rubric results with test/lint outcomes
 * before persisting a single authoritative verdict row.
 */
export function evaluateRubric(
  output: string,
  taskType: string,
  options?: QualityCheckerOptions,
): Omit<QualityCheckResult, 'id'> {
  const passThreshold = options?.passThreshold ?? 0.6
  const rubric = getRubric(taskType)
  const findings: string[] = []
  let totalWeight = 0
  let passedWeight = 0

  for (const entry of rubric) {
    totalWeight += entry.weight
    const failed = entry.failPatterns.some((pattern) => pattern.test(output))
    if (failed) {
      findings.push(entry.findingMessage)
    } else {
      passedWeight += entry.weight
    }
  }

  const score =
    totalWeight > 0 ? Math.round((passedWeight / totalWeight) * 100) / 100 : 1
  const passed = score >= passThreshold && findings.length === 0

  return { passed, score, findings }
}

// ── Factory ──────────────────────────────────────────────────────────

export function createQualityChecker(
  db: Database.Database,
  options?: QualityCheckerOptions,
): QualityChecker {
  const passThreshold = options?.passThreshold ?? 0.6

  function check(input: QualityCheckInput): QualityCheckResult {
    const result = evaluateRubric(input.output, input.taskType, { passThreshold })

    const record = createQualityCheck(db, {
      session_id: input.sessionId ?? null,
      task_type: input.taskType,
      output: input.output,
      passed: result.passed,
      score: result.score,
      findings: result.findings,
    })

    return {
      id: record.id,
      passed: result.passed,
      score: result.score,
      findings: result.findings,
    }
  }

  function getBySession(sessionId: string): readonly QualityCheck[] {
    return findQualityChecksBySession(db, sessionId)
  }

  return { check, getBySession }
}
