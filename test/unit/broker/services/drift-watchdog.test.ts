/**
 * M3 (anti-drift) — staleness + deferral watchdog tests.
 *
 * One daily scheduled task with two probes:
 *   (a) docs/NORTH_STAR.md last commit older than 14 days → staleness
 *       finding (precedent: it once went 12 days / 71 commits stale);
 *   (b) specs/<slug>/{tasks.md,spec.md} `Due: YYYY-MM-DD` markers that
 *       are past due on UNCHECKED items → deferral findings (precedent:
 *       spec 003 US4 "post-Monday" due 2026-08-04 silently decayed).
 *
 * Both feed EXACTLY ONE GitHub issue (label `scns:self-improvement`,
 * NEVER `scns-auto`), updated in place; closed-and-still-stale reopens
 * it; all-clear closes it. The specs tree lives OUTSIDE the scns git
 * repo (scns_root/specs), so the scan is filesystem-based, not git-based.
 *
 * The `Due:` parser must survive the real-world shape: the marker wraps
 * across lines in specs/003 ("Due:\n      2026-08-17."), items carry
 * multi-line continuations, and bold `**...**` wrapping.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DRIFT_WATCHDOG_MARKER,
  runDriftWatchdog,
  scanSpecDeferrals,
  type DriftWatchdogDeps,
} from '../../../../src/broker/services/drift-watchdog.js'
import type {
  IssueRunCommand,
  IssueRunResult,
} from '../../../../src/broker/services/tracked-issue.js'

const NOW = new Date('2026-08-15T07:43:00Z')
const LABEL = 'scns:self-improvement'

function ok(stdout: string): IssueRunResult {
  return { ok: true, stdout, stderr: '' }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeSpecsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'scns-specs-'))
  dirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content, 'utf8')
  }
  return dir
}

/** Mutable fake GitHub + a git log -1 date for the NORTH_STAR probe. */
function fakeWorld(northStarCommitIso: string | null) {
  const issues: Array<{ number: number; state: string; body: string }> = []
  const calls: Array<{ file: string; args: readonly string[] }> = []
  let nextNumber = 200
  const run: IssueRunCommand = (file, args) => {
    calls.push({ file, args })
    if (file === 'git' && args[0] === 'log') {
      return Promise.resolve(ok(northStarCommitIso ? `${northStarCommitIso}\n` : ''))
    }
    if (file === 'gh' && args[1] === 'list') return Promise.resolve(ok(JSON.stringify(issues)))
    if (file === 'gh' && args[1] === 'create') {
      const number = nextNumber++
      issues.push({ number, state: 'OPEN', body: args[args.indexOf('--body') + 1]! })
      return Promise.resolve(ok(`https://github.com/johnhain-msft/scns/issues/${number}\n`))
    }
    if (file === 'gh' && args[1] === 'edit') {
      const target = issues.find((i) => String(i.number) === args[2])!
      target.body = args[args.indexOf('--body') + 1]!
      return Promise.resolve(ok(''))
    }
    if (file === 'gh' && args[1] === 'reopen') {
      issues.find((i) => String(i.number) === args[2])!.state = 'OPEN'
      return Promise.resolve(ok(''))
    }
    if (file === 'gh' && args[1] === 'close') {
      issues.find((i) => String(i.number) === args[2])!.state = 'CLOSED'
      return Promise.resolve(ok(''))
    }
    throw new Error(`unexpected: ${file} ${args.join(' ')}`)
  }
  return { run, calls, issues }
}

function makeDeps(
  world: ReturnType<typeof fakeWorld>,
  specsDir: string,
  overrides?: Partial<DriftWatchdogDeps>,
): DriftWatchdogDeps {
  return {
    projectRoot: '/repo',
    specsDir,
    runCommand: world.run,
    staleDays: 14,
    now: () => NOW,
    ...overrides,
  }
}

// Copied shape of the real specs/003 exemplars, including the wrapped date.
const TASKS_WITH_DEFERRALS = `# Tasks

- [x] T091 [C6] done thing — **DONE 2026-08-02.**
- [ ] T092c [C6] SC-007 full-corpus re-measurement — **DEFERRED. Owner: John. Due: 2026-08-04.** Needs a
      settled-row count that the current ~1.2 labels/day corpus cannot supply this week.
- [ ] T093c [C6] SC-001 end-to-end label-integrity re-measurement — **DEFERRED. Owner: John. Due:
      2026-08-17.** Requires ≥3 further weeks of accrual before the figure means anything.
- [x] T094 [C6] checked-but-past-due — **DEFERRED. Due: 2026-08-01.** Completed anyway.
`

describe('scanSpecDeferrals', () => {
  it('finds past-due unchecked items, including a wrapped Due: date', () => {
    const specsDir = makeSpecsDir({ '003-label-integrity/tasks.md': TASKS_WITH_DEFERRALS })
    const found = scanSpecDeferrals(specsDir, NOW)
    // 2026-08-04 is past due on 2026-08-15; the wrapped 2026-08-17 is not
    // yet due; the checked T094 is ignored despite being past due.
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      file: '003-label-integrity/tasks.md',
      dueDate: '2026-08-04',
    })
    expect(found[0]!.snippet).toContain('T092c')
  })

  it('the wrapped date becomes due once the clock passes it', () => {
    const specsDir = makeSpecsDir({ '003-label-integrity/tasks.md': TASKS_WITH_DEFERRALS })
    const later = new Date('2026-08-18T00:00:00Z')
    const found = scanSpecDeferrals(specsDir, later)
    expect(found.map((f) => f.dueDate).sort()).toEqual(['2026-08-04', '2026-08-17'])
  })

  it('a plain bullet under an unchecked item is NOT folded into it (no false Due:)', () => {
    const specsDir = makeSpecsDir({
      '006-z/tasks.md': [
        '- [ ] T010 rollout of the new gate',
        '- historical note, was Due: 2026-08-01 before the re-plan',
        '',
      ].join('\n'),
    })
    expect(scanSpecDeferrals(specsDir, NOW)).toEqual([])
  })

  it('supports + bullets for checklist items', () => {
    const specsDir = makeSpecsDir({
      '007-plus/tasks.md': '+ [ ] T020 sweep — DEFERRED. Due: 2026-08-01.\n',
    })
    const found = scanSpecDeferrals(specsDir, NOW)
    expect(found).toHaveLength(1)
    expect(found[0]!.dueDate).toBe('2026-08-01')
  })

  it('a re-dated deferral fires on the LATEST Due: date, not the first', () => {
    const specsDir = makeSpecsDir({
      '008-redate/tasks.md':
        '- [ ] T030 corpus re-measure — DEFERRED. Due: 2026-08-04. Re-dated 2026-08-14: Due: 2026-09-01.\n',
    })
    // Latest date (2026-09-01) is in the future → not past due on NOW.
    expect(scanSpecDeferrals(specsDir, NOW)).toEqual([])
    const later = new Date('2026-09-02T00:00:00Z')
    const found = scanSpecDeferrals(specsDir, later)
    expect(found).toHaveLength(1)
    expect(found[0]!.dueDate).toBe('2026-09-01')
  })

  it('scans spec.md too and survives a missing/empty specs dir', () => {
    const specsDir = makeSpecsDir({
      '004-next/spec.md': '- [ ] US9 rollout — Due: 2026-01-01 hard deadline\n',
    })
    expect(scanSpecDeferrals(specsDir, NOW)).toHaveLength(1)
    expect(scanSpecDeferrals(join(specsDir, 'does-not-exist'), NOW)).toEqual([])
  })
})

describe('runDriftWatchdog', () => {
  it('all healthy → no issue, outcome all-clear, zero gh writes', async () => {
    const world = fakeWorld('2026-08-14T10:00:00Z') // NORTH_STAR fresh
    const specsDir = makeSpecsDir({ '001-x/tasks.md': '- [x] done — Due: 2026-08-01\n' })
    const outcome = await runDriftWatchdog(makeDeps(world, specsDir))
    expect(outcome.status).toBe('all-clear')
    expect(world.issues).toHaveLength(0)
    const writes = world.calls.filter((c) => c.file === 'gh' && c.args[1] !== 'list')
    expect(writes).toHaveLength(0)
  })

  it('stale NORTH_STAR (>14 days) → files ONE issue with the staleness finding', async () => {
    const world = fakeWorld('2026-07-20T10:00:00Z') // 26 days before NOW
    const specsDir = makeSpecsDir({})
    const outcome = await runDriftWatchdog(makeDeps(world, specsDir))
    expect(outcome.status).toBe('findings')
    // The age probe must see refreshes on ANY ref — the broker clone's
    // checked-out HEAD may lag behind a topic branch or origin/main.
    expect(world.calls.find((c) => c.file === 'git')!.args).toContain('--all')
    expect(outcome.action).toBe('created')
    expect(world.issues).toHaveLength(1)
    expect(world.issues[0]!.body).toContain('docs/NORTH_STAR.md')
    expect(world.issues[0]!.body).toContain('2026-07-20')
    expect(world.issues[0]!.body).toContain(DRIFT_WATCHDOG_MARKER)

    const create = world.calls.find((c) => c.args[1] === 'create')!
    expect(create.args).toContain(LABEL)
    expect(create.args.join(' ')).not.toContain('scns-auto')
  })

  it('renders both staleness AND past-due deferrals in the same single issue', async () => {
    const world = fakeWorld('2026-07-20T10:00:00Z')
    const specsDir = makeSpecsDir({ '003-label-integrity/tasks.md': TASKS_WITH_DEFERRALS })
    const outcome = await runDriftWatchdog(makeDeps(world, specsDir))
    expect(outcome.status).toBe('findings')
    expect(world.issues).toHaveLength(1)
    const body = world.issues[0]!.body
    expect(body).toContain('docs/NORTH_STAR.md')
    expect(body).toContain('T092c')
    expect(body).toContain('2026-08-04')
  })

  it('run twice with identical findings → no duplicate issue, no edit', async () => {
    const world = fakeWorld('2026-07-20T10:00:00Z')
    const specsDir = makeSpecsDir({ '003-label-integrity/tasks.md': TASKS_WITH_DEFERRALS })
    const deps = makeDeps(world, specsDir)
    await runDriftWatchdog(deps)
    const callsAfterFirst = world.calls.length

    const second = await runDriftWatchdog(deps)
    expect(second.status).toBe('findings')
    expect(second.action).toBe('unchanged')
    expect(world.issues).toHaveLength(1)
    const writes = world.calls
      .slice(callsAfterFirst)
      .filter((c) => c.file === 'gh' && c.args[1] !== 'list')
    expect(writes).toHaveLength(0)
  })

  it('changed findings → edits the SAME issue in place', async () => {
    const world = fakeWorld('2026-07-20T10:00:00Z')
    const specsA = makeSpecsDir({ '003-x/tasks.md': TASKS_WITH_DEFERRALS })
    await runDriftWatchdog(makeDeps(world, specsA))
    const number = world.issues[0]!.number

    // A new deferral decays past due; findings change, issue must follow.
    const specsB = makeSpecsDir({
      '003-x/tasks.md': TASKS_WITH_DEFERRALS,
      '005-y/tasks.md': '- [ ] T001 rollout — DEFERRED. Due: 2026-08-10.\n',
    })
    const outcome = await runDriftWatchdog(makeDeps(world, specsB))
    expect(outcome.action).toBe('updated')
    expect(world.issues).toHaveLength(1)
    expect(world.issues[0]!.number).toBe(number)
    expect(world.issues[0]!.body).toContain('T001')
  })

  it('closed-and-still-stale → reopens the SAME issue', async () => {
    const world = fakeWorld('2026-07-20T10:00:00Z')
    const specsDir = makeSpecsDir({})
    const deps = makeDeps(world, specsDir)
    await runDriftWatchdog(deps)
    world.issues[0]!.state = 'CLOSED'

    const outcome = await runDriftWatchdog(deps)
    expect(outcome.action).toBe('reopened')
    expect(world.issues).toHaveLength(1)
    expect(world.issues[0]!.state).toBe('OPEN')
  })

  it('findings resolved while the issue is open → closes it with a comment', async () => {
    const world = fakeWorld('2026-07-20T10:00:00Z')
    const specsDir = makeSpecsDir({})
    await runDriftWatchdog(makeDeps(world, specsDir))
    expect(world.issues[0]!.state).toBe('OPEN')

    const healthyWorld = { ...world, run: world.run }
    const outcome = await runDriftWatchdog({
      ...makeDeps(healthyWorld, specsDir),
      runCommand: (file, args, cwd) => {
        if (file === 'git' && args[0] === 'log') {
          return Promise.resolve(ok('2026-08-14T10:00:00Z\n'))
        }
        return world.run(file, args, cwd)
      },
    })
    expect(outcome.status).toBe('all-clear')
    expect(outcome.closedIssue).toBe(true)
    expect(world.issues[0]!.state).toBe('CLOSED')
  })

  it('a NORTH_STAR file with no commit history is reported as a finding, not skipped', async () => {
    const world = fakeWorld(null)
    const specsDir = makeSpecsDir({})
    const outcome = await runDriftWatchdog(makeDeps(world, specsDir))
    expect(outcome.status).toBe('findings')
    expect(world.issues[0]!.body).toMatch(/no commit/i)
  })
})
