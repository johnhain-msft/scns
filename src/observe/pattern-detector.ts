import type { Observation } from './types.js'
import { basename } from 'node:path'

// ── Public interfaces ────────────────────────────────────────────────

export interface WorkSchedulePattern {
  readonly activeHours: readonly number[]
  readonly peakHour: number
  readonly averageSessionMinutes: number
  readonly breakGaps: readonly number[]
  readonly activeDays: readonly number[]
}

export interface ToolFrequencyPattern {
  readonly appCounts: ReadonlyMap<string, number>
  readonly topApps: readonly string[]
  readonly categoryBreakdown: ReadonlyMap<string, number>
}

export interface ProjectFocusPattern {
  readonly repoCounts: ReadonlyMap<string, number>
  readonly topRepos: readonly string[]
  readonly fileTypeCounts: ReadonlyMap<string, number>
  readonly recentFocus: string | null
  /**
   * Per-repo development-activity counts (basename-keyed): git commits PLUS
   * file-change events. Broader than `repoCounts` (git-only) so a repo under
   * active editing is visible even during a commit freeze.
   */
  readonly repoActivityCounts: ReadonlyMap<string, number>
}

export interface DetectedPatterns {
  readonly workSchedule: WorkSchedulePattern | null
  readonly toolFrequency: ToolFrequencyPattern | null
  readonly projectFocus: ProjectFocusPattern | null
  readonly observationCount: number
  readonly windowStart: string
  readonly windowEnd: string
}

export interface PatternDetectorOptions {
  readonly windowHours?: number
  readonly minObservations?: number
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_WINDOW_HOURS = 168
const DEFAULT_MIN_OBSERVATIONS = 10
const BREAK_THRESHOLD_MINUTES = 30

const CODING_APPS = new Set(['VSCode', 'Cursor', 'Xcode', 'IntelliJ'])
const BROWSING_APPS = new Set(['Chrome', 'Safari', 'Arc', 'Firefox'])
const COMMUNICATION_APPS = new Set(['Slack', 'Discord', 'Teams'])
const TERMINAL_APPS = new Set(['Terminal', 'iTerm', 'iTerm2', 'Warp', 'Alacritty'])

// ── Helpers ──────────────────────────────────────────────────────────

function categorizeApp(name: string): string {
  if (CODING_APPS.has(name)) return 'coding'
  if (BROWSING_APPS.has(name)) return 'browsing'
  if (COMMUNICATION_APPS.has(name)) return 'communication'
  if (TERMINAL_APPS.has(name)) return 'terminal'
  return 'other'
}

function sortedTimestamps(observations: readonly Observation[]): number[] {
  return observations.map((o) => new Date(o.timestamp).getTime()).sort((a, b) => a - b)
}

function topN<K>(map: ReadonlyMap<K, number>, n: number): K[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k)
}

function incrementMap<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function filterByWindow(
  observations: readonly Observation[],
  windowHours: number,
): readonly Observation[] {
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000
  return observations.filter((o) => new Date(o.timestamp).getTime() >= cutoff)
}

// ── Detection functions ──────────────────────────────────────────────

function analyzeWorkSchedule(
  observations: readonly Observation[],
  minObs: number,
): WorkSchedulePattern | null {
  if (observations.length < minObs) return null

  const hourCounts = new Map<number, number>()
  const dayCounts = new Map<number, number>()

  for (const obs of observations) {
    const d = new Date(obs.timestamp)
    incrementMap(hourCounts, d.getUTCHours())
    incrementMap(dayCounts, d.getUTCDay())
  }

  const activeHours = [...hourCounts.keys()].sort((a, b) => a - b)
  const activeDays = [...dayCounts.keys()].sort((a, b) => a - b)

  let peakHour = 0
  let peakCount = 0
  for (const [hour, count] of hourCounts) {
    if (count > peakCount) {
      peakCount = count
      peakHour = hour
    }
  }

  // Session / break analysis
  const sorted = sortedTimestamps(observations)
  const breakGaps: number[] = []
  const sessionLengths: number[] = []
  let sessionStart = sorted[0]!
  let prev = sorted[0]!

  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i]!
    const gap = (t - prev) / 60_000
    if (gap > BREAK_THRESHOLD_MINUTES) {
      sessionLengths.push((prev - sessionStart) / 60_000)
      breakGaps.push(Math.round(gap))
      sessionStart = t
    }
    prev = t
  }
  // Close last session
  sessionLengths.push((prev - sessionStart) / 60_000)

  const averageSessionMinutes =
    sessionLengths.length > 0
      ? Math.round(sessionLengths.reduce((a, b) => a + b, 0) / sessionLengths.length)
      : 0

  return {
    activeHours,
    peakHour,
    averageSessionMinutes,
    breakGaps,
    activeDays,
  }
}

function analyzeToolFrequency(observations: readonly Observation[]): ToolFrequencyPattern | null {
  const appObs = observations.filter((o) => o.type === 'active-app')
  if (appObs.length === 0) return null

  const appCounts = new Map<string, number>()
  const categoryBreakdown = new Map<string, number>()

  for (const obs of appObs) {
    incrementMap(appCounts, obs.source)
    incrementMap(categoryBreakdown, categorizeApp(obs.source))
  }

  return {
    appCounts,
    topApps: topN(appCounts, 5),
    categoryBreakdown,
  }
}

function analyzeProjectFocus(observations: readonly Observation[]): ProjectFocusPattern | null {
  const gitObs = observations.filter((o) => o.type === 'git-activity')
  const fileObs = observations.filter((o) => o.type === 'file-change')

  if (gitObs.length === 0 && fileObs.length === 0) return null

  const repoCounts = new Map<string, number>()
  for (const obs of gitObs) {
    incrementMap(repoCounts, obs.source)
  }

  // Combined dev-activity (git commits + file-change events), keyed by repo
  // basename so a repo under active editing is visible even with zero commits.
  // git `source` is already a repo basename; file-change `source` is a watched
  // directory path, so basename it to the repo/dir name.
  const repoActivityCounts = new Map<string, number>()
  for (const obs of gitObs) {
    incrementMap(repoActivityCounts, basename(obs.source))
  }
  for (const obs of fileObs) {
    incrementMap(repoActivityCounts, basename(obs.source))
  }

  const fileTypeCounts = new Map<string, number>()
  for (const obs of fileObs) {
    const extTag = obs.tags.find((t) => t.startsWith('ext:'))
    if (extTag) {
      incrementMap(fileTypeCounts, extTag.slice(4))
    }
  }

  const topRepos = topN(repoCounts, 10)

  // Recent focus: most active repo in last 24h of the observation window
  let recentFocus: string | null = null
  if (gitObs.length > 0) {
    const allSorted = sortedTimestamps(observations)
    const windowEnd = allSorted[allSorted.length - 1]!
    const recentCutoff = windowEnd - 24 * 60 * 60 * 1000

    const recentRepoCounts = new Map<string, number>()
    for (const obs of gitObs) {
      if (new Date(obs.timestamp).getTime() > recentCutoff) {
        incrementMap(recentRepoCounts, obs.source)
      }
    }
    if (recentRepoCounts.size > 0) {
      recentFocus = topN(recentRepoCounts, 1)[0] ?? null
    }
  }

  return { repoCounts, topRepos, fileTypeCounts, recentFocus, repoActivityCounts }
}

// ── Factory ──────────────────────────────────────────────────────────

export function createPatternDetector(options?: PatternDetectorOptions) {
  const windowHours = options?.windowHours ?? DEFAULT_WINDOW_HOURS
  const minObservations = options?.minObservations ?? DEFAULT_MIN_OBSERVATIONS

  return {
    detect(observations: readonly Observation[]): DetectedPatterns {
      const filtered = filterByWindow(observations, windowHours)

      if (filtered.length === 0) {
        return {
          workSchedule: null,
          toolFrequency: null,
          projectFocus: null,
          observationCount: 0,
          windowStart: '',
          windowEnd: '',
        }
      }

      const sorted = sortedTimestamps(filtered)
      const windowStart = new Date(sorted[0]!).toISOString()
      const windowEnd = new Date(sorted[sorted.length - 1]!).toISOString()

      return {
        workSchedule: analyzeWorkSchedule(filtered, minObservations),
        toolFrequency: analyzeToolFrequency(filtered),
        projectFocus: analyzeProjectFocus(filtered),
        observationCount: filtered.length,
        windowStart,
        windowEnd,
      }
    },

    detectWorkSchedule(observations: readonly Observation[]): WorkSchedulePattern | null {
      return analyzeWorkSchedule(observations, minObservations)
    },

    detectToolFrequency(observations: readonly Observation[]): ToolFrequencyPattern | null {
      return analyzeToolFrequency(observations)
    },

    detectProjectFocus(observations: readonly Observation[]): ProjectFocusPattern | null {
      return analyzeProjectFocus(observations)
    },
  }
}
