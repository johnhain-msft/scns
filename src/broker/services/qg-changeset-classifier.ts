/**
 * Phase 13.12.34 — QG Changeset Classifier.
 *
 * Closes the structural chicken-and-egg: when a diff modifies the QG
 * arbiter or its sibling broker-plumbing files, the QG cannot validate
 * its own fix without first running the (potentially-broken) version
 * of itself. Postmortem (team ca3ecfec, 2026-05-15): the verdict-PASS
 * cycles that produced poison-pill branches WERE running through the
 * deadlocked QG runner; the system had no way to recognize that the
 * gate gating its own fix was itself the thing being fixed.
 *
 * This classifier identifies "QG-infrastructure changes" — diffs that
 * touch the core feedback-loop machinery — so that downstream services
 * (the auto-merger, the future lite-QG runner) can route them
 * differently. The decision is intentionally simple and conservative:
 * if ANY changed file is in the QG-infra set, the whole changeset
 * classifies as `qg-infra` and the caller MUST require explicit human
 * approval (or a hardcoded operator override) before landing it.
 *
 * The set is hand-curated. It is NOT auto-derived from filesystem
 * heuristics because the cost of a false negative (allowing auto-merge
 * of a broken QG fix) is far higher than the cost of a false positive
 * (requiring human review of a change that happened to match).
 */

import {
  SAFETY_KERNEL_DIR_PREFIX,
  SAFETY_ALLOWLIST_PATH,
} from './safety-kernel/protected-paths.js'

// ── Public types ─────────────────────────────────────────────────────

export type ChangesetKind = 'qg-infra' | 'ordinary'

export interface ChangesetClassification {
  readonly kind: ChangesetKind
  readonly qgInfraFiles: readonly string[]
  readonly otherFiles: readonly string[]
}

// ── The QG-infrastructure file set ───────────────────────────────────

/**
 * Exact paths whose modification triggers the QG-infrastructure
 * classification. Match is by exact-string equality against the file
 * paths returned by `git diff --name-only`.
 */
export const QG_INFRA_EXACT_PATHS: readonly string[] = [
  'src/broker/services/quality-gate-arbiter.ts',
  'src/broker/services/quality-checker.ts',
  'src/broker/services/auto-dispatch.ts',
  'src/broker/services/team-task-autospawner.ts',
  'src/broker/services/task-completion-gate.ts',
  'src/broker/services/gate-evidence.ts',
  'src/broker/services/self-improve-followup-creator.ts',
  'src/broker/services/auto-merger.ts',
  'src/broker/services/manager-exit-monitor.ts',
  'src/broker/services/team-lifecycle.ts',
  'src/broker/services/team-reaper.ts',
  'src/broker/services/event-log.ts',
  'src/broker/event-dispatcher.ts',
  'src/broker/startup.ts',
  'scripts/broker-restart.sh',
  // WS-0 — the human-owned safety-kernel allowlist is QG-infra (defense-in-
  // depth; the auto-merger's absolute no-safety-kernel-edit gate is the hard
  // stop). Editing it requires a human.
  SAFETY_ALLOWLIST_PATH,
]

/**
 * Prefix patterns: any path starting with one of these is QG-infra.
 * Used for sub-tree matches where listing every file would be noisy.
 */
export const QG_INFRA_PREFIXES: readonly string[] = [
  'src/broker/services/quality-gate-',
  // WS-0 — the entire immutable safety kernel is QG-infra.
  SAFETY_KERNEL_DIR_PREFIX,
]

// ── Classifier (pure function) ───────────────────────────────────────

/**
 * Classify a list of changed file paths. The whole changeset
 * classifies as `qg-infra` if ANY file matches the QG-infra set;
 * otherwise it is `ordinary`. The breakdown lists are useful for
 * audit-event payloads and human-readable rejection messages.
 *
 * Empty input returns `ordinary` with empty lists.
 */
export function classifyChangeset(
  changedFiles: readonly string[],
): ChangesetClassification {
  const qgInfraFiles: string[] = []
  const otherFiles: string[] = []

  for (const file of changedFiles) {
    if (!file) continue
    if (isQgInfraPath(file)) {
      qgInfraFiles.push(file)
    } else {
      otherFiles.push(file)
    }
  }

  return {
    kind: qgInfraFiles.length > 0 ? 'qg-infra' : 'ordinary',
    qgInfraFiles,
    otherFiles,
  }
}

/**
 * Exported single-path predicate. Useful for callers that only need
 * to check one path (e.g., a streaming consumer).
 */
export function isQgInfraPath(file: string): boolean {
  if (QG_INFRA_EXACT_PATHS.includes(file)) return true
  for (const prefix of QG_INFRA_PREFIXES) {
    if (file.startsWith(prefix)) return true
  }
  return false
}
