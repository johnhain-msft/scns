/**
 * F1 — Gate-PASS Publisher Service.
 *
 * The quality-gate arbiter commits a verdict-PASS diff on a local
 * `scns/auto/<slug>` branch and removes its worktree — the branch then
 * exists ONLY in the projectRoot clone. Nothing published it: the
 * auto-merger (default-OFF) merges locally, so a human never saw gate
 * output on GitHub without inspecting the clone. This service closes
 * that gap: on a verdict-PASS it pushes the branch to `origin` and opens
 * a PR against the repo's default branch via the `gh` CLI, carrying the
 * verdict evidence (score, reason, qualityCheckId, source issue) in the
 * PR body so a human can review the artifact where they already work.
 *
 * Design constraints (handoff F1):
 *   - Publishing is POST-verdict: the `quality_gate_verdict` event is
 *     already emitted before this subscriber runs, so a publish failure
 *     can never flip a verdict. Failures log loudly and emit a
 *     `gate_publish_failed` audit event.
 *   - Idempotent under verdict re-delivery: before pushing, `gh pr list
 *     --head <branch> --state all` is consulted — an existing PR (open,
 *     closed, or merged) skips the publish entirely. An in-process
 *     in-flight guard covers the replay-before-first-finishes race.
 *   - One AUTO PR per source issue (first-PASS-wins, John 2026-08-11): a
 *     later PASS wave lands on a different branch, so a second probe scans
 *     existing scns/auto/* PRs (any state) for a body already closing the
 *     same issue and skips instead of opening a competing `Closes #N` PR.
 *   - The remote's default branch is NEVER pushed: only `scns/auto/*`
 *     branches are eligible, pushed by exact name, never with --force.
 *   - Dev-default-ON (AGENTS.md §9): the CLI enables this unless
 *     `BROKER_PUBLISH_GATE_PASS=0`.
 *
 * Commands are run through an injectable execFile-style runner (array
 * args, no shell) — the same pattern as `fetchGithubIssueSignals`' `gh`
 * shell-out — so tests script the full git/gh conversation.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { EventLog } from './event-log.js'
import type { EventDispatcher, TypedEvent } from '../event-dispatcher.js'
import { logger } from '../../shared/logger.js'

const execFileAsync = promisify(execFile)

const log = logger.child({ module: 'gate-pass-publisher' })

// ── Public types ─────────────────────────────────────────────────────

export interface PublishRunResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  readonly code?: number
}

/** execFile-style command runner: no shell, args as an array. */
export type PublishRunCommand = (
  file: string,
  args: readonly string[],
  cwd: string,
) => Promise<PublishRunResult>

/** The verdict evidence carried into the PR body. */
export interface PublishEvidence {
  readonly teamId: string
  readonly score: number | null
  readonly reason: string | null
  readonly qualityCheckId: string | null
  readonly sourceIssueNumber: number | null
}

export type PublishOutcome =
  | { readonly status: 'published'; readonly prUrl: string }
  | {
      readonly status: 'skipped'
      readonly reason: 'not-auto-branch' | 'no-remote' | 'pr-exists' | 'issue-pr-exists'
      readonly detail: string
      readonly prUrl?: string
    }
  | {
      readonly status: 'failed'
      readonly step: 'pr-list' | 'issue-pr-list' | 'push' | 'pr-create'
      readonly detail: string
    }

export interface GatePassPublisherDeps {
  readonly eventLog: EventLog
  readonly dispatcher: EventDispatcher
  readonly projectRoot: string
  readonly enabled: boolean
  readonly runCommand?: PublishRunCommand
  /**
   * Resolve the GitHub issue number a team was spawned for (self-issue
   * lease lookup). Called synchronously at verdict time — before any
   * async publish step — so a later lease sweep cannot lose the linkage.
   * Optional: without it the PR body simply omits the `Closes #N` line.
   */
  readonly resolveSourceIssue?: (teamId: string) => number | null
}

export interface GatePassPublisher {
  /** Manually publish a branch (skips the event subscriber). */
  publish(branch: string, evidence: PublishEvidence): Promise<PublishOutcome>
  /** Await every publish kicked off by the subscriber so far (tests/shutdown). */
  flush(): Promise<void>
  stop(): void
}

// ── Defaults ─────────────────────────────────────────────────────────

export const defaultPublishRunCommand: PublishRunCommand = async (file, args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    })
    return { ok: true, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? String(err),
      code: typeof e.code === 'number' ? e.code : 1,
    }
  }
}

const AUTO_BRANCH_PREFIX = 'scns/auto/'

// ── PR body (exported for tests) ─────────────────────────────────────

export function buildPrBody(branch: string, evidence: PublishEvidence): string {
  const lines = [
    'Automated quality-gate PASS artifact, published by the SCNS gate-pass publisher.',
    '',
    '| Verdict evidence | |',
    '| --- | --- |',
    `| Branch | \`${branch}\` |`,
    `| Team | \`${evidence.teamId}\` |`,
    `| Gate reason | ${evidence.reason ?? 'unknown'} |`,
    `| Gate score | ${evidence.score ?? 'unknown'} |`,
    `| Quality check id | ${evidence.qualityCheckId ?? 'unknown'} |`,
    '',
  ]
  if (evidence.sourceIssueNumber !== null) {
    lines.push(`Closes #${evidence.sourceIssueNumber}`, '')
  }
  lines.push(
    '> Publishing is post-verdict: the quality-gate verdict was decided before this PR was opened. ' +
      'Review and merge (or close) is human-owned — nothing auto-merges on the remote.',
  )
  return lines.join('\n')
}

// ── Pure publish orchestration (exported for tests) ──────────────────

/**
 * Push a verdict-PASS `scns/auto/*` branch to origin and open a PR
 * against the repo's default branch (gh's own default when `--base` is
 * omitted). Never touches any other ref; never forces.
 */
export async function publishGatePassBranch(
  run: PublishRunCommand,
  branch: string,
  projectRoot: string,
  evidence: PublishEvidence,
): Promise<PublishOutcome> {
  if (!branch.startsWith(AUTO_BRANCH_PREFIX)) {
    return {
      status: 'skipped',
      reason: 'not-auto-branch',
      detail: `branch ${branch} is not under ${AUTO_BRANCH_PREFIX} — refusing to publish`,
    }
  }

  // A repo without an origin remote is a legitimate local-only project,
  // not a failure — skip quietly.
  const remote = await run('git', ['remote', 'get-url', 'origin'], projectRoot)
  if (!remote.ok) {
    return {
      status: 'skipped',
      reason: 'no-remote',
      detail: `no origin remote in ${projectRoot}: ${(remote.stderr || remote.stdout).trim()}`,
    }
  }

  // Idempotency probe — `--state all` so a closed/merged PR from an
  // earlier delivery is honored (a replay must not re-open it). When gh
  // cannot answer, FAIL rather than blind-push: without the probe a
  // replay could open duplicates.
  const list = await run(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url'],
    projectRoot,
  )
  if (!list.ok) {
    return {
      status: 'failed',
      step: 'pr-list',
      detail: `gh pr list failed: ${(list.stderr || list.stdout).trim().slice(0, 300)}`,
    }
  }
  let existing: Array<{ number?: number; url?: string }> = []
  try {
    const parsed = JSON.parse(list.stdout || '[]') as unknown
    if (Array.isArray(parsed)) existing = parsed as Array<{ number?: number; url?: string }>
  } catch {
    // Unparseable output counts as "cannot answer" — same no-blind-push rule.
    return {
      status: 'failed',
      step: 'pr-list',
      detail: `gh pr list returned unparseable JSON: ${(list.stdout || '').slice(0, 200)}`,
    }
  }
  if (existing.length > 0) {
    return {
      status: 'skipped',
      reason: 'pr-exists',
      detail: `PR already exists for ${branch} (#${existing[0]?.number ?? '?'})`,
      ...(existing[0]?.url ? { prUrl: existing[0].url } : {}),
    }
  }

  // Issue-keyed dedupe (John, 2026-08-11): one AUTO PR per source issue,
  // first-PASS-wins — a later PASS wave lands on a DIFFERENT branch, so the
  // branch probe above cannot see it. Scan the repo's auto-PRs (any state:
  // a rejected artifact must not respawn on the next wave) for a body that
  // already closes this issue. Scoped to scns/auto/* heads so a human's own
  // PR never suppresses the artifact. Fails closed like the branch probe.
  if (evidence.sourceIssueNumber !== null) {
    const issueList = await run(
      'gh',
      ['pr', 'list', '--state', 'all', '--json', 'number,url,body,headRefName', '--limit', '100'],
      projectRoot,
    )
    if (!issueList.ok) {
      return {
        status: 'failed',
        step: 'issue-pr-list',
        detail: `gh pr list (issue dedupe) failed: ${(issueList.stderr || issueList.stdout).trim().slice(0, 300)}`,
      }
    }
    let autoPrs: Array<{ number?: number; url?: string; body?: string; headRefName?: string }> = []
    try {
      const parsed = JSON.parse(issueList.stdout || '[]') as unknown
      if (Array.isArray(parsed)) autoPrs = parsed
    } catch {
      return {
        status: 'failed',
        step: 'issue-pr-list',
        detail: `gh pr list (issue dedupe) returned unparseable JSON: ${(issueList.stdout || '').slice(0, 200)}`,
      }
    }
    const closesRe = new RegExp(`Closes #${evidence.sourceIssueNumber}(?!\\d)`)
    const dup = autoPrs.find(
      (p) =>
        typeof p.headRefName === 'string' &&
        p.headRefName.startsWith(AUTO_BRANCH_PREFIX) &&
        typeof p.body === 'string' &&
        closesRe.test(p.body),
    )
    if (dup) {
      return {
        status: 'skipped',
        reason: 'issue-pr-exists',
        detail:
          `an auto PR already closes issue #${evidence.sourceIssueNumber} ` +
          `(#${dup.number ?? '?'}, head ${dup.headRefName}) — first-PASS-wins, not publishing ${branch}`,
        ...(dup.url ? { prUrl: dup.url } : {}),
      }
    }
  }

  const push = await run('git', ['push', 'origin', branch], projectRoot)
  if (!push.ok) {
    return {
      status: 'failed',
      step: 'push',
      detail: `git push origin ${branch} failed: ${(push.stderr || push.stdout).trim().slice(0, 300)}`,
    }
  }

  const subject = await run('git', ['log', '-1', '--format=%s', branch], projectRoot)
  const title =
    subject.ok && subject.stdout.trim().length > 0
      ? subject.stdout.trim().split('\n')[0]!
      : `Auto: quality-gate PASS on ${branch}`

  const create = await run(
    'gh',
    ['pr', 'create', '--head', branch, '--title', title, '--body', buildPrBody(branch, evidence)],
    projectRoot,
  )
  if (!create.ok) {
    return {
      status: 'failed',
      step: 'pr-create',
      detail: `gh pr create failed: ${(create.stderr || create.stdout).trim().slice(0, 300)}`,
    }
  }

  const urlMatch = (create.stdout || '').match(/https:\/\/\S+/)
  return { status: 'published', prUrl: urlMatch ? urlMatch[0] : create.stdout.trim() }
}

// ── Factory ──────────────────────────────────────────────────────────

export function createGatePassPublisher(deps: GatePassPublisherDeps): GatePassPublisher {
  const run = deps.runCommand ?? defaultPublishRunCommand
  const inFlight = new Set<string>()
  const pending = new Set<Promise<void>>()
  let unsubscribe: (() => void) | null = null

  function publish(branch: string, evidence: PublishEvidence): Promise<PublishOutcome> {
    return publishGatePassBranch(run, branch, deps.projectRoot, evidence)
  }

  async function publishForVerdict(branch: string, evidence: PublishEvidence): Promise<void> {
    const outcome = await publish(branch, evidence)
    if (outcome.status === 'published') {
      log.info(
        { branch, teamId: evidence.teamId, prUrl: outcome.prUrl },
        'gate-pass branch published as PR',
      )
      deps.eventLog.gatePublished(null, {
        branch,
        team_id: evidence.teamId,
        pr_url: outcome.prUrl,
        quality_check_id: evidence.qualityCheckId,
        source_issue_number: evidence.sourceIssueNumber,
      })
    } else if (outcome.status === 'skipped') {
      log.info(
        { branch, teamId: evidence.teamId, reason: outcome.reason, detail: outcome.detail },
        'gate-pass publish skipped',
      )
    } else {
      // Loud, but never a verdict flip — the verdict event already shipped.
      log.error(
        { branch, teamId: evidence.teamId, step: outcome.step, detail: outcome.detail },
        'gate-pass publish FAILED — branch remains local-only',
      )
      deps.eventLog.gatePublishFailed(null, {
        branch,
        team_id: evidence.teamId,
        step: outcome.step,
        detail: outcome.detail,
        quality_check_id: evidence.qualityCheckId,
        source_issue_number: evidence.sourceIssueNumber,
      })
    }
  }

  function handleVerdict(evt: TypedEvent): void {
    if (!deps.enabled) return
    try {
      const payload = JSON.parse(evt.payload) as {
        team_id?: string
        passed?: boolean
        branch?: string | null
        score?: number
        reason?: string
        qualityCheckId?: string | null
      }
      if (payload.passed !== true) return
      const branch = payload.branch
      if (!branch || typeof branch !== 'string' || !branch.startsWith(AUTO_BRANCH_PREFIX)) return
      if (inFlight.has(branch)) {
        log.info({ branch }, 'gate-pass publish already in flight — skipping replay')
        return
      }
      inFlight.add(branch)

      const teamId = payload.team_id ?? 'unknown-team'
      // Resolve the source issue NOW (sync): the self-issue lease keeps its
      // teamId after markDone, but a stale sweep could still clear the row
      // before an async lookup ran.
      let sourceIssueNumber: number | null = null
      try {
        sourceIssueNumber = deps.resolveSourceIssue?.(teamId) ?? null
      } catch (err) {
        log.warn({ err, teamId }, 'resolveSourceIssue threw — publishing without issue linkage')
      }

      const evidence: PublishEvidence = {
        teamId,
        score: typeof payload.score === 'number' ? payload.score : null,
        reason: payload.reason ?? null,
        qualityCheckId: payload.qualityCheckId ?? null,
        sourceIssueNumber,
      }
      const task = publishForVerdict(branch, evidence)
        .catch((err) => {
          log.warn(
            { err: err instanceof Error ? err.message : String(err), branch },
            'gate-pass publisher failed unexpectedly (swallowed to keep dispatcher alive)',
          )
        })
        .finally(() => {
          inFlight.delete(branch)
          pending.delete(task)
        })
      pending.add(task)
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'gate-pass publisher handler failed (swallowed to keep dispatcher alive)',
      )
    }
  }

  if (deps.enabled) {
    unsubscribe = deps.dispatcher.subscribe(
      { event_types: ['quality_gate_verdict'] },
      handleVerdict,
    )
    log.info(
      { projectRoot: deps.projectRoot },
      'gate-pass publisher started (default ON; disable with BROKER_PUBLISH_GATE_PASS=0)',
    )
  } else {
    log.info('gate-pass publisher NOT started (BROKER_PUBLISH_GATE_PASS=0)')
  }

  return {
    publish,
    async flush(): Promise<void> {
      // Publishes can enqueue while we await (verdict replays); loop until quiet.
      while (pending.size > 0) {
        await Promise.all([...pending])
      }
    },
    stop() {
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    },
  }
}
