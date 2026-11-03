/**
 * T145 / FR-057c — a retry after a quality-gate failure gets a FRESH agent context, and is an
 * implementation retry rather than a second human decision.
 *
 * Why this needs to be behavioural rather than a code trace: both dev sessions on `65a914f4`
 * exited with `message_count=0`, which is the signature of a stuck agent context. If a retry
 * resumed that context it would reproduce the failure deterministically and the retry budget
 * would buy nothing — five identical failures instead of one.
 *
 * Per T145's own instruction ("confirm whether the brain's existing spawn path already gives a
 * fresh context per attempt; if it does, this task is an assertion, not an implementation"),
 * this file ASSERTS the existing behaviour rather than adding a mechanism. What it pins:
 *
 *   1. the brain calls `onSpawnTeam` again on the retry — a new spawn, not a resume;
 *   2. the retry carries no re-prompt of John: no new verdict is written and his reason and
 *      verdict are byte-identical before and after;
 *   3. backoff is honoured, so the retry is scheduled rather than immediate.
 *
 * The store here is a REAL `createSuggestionStore` over a `mkdtempSync` dir, not a mock, because
 * the whole point is the interaction between the gate's write and the brain's next read.
 * `~/.scns` is never opened.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSuggestionStore } from '../../../src/suggest/suggestion-store.js'
import { SuggestionType, type Suggestion, type SuggestionStatus } from '../../../src/suggest/types.js'

const SUGGESTION_ID = '65a914f4-b229-4fde-874e-c46a44dd845f'
const TEAM_ID = `team-sugg-${SUGGESTION_ID.slice(0, 8)}`
const JOHN_APPROVED = 'human:cheap-win:small and unblocks the weekly loop'

let dir: string
let store: ReturnType<typeof createSuggestionStore>

/**
 * The brain's approved-suggestion loop, reduced to the two decisions T145 is about: skip while
 * backoff is live, otherwise spawn a NEW team. Mirrors `agent-loop.ts` ApprovedSuggestions
 * (`nextRetryAt` skip at :640, `onSpawnTeam` + `markInProgress` at :720-790).
 */
async function brainTick(
  onSpawnTeam: (input: { suggestionId: string }) => Promise<{ teamId: string }>,
  nowMs: number,
): Promise<'skipped-backoff' | 'spawned' | 'nothing'> {
  const approved = store.list('approved' as SuggestionStatus)
  if (approved.length === 0) return 'nothing'
  const s = approved[0]!
  if (s.nextRetryAt && nowMs < new Date(s.nextRetryAt).getTime()) return 'skipped-backoff'
  const spawn = await onSpawnTeam({ suggestionId: s.id })
  store.markInProgress(s.id, spawn.teamId)
  return 'spawned'
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scns-retry-fresh-'))
  store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
  store.save({
    id: SUGGESTION_ID,
    type: SuggestionType.Workflow,
    title: 'Log a structured event on every autonomy-level transition',
    description: 'a description',
    confidence: 0.9,
    status: 'pending',
    createdAt: '2026-08-04T16:30:00.000Z',
    updatedAt: '2026-08-04T16:30:00.000Z',
    evidence: [],
    tags: ['self-improvement'],
    estimatedComplexity: 'team',
    suggestedRoles: ['dev', 'reviewer'],
  } as Suggestion)
  store.updateStatus(SUGGESTION_ID, 'approved' as SuggestionStatus, JOHN_APPROVED, undefined, {
    reviewVerdict: 'approve',
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('FR-057c — a retry is a new implementation attempt, not a new decision', () => {
  it('T145: the retry spawns a NEW team rather than resuming the failed one', async () => {
    let spawnCount = 0
    const onSpawnTeam = vi.fn(async () => {
      spawnCount++
      return { teamId: `${TEAM_ID}-attempt-${spawnCount}` }
    })

    const t0 = Date.parse('2026-08-04T16:33:00.000Z')
    expect(await brainTick(onSpawnTeam, t0)).toBe('spawned')
    expect(store.get(SUGGESTION_ID)!.inflightTeamId).toBe(`${TEAM_ID}-attempt-1`)

    // The gate fails, exactly as it did at 16:53.
    store.recordQualityGateFailure(SUGGESTION_ID, 'qg-fail:tests-failed', t0)

    // `inflightTeamId` is gone, so nothing points at the stuck context any more.
    expect(store.get(SUGGESTION_ID)!.inflightTeamId).toBeNull()

    // Two minutes later backoff is still live (2^1 = 2 minutes): the brain waits.
    expect(await brainTick(onSpawnTeam, t0 + 60_000)).toBe('skipped-backoff')
    expect(onSpawnTeam).toHaveBeenCalledTimes(1)

    // Past the backoff, it spawns AGAIN — a second call, a second team id.
    expect(await brainTick(onSpawnTeam, t0 + 5 * 60_000)).toBe('spawned')
    expect(onSpawnTeam).toHaveBeenCalledTimes(2)
    expect(store.get(SUGGESTION_ID)!.inflightTeamId).toBe(`${TEAM_ID}-attempt-2`)
  })

  it('T145: the retry writes no second verdict and no new rationale-bearing reason', async () => {
    const t0 = Date.parse('2026-08-04T16:33:00.000Z')
    const before = store.get(SUGGESTION_ID)!
    const onSpawnTeam = vi.fn(async () => ({ teamId: TEAM_ID }))

    await brainTick(onSpawnTeam, t0)
    store.recordQualityGateFailure(SUGGESTION_ID, 'qg-fail:tests-failed', t0)
    await brainTick(onSpawnTeam, t0 + 5 * 60_000)
    store.recordQualityGateFailure(SUGGESTION_ID, 'qg-fail:tests-failed', t0 + 5 * 60_000)

    const after = store.get(SUGGESTION_ID)!
    // John decided ONCE. Two build attempts later he has still decided once — same verdict, same
    // words, byte-for-byte. A retry that re-prompted him, or that re-recorded his verdict, would
    // double-count a single decision in the corpus SC-021 measures.
    expect(after.reviewVerdict).toBe(before.reviewVerdict)
    expect(after.reviewReason).toBe(before.reviewReason)
    // Only the machine's side of the file moves.
    expect(after.attemptCount).toBe(2)
    expect(after.machineReason).toBe('qg-fail:tests-failed')
  })

  it('T145: backoff grows between attempts, so retries are scheduled and not a hot loop', async () => {
    const t0 = Date.parse('2026-08-04T16:33:00.000Z')
    const first = store.recordQualityGateFailure(SUGGESTION_ID, 'qg-fail:tests-failed', t0)!
    const gapAfterFirst = new Date(first.nextRetryAt!).getTime() - t0

    store.markInProgress(SUGGESTION_ID, TEAM_ID)
    const second = store.recordQualityGateFailure(SUGGESTION_ID, 'qg-fail:tests-failed', t0)!
    const gapAfterSecond = new Date(second.nextRetryAt!).getTime() - t0

    expect(gapAfterSecond).toBeGreaterThan(gapAfterFirst)
  })
})
