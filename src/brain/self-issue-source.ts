/**
 * Self-issue source — lets SCNS grab its OWN problems (open GitHub issues and
 * failing tests) and author them as tasks in the brain queue, so the brain can
 * pick them up and (at sufficient autonomy) spawn teams to resolve them.
 *
 * The ingestion logic is pure and injectable so it is fully unit-testable
 * without touching `gh` or the network. The default GitHub fetcher
 * (`fetchGithubIssueSignals`) shells out to the `gh` CLI and is verified
 * separately/live.
 *
 * Safety: ingestion is bounded (`maxPerRun`) and deduplicated by stable signal
 * key. Bug 2 fix: the source no longer writes any persistent "ingested" mark at
 * enqueue time (that fire-and-forget flag lost work on a broker restart). A
 * signal is skipped only when it is already being handled — `isActive` covers
 * both a durable lease (`in-progress`/`done` in the self-issue tracker) and the
 * live in-memory queue — so a signal enqueued but lost to a restart is
 * re-enqueued next run. Callers gate scheduling behind a kill-switch.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DecisionPriority } from './state-types.js'

const execFileAsync = promisify(execFile)

export type SelfIssueKind = 'github-issue' | 'failing-test'

export interface SelfIssueSignal {
  /** Stable unique key for dedup, e.g. 'github-issue:42' or 'failing-test:<file>::<name>'. */
  readonly key: string
  readonly kind: SelfIssueKind
  readonly title: string
  readonly body?: string
  readonly labels?: readonly string[]
  readonly url?: string
}

export interface SelfIssueSourceDeps {
  /** Fetch the current set of signals (issues + failing tests). */
  readonly fetchSignals: () => Promise<readonly SelfIssueSignal[]>
  /**
   * True if this signal is already being handled and must NOT be re-enqueued:
   * either it holds a durable lease (`in-progress`/`done` in the self-issue
   * tracker) or it is already sitting in the brain's in-memory queue. A signal
   * that was enqueued but lost to a restart is NOT active (empty queue, no
   * lease) and will be re-enqueued — this is the Bug 2 fix.
   */
  readonly isActive: (key: string) => boolean
  /**
   * Enqueue a task into the brain queue; returns the task id or null if full.
   * `signalKey` is threaded onto the PendingTask so the brain can lease it to a
   * unique team on spawn and the queue-membership check can find it.
   */
  readonly enqueueTask: (
    description: string,
    priority: DecisionPriority,
    signalKey: string,
  ) => string | null
  /** Optional structured logger. */
  readonly log?: (obj: Record<string, unknown>, msg: string) => void
}

export interface SelfIssueSourceOptions {
  /** Maximum signals to enqueue per run. Default 3. */
  readonly maxPerRun?: number
  /**
   * If non-empty, only github-issue signals carrying at least one of these
   * labels are ingested. Failing-test signals are always allowed.
   */
  readonly labelAllowlist?: readonly string[]
}

export interface IngestResult {
  readonly ingested: number
  readonly skippedDuplicate: number
  readonly skippedFiltered: number
  readonly enqueueFailed: number
  readonly taskIds: readonly string[]
}

const CRITICAL_LABELS = new Set(['critical', 'security', 'p0', 'urgent'])
const HIGH_LABELS = new Set(['bug', 'regression', 'p1', 'high'])

/** Map a signal to a brain task priority based on its kind and labels. */
export function priorityForSignal(signal: SelfIssueSignal): DecisionPriority {
  const labels = (signal.labels ?? []).map((l) => l.toLowerCase())
  if (labels.some((l) => CRITICAL_LABELS.has(l))) return DecisionPriority.Critical
  if (labels.some((l) => HIGH_LABELS.has(l))) return DecisionPriority.High
  // A failing test is a concrete regression — treat as High even without labels.
  if (signal.kind === 'failing-test') return DecisionPriority.High
  return DecisionPriority.Normal
}

/** Build the brain task description text for a signal. */
export function describeSignal(signal: SelfIssueSignal): string {
  const lines: string[] = []
  const heading = signal.kind === 'github-issue' ? 'Resolve GitHub issue' : 'Fix failing test'
  lines.push(`${heading}: ${signal.title}`)
  if (signal.url) lines.push(`Reference: ${signal.url}`)
  lines.push(`Signal: ${signal.key}`)
  if (signal.labels && signal.labels.length > 0) {
    lines.push(`Labels: ${signal.labels.join(', ')}`)
  }
  if (signal.body && signal.body.trim().length > 0) {
    lines.push('', signal.body.trim())
  }
  return lines.join('\n')
}

function passesLabelFilter(signal: SelfIssueSignal, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true
  if (signal.kind === 'failing-test') return true
  const labels = (signal.labels ?? []).map((l) => l.toLowerCase())
  const allow = allowlist.map((l) => l.toLowerCase())
  return labels.some((l) => allow.includes(l))
}

export function createSelfIssueSource(deps: SelfIssueSourceDeps, options?: SelfIssueSourceOptions) {
  const maxPerRun = options?.maxPerRun ?? 3
  const labelAllowlist = options?.labelAllowlist ?? []

  return {
    async ingest(): Promise<IngestResult> {
      const signals = await deps.fetchSignals()
      let ingested = 0
      let skippedDuplicate = 0
      let skippedFiltered = 0
      let enqueueFailed = 0
      const taskIds: string[] = []

      for (const signal of signals) {
        if (ingested >= maxPerRun) break

        if (!passesLabelFilter(signal, labelAllowlist)) {
          skippedFiltered += 1
          continue
        }
        if (deps.isActive(signal.key)) {
          skippedDuplicate += 1
          continue
        }

        const priority = priorityForSignal(signal)
        const taskId = deps.enqueueTask(describeSignal(signal), priority, signal.key)
        if (taskId == null) {
          // Queue full — nothing was enqueued and nothing was marked, so it
          // retries on the next run.
          enqueueFailed += 1
          continue
        }

        taskIds.push(taskId)
        ingested += 1
        deps.log?.(
          { key: signal.key, kind: signal.kind, priority, taskId },
          'Self-issue enqueued as brain task',
        )
      }

      return { ingested, skippedDuplicate, skippedFiltered, enqueueFailed, taskIds }
    },
  }
}

// ── Default GitHub fetcher (shells out to `gh`) ──────────────────────

interface GhIssueJson {
  readonly number: number
  readonly title: string
  readonly body?: string
  readonly url?: string
  readonly labels?: ReadonlyArray<{ readonly name: string }>
}

export interface FetchGithubIssuesOptions {
  /** Repo in owner/name form. Omit to use the cwd's default remote. */
  readonly repo?: string
  /** Working directory for the `gh` invocation. */
  readonly cwd?: string
  /** Only fetch issues with these labels (passed to `gh`). */
  readonly labels?: readonly string[]
  /** Max issues to fetch. Default 30. */
  readonly limit?: number
}

/**
 * Fetch open GitHub issues as signals via the `gh` CLI. Returns an empty array
 * (rather than throwing) on any failure so a scheduled ingest run degrades
 * gracefully when `gh` is unavailable or unauthenticated.
 */
export async function fetchGithubIssueSignals(
  options?: FetchGithubIssuesOptions,
): Promise<readonly SelfIssueSignal[]> {
  const limit = options?.limit ?? 30
  const args = [
    'issue',
    'list',
    '--state',
    'open',
    '--json',
    'number,title,body,url,labels',
    '--limit',
    String(limit),
  ]
  if (options?.repo) args.push('-R', options.repo)
  if (options?.labels && options.labels.length > 0) {
    for (const label of options.labels) args.push('--label', label)
  }

  try {
    // `windowsHide`: the brain runs inside a DETACHED, console-less broker, so a
    // child without it gets a brand-new console — a real window on the user's
    // desktop every `self-issue-ingest` tick (measured 2026-09-15).
    const { stdout } = await execFileAsync('gh', args, {
      cwd: options?.cwd,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    })
    const issues = JSON.parse(stdout) as GhIssueJson[]
    return issues.map((issue) => ({
      key: `github-issue:${issue.number}`,
      kind: 'github-issue' as const,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      labels: (issue.labels ?? []).map((l) => l.name),
    }))
  } catch {
    return []
  }
}

/**
 * Inverse of the `github-issue:${number}` signal-key format built in
 * {@link fetchGithubIssueSignals}. Returns the issue number, or null for
 * any other key shape — used by the gate-pass publisher for `Closes #N`.
 */
export function issueNumberFromSignalKey(signalKey: string): number | null {
  const m = signalKey.match(/^github-issue:(\d+)$/)
  if (!m) return null
  const n = Number.parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : null
}

// ── Per-project repo resolution (Track-2 federation) ─────────────────

/**
 * Parse a git remote URL into a GitHub `owner/name` slug, or null if it is not
 * a recognizable GitHub remote. Handles HTTPS (`https://github.com/owner/name.git`),
 * SSH (`git@github.com:owner/name.git`), and `ssh://git@github.com/owner/name`
 * forms; tolerates a trailing `.git` and/or slash.
 */
export function parseGithubRepoSlug(remoteUrl: string): string | null {
  const m = remoteUrl.trim().match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i)
  if (!m) return null
  const [, owner, name] = m
  return owner && name ? `${owner}/${name}` : null
}

/**
 * Derive the GitHub `owner/name` slug for a project from its `origin` remote by
 * shelling out to git. Returns null when the project has no origin remote or it
 * is not a GitHub URL. `getOriginUrl` is injectable for tests.
 */
export async function deriveSelfIssueRepoFromGit(
  projectRoot: string,
  getOriginUrl: (root: string) => Promise<string> = defaultGitOriginUrl,
): Promise<string | null> {
  try {
    return parseGithubRepoSlug(await getOriginUrl(projectRoot))
  } catch {
    return null
  }
}

async function defaultGitOriginUrl(root: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
    windowsHide: true,
  })
  return stdout.trim()
}

/**
 * Resolve which repo the self-issue-ingest scheduler targets.
 * - An explicit `SCNS_SELF_ISSUE_REPO` (non-blank) always wins.
 * - Otherwise a meta-CHILD broker (identified by `SCNS_INSTANCE_ID`, which is set
 *   ONLY by the meta-supervisor child spawn) resolves to `undefined` — it must
 *   NOT fall back to the singleton's repo, which would ingest SCNS's issues into
 *   another project's broker.
 * - The singleton (no instanceId) keeps the historical `johnhain-msft/scns` default.
 */
export function resolveSelfIssueRepo(input: {
  readonly explicitRepo?: string | null
  readonly instanceId?: string | null
}): string | undefined {
  const explicit = (input.explicitRepo ?? '').trim()
  if (explicit !== '') return explicit
  const isMetaChild = (input.instanceId ?? '').trim() !== ''
  return isMetaChild ? undefined : 'johnhain-msft/scns'
}
