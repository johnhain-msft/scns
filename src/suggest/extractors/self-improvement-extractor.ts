/**
 * Gap 4 (prong b) — self-improvement extractor.
 *
 * When the user is actively developing the SCNS repo itself, propose
 * actionable improvements to SCNS's own agents/flows/prompts. The
 * candidates are typed `agentic-workflow` (actionable in
 * `actionableShape`, so the now-working delivery loop can implement
 * them) and tagged `self-improvement` / `scns-self-improvement` for
 * filtering. Cross-cycle de-duplication is handled by the generator's
 * template-family dedupe policy, so re-emitting the same seeds every
 * cycle is safe.
 */

import type { SuggestionCandidate, PatternSources } from './types.js'
import type { Evidence } from '../types.js'

/** A repo whose active development should trigger SCNS self-improvement proposals. */
const SCNS_REPO_RE = /(^|[/\\])scns$/i

/** Minimum commits in the SCNS repo (within the observation window) to act. */
const MIN_SCNS_COMMITS = 3

/**
 * Minimum combined dev-activity events (git commits + file-change events) in the
 * SCNS repo to act. This broader signal lets self-improvement activate on real
 * editing activity even during a commit freeze, when the git-commit count is 0.
 * File-change events are noisier than commits, hence a higher threshold.
 */
const MIN_SCNS_ACTIVITY = 8

export interface ScnsSelfImprovementSeed {
  /** Short, stable tag fragment (also used as a dedupe family hint). */
  readonly tag: string
  readonly title: string
  readonly description: string
}

/**
 * Curated, concrete improvements to SCNS itself that the delivery loop
 * can implement (each is small and naturally test-coverable, satisfying
 * the auto-merge `has-test-coverage` gate). Keep this list short and
 * high-signal — every entry is re-proposed whenever SCNS is under
 * active development (deduped by template family).
 */
export const SCNS_SELF_IMPROVEMENT_SEEDS: readonly ScnsSelfImprovementSeed[] = [
  {
    tag: 'dev-prompt-staging',
    title: 'Strengthen scns-dev prompt: require a final `git add -A` before exit',
    description:
      'The scns-dev implementer prompt should make the final `git add -A` an ' +
      'explicit, mandatory exit step (with a self-check that `git diff --cached` ' +
      'is non-empty) so staged work is never left behind. Update ' +
      'src/cli/team-member-prompts.ts (buildImplementerPrompt) and add a test ' +
      'asserting the prompt contains the mandatory final-stage instruction.',
  },
  {
    tag: 'watchdog-env-docs',
    title: 'Document the external health-watchdog env knobs and kill-switch',
    description:
      'Add documentation + a test covering the `scns watchdog run` options ' +
      '(--max-timeouts, --cooldown-ms, --grace-ms) and the ' +
      '~/.scns/watchdog.disabled / SCNS_WATCHDOG_DISABLED kill-switch, so the ' +
      'external watchdog is discoverable and operable.',
  },
  {
    tag: 'worktree-cleanup-metric',
    title: 'Emit a structured event when a per-team worktree is reclaimed',
    description:
      'team-worktree-manager.removeWorktreeForTeam should emit a structured ' +
      'event (e.g. worktree_reclaimed) so operators can audit worktree ' +
      'lifecycle. Add the emission behind the existing eventLog sink and a ' +
      'unit test asserting it fires on cleanup.',
  },
]

export function extractSelfImprovementSuggestions(
  sources: PatternSources,
): readonly SuggestionCandidate[] {
  const observations = sources.observations
  if (!observations) return []

  // Primary signal: fresh git commits in the SCNS repo.
  const scnsRepo = observations.topRepos.find(
    (r) => SCNS_REPO_RE.test(r) && (observations.repoCounts.get(r) ?? 0) >= MIN_SCNS_COMMITS,
  )
  const commits = scnsRepo ? (observations.repoCounts.get(scnsRepo) ?? 0) : 0

  // Broadened signal: combined dev activity (commits + file-change events) in the
  // SCNS repo — fires on real editing even during a commit freeze. Falls back to
  // the git-only counts when the broader signal is unavailable.
  const activityCounts = observations.repoActivityCounts ?? observations.repoCounts
  let activityRepo: string | undefined
  let activity = 0
  for (const [repo, count] of activityCounts) {
    if (SCNS_REPO_RE.test(repo) && count >= MIN_SCNS_ACTIVITY && count > activity) {
      activityRepo = repo
      activity = count
    }
  }

  if (!scnsRepo && !activityRepo) return []

  const focusRepo = scnsRepo ?? activityRepo!
  const now = new Date().toISOString()
  const detail =
    commits >= MIN_SCNS_COMMITS
      ? `${commits} commits in ${focusRepo} — SCNS is under active development; aim self-improvement at SCNS itself`
      : `${activity} dev-activity events (commits + file edits) in ${focusRepo} — SCNS is under active development; aim self-improvement at SCNS itself`
  const observationCount = Math.max(commits, activity)
  const evidence: readonly Evidence[] = [
    {
      source: 'observation-project-focus',
      detail,
      observedAt: now,
      weight: Math.min(1, observationCount / 20),
    },
  ]

  return SCNS_SELF_IMPROVEMENT_SEEDS.map((seed) => ({
    type: 'agentic-workflow' as const,
    title: seed.title,
    description: seed.description,
    evidence,
    tags: ['self-improvement', 'scns-self-improvement', seed.tag],
    observationCount,
    windowDays: 7,
  }))
}
