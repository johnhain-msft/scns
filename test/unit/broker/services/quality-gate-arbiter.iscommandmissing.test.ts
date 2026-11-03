/**
 * Phase 13.12.30 — `isCommandMissing` narrowed to exit-code-only.
 *
 * Postmortem qc=4f7e7f48: the previous implementation also scanned
 * stdout+stderr for "command not found" / ":not found" / "enoent",
 * which mislabeled regular test failures as `tooling-missing` whenever
 * the vitest test bundle dumped fixture text containing those strings.
 * The bridge test file itself
 * (`test/unit/broker/services/quality-gate-arbiter.bridge.test.ts`)
 * embeds `vitest: command not found` as test input — so every time a
 * sibling test broke in a run that *did* exercise the bridge fixtures,
 * the verdict reason flipped from the real cause to `tooling-missing`.
 *
 * Acceptance:
 *   (a) ok=true                                  → false
 *   (b) exit 127                                 → true   (canonical)
 *   (c) exit 126                                 → true   (perm/non-exec)
 *   (d) exit 1, stdout contains vitest fixture
 *       text "vitest: command not found"        → false  (regression)
 *   (e) exit 1, stderr contains vitest fixture
 *       text "vitest: command not found"        → false  (regression)
 *   (f) exit 1, both stdout AND stderr contain
 *       "command not found" / "not found" / "ENOENT" → false (regression)
 *   (g) exit code missing/undefined              → false
 */

import { describe, it, expect } from 'vitest'
import {
  isCommandMissing,
  type RunResult,
} from '../../../../src/broker/services/quality-gate-arbiter.js'

function err(
  code: number | undefined,
  stdout = '',
  stderr = '',
): RunResult {
  return { ok: false, code: code as number, stdout, stderr }
}

describe('isCommandMissing — exit-code-only matcher (Phase 13.12.30)', () => {
  it('returns false for ok results regardless of code/output', () => {
    expect(
      isCommandMissing({
        ok: true,
        stdout: 'vitest: command not found',
        stderr: 'eslint: command not found',
      } as RunResult),
    ).toBe(false)
  })

  it('returns true for exit 127 (shell "command not found")', () => {
    expect(isCommandMissing(err(127, '', 'sh: vitest: command not found'))).toBe(true)
  })

  it('returns true for exit 126 (shell "found but not executable")', () => {
    expect(isCommandMissing(err(126, '', 'sh: vitest: Permission denied'))).toBe(true)
  })

  // ── Regression cases — qc=4f7e7f48 ─────────────────────────────────

  it('returns false for exit 1 + vitest fixture text in STDOUT (regression)', () => {
    // This is the failure mode that produced the misleading verdict
    // in qc=4f7e7f48. Vitest dumps the source of the failing test —
    // which contains "vitest: command not found" as a literal string
    // used to drive bridge tests — into its own stdout. The old
    // implementation matched the substring and reported the verdict
    // as tooling-missing even though vitest was fully resolved.
    const stdout = `
      FAIL  test/unit/broker/services/quality-gate-arbiter.bridge.test.ts
        > bridge verifies vitest/eslint resolve
        Expected: { ok: true }
        Received: stderr 'sh: vitest: command not found'
        at line 42
    `
    expect(isCommandMissing(err(1, stdout, ''))).toBe(false)
  })

  it('returns false for exit 1 + vitest fixture text in STDERR (regression)', () => {
    const stderr = `
      AssertionError: expected verdict to fire with stderr matching
      "sh: eslint: command not found", got "sh: vitest: command not found"
    `
    expect(isCommandMissing(err(1, '', stderr))).toBe(false)
  })

  it('returns false for exit 1 with all three legacy haystack signals (regression)', () => {
    // The previous matcher would have fired on ANY of these substrings
    // appearing anywhere in stdout+stderr. None of them should produce
    // a tooling-missing classification when the actual exit code is 1.
    const out = 'eslint: command not found / nothing: not found / ENOENT here'
    expect(isCommandMissing(err(1, out, out))).toBe(false)
  })

  it('returns false when exit code is undefined / not numeric', () => {
    expect(isCommandMissing({ ok: false, stdout: '', stderr: '' } as RunResult)).toBe(false)
  })
})
