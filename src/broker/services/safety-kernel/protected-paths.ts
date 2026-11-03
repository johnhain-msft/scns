/**
 * WS-0 Safety Kernel — protected paths (Gate 3, non-self-editable).
 *
 * SINGLE source of truth for "is this file part of the immutable kernel?".
 * Consumed by:
 *   - auto-merger.ts            → absolute `no-safety-kernel-edit` gate (no override)
 *   - qg-changeset-classifier.ts → flags kernel-touching changesets as qg-infra
 *   - quality-gate-arbiter.ts    → `kernel-self-edit` pre-commit reject
 *
 * Editing the kernel or the allowlist therefore requires a human (these
 * paths can never auto-merge). Pure string module — no runtime deps — so
 * the QG-infra files can import it without cycles.
 */

/** Directory prefix: every file under here is kernel-protected. */
export const SAFETY_KERNEL_DIR_PREFIX = 'src/broker/services/safety-kernel/'

/** The human-owned egress/spend allowlist (ships EMPTY = deny-all). */
export const SAFETY_ALLOWLIST_PATH = 'config/safety-allowlist.json'

/** Exact paths that are kernel-protected in addition to the dir prefix. */
export const SAFETY_KERNEL_PROTECTED_EXACT: readonly string[] = [SAFETY_ALLOWLIST_PATH]

/**
 * True iff `file` (a repo-relative path from `git diff --name-only`) is part
 * of the immutable safety kernel. Exact-match for listed files, prefix-match
 * for the kernel directory. Case-sensitive (filesystem semantics).
 */
export function isSafetyKernelPath(file: string): boolean {
  if (!file) return false
  if (SAFETY_KERNEL_PROTECTED_EXACT.includes(file)) return true
  return file.startsWith(SAFETY_KERNEL_DIR_PREFIX)
}
