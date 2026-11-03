/**
 * Gap 4 (prong a) — file SCNS's own gaps as GitHub issues.
 *
 * The brain already self-ingests open GitHub issues as tasks
 * (`self-issue-source.ts`, on a periodic cron), but there is no fuel: 0
 * open issues. This module lets SCNS author its OWN improvement gaps as
 * issues (label `scns:self-improvement`), which the existing
 * self-issue-ingest then turns into brain tasks the (now-working)
 * delivery loop can implement.
 *
 * Loop-prevention (per rubber-duck): every issue body carries a stable
 * `<!-- scns-self-improve:<key> -->` marker; an open issue already
 * carrying a gap's marker suppresses re-filing it. Creation is bounded
 * per run, and the CLI defaults to DRY-RUN.
 */

import { execFileSync as nodeExecFileSync } from 'node:child_process'

export const SELF_IMPROVE_LABEL = 'scns:self-improvement'
export const DEFAULT_MAX_PER_RUN = 3

export interface SelfImprovementGap {
  /** Stable identity used for the dedupe marker. */
  readonly key: string
  readonly title: string
  readonly body: string
}

export interface OpenIssue {
  readonly title: string
  readonly body: string
}

export interface FileSelfImprovementDeps {
  readonly listOpenIssues: (label: string) => Promise<readonly OpenIssue[]>
  readonly createIssue: (i: {
    title: string
    body: string
    labels: readonly string[]
  }) => Promise<{ url?: string }>
  readonly label?: string
  readonly maxPerRun?: number
  /** When true, compute the plan but never call createIssue. */
  readonly dryRun?: boolean
}

export interface PlannedIssue {
  readonly key: string
  readonly title: string
}
export interface CreatedIssue {
  readonly key: string
  readonly title: string
  readonly url?: string
}
export interface FileSelfImprovementResult {
  /** Gaps that passed dedupe + cap (would be / were created). */
  readonly toCreate: readonly PlannedIssue[]
  /** Gaps actually created (empty in dry-run). */
  readonly created: readonly CreatedIssue[]
  readonly skippedDuplicate: readonly string[]
  readonly skippedCap: readonly string[]
}

/** Stable marker embedded in each issue body for idempotent dedupe. */
export function selfImproveMarker(key: string): string {
  return `<!-- scns-self-improve:${key} -->`
}

export async function fileSelfImprovementIssues(
  gaps: readonly SelfImprovementGap[],
  deps: FileSelfImprovementDeps,
): Promise<FileSelfImprovementResult> {
  const label = deps.label ?? SELF_IMPROVE_LABEL
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN

  const existing = await deps.listOpenIssues(label)
  const alreadyOpen = new Set<string>()
  for (const issue of existing) {
    const body = issue.body ?? ''
    for (const g of gaps) {
      if (body.includes(selfImproveMarker(g.key))) alreadyOpen.add(g.key)
    }
  }

  const toCreate: PlannedIssue[] = []
  const skippedDuplicate: string[] = []
  const skippedCap: string[] = []
  for (const g of gaps) {
    if (alreadyOpen.has(g.key)) {
      skippedDuplicate.push(g.key)
      continue
    }
    if (toCreate.length >= maxPerRun) {
      skippedCap.push(g.key)
      continue
    }
    toCreate.push({ key: g.key, title: g.title })
  }

  const created: CreatedIssue[] = []
  if (!deps.dryRun) {
    for (const planned of toCreate) {
      const g = gaps.find((x) => x.key === planned.key)!
      const body = `${g.body}\n\n${selfImproveMarker(g.key)}`
      const res = await deps.createIssue({ title: g.title, body, labels: [label] })
      created.push({ key: g.key, title: g.title, url: res?.url })
    }
  }

  return { toCreate, created, skippedDuplicate, skippedCap }
}

// ── gh CLI helpers (injectable exec for tests) ───────────────────────

type Exec = typeof nodeExecFileSync

/** List open issues carrying `label` via the `gh` CLI. Never throws. */
export function ghListOpenSelfImprovementIssues(
  label: string,
  repo?: string,
  exec: Exec = nodeExecFileSync,
): readonly OpenIssue[] {
  const args = [
    'issue',
    'list',
    '--state',
    'open',
    '--label',
    label,
    '--json',
    'title,body',
    '--limit',
    '100',
  ]
  if (repo) args.push('-R', repo)
  try {
    const out = exec('gh', args, { encoding: 'utf8', windowsHide: true })
    const parsed = JSON.parse(String(out || '[]')) as Array<{ title?: string; body?: string }>
    if (!Array.isArray(parsed)) return []
    return parsed.map((i) => ({ title: i.title ?? '', body: i.body ?? '' }))
  } catch {
    return []
  }
}

/** Create an issue via the `gh` CLI. Returns the created issue URL. */
export function ghCreateIssue(
  input: { title: string; body: string; labels: readonly string[] },
  repo?: string,
  exec: Exec = nodeExecFileSync,
): { url?: string } {
  const args = ['issue', 'create', '--title', input.title, '--body', input.body]
  for (const l of input.labels) args.push('--label', l)
  if (repo) args.push('-R', repo)
  const out = exec('gh', args, { encoding: 'utf8', windowsHide: true })
  const url = String(out || '').trim()
  return { url: url || undefined }
}

// ── Curated catalog of SCNS's own improvement gaps ───────────────────

/**
 * Concrete, test-coverable improvements to SCNS itself. Each is small
 * enough for the delivery loop to land (and to satisfy the auto-merge
 * `has-test-coverage` gate). Filing these as issues fuels the existing
 * self-issue-ingest path so SCNS works on improving ITSELF.
 */
export const SCNS_SELF_IMPROVEMENT_GAPS: readonly SelfImprovementGap[] = [
  {
    key: 'dev-prompt-final-stage',
    title: 'scns-dev prompt: make final `git add -A` a mandatory exit step',
    body:
      'The scns-dev implementer prompt should make the final `git add -A` an ' +
      'explicit, mandatory exit precondition (with a self-check that ' +
      '`git diff --cached` is non-empty), reinforcing the broker-side ' +
      'completion auto-stage. Update src/cli/team-member-prompts.ts and add a ' +
      'unit test asserting the prompt contains the mandatory final-stage step.',
  },
  {
    key: 'watchdog-operability-docs',
    title: 'Document the external health-watchdog (`scns watchdog run`)',
    body:
      'Add operator documentation + a test covering the external watchdog: the ' +
      '`scns watchdog run` flags (--max-timeouts, --cooldown-ms, --grace-ms), the ' +
      'com.scns.watchdog launchd job, and the ~/.scns/watchdog.disabled / ' +
      'SCNS_WATCHDOG_DISABLED kill-switch.',
  },
  {
    key: 'worktree-reclaim-event',
    title: 'Emit a structured event when a per-team worktree is reclaimed',
    body:
      'team-worktree-manager.removeWorktreeForTeam should emit a structured ' +
      'worktree_reclaimed event via the existing eventLog sink so operators can ' +
      'audit worktree lifecycle. Add a unit test asserting it fires on cleanup ' +
      'and is skipped when a live member still references the team.',
  },
]
