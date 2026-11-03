import type { SuggestionCandidate, PatternSources } from './types.js'
import type { Evidence } from '../types.js'

const MIN_COMMITS = 5

export function extractGithubActionSuggestions(
  sources: PatternSources,
): readonly SuggestionCandidate[] {
  const { observations } = sources
  if (!observations) {
    return []
  }

  const candidates: SuggestionCandidate[] = []
  const now = new Date().toISOString()
  const emittedRepos = new Set<string>()

  for (const repo of observations.topRepos) {
    if (emittedRepos.has(repo)) continue

    const commitCount = observations.repoCounts.get(repo) ?? 0
    if (commitCount < MIN_COMMITS) continue

    const evidence: Evidence[] = [
      {
        source: 'observation-project-focus',
        detail: `${commitCount} commits in ${repo} within observation window`,
        observedAt: now,
        weight: Math.min(1, commitCount / 20),
      },
    ]

    if (observations.recentFocus === repo) {
      evidence.push({
        source: 'observation-project-focus',
        detail: `${repo} is your recent focus project`,
        observedAt: now,
        weight: 0.6,
      })
    }

    // Check for test-related file patterns suggesting CI opportunity.
    // Note: extname() only returns the final extension (e.g., '.ts' for 'foo.test.ts'),
    // so we check for the presence of common test/spec source extensions.
    const testExtensions = ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go']
    const hasSourceFiles = testExtensions.some(
      (ext) => (observations.fileTypeCounts.get(ext) ?? 0) > 0,
    )

    const actionType = hasSourceFiles ? 'CI/CD with test' : 'CI/CD'

    candidates.push({
      type: 'github-action',
      title: `Create ${actionType} workflow for ${repo}`,
      description:
        `You have ${commitCount} commits in ${repo}. ` +
        `A GitHub Actions workflow could automate builds, tests, and deployment ` +
        `for this active repository.`,
      evidence,
      tags: ['github-action', 'ci-cd', repo],
      observationCount: commitCount,
      windowDays: 7,
    })

    emittedRepos.add(repo)
  }

  return candidates
}
