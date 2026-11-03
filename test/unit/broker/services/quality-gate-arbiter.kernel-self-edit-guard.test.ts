/**
 * WS-0 Gate 3 (layer 3) — QG arbiter `kernel-self-edit` pre-commit reject.
 *
 * The immutable safety kernel is protected by THREE independent layers:
 *   1) auto-merger `no-safety-kernel-edit` (absolute, no override)   [self-mod-guard.test.ts]
 *   2) qg-changeset-classifier flags kernel touches as `qg-infra`    [self-mod-guard.test.ts]
 *   3) THIS: the QG arbiter refuses to even commit a branch whose staged diff
 *      touches a kernel/allowlist path (`finishFail(..., 'kernel-self-edit')`).
 *
 * The arbiter's reject consumes `detectStagedKernelEdits`, a pure parser over
 * `git diff --cached --name-only` (mirrors `detectStagedSymlinks`). These tests
 * pin that parser so layer 3 has real coverage, not verified-by-reading only.
 */
import { describe, it, expect } from 'vitest'
import {
  detectStagedKernelEdits,
  type RunResult,
} from '../../../../src/broker/services/quality-gate-arbiter.js'
import {
  SAFETY_KERNEL_DIR_PREFIX,
  SAFETY_ALLOWLIST_PATH,
} from '../../../../src/broker/services/safety-kernel/protected-paths.js'

function ok(stdout: string, stderr = ''): RunResult {
  return { ok: true, stdout, stderr }
}
function err(code: number, stdout = '', stderr = ''): RunResult {
  return { ok: false, stdout, stderr, code }
}
/** A run() that returns `diffOut` for the staged-name diff and errors otherwise. */
function runWithDiff(diffOut: string): (cmd: string, cwd: string) => RunResult {
  return (cmd: string) =>
    cmd.startsWith('git diff --cached --name-only') ? ok(diffOut) : err(1, '', 'unexpected: ' + cmd)
}

describe('detectStagedKernelEdits — QG arbiter Gate 3 layer 3 (pure parser)', () => {
  it('returns [] for an ordinary (non-kernel) staged diff', () => {
    const run = runWithDiff('src/feature.ts\ntest/feature.test.ts\nREADME.md\n')
    expect(detectStagedKernelEdits(run, '/wt')).toEqual([])
  })

  it('N5b: flags a staged kernel SOURCE file', () => {
    const run = runWithDiff(`src/cli.ts\n${SAFETY_KERNEL_DIR_PREFIX}kernel-policy.ts\n`)
    expect(detectStagedKernelEdits(run, '/wt')).toEqual([`${SAFETY_KERNEL_DIR_PREFIX}kernel-policy.ts`])
  })

  it('N5b: flags the human-owned allowlist file', () => {
    const run = runWithDiff(`${SAFETY_ALLOWLIST_PATH}\n`)
    expect(detectStagedKernelEdits(run, '/wt')).toEqual([SAFETY_ALLOWLIST_PATH])
  })

  it('returns ALL kernel paths when several are staged (mixed with ordinary files)', () => {
    const run = runWithDiff(
      `src/x.ts\n${SAFETY_KERNEL_DIR_PREFIX}safety-kernel.ts\n${SAFETY_KERNEL_DIR_PREFIX}kernel-audit.ts\n${SAFETY_ALLOWLIST_PATH}\ntest/x.test.ts\n`,
    )
    expect(detectStagedKernelEdits(run, '/wt')).toEqual([
      `${SAFETY_KERNEL_DIR_PREFIX}safety-kernel.ts`,
      `${SAFETY_KERNEL_DIR_PREFIX}kernel-audit.ts`,
      SAFETY_ALLOWLIST_PATH,
    ])
  })

  it('trims whitespace and ignores blank lines', () => {
    const run = runWithDiff(`\n  ${SAFETY_KERNEL_DIR_PREFIX}index.ts  \n\n`)
    expect(detectStagedKernelEdits(run, '/wt')).toEqual([`${SAFETY_KERNEL_DIR_PREFIX}index.ts`])
  })

  it('returns [] (fail-safe) when the git diff command itself fails', () => {
    const run = (): RunResult => err(128, '', 'fatal: not a git repository')
    expect(detectStagedKernelEdits(run, '/wt')).toEqual([])
  })

  it('does NOT match the kernel test dir (test/…/safety-kernel/ is not the protected src kernel)', () => {
    const run = runWithDiff('test/unit/broker/services/safety-kernel/kernel-policy.test.ts\n')
    expect(detectStagedKernelEdits(run, '/wt')).toEqual([])
  })
})

// ── T052 [US5] (specs/001-learning-memory-loop) — NO automated loop/arbiter can touch a guardrail ─
// Layer-3 pins the QG arbiter's staged-diff reject above; this extends the guarantee to the
// AUTOMATED WRITERS this feature introduced: the evidence arbiter's policy commit (the only file an
// automated promotion may write) refuses guardrail targets outright, and the certified-evidence
// validator refuses everything uncertified — so "an automated loop edits the kernel/allowlist" has
// no code path (FR-022/FR-027).
import { commitRoutingPolicy } from '../../../../src/memory/routing-policy.js'

describe('T052 — the evidence arbiter (an automated loop) is refused on every guardrail path', () => {
  const CERT = {
    arm: 'magma' as const,
    committedAt: '2026-07-06T00:00:00.000Z',
    evidence: {
      deltaAcc: 0.1,
      sigma: 0.0267,
      hcopeLowerBound: 0.05,
      controlsPass: true,
      negControlN: 6,
      meanTokensDelta: -10,
      deterministicRuns: 2,
      gate: 'arm-frontier-accuracy',
      heldOut: true,
    },
  }

  it('refuses the exact allowlist file and ANY kernel-dir path — even with fully-certified evidence', () => {
    for (const p of [
      SAFETY_ALLOWLIST_PATH,
      `${SAFETY_KERNEL_DIR_PREFIX}kernel-policy.ts`,
      `/repo/${SAFETY_ALLOWLIST_PATH}`,
      `/repo/${SAFETY_KERNEL_DIR_PREFIX}anything.json`,
    ]) {
      const res = commitRoutingPolicy(p, CERT)
      expect(res.committed, p).toBe(false)
      expect(res.reason, p).toMatch(/safety|guardrail/i)
    }
  })
})
