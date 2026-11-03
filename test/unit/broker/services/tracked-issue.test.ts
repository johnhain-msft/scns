/**
 * Step 3 (anti-drift) — tracked-issue helper tests.
 *
 * Both the session-end NORTH_STAR nudge (M2) and the drift watchdog (M3)
 * maintain EXACTLY ONE GitHub issue each, identified by a stable HTML
 * marker in the body. This module owns that contract:
 *
 *   - find:   scan open+closed labelled issues for the marker
 *   - upsert: create when absent, edit-in-place when changed,
 *             reopen when closed, and NEVER create a second issue
 *   - close:  close the open tracked issue (all-clear)
 *
 * All gh calls go through an injectable execFile-style runner (array
 * args, no shell) — the gate-pass-publisher pattern — so these tests
 * script the full gh conversation and assert exact commands.
 */
import { describe, expect, it } from 'vitest'

import {
  closeTrackedIssue,
  findTrackedIssue,
  upsertTrackedIssue,
  type IssueRunCommand,
  type IssueRunResult,
} from '../../../../src/broker/services/tracked-issue.js'

const MARKER = '<!-- scns-test-marker -->'
const LABEL = 'scns:self-improvement'
const CWD = '/repo'

function ok(stdout: string): IssueRunResult {
  return { ok: true, stdout, stderr: '' }
}

interface RecordedCall {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
}

function fakeRun(router: (file: string, args: readonly string[]) => IssueRunResult): {
  run: IssueRunCommand
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const run: IssueRunCommand = (file, args, cwd) => {
    calls.push({ file, args, cwd })
    return Promise.resolve(router(file, args))
  }
  return { run, calls }
}

function listResponse(
  issues: ReadonlyArray<{ number: number; state: string; body: string }>,
): IssueRunResult {
  return ok(JSON.stringify(issues))
}

describe('findTrackedIssue', () => {
  it('returns null when no issue carries the marker', async () => {
    const { run, calls } = fakeRun(() =>
      listResponse([{ number: 7, state: 'OPEN', body: 'unrelated issue' }]),
    )
    const found = await findTrackedIssue({ marker: MARKER, label: LABEL, cwd: CWD, run })
    expect(found).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.file).toBe('gh')
    expect(calls[0]!.args).toContain('--state')
    expect(calls[0]!.args).toContain('all')
    expect(calls[0]!.args).toContain(LABEL)
    expect(calls[0]!.cwd).toBe(CWD)
  })

  it('prefers the OPEN issue when both an open and a closed carrier exist', async () => {
    const { run } = fakeRun(() =>
      listResponse([
        { number: 3, state: 'CLOSED', body: `old\n${MARKER}` },
        { number: 9, state: 'OPEN', body: `current\n${MARKER}` },
      ]),
    )
    const found = await findTrackedIssue({ marker: MARKER, label: LABEL, cwd: CWD, run })
    expect(found).toEqual({ number: 9, state: 'OPEN', body: `current\n${MARKER}` })
  })

  it('falls back to the most recent closed carrier', async () => {
    const { run } = fakeRun(() =>
      listResponse([
        { number: 3, state: 'CLOSED', body: `older\n${MARKER}` },
        { number: 5, state: 'CLOSED', body: `newer\n${MARKER}` },
      ]),
    )
    const found = await findTrackedIssue({ marker: MARKER, label: LABEL, cwd: CWD, run })
    expect(found?.number).toBe(5)
    expect(found?.state).toBe('CLOSED')
  })
})

describe('upsertTrackedIssue', () => {
  const BODY = 'Current findings.\n\n- item one'

  it('creates a labelled issue (marker appended) when none exists', async () => {
    const { run, calls } = fakeRun((file, args) => {
      if (args[0] === 'issue' && args[1] === 'list') return listResponse([])
      if (args[0] === 'issue' && args[1] === 'create') {
        return ok('https://github.com/johnhain-msft/scns/issues/42\n')
      }
      throw new Error(`unexpected: ${file} ${args.join(' ')}`)
    })
    const res = await upsertTrackedIssue({
      marker: MARKER,
      label: LABEL,
      cwd: CWD,
      run,
      title: 'Drift findings',
      body: BODY,
    })
    expect(res).toEqual({ action: 'created', issueNumber: 42 })
    const create = calls.find((c) => c.args[1] === 'create')!
    expect(create.args).toContain('--label')
    expect(create.args).toContain(LABEL)
    const bodyArg = create.args[create.args.indexOf('--body') + 1]!
    expect(bodyArg).toContain(BODY)
    expect(bodyArg).toContain(MARKER)
  })

  it('is unchanged when an open issue already carries the same body', async () => {
    const { run, calls } = fakeRun((_file, args) => {
      if (args[1] === 'list') {
        return listResponse([{ number: 42, state: 'OPEN', body: `${BODY}\n\n${MARKER}` }])
      }
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const res = await upsertTrackedIssue({
      marker: MARKER,
      label: LABEL,
      cwd: CWD,
      run,
      title: 'Drift findings',
      body: BODY,
    })
    expect(res).toEqual({ action: 'unchanged', issueNumber: 42 })
    // Strictly one gh call: the list. No edit, no create.
    expect(calls).toHaveLength(1)
  })

  it('treats a CRLF body from the GitHub web UI as unchanged (no daily no-op edits)', async () => {
    const crlfBody = `${BODY}\n\n${MARKER}\n`.replace(/\n/g, '\r\n')
    const { run, calls } = fakeRun((_file, args) => {
      if (args[1] === 'list') return listResponse([{ number: 42, state: 'OPEN', body: crlfBody }])
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const res = await upsertTrackedIssue({
      marker: MARKER,
      label: LABEL,
      cwd: CWD,
      run,
      title: 'Drift findings',
      body: BODY,
    })
    expect(res).toEqual({ action: 'unchanged', issueNumber: 42 })
    expect(calls).toHaveLength(1)
  })

  it('edits the open issue in place when the body changed — never a second issue', async () => {
    const { run, calls } = fakeRun((_file, args) => {
      if (args[1] === 'list') {
        return listResponse([{ number: 42, state: 'OPEN', body: `stale body\n\n${MARKER}` }])
      }
      if (args[1] === 'edit') return ok('')
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const res = await upsertTrackedIssue({
      marker: MARKER,
      label: LABEL,
      cwd: CWD,
      run,
      title: 'Drift findings',
      body: BODY,
    })
    expect(res).toEqual({ action: 'updated', issueNumber: 42 })
    const edit = calls.find((c) => c.args[1] === 'edit')!
    expect(edit.args).toContain('42')
    expect(calls.some((c) => c.args[1] === 'create')).toBe(false)
  })

  it('skips an open issue untouched when onOpen is "skip" (strict dedupe mode)', async () => {
    const { run, calls } = fakeRun((_file, args) => {
      if (args[1] === 'list') {
        return listResponse([{ number: 42, state: 'OPEN', body: `anything\n${MARKER}` }])
      }
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const res = await upsertTrackedIssue({
      marker: MARKER,
      label: LABEL,
      cwd: CWD,
      run,
      title: 'Nudge',
      body: BODY,
      onOpen: 'skip',
    })
    expect(res).toEqual({ action: 'unchanged', issueNumber: 42 })
    expect(calls).toHaveLength(1)
  })

  it('reopens a closed carrier and refreshes its body', async () => {
    const { run, calls } = fakeRun((_file, args) => {
      if (args[1] === 'list') {
        return listResponse([{ number: 42, state: 'CLOSED', body: `old\n${MARKER}` }])
      }
      if (args[1] === 'reopen') return ok('')
      if (args[1] === 'edit') return ok('')
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const res = await upsertTrackedIssue({
      marker: MARKER,
      label: LABEL,
      cwd: CWD,
      run,
      title: 'Drift findings',
      body: BODY,
    })
    expect(res).toEqual({ action: 'reopened', issueNumber: 42 })
    expect(calls.map((c) => c.args[1])).toEqual(['list', 'reopen', 'edit'])
    expect(calls.some((c) => c.args[1] === 'create')).toBe(false)
  })

  it('throws on a gh failure instead of silently pretending success', async () => {
    const { run } = fakeRun((_file, args) => {
      if (args[1] === 'list') return listResponse([])
      return { ok: false, stdout: '', stderr: 'boom', code: 1 }
    })
    await expect(
      upsertTrackedIssue({
        marker: MARKER,
        label: LABEL,
        cwd: CWD,
        run,
        title: 'Drift findings',
        body: BODY,
      }),
    ).rejects.toThrow(/boom|create/)
  })
})

describe('closeTrackedIssue', () => {
  it('closes the open carrier with a comment', async () => {
    const { run, calls } = fakeRun((_file, args) => {
      if (args[1] === 'list') {
        return listResponse([{ number: 42, state: 'OPEN', body: `x\n${MARKER}` }])
      }
      if (args[1] === 'close') return ok('')
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const res = await closeTrackedIssue({
      marker: MARKER,
      label: LABEL,
      cwd: CWD,
      run,
      comment: 'All clear.',
    })
    expect(res).toEqual({ closed: true, issueNumber: 42 })
    const close = calls.find((c) => c.args[1] === 'close')!
    expect(close.args).toContain('42')
    expect(close.args).toContain('--comment')
  })

  it('is a no-op when no open carrier exists', async () => {
    const { run, calls } = fakeRun((_file, args) => {
      if (args[1] === 'list') {
        return listResponse([{ number: 42, state: 'CLOSED', body: `x\n${MARKER}` }])
      }
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const res = await closeTrackedIssue({ marker: MARKER, label: LABEL, cwd: CWD, run })
    expect(res).toEqual({ closed: false, issueNumber: null })
    expect(calls).toHaveLength(1)
  })
})
