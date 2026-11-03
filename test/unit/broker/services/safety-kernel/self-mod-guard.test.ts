/**
 * WS-0 Safety Kernel — Gate 3 (non-self-editable) self-mod guard tests.
 *
 * RED-TEAM:
 *   N4  a branch that adds/edits a kernel or allowlist file is AUTO-REJECTED
 *       by the auto-merger via an ABSOLUTE gate (`no-safety-kernel-edit`)
 *       that has NO override (fails even with allowQgInfraMerge=true).
 *   N5  the QG changeset classifier flags any kernel-touching changeset as
 *       `qg-infra` (defense-in-depth; the QG arbiter reuses
 *       `isSafetyKernelPath` for its kernel-self-edit reject).
 */
import { describe, it, expect } from 'vitest'
import {
  evaluateSafetyGates,
  DEFAULT_FORBIDDEN_FILES,
} from '../../../../../src/broker/services/auto-merger.js'
import type { RunResult } from '../../../../../src/broker/services/quality-gate-arbiter.js'
import { classifyChangeset } from '../../../../../src/broker/services/qg-changeset-classifier.js'
import {
  isSafetyKernelPath,
  SAFETY_KERNEL_DIR_PREFIX,
  SAFETY_ALLOWLIST_PATH,
} from '../../../../../src/broker/services/safety-kernel/protected-paths.js'

function ok(stdout: string, stderr = ''): RunResult {
  return { ok: true, stdout, stderr }
}
function err(code: number, stdout = '', stderr = ''): RunResult {
  return { ok: false, stdout, stderr, code }
}
function fakeRun(router: (cmd: string) => RunResult): (cmd: string, cwd: string) => RunResult {
  return (cmd: string) => router(cmd)
}

/** Router where the ONLY anomaly is that the diff touches `changed` files. */
function routerTouching(changed: string[]): (cmd: string) => RunResult {
  const treeLines =
    changed.map((f) => `100644 blob deadbeef\t${f}`).join('\n') +
    '\n100644 blob abc12345\ttest/feature.test.ts\n'
  return (cmd: string) => {
    if (cmd.startsWith('git rev-parse main')) return ok('1234abcd5678efef9012345678901234567890ab\n')
    if (cmd.startsWith('git rev-parse "')) return ok('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')
    if (cmd.startsWith('git ls-tree')) return ok(treeLines)
    if (cmd.startsWith('git diff --name-only')) return ok([...changed, 'test/feature.test.ts'].join('\n') + '\n')
    if (cmd.includes('-- .github/copilot-instructions.md')) return ok('')
    if (cmd.startsWith('git diff --numstat')) return ok('3\t1\t' + (changed[0] ?? 'x') + '\n4\t0\ttest/feature.test.ts\n')
    return err(1, '', 'unexpected cmd: ' + cmd)
  }
}

const OPTS = { maxDiffLines: 500, forbiddenFiles: DEFAULT_FORBIDDEN_FILES }

describe('Gate 3 — auto-merger no-safety-kernel-edit (absolute, no override)', () => {
  it('N4: rejects a branch that edits a kernel source file', () => {
    const res = evaluateSafetyGates(
      fakeRun(routerTouching([`${SAFETY_KERNEL_DIR_PREFIX}kernel-policy.ts`])),
      'scns/auto/x',
      '/repo',
      OPTS,
    )
    expect(res.ok).toBe(false)
    const gate = res.outcomes.find((o) => o.gate === 'no-safety-kernel-edit')
    expect(gate?.passed).toBe(false)
  })

  it('N4: rejects a branch that edits the human-owned allowlist file', () => {
    const res = evaluateSafetyGates(
      fakeRun(routerTouching([SAFETY_ALLOWLIST_PATH])),
      'scns/auto/x',
      '/repo',
      OPTS,
    )
    expect(res.ok).toBe(false)
    expect(res.outcomes.find((o) => o.gate === 'no-safety-kernel-edit')?.passed).toBe(false)
  })

  it('N4: the kernel gate is ABSOLUTE — still fails with allowQgInfraMerge override', () => {
    const res = evaluateSafetyGates(
      fakeRun(routerTouching([`${SAFETY_KERNEL_DIR_PREFIX}safety-kernel.ts`])),
      'scns/auto/x',
      '/repo',
      { ...OPTS, allowQgInfraMerge: true },
    )
    expect(res.ok).toBe(false)
    expect(res.outcomes.find((o) => o.gate === 'no-safety-kernel-edit')?.passed).toBe(false)
  })

  it('passes the kernel gate for an ordinary (non-kernel) branch', () => {
    const res = evaluateSafetyGates(
      fakeRun(routerTouching(['src/feature.ts'])),
      'scns/auto/x',
      '/repo',
      OPTS,
    )
    const gate = res.outcomes.find((o) => o.gate === 'no-safety-kernel-edit')
    expect(gate?.passed).toBe(true)
  })
})

describe('Gate 3 — QG changeset classifier covers the kernel (N5)', () => {
  it('classifies a kernel-touching changeset as qg-infra', () => {
    const c = classifyChangeset(['src/cli.ts', `${SAFETY_KERNEL_DIR_PREFIX}kernel-audit.ts`])
    expect(c.kind).toBe('qg-infra')
    expect(c.qgInfraFiles).toContain(`${SAFETY_KERNEL_DIR_PREFIX}kernel-audit.ts`)
  })
  it('classifies the allowlist file as qg-infra', () => {
    const c = classifyChangeset([SAFETY_ALLOWLIST_PATH])
    expect(c.kind).toBe('qg-infra')
  })
  it('isSafetyKernelPath agrees with the classifier on kernel paths', () => {
    expect(isSafetyKernelPath(`${SAFETY_KERNEL_DIR_PREFIX}kernel-audit.ts`)).toBe(true)
    expect(isSafetyKernelPath('src/cli.ts')).toBe(false)
  })
})
