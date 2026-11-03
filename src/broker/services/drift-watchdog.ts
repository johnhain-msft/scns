/**
 * M3 (anti-drift) — daily staleness + deferral watchdog.
 *
 * Two decay modes this catches mechanically (both happened for real):
 *   (a) NORTH_STAR staleness — the doc once went 12 days / 71 commits
 *       stale, so intent silently diverged from the code. If the last
 *       commit touching docs/NORTH_STAR.md is older than `staleDays`
 *       (default 14), that is a finding.
 *   (b) Deferral decay — spec 003 US4 said "post-Monday" (Due:
 *       2026-08-04) and nothing fired. Any UNCHECKED checklist item in
 *       specs/<slug>/{tasks.md,spec.md} whose text carries a past-due
 *       `Due: YYYY-MM-DD` marker is a finding. The specs tree lives
 *       OUTSIDE the scns git repo (scns_root/specs), so this probe scans
 *       the filesystem, not git.
 *
 * Findings maintain EXACTLY ONE GitHub issue via tracked-issue.ts
 * (marker DRIFT_WATCHDOG_MARKER, label `scns:self-improvement` — NEVER
 * `scns-auto`, which is a curated human opt-in): created when absent,
 * edited in place when findings change, reopened when closed while
 * still stale, closed with a comment on all-clear. Run from the
 * `drift-watchdog` scheduled task (daily, off-peak).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventLog } from './event-log.js'
import { logger } from '../../shared/logger.js'
import {
  closeTrackedIssue,
  defaultIssueRunCommand,
  upsertTrackedIssue,
  type IssueRunCommand,
} from './tracked-issue.js'

const log = logger.child({ module: 'drift-watchdog' })

export const DRIFT_WATCHDOG_MARKER = '<!-- scns-drift-watchdog -->'
export const DRIFT_WATCHDOG_LABEL = 'scns:self-improvement'
const NORTH_STAR_PATH = 'docs/NORTH_STAR.md'
const DEFAULT_STALE_DAYS = 14
const SPEC_FILES = ['tasks.md', 'spec.md'] as const

export interface DriftWatchdogDeps {
  /** The scns clone (for the NORTH_STAR git-age probe and gh calls). */
  readonly projectRoot: string
  /** The specs tree — scns_root/specs, OUTSIDE the git repo. */
  readonly specsDir: string
  readonly runCommand?: IssueRunCommand
  readonly staleDays?: number
  readonly now?: () => Date
  readonly eventLog?: EventLog
}

export interface DeferralFinding {
  /** Path relative to specsDir. */
  readonly file: string
  /** 1-indexed line of the checklist item. */
  readonly line: number
  readonly dueDate: string
  /** First line of the item, trimmed. */
  readonly snippet: string
}

export interface WatchdogOutcome {
  readonly status: 'findings' | 'all-clear' | 'error'
  readonly action?: 'created' | 'updated' | 'reopened' | 'unchanged'
  readonly issueNumber?: number | null
  readonly closedIssue?: boolean
  readonly staleness: { readonly stale: boolean; readonly lastCommitIso: string | null }
  readonly deferrals: readonly DeferralFinding[]
}

// ── Deferral scanning (pure filesystem, exported for tests) ──────────

interface ChecklistItem {
  readonly checked: boolean
  readonly line: number
  readonly text: string
  readonly firstLine: string
}

/**
 * Split a markdown file into checklist items. An item starts at
 * `- [ ]` / `- [x]` and its text continues across indented/wrapped
 * lines until the next item, a heading, or a blank line — the real
 * specs wrap `Due:` onto the next line, so continuations matter.
 */
function parseChecklistItems(content: string): ChecklistItem[] {
  const items: ChecklistItem[] = []
  const lines = content.split('\n')
  let current: { checked: boolean; line: number; parts: string[] } | null = null

  const flush = (): void => {
    if (!current) return
    items.push({
      checked: current.checked,
      line: current.line,
      text: current.parts.map((p) => p.trim()).join(' '),
      firstLine: current.parts[0]!.trim(),
    })
    current = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const itemStart = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/)
    if (itemStart) {
      flush()
      current = { checked: itemStart[1] !== ' ', line: i + 1, parts: [line] }
    } else if (line.trim() === '' || /^#/.test(line) || /^\s*[-*+]\s/.test(line)) {
      // A blank line, a heading, or ANY new bullet ends the item — a
      // plain bullet after an unchecked item must not fold its text
      // (and its Due: date) into the item above it.
      flush()
    } else if (current) {
      current.parts.push(line)
    }
  }
  flush()
  return items
}

/**
 * Latest `Due: YYYY-MM-DD` in the (whitespace-joined) item text. The
 * LATEST because re-dating by appending ("Due: 2026-08-04. Re-dated:
 * Due: 2026-09-01") is exactly what the watchdog issue asks humans to
 * do — the old date must stop firing. ISO dates compare lexically.
 */
function extractDueDate(itemText: string): string | null {
  let latest: string | null = null
  for (const match of itemText.matchAll(/Due:\s*(\d{4}-\d{2}-\d{2})/g)) {
    const date = match[1]!
    if (latest === null || date > latest) latest = date
  }
  return latest
}

/** Scan specs/<slug>/{tasks.md,spec.md} for past-due unchecked items. */
export function scanSpecDeferrals(specsDir: string, now: Date): DeferralFinding[] {
  if (!existsSync(specsDir)) return []
  const today = now.toISOString().slice(0, 10)
  const findings: DeferralFinding[] = []

  const slugs = readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  for (const slug of slugs) {
    for (const name of SPEC_FILES) {
      const path = join(specsDir, slug, name)
      if (!existsSync(path)) continue
      const items = parseChecklistItems(readFileSync(path, 'utf8'))
      for (const item of items) {
        if (item.checked) continue
        const dueDate = extractDueDate(item.text)
        if (!dueDate || dueDate >= today) continue
        findings.push({
          file: `${slug}/${name}`,
          line: item.line,
          dueDate,
          snippet: item.firstLine.slice(0, 200),
        })
      }
    }
  }
  return findings
}

// ── Issue body ───────────────────────────────────────────────────────

function buildWatchdogBody(
  staleness: { stale: boolean; lastCommitIso: string | null },
  deferrals: readonly DeferralFinding[],
  staleDays: number,
): string {
  const lines: string[] = [
    'The daily drift watchdog found written intent decaying. Both findings below are',
    'the failure modes the anti-drift work exists for: a stale NORTH_STAR means design',
    'intent no longer matches the code, and a past-due deferral is a promise that is',
    'silently rotting.',
    '',
  ]
  if (staleness.stale) {
    lines.push('## NORTH_STAR staleness', '')
    if (staleness.lastCommitIso) {
      lines.push(
        `The last commit touching \`docs/NORTH_STAR.md\` was ${staleness.lastCommitIso} —`,
        `older than the ${staleDays}-day threshold. Refresh "Current state" and`,
        '"Next moves" to match what has actually landed since.',
      )
    } else {
      lines.push(
        '`docs/NORTH_STAR.md` has no commit history in this clone — the staleness',
        'probe could not date it. Investigate and refresh the document.',
      )
    }
    lines.push('')
  }
  if (deferrals.length > 0) {
    lines.push('## Past-due deferrals (unchecked items with an expired Due: date)', '')
    for (const d of deferrals) {
      lines.push(`- \`specs/${d.file}:${d.line}\` — due ${d.dueDate}: ${d.snippet}`)
    }
    lines.push(
      '',
      'For each: either do it, re-date it with a written reason, or explicitly retire',
      'it in the spec. A deferral is only honest while its date is in the future.',
    )
    lines.push('')
  }
  lines.push(
    'This issue is maintained by the SCNS broker (drift-watchdog, daily). It updates',
    'in place while findings persist, reopens if closed while still stale, and closes',
    'itself when everything is healthy again.',
  )
  return lines.join('\n')
}

// ── Watchdog run ─────────────────────────────────────────────────────

export async function runDriftWatchdog(deps: DriftWatchdogDeps): Promise<WatchdogOutcome> {
  const run = deps.runCommand ?? defaultIssueRunCommand
  const staleDays = deps.staleDays ?? DEFAULT_STALE_DAYS
  const now = deps.now ?? (() => new Date())
  const startedAt = Date.now()

  const locator = {
    marker: DRIFT_WATCHDOG_MARKER,
    label: DRIFT_WATCHDOG_LABEL,
    cwd: deps.projectRoot,
    run,
  }

  // (a) NORTH_STAR age via the clone's history. --all: refreshes land on
  // topic branches and via origin/main — the checked-out HEAD may lag
  // and would report staleness the repo does not have.
  const gitLog = await run(
    'git',
    ['log', '-1', '--all', '--format=%cI', '--', NORTH_STAR_PATH],
    deps.projectRoot,
  )
  if (!gitLog.ok) {
    log.warn({ stderr: gitLog.stderr }, 'drift watchdog: git log failed')
    return {
      status: 'error',
      staleness: { stale: false, lastCommitIso: null },
      deferrals: [],
    }
  }
  const lastCommitIso = gitLog.stdout.trim() || null
  const stale = lastCommitIso
    ? now().getTime() - new Date(lastCommitIso).getTime() > staleDays * 86_400_000
    : true
  const staleness = { stale, lastCommitIso }

  // (b) Past-due deferrals in the specs tree.
  const deferrals = scanSpecDeferrals(deps.specsDir, now())

  const emit = (data: Record<string, unknown>): void => {
    try {
      deps.eventLog?.driftWatchdogRan(null, {
        ...data,
        stale_north_star: staleness.stale,
        past_due_deferrals: deferrals.length,
        duration_ms: Date.now() - startedAt,
      })
    } catch (err) {
      log.warn({ err }, 'drift watchdog: event emit failed (non-fatal)')
    }
  }

  if (!staleness.stale && deferrals.length === 0) {
    const closed = await closeTrackedIssue({
      ...locator,
      comment:
        'All clear: docs/NORTH_STAR.md is fresh and no spec deferral is past due. Closing automatically.',
    })
    emit({ status: 'all-clear', closed_issue: closed.closed, issue_number: closed.issueNumber })
    return { status: 'all-clear', closedIssue: closed.closed, staleness, deferrals }
  }

  const upsert = await upsertTrackedIssue({
    ...locator,
    title: 'Drift watchdog: written intent is going stale',
    body: buildWatchdogBody(staleness, deferrals, staleDays),
  })
  emit({ status: 'findings', action: upsert.action, issue_number: upsert.issueNumber })
  log.info(
    { action: upsert.action, issueNumber: upsert.issueNumber, deferrals: deferrals.length, stale },
    'drift watchdog findings',
  )
  return {
    status: 'findings',
    action: upsert.action,
    issueNumber: upsert.issueNumber,
    staleness,
    deferrals,
  }
}
