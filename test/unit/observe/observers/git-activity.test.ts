import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createGitActivityObserver } from '../../../../src/observe/observers/git-activity.js'
import type { GitClient, GitCommit } from '../../../../src/observe/observers/git-activity.js'
import { ObservationType } from '../../../../src/observe/types.js'
import type { ObserverConfig } from '../../../../src/observe/types.js'
import { createDailyLogWriter } from '../../../../src/observe/daily-log-writer.js'
import { createPrivacyFilter } from '../../../../src/observe/privacy-filter.js'

function makeCommit(overrides: Partial<GitCommit> = {}): GitCommit {
  return {
    hash: 'abc123',
    author: 'dev',
    date: new Date().toISOString(),
    message: 'fix bug',
    filesChanged: 3,
    ...overrides,
  }
}

function createMockGitClient(overrides: Partial<GitClient> = {}): GitClient {
  return {
    log: vi.fn().mockResolvedValue([]),
    branches: vi.fn().mockResolvedValue(['main']),
    currentBranch: vi.fn().mockResolvedValue('main'),
    isRepo: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

function createMockLogWriter() {
  const entries: string[] = []
  const writer = createDailyLogWriter({
    appendDailyLog(entry: string) {
      entries.push(entry)
    },
  })
  return { writer, entries }
}

function createTestPrivacyFilter(excludePaths: string[] = []) {
  return createPrivacyFilter({
    config: {
      excludeApps: [],
      excludePaths,
      excludeUrls: [],
      sanitizeSecrets: true,
      terminalHistoryOptIn: false,
      browserTabsOptIn: false,
    },
  })
}

function defaultConfig(repos: string[] = ['/repo']): ObserverConfig {
  return { enabled: true, repos, optIn: false }
}

describe('GitActivityObserver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('poll() returns observations for new commits', async () => {
    const commit = makeCommit({ hash: 'aaa111', message: 'add feature' })
    const client = createMockGitClient({
      log: vi.fn().mockResolvedValue([commit]),
    })
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    const observations = await observer.poll()

    expect(observations.length).toBeGreaterThanOrEqual(1)
    const commitObs = observations.find((o) => o.content.includes('add feature'))
    expect(commitObs).toBeDefined()
    expect(commitObs!.type).toBe(ObservationType.GitActivity)
  })

  it('poll() skips already-seen commits (dedup by hash)', async () => {
    const commit = makeCommit({ hash: 'dup111' })
    const client = createMockGitClient({
      log: vi.fn().mockResolvedValue([commit]),
    })
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    const first = await observer.poll()
    const second = await observer.poll()

    const commitObs1 = first.filter((o) => o.content.includes(commit.message))
    const commitObs2 = second.filter((o) => o.content.includes(commit.message))
    expect(commitObs1.length).toBe(1)
    expect(commitObs2.length).toBe(0)
  })

  it('poll() detects new branches', async () => {
    let branchCall = 0
    const client = createMockGitClient({
      branches: vi.fn().mockImplementation(async () => {
        branchCall++
        return branchCall === 1 ? ['main'] : ['main', 'feature-x']
      }),
    })
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    await observer.poll()
    const obs = await observer.poll()

    const branchObs = obs.find((o) => o.content.includes('New branch'))
    expect(branchObs).toBeDefined()
    expect(branchObs!.content).toContain('feature-x')
  })

  it('poll() handles invalid repo path gracefully', async () => {
    const client = createMockGitClient({
      isRepo: vi.fn().mockResolvedValue(false),
    })
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(['/not-a-repo']),
    })

    const obs = await observer.poll()
    expect(obs).toEqual([])
  })

  it('poll() handles empty repo (no commits)', async () => {
    const client = createMockGitClient({
      log: vi.fn().mockResolvedValue([]),
    })
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    const obs = await observer.poll()
    expect(obs).toEqual([])
  })

  it('first poll re-observes the recent commit history (7-day lookback, survives restart)', async () => {
    const client = createMockGitClient()
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    await observer.poll()

    const logCall = (client.log as ReturnType<typeof vi.fn>).mock.calls[0]!
    const sinceArg = logCall[1] as string
    const sinceDate = new Date(sinceArg)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    expect(Math.abs(sinceDate.getTime() - sevenDaysAgo.getTime())).toBeLessThan(5000)
  })

  it('honors a custom firstPollLookbackMs', async () => {
    const client = createMockGitClient()
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
      firstPollLookbackMs: 60 * 60 * 1000, // 1 hour
    })

    await observer.poll()

    const sinceArg = (client.log as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    expect(Math.abs(new Date(sinceArg).getTime() - oneHourAgo.getTime())).toBeLessThan(5000)
  })

  it('subsequent polls use last-seen timestamp', async () => {
    const commitDate = new Date().toISOString()
    const commit = makeCommit({ hash: 'ts111', date: commitDate })
    const client = createMockGitClient({
      log: vi.fn().mockResolvedValueOnce([commit]).mockResolvedValue([]),
    })
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    await observer.poll()
    await observer.poll()

    const secondCall = (client.log as ReturnType<typeof vi.fn>).mock.calls[1]!
    const sinceArg = secondCall[1] as string
    expect(sinceArg).toBe(commitDate)
  })

  it('start() begins polling interval', async () => {
    const client = createMockGitClient()
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
      intervalMs: 5000,
    })

    observer.start()
    await vi.advanceTimersByTimeAsync(5100)

    expect((client.isRepo as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
  })

  it('stop() clears interval', async () => {
    const client = createMockGitClient()
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
      intervalMs: 5000,
    })

    observer.start()
    observer.stop()
    await vi.advanceTimersByTimeAsync(10_000)

    // isRepo should only have been called from the initial immediate poll (at most)
    expect((client.isRepo as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('isRunning() reflects state', () => {
    const client = createMockGitClient()
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    expect(observer.isRunning()).toBe(false)
    observer.start()
    expect(observer.isRunning()).toBe(true)
    observer.stop()
    expect(observer.isRunning()).toBe(false)
  })

  it('multiple repos tracked simultaneously', async () => {
    const commit1 = makeCommit({ hash: 'r1', message: 'repo1 commit' })
    const commit2 = makeCommit({ hash: 'r2', message: 'repo2 commit' })
    const client = createMockGitClient({
      log: vi.fn().mockImplementation(async (repoPath: string) => {
        if (repoPath === '/repo1') return [commit1]
        if (repoPath === '/repo2') return [commit2]
        return []
      }),
    })
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(['/repo1', '/repo2']),
    })

    const obs = await observer.poll()

    expect(obs.some((o) => o.content.includes('repo1 commit'))).toBe(true)
    expect(obs.some((o) => o.content.includes('repo2 commit'))).toBe(true)
  })

  it('getTrackedRepos() returns configured repos', () => {
    const client = createMockGitClient()
    const { writer } = createMockLogWriter()
    const repos = ['/repo/a', '/repo/b']
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(repos),
    })

    expect(observer.getTrackedRepos()).toEqual(repos)
  })

  it('tags include repo name and branch', async () => {
    const commit = makeCommit({ hash: 'tag1' })
    const client = createMockGitClient({
      log: vi.fn().mockResolvedValue([commit]),
      currentBranch: vi.fn().mockResolvedValue('develop'),
    })
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(['/my-project']),
    })

    const obs = await observer.poll()
    const commitObs = obs.find((o) => o.content.includes(commit.message))

    expect(commitObs).toBeDefined()
    expect(commitObs!.tags.some((t) => t.includes('branch:'))).toBe(true)
  })

  it('commit metadata (hash, author, filesChanged) in observation metadata', async () => {
    const commit = makeCommit({ hash: 'meta1', author: 'alice', filesChanged: 5 })
    const client = createMockGitClient({
      log: vi.fn().mockResolvedValue([commit]),
    })
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    const obs = await observer.poll()
    const commitObs = obs.find((o) => o.content.includes(commit.message))

    expect(commitObs).toBeDefined()
    expect(commitObs!.metadata).toBeDefined()
    expect(commitObs!.metadata!['hash']).toBe('meta1')
    expect(commitObs!.metadata!['author']).toBe('alice')
    expect(commitObs!.metadata!['filesChanged']).toBe(5)
  })

  it('no repos configured → no-op start', () => {
    const client = createMockGitClient()
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig([]),
    })

    observer.start()
    expect(observer.isRunning()).toBe(false)
  })

  it('git client failure handled gracefully', async () => {
    const client = createMockGitClient({
      log: vi.fn().mockRejectedValue(new Error('git not found')),
    })
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    const obs = await observer.poll()
    expect(obs).toEqual([])
  })

  it('excluded repos filtered by privacy filter', async () => {
    const commit = makeCommit({ hash: 'priv1' })
    const client = createMockGitClient({
      log: vi.fn().mockResolvedValue([commit]),
    })
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(['/secret-repo']),
      config: defaultConfig(['/secret-repo']),
    })

    const obs = await observer.poll()
    expect(obs).toEqual([])
  })

  it('branch name included in commit observations', async () => {
    const commit = makeCommit({ hash: 'br1' })
    const client = createMockGitClient({
      log: vi.fn().mockResolvedValue([commit]),
      currentBranch: vi.fn().mockResolvedValue('feature-abc'),
    })
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    const obs = await observer.poll()
    const commitObs = obs.find((o) => o.content.includes(commit.message))

    expect(commitObs).toBeDefined()
    expect(commitObs!.metadata!['branch']).toBe('feature-abc')
  })

  it('GitClient.isRepo check works', async () => {
    const client = createMockGitClient({
      isRepo: vi.fn().mockResolvedValue(false),
      log: vi.fn().mockResolvedValue([makeCommit()]),
    })
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    const obs = await observer.poll()
    expect(obs).toEqual([])
    expect(client.log as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('type is git-activity', () => {
    const client = createMockGitClient()
    const { writer } = createMockLogWriter()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: writer,
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(),
    })

    expect(observer.type).toBe(ObservationType.GitActivity)
  })

  it('buffers each repo per-poll (one writeBatch per repo with commits, not one batched call)', async () => {
    const cA = makeCommit({ hash: 'a1', message: 'repoA commit' })
    const cB = makeCommit({ hash: 'b1', message: 'repoB commit' })
    const client = createMockGitClient({
      log: vi.fn().mockImplementation(async (repoPath: string) =>
        repoPath === '/repoA' ? [cA] : repoPath === '/repoB' ? [cB] : [],
      ),
    })
    const writeBatch = vi.fn()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: { write: vi.fn(), writeBatch },
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(['/repoA', '/repoB']),
    })

    await observer.poll()

    // Per-repo buffering: one writeBatch call per repo that produced observations
    // (the old behavior batched all repos into a single end-of-poll writeBatch).
    expect(writeBatch).toHaveBeenCalledTimes(2)
  })

  it('a repo surfaces even if a later repo throws (incremental buffering)', async () => {
    const cA = makeCommit({ hash: 'a1', message: 'early commit' })
    const client = createMockGitClient({
      log: vi.fn().mockImplementation(async (repoPath: string) => {
        if (repoPath === '/early') return [cA]
        throw new Error('boom') // a later repo fails mid-poll
      }),
    })
    const writeBatch = vi.fn()
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: { write: vi.fn(), writeBatch },
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(['/early', '/broken']),
    })

    const obs = await observer.poll()

    const written = writeBatch.mock.calls.flatMap((call) => call[0] as Observation[])
    expect(written.some((o) => o.content.includes('early commit'))).toBe(true)
    expect(obs.some((o) => o.content.includes('early commit'))).toBe(true)
  })

  it('polls priorityRepos before other repos (own repo seeds the buffer first)', async () => {
    const order: string[] = []
    const client = createMockGitClient({
      isRepo: vi.fn().mockImplementation(async (p: string) => {
        order.push(p)
        return true
      }),
    })
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: { write: vi.fn(), writeBatch: vi.fn() },
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(['/a', '/scns', '/b']),
      priorityRepos: ['/scns'],
    })

    await observer.poll()

    expect(order[0]).toBe('/scns')
    expect(order).toEqual(['/scns', '/a', '/b'])
  })

  it('priorityRepos matching is path-normalized and ignores unknown entries', async () => {
    const order: string[] = []
    const client = createMockGitClient({
      isRepo: vi.fn().mockImplementation(async (p: string) => {
        order.push(p)
        return true
      }),
    })
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: { write: vi.fn(), writeBatch: vi.fn() },
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(['/repos/a', '/repos/scns']),
      // trailing slash + an entry not in repos
      priorityRepos: ['/repos/scns/', '/not-tracked'],
    })

    await observer.poll()

    expect(order[0]).toBe('/repos/scns')
  })

  it('no priorityRepos → original repo order preserved', async () => {
    const order: string[] = []
    const client = createMockGitClient({
      isRepo: vi.fn().mockImplementation(async (p: string) => {
        order.push(p)
        return true
      }),
    })
    const observer = createGitActivityObserver({
      gitClient: client,
      logWriter: { write: vi.fn(), writeBatch: vi.fn() },
      privacyFilter: createTestPrivacyFilter(),
      config: defaultConfig(['/a', '/b', '/c']),
    })

    await observer.poll()

    expect(order).toEqual(['/a', '/b', '/c'])
  })
})
