/**
 * Step 3 (anti-drift) — maintain EXACTLY ONE GitHub issue per concern.
 *
 * The session-end NORTH_STAR nudge (M2) and the drift watchdog (M3) both
 * need the same discipline: a single reminder issue identified by a
 * stable HTML marker in the body — created when absent, edited in place
 * when its content changes, reopened when a human closed it while the
 * condition still holds, closed on all-clear, and NEVER duplicated.
 *
 * All gh calls go through an injectable execFile-style runner (array
 * args, no shell) — the same pattern as gate-pass-publisher — so tests
 * script the full gh conversation. Real calls run with cwd inside the
 * clone, letting gh resolve the origin repo itself.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface IssueRunResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  readonly code?: number
}

/** execFile-style command runner: no shell, args as an array. */
export type IssueRunCommand = (
  file: string,
  args: readonly string[],
  cwd: string,
) => Promise<IssueRunResult>

export const defaultIssueRunCommand: IssueRunCommand = async (file, args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    })
    return { ok: true, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
      code: typeof e.code === 'number' ? e.code : undefined,
    }
  }
}

export interface TrackedIssueRef {
  readonly number: number
  readonly state: 'OPEN' | 'CLOSED'
  readonly body: string
}

export interface TrackedIssueLocator {
  /** Stable HTML marker embedded in the issue body, e.g. `<!-- scns-x -->`. */
  readonly marker: string
  /** Label the issue carries (and the list query filters by). */
  readonly label: string
  /** Directory to run gh in — a clone whose origin is the target repo. */
  readonly cwd: string
  readonly run: IssueRunCommand
}

function fail(step: string, res: IssueRunResult): Error {
  return new Error(`tracked-issue ${step} failed: ${res.stderr || res.stdout || 'unknown error'}`)
}

/**
 * Locate the single issue carrying `marker`. An OPEN carrier always wins;
 * otherwise the most recent CLOSED one (highest number) is returned so a
 * reopen targets the same thread a human last saw.
 */
export async function findTrackedIssue(loc: TrackedIssueLocator): Promise<TrackedIssueRef | null> {
  const res = await loc.run(
    'gh',
    [
      'issue',
      'list',
      '--state',
      'all',
      '--label',
      loc.label,
      '--json',
      'number,state,body',
      // The list is newest-first and closed carriers accumulate forever;
      // a carrier older than the page would look absent and cause a
      // duplicate. 1000 (the gh maximum) pushes that horizon far out.
      '--limit',
      '1000',
    ],
    loc.cwd,
  )
  if (!res.ok) throw fail('list', res)

  let parsed: Array<{ number?: number; state?: string; body?: string }>
  try {
    parsed = JSON.parse(res.stdout || '[]')
  } catch {
    throw new Error(`tracked-issue list returned unparseable JSON: ${res.stdout.slice(0, 200)}`)
  }
  const carriers = parsed
    .filter((i) => typeof i.number === 'number' && (i.body ?? '').includes(loc.marker))
    .map((i) => ({
      number: i.number!,
      state: i.state === 'OPEN' ? ('OPEN' as const) : ('CLOSED' as const),
      body: i.body ?? '',
    }))
  if (carriers.length === 0) return null
  const open = carriers.filter((c) => c.state === 'OPEN').sort((a, b) => b.number - a.number)
  if (open.length > 0) return open[0]!
  return carriers.sort((a, b) => b.number - a.number)[0]!
}

export type UpsertAction = 'created' | 'updated' | 'reopened' | 'unchanged'

export interface UpsertResult {
  readonly action: UpsertAction
  readonly issueNumber: number | null
}

export interface UpsertTrackedIssueInput extends TrackedIssueLocator {
  readonly title: string
  /** Body WITHOUT the marker — it is appended here so it can never be forgotten. */
  readonly body: string
  /**
   * What to do when an OPEN carrier already exists:
   *   'update' (default) — edit the body in place when it changed;
   *   'skip'             — leave it untouched (strict-dedupe nudge mode).
   */
  readonly onOpen?: 'update' | 'skip'
}

function issueNumberFromCreateOutput(stdout: string): number | null {
  const match = stdout.trim().match(/\/issues\/(\d+)\s*$/)
  return match ? parseInt(match[1]!, 10) : null
}

export async function upsertTrackedIssue(input: UpsertTrackedIssueInput): Promise<UpsertResult> {
  const fullBody = `${input.body.trimEnd()}\n\n${input.marker}\n`
  const existing = await findTrackedIssue(input)

  if (!existing) {
    const res = await input.run(
      'gh',
      ['issue', 'create', '--title', input.title, '--body', fullBody, '--label', input.label],
      input.cwd,
    )
    if (!res.ok) throw fail('create', res)
    return { action: 'created', issueNumber: issueNumberFromCreateOutput(res.stdout) }
  }

  const number = String(existing.number)

  // The GitHub web UI serves bodies with CRLF endings; without
  // normalization every comparison would differ and a daily task would
  // emit a no-op edit each run.
  const normalize = (s: string): string => s.replace(/\r\n/g, '\n').trim()

  if (existing.state === 'OPEN') {
    if (input.onOpen === 'skip' || normalize(existing.body) === normalize(fullBody)) {
      return { action: 'unchanged', issueNumber: existing.number }
    }
    const res = await input.run('gh', ['issue', 'edit', number, '--body', fullBody], input.cwd)
    if (!res.ok) throw fail('edit', res)
    return { action: 'updated', issueNumber: existing.number }
  }

  // Closed while the condition still holds — reopen the same thread and
  // refresh its body, never open a competing duplicate.
  const reopen = await input.run('gh', ['issue', 'reopen', number], input.cwd)
  if (!reopen.ok) throw fail('reopen', reopen)
  const edit = await input.run('gh', ['issue', 'edit', number, '--body', fullBody], input.cwd)
  if (!edit.ok) throw fail('edit-after-reopen', edit)
  return { action: 'reopened', issueNumber: existing.number }
}

export interface CloseTrackedIssueInput extends TrackedIssueLocator {
  readonly comment?: string
}

export async function closeTrackedIssue(
  input: CloseTrackedIssueInput,
): Promise<{ readonly closed: boolean; readonly issueNumber: number | null }> {
  const existing = await findTrackedIssue(input)
  if (!existing || existing.state !== 'OPEN') return { closed: false, issueNumber: null }

  const args = ['issue', 'close', String(existing.number)]
  if (input.comment) args.push('--comment', input.comment)
  const res = await input.run('gh', args, input.cwd)
  if (!res.ok) throw fail('close', res)
  return { closed: true, issueNumber: existing.number }
}
