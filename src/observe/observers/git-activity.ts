/**
 * Git activity observer — polls git repositories for new commits and branches.
 */

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { basename, resolve } from 'node:path'
import type { Observer } from '../observer.js'
import { ObservationType } from '../types.js'
import type { Observation, ObserverConfig } from '../types.js'
import { buildTags } from '../tags.js'
import type { createDailyLogWriter } from '../daily-log-writer.js'
import type { createPrivacyFilter } from '../privacy-filter.js'
import { logger } from '../../shared/logger.js'

export interface GitCommit {
  readonly hash: string
  readonly author: string
  readonly date: string
  readonly message: string
  readonly filesChanged: number
}

export interface GitClient {
  log(repoPath: string, since: string, maxCount?: number): Promise<GitCommit[]>
  branches(repoPath: string): Promise<string[]>
  currentBranch(repoPath: string): Promise<string>
  isRepo(path: string): Promise<boolean>
}

function execGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    // `windowsHide` keeps the polled git commands from flashing a console
    // window on win32 (the observer runs on a timer).
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolvePromise(stdout.trim())
    })
  })
}

export interface GitClientOptions {
  /**
   * Per-command git execution timeout in ms. Generous by default so git commands
   * complete instead of being SIGTERM-killed when the host is under heavy CPU load
   * (broker startup, dream consolidation, scheduled reindex).
   */
  readonly execTimeoutMs?: number
}

/**
 * Default per-command git timeout. Raised from the original 10s to 30s after live
 * broker.log evidence showed `git rev-parse`/`git log`/`git branch` being SIGTERM-killed
 * at the 10s boundary during startup / heavy-load windows, blanking the project-focus signal.
 */
export const DEFAULT_GIT_EXEC_TIMEOUT_MS = 30_000

/** Real implementation using child_process.execFile('git', ...) */
export function createGitClient(options: GitClientOptions = {}): GitClient {
  const timeoutMs = options.execTimeoutMs ?? DEFAULT_GIT_EXEC_TIMEOUT_MS
  return {
    async log(repoPath, since, maxCount = 100): Promise<GitCommit[]> {
      const args = [
        'log',
        `--since=${since}`,
        `--max-count=${maxCount}`,
        '--format=%H%n%an%n%aI%n%s',
        '--shortstat',
      ]
      const output = await execGit(args, repoPath, timeoutMs)
      if (!output) return []

      const commits: GitCommit[] = []
      const lines = output.split('\n')
      let i = 0

      while (i < lines.length) {
        const hash = lines[i]?.trim()
        if (!hash) {
          i++
          continue
        }
        const author = lines[i + 1]?.trim() ?? ''
        const date = lines[i + 2]?.trim() ?? ''
        const message = lines[i + 3]?.trim() ?? ''
        i += 4

        // Parse shortstat line (e.g. " 3 files changed, 10 insertions(+), 2 deletions(-)")
        let filesChanged = 0
        const statLine = lines[i]?.trim() ?? ''
        if (statLine) {
          const match = /(\d+)\s+file/.exec(statLine)
          if (match?.[1]) {
            filesChanged = parseInt(match[1], 10)
          }
          i++
        }

        // Skip blank separator line
        if (lines[i]?.trim() === '') i++

        commits.push({ hash, author, date, message, filesChanged })
      }

      return commits
    },

    async branches(repoPath): Promise<string[]> {
      const output = await execGit(['branch', '--format=%(refname:short)'], repoPath, timeoutMs)
      if (!output) return []
      return output.split('\n').filter(Boolean)
    },

    async currentBranch(repoPath): Promise<string> {
      return execGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath, timeoutMs)
    },

    async isRepo(path): Promise<boolean> {
      try {
        await execGit(['rev-parse', '--is-inside-work-tree'], path, timeoutMs)
        return true
      } catch {
        return false
      }
    },
  }
}

export interface GitActivityObserverOptions {
  readonly gitClient?: GitClient
  readonly logWriter: ReturnType<typeof createDailyLogWriter>
  readonly privacyFilter: ReturnType<typeof createPrivacyFilter>
  readonly config: ObserverConfig
  readonly intervalMs?: number
  /**
   * How far back the FIRST poll of a repo looks for commits (subsequent polls use the
   * last-seen timestamp). Defaults to {@link DEFAULT_GIT_FIRST_POLL_LOOKBACK_MS} so that
   * after a broker restart the brain RE-OBSERVES recent commit history instead of
   * forgetting it (the in-memory seen-hash state is cleared on restart). A short window
   * here made the project-focus signal blind to all but the last hour of commits.
   */
  readonly firstPollLookbackMs?: number
  /**
   * Per-command git execution timeout (ms) for the default git client. See
   * {@link DEFAULT_GIT_EXEC_TIMEOUT_MS}. Ignored when a `gitClient` is injected.
   */
  readonly execTimeoutMs?: number
  /**
   * Repositories to poll FIRST (e.g. the broker's own project root). Their commit
   * history seeds the brain's observation buffer before slower/larger repos are
   * reached, so the project-focus signal survives a restart even under contention.
   * Matched by resolved absolute path; entries not in `config.repos` are ignored.
   */
  readonly priorityRepos?: readonly string[]
}

/**
 * First-poll lookback default = 7 days, matching the pattern detector's observation
 * window (168h). Keeps the re-observed history bounded while ensuring active-development
 * signal survives the daily broker restart.
 */
export const DEFAULT_GIT_FIRST_POLL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

export function createGitActivityObserver(
  options: GitActivityObserverOptions,
): Observer & { poll(): Promise<Observation[]>; getTrackedRepos(): readonly string[] } {
  const {
    gitClient = createGitClient({
      execTimeoutMs: options.execTimeoutMs ?? DEFAULT_GIT_EXEC_TIMEOUT_MS,
    }),
    logWriter,
    privacyFilter,
    config,
    intervalMs = 300_000,
    firstPollLookbackMs = DEFAULT_GIT_FIRST_POLL_LOOKBACK_MS,
    priorityRepos = [],
  } = options

  const log = logger.child({ observer: 'git-activity' })
  const repos = config.repos ?? []
  let running = false
  let intervalHandle: ReturnType<typeof setInterval> | undefined

  // Per-repo state
  const seenHashes = new Map<string, Set<string>>()
  const knownBranches = new Map<string, Set<string>>()
  const lastPollTime = new Map<string, string>()

  function repoName(repoPath: string): string {
    return basename(repoPath)
  }

  /**
   * Poll priority repos first (preserving original relative order within each
   * group), then the rest. Lets the broker's own project seed the observation
   * buffer before slower/larger repos under startup contention.
   */
  function orderedRepos(): string[] {
    if (priorityRepos.length === 0) return [...repos]
    const priority = new Set(priorityRepos.map((p) => resolve(p)))
    const first: string[] = []
    const rest: string[] = []
    for (const repoPath of repos) {
      if (priority.has(resolve(repoPath))) first.push(repoPath)
      else rest.push(repoPath)
    }
    return [...first, ...rest]
  }

  async function pollRepo(repoPath: string): Promise<Observation[]> {
    if (privacyFilter.isPathExcluded(repoPath)) return []

    const isValid = await gitClient.isRepo(repoPath)
    if (!isValid) return []

    const observations: Observation[] = []

    // Determine since time. First poll of a repo (no last-seen) re-observes the recent
    // commit history so the project-focus signal survives a broker restart.
    const since =
      lastPollTime.get(repoPath) ?? new Date(Date.now() - firstPollLookbackMs).toISOString()

    // Get current branch
    const branch = await gitClient.currentBranch(repoPath)

    // Fetch commits
    const commits = await gitClient.log(repoPath, since)
    const seen = seenHashes.get(repoPath) ?? new Set<string>()
    seenHashes.set(repoPath, seen)

    let latestDate = lastPollTime.get(repoPath)

    for (const commit of commits) {
      if (seen.has(commit.hash)) continue
      seen.add(commit.hash)

      const tags = buildTags(ObservationType.GitActivity, repoName(repoPath), {
        branch,
        author: commit.author,
      })

      observations.push({
        id: randomUUID(),
        type: ObservationType.GitActivity,
        timestamp: commit.date,
        source: repoName(repoPath),
        content: commit.message,
        tags,
        metadata: {
          hash: commit.hash,
          author: commit.author,
          filesChanged: commit.filesChanged,
          branch,
          repoPath,
        },
      })

      if (!latestDate || commit.date > latestDate) {
        latestDate = commit.date
      }
    }

    if (latestDate) {
      lastPollTime.set(repoPath, latestDate)
    }

    // Detect new branches
    const branchList = await gitClient.branches(repoPath)
    const known = knownBranches.get(repoPath) ?? new Set<string>()
    const isFirstPoll = !knownBranches.has(repoPath)
    knownBranches.set(repoPath, new Set(branchList))

    if (!isFirstPoll) {
      for (const b of branchList) {
        if (!known.has(b)) {
          const tags = buildTags(ObservationType.GitActivity, repoName(repoPath), {
            branch: b,
          })

          observations.push({
            id: randomUUID(),
            type: ObservationType.GitActivity,
            timestamp: new Date().toISOString(),
            source: repoName(repoPath),
            content: `New branch: ${b}`,
            tags,
          })
        }
      }
    }

    return observations
  }

  async function pollAll(): Promise<Observation[]> {
    const allObservations: Observation[] = []

    for (const repoPath of orderedRepos()) {
      try {
        const obs = await pollRepo(repoPath)
        if (obs.length > 0) {
          // Buffer per-repo so each repo's signal reaches the brain's observation
          // buffer as soon as that repo is polled, instead of being withheld until
          // every repo finishes. Combined with priority-repo-first ordering this
          // stops a slow/late repo from delaying the priority repo's burst.
          logWriter.writeBatch(obs)
          // Observability: the first poll after a restart re-observes the recent
          // commit history, so this surfaces the per-repo burst count that the brain
          // buffer receives — the signal that was previously invisible at runtime.
          log.info({ repo: repoName(repoPath), count: obs.length }, 'git observations buffered')
        }
        allObservations.push(...obs)
      } catch (err) {
        log.error({ err, repoPath }, 'Failed to poll git repo')
      }
    }

    return allObservations
  }

  return {
    type: ObservationType.GitActivity,
    name: 'git-activity-observer',

    start(): void {
      if (running || repos.length === 0) return

      running = true

      // Immediate first poll
      void pollAll()

      intervalHandle = setInterval(() => {
        void pollAll()
      }, intervalMs)
    },

    stop(): void {
      if (intervalHandle !== undefined) {
        clearInterval(intervalHandle)
        intervalHandle = undefined
      }
      running = false
    },

    isRunning(): boolean {
      return running
    },

    async poll(): Promise<Observation[]> {
      return pollAll()
    },

    getTrackedRepos(): readonly string[] {
      return repos
    },
  }
}
