import { describe, it, expect, vi } from 'vitest'
import {
  createSelfIssueSource,
  priorityForSignal,
  describeSignal,
  parseGithubRepoSlug,
  resolveSelfIssueRepo,
  deriveSelfIssueRepoFromGit,
  issueNumberFromSignalKey,
  type SelfIssueSignal,
} from '../../../src/brain/self-issue-source.js'
import { DecisionPriority } from '../../../src/brain/state-types.js'

function ghIssue(overrides: Partial<SelfIssueSignal> = {}): SelfIssueSignal {
  return {
    key: 'github-issue:42',
    kind: 'github-issue',
    title: 'Fix the flaky ACP one-shot test',
    body: 'It fails ~1/10 runs.',
    labels: ['bug'],
    url: 'https://github.com/johnhain-msft/scns/issues/42',
    ...overrides,
  }
}

function makeDeps(signals: SelfIssueSignal[]) {
  const leased = new Set<string>() // tracker: in-progress/done (durable, survives restart)
  const queue: string[] = [] // brain in-memory queue (signalKeys; lost on restart)
  const enqueued: Array<{ description: string; priority: DecisionPriority; signalKey: string }> = []
  let counter = 0
  return {
    leased,
    queue,
    enqueued,
    deps: {
      fetchSignals: vi.fn().mockResolvedValue(signals),
      isActive: (key: string) => leased.has(key) || queue.includes(key),
      enqueueTask: vi.fn((description: string, priority: DecisionPriority, signalKey: string) => {
        enqueued.push({ description, priority, signalKey })
        queue.push(signalKey)
        return `task-${++counter}`
      }),
    },
  }
}

describe('priorityForSignal', () => {
  it('maps critical/security labels to Critical', () => {
    expect(priorityForSignal(ghIssue({ labels: ['critical'] }))).toBe(DecisionPriority.Critical)
    expect(priorityForSignal(ghIssue({ labels: ['security'] }))).toBe(DecisionPriority.Critical)
  })

  it('maps bug labels to High', () => {
    expect(priorityForSignal(ghIssue({ labels: ['bug'] }))).toBe(DecisionPriority.High)
  })

  it('failing-test signals are High by default', () => {
    expect(priorityForSignal(ghIssue({ kind: 'failing-test', labels: [] }))).toBe(
      DecisionPriority.High,
    )
  })

  it('defaults to Normal for unlabeled issues', () => {
    expect(priorityForSignal(ghIssue({ labels: [] }))).toBe(DecisionPriority.Normal)
  })
})

describe('describeSignal', () => {
  it('includes the kind, title, url and body', () => {
    const desc = describeSignal(ghIssue())
    expect(desc).toContain('Fix the flaky ACP one-shot test')
    expect(desc).toContain('https://github.com/johnhain-msft/scns/issues/42')
    expect(desc).toContain('It fails ~1/10 runs.')
  })
})

describe('createSelfIssueSource.ingest', () => {
  it('enqueues a task per new signal with its signalKey', async () => {
    const { deps, enqueued, queue } = makeDeps([
      ghIssue({ key: 'github-issue:1', title: 'A' }),
      ghIssue({ key: 'github-issue:2', title: 'B' }),
    ])
    const source = createSelfIssueSource(deps)
    const result = await source.ingest()

    expect(result.ingested).toBe(2)
    expect(enqueued).toHaveLength(2)
    expect(queue).toEqual(['github-issue:1', 'github-issue:2'])
    expect(enqueued.map((e) => e.signalKey)).toEqual(['github-issue:1', 'github-issue:2'])
  })

  it('skips already-active signals (leased or already queued)', async () => {
    const { deps, enqueued, leased } = makeDeps([ghIssue({ key: 'github-issue:7' })])
    leased.add('github-issue:7')
    const source = createSelfIssueSource(deps)
    const result = await source.ingest()

    expect(result.ingested).toBe(0)
    expect(result.skippedDuplicate).toBe(1)
    expect(enqueued).toHaveLength(0)
  })

  // ── Bug 2 regression: durability across a broker restart ────────────
  it('re-enqueues a signal that was enqueued but lost to a restart (Bug 2)', async () => {
    const { deps, enqueued, queue } = makeDeps([ghIssue({ key: 'github-issue:1' })])
    const source = createSelfIssueSource(deps)

    await source.ingest()
    expect(queue).toEqual(['github-issue:1'])

    // Restart: the in-memory queue is lost. No lease was ever written because
    // the brain never dequeued/spawned it. Under the old fire-and-forget
    // `ingested` flag this signal would be gone forever.
    queue.length = 0

    const result = await source.ingest()
    expect(result.ingested).toBe(1)
    expect(enqueued).toHaveLength(2)
    expect(queue).toEqual(['github-issue:1'])
  })

  it('does NOT duplicate a signal already sitting in the queue (same process)', async () => {
    const { deps, queue } = makeDeps([ghIssue({ key: 'github-issue:1' })])
    const source = createSelfIssueSource(deps)

    await source.ingest()
    const result = await source.ingest()

    expect(result.ingested).toBe(0)
    expect(result.skippedDuplicate).toBe(1)
    expect(queue).toHaveLength(1)
  })

  it('does NOT re-enqueue a signal leased in-progress (crash safety without duplication)', async () => {
    const { deps, queue, leased } = makeDeps([ghIssue({ key: 'github-issue:1' })])
    const source = createSelfIssueSource(deps)

    await source.ingest()
    // Brain dequeues + spawns a team: the signal moves from queue → lease.
    queue.length = 0
    leased.add('github-issue:1')

    const result = await source.ingest()
    expect(result.ingested).toBe(0)
    expect(result.skippedDuplicate).toBe(1)
  })

  it('respects maxPerRun', async () => {
    const signals = Array.from({ length: 10 }, (_, i) =>
      ghIssue({ key: `github-issue:${i}`, title: `T${i}` }),
    )
    const { deps, enqueued } = makeDeps(signals)
    const source = createSelfIssueSource(deps, { maxPerRun: 3 })
    const result = await source.ingest()

    expect(result.ingested).toBe(3)
    expect(enqueued).toHaveLength(3)
  })

  it('filters by label allowlist when configured', async () => {
    const { deps, enqueued } = makeDeps([
      ghIssue({ key: 'github-issue:1', labels: ['bug'] }),
      ghIssue({ key: 'github-issue:2', labels: ['self-heal'] }),
    ])
    const source = createSelfIssueSource(deps, { labelAllowlist: ['self-heal'] })
    const result = await source.ingest()

    expect(result.ingested).toBe(1)
    expect(result.skippedFiltered).toBe(1)
    expect(enqueued[0]!.signalKey).toBe('github-issue:2')
  })

  it('does NOT lease/leave-active when enqueue fails (so it retries next run)', async () => {
    const { deps, leased } = makeDeps([ghIssue({ key: 'github-issue:9' })])
    ;(deps.enqueueTask as ReturnType<typeof vi.fn>).mockReturnValue(null) // queue full
    const source = createSelfIssueSource(deps)
    const result = await source.ingest()

    expect(result.ingested).toBe(0)
    expect(result.enqueueFailed).toBe(1)
    expect(leased.has('github-issue:9')).toBe(false)
    expect(deps.isActive('github-issue:9')).toBe(false)
  })

  it('handles failing-test signals through the same path', async () => {
    const { deps, enqueued } = makeDeps([
      {
        key: 'failing-test:test/foo.test.ts::does X',
        kind: 'failing-test',
        title: 'does X (test/foo.test.ts)',
        body: 'AssertionError: expected 1 to be 2',
        labels: [],
      },
    ])
    const source = createSelfIssueSource(deps)
    const result = await source.ingest()

    expect(result.ingested).toBe(1)
    expect(enqueued[0]!.priority).toBe(DecisionPriority.High)
  })

  it('returns zero counts when there are no signals', async () => {
    const { deps } = makeDeps([])
    const source = createSelfIssueSource(deps)
    const result = await source.ingest()
    expect(result.ingested).toBe(0)
    expect(result.skippedDuplicate).toBe(0)
  })
})

describe('parseGithubRepoSlug', () => {
  it('parses HTTPS, SSH, ssh://, no-.git and trailing-slash forms', () => {
    expect(parseGithubRepoSlug('https://github.com/example-org/Cosmere_RPG.git')).toBe(
      'example-org/Cosmere_RPG',
    )
    expect(parseGithubRepoSlug('git@github.com:owner/name.git')).toBe('owner/name')
    expect(parseGithubRepoSlug('ssh://git@github.com/owner/name.git')).toBe('owner/name')
    expect(parseGithubRepoSlug('https://github.com/owner/name')).toBe('owner/name')
    expect(parseGithubRepoSlug('https://github.com/owner/name/')).toBe('owner/name')
  })

  it('returns null for non-GitHub or empty remotes', () => {
    expect(parseGithubRepoSlug('https://gitlab.com/owner/name.git')).toBeNull()
    expect(parseGithubRepoSlug('')).toBeNull()
    expect(parseGithubRepoSlug('   ')).toBeNull()
  })
})

// F1 — the gate-pass publisher turns a signalKey back into the issue number
// for the PR body's `Closes #N` line. Inverse of the `github-issue:${number}`
// key format built in fetchGithubIssueSignals.
describe('issueNumberFromSignalKey', () => {
  it('parses the github-issue key form', () => {
    expect(issueNumberFromSignalKey('github-issue:42')).toBe(42)
    expect(issueNumberFromSignalKey('github-issue:2')).toBe(2)
  })

  it('returns null for non-issue keys and malformed numbers', () => {
    expect(issueNumberFromSignalKey('todo-comment:src/foo.ts:12')).toBeNull()
    expect(issueNumberFromSignalKey('github-issue:')).toBeNull()
    expect(issueNumberFromSignalKey('github-issue:abc')).toBeNull()
    expect(issueNumberFromSignalKey('')).toBeNull()
  })
})

describe('resolveSelfIssueRepo', () => {
  it('an explicit repo always wins', () => {
    expect(resolveSelfIssueRepo({ explicitRepo: 'a/b', instanceId: 'child-1' })).toBe('a/b')
    expect(resolveSelfIssueRepo({ explicitRepo: 'a/b' })).toBe('a/b')
  })

  it('a meta-child (SCNS_INSTANCE_ID set) with no explicit repo resolves to undefined (no SCNS fallback)', () => {
    expect(resolveSelfIssueRepo({ instanceId: 'child-1' })).toBeUndefined()
    expect(resolveSelfIssueRepo({ explicitRepo: '   ', instanceId: 'child-1' })).toBeUndefined()
  })

  it('the singleton (no instanceId) keeps the historical johnhain-msft/scns default', () => {
    expect(resolveSelfIssueRepo({})).toBe('johnhain-msft/scns')
    expect(resolveSelfIssueRepo({ explicitRepo: '' })).toBe('johnhain-msft/scns')
  })
})

describe('deriveSelfIssueRepoFromGit', () => {
  it('derives the slug from an injected origin URL', async () => {
    const got = await deriveSelfIssueRepoFromGit(
      '/repo',
      async () => 'https://github.com/example-org/Cosmere_RPG.git',
    )
    expect(got).toBe('example-org/Cosmere_RPG')
  })

  it('returns null when the project has no origin remote (exec throws)', async () => {
    const got = await deriveSelfIssueRepoFromGit('/repo', async () => {
      throw new Error('fatal: No such remote')
    })
    expect(got).toBeNull()
  })

  it('returns null for a non-GitHub remote', async () => {
    const got = await deriveSelfIssueRepoFromGit('/repo', async () => 'https://gitlab.com/o/n.git')
    expect(got).toBeNull()
  })
})
