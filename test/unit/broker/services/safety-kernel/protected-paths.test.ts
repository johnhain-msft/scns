/**
 * WS-0 Safety Kernel — protected-paths predicate tests.
 *
 * `isSafetyKernelPath` is the SINGLE source of truth for "is this file
 * part of the immutable kernel?" — consumed by the auto-merger (absolute,
 * no-override gate), the QG changeset classifier, and the QG arbiter's
 * kernel-self-edit reject. Gate 3 (non-self-editable) hinges on it.
 */
import { describe, it, expect } from 'vitest'
import {
  isSafetyKernelPath,
  SAFETY_KERNEL_DIR_PREFIX,
  SAFETY_ALLOWLIST_PATH,
} from '../../../../../src/broker/services/safety-kernel/protected-paths.js'

describe('protected-paths: isSafetyKernelPath', () => {
  it('matches every file under the safety-kernel directory prefix', () => {
    for (const f of [
      `${SAFETY_KERNEL_DIR_PREFIX}safety-kernel.ts`,
      `${SAFETY_KERNEL_DIR_PREFIX}kernel-policy.ts`,
      `${SAFETY_KERNEL_DIR_PREFIX}kernel-audit.ts`,
      `${SAFETY_KERNEL_DIR_PREFIX}egress-signatures.ts`,
      `${SAFETY_KERNEL_DIR_PREFIX}a/deeply/nested/future-file.ts`,
    ]) {
      expect(isSafetyKernelPath(f)).toBe(true)
    }
  })

  it('matches the human-owned allowlist file exactly', () => {
    expect(isSafetyKernelPath(SAFETY_ALLOWLIST_PATH)).toBe(true)
  })

  it('does NOT match ordinary source / test / docs paths', () => {
    for (const f of [
      'src/cli.ts',
      'src/broker/services/auto-merger.ts',
      'src/broker/services/quality-gate-arbiter.ts',
      'test/unit/broker/services/safety-kernel/kernel-policy.test.ts',
      'docs/safety-kernel.md',
      'README.md',
    ]) {
      expect(isSafetyKernelPath(f)).toBe(false)
    }
  })

  it('rejects empty/whitespace and substring-only lookalikes', () => {
    expect(isSafetyKernelPath('')).toBe(false)
    expect(isSafetyKernelPath('   ')).toBe(false)
    expect(isSafetyKernelPath('docs/src/broker/services/safety-kernel/x.md')).toBe(false)
    expect(isSafetyKernelPath('config/safety-allowlist.json.bak')).toBe(false)
  })
})
