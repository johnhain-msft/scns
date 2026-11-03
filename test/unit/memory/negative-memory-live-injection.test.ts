/**
 * The LIVE per-prompt "Things to AVOID" injection must honor the critic's verdict.
 *
 * `negative-memory-applicator.ts` (which writes the managed AGENTS.md block) already filters out
 * memories the critic marked `suppress`. The live injection path in `dashboard-routes.ts` did NOT —
 * it called `store.list({ limit: 10 })` and filtered only on `!!dontRule`. Measured consequence
 * (2026-07-28): all 215 quality-gate-rejection artifacts in the vault carry `criticStatus: suppress`,
 * and 10/10 rules injected into a live session were those artifacts — the entire injection budget was
 * noise the critic had already rejected, crowding out the real lessons.
 *
 * The fix is a SHARED predicate, not a second filter: both consumers classify through
 * `classifyNegativeMemory` so "eligible" has exactly one definition.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyNegativeMemory,
  selectInjectableNegativeRules,
  NEGATIVE_MEMORY_SCAN_LIMIT,
  NEGATIVE_RULE_RELEVANCE_FLOOR,
} from '../../../src/memory/negative-memory-applicator.js'
import { makePromptRelevanceScorer } from '../../../src/memory/injection-relevance.js'

const mem = (over: Record<string, unknown> = {}) => ({
  dontRule: 'do not do the thing',
  confidence: 0.7,
  pinned: false,
  criticVerdict: null,
  ...over,
})

describe('classifyNegativeMemory — one definition of "eligible"', () => {
  it('suppresses what the critic rejected', () => {
    expect(classifyNegativeMemory(mem({ criticVerdict: { status: 'suppress' } }))).toBe(
      'suppressed-by-critic',
    )
  })

  it('keeps what the critic upheld', () => {
    expect(classifyNegativeMemory(mem({ criticVerdict: { status: 'keep' } }))).toBe('eligible')
    expect(classifyNegativeMemory(mem({ criticVerdict: { status: 'revise' } }))).toBe('eligible')
  })

  it('treats an unjudged memory as pending review by default', () => {
    expect(classifyNegativeMemory(mem())).toBe('pending-review')
  })

  it('admits an unjudged memory when the caller opts in', () => {
    expect(classifyNegativeMemory(mem(), { allowUnjudged: true })).toBe('eligible')
  })

  it('honors pinned over every other signal', () => {
    expect(
      classifyNegativeMemory(
        mem({ pinned: true, confidence: 0, criticVerdict: { status: 'suppress' } }),
      ),
    ).toBe('eligible')
  })

  it('drops low-confidence memories', () => {
    expect(classifyNegativeMemory(mem({ confidence: 0.1 }))).toBe('low-confidence')
  })
})

describe('selectInjectableNegativeRules — what the live prompt actually receives', () => {
  const suppressed = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      mem({
        dontRule: `Quality gate rejected team team-selfissue-${i}: Tests regressed`,
        criticVerdict: { status: 'suppress' },
      }),
    )
  it('never injects a rule the critic suppressed', () => {
    const rules = selectInjectableNegativeRules(suppressed(10), { limit: 10 })
    expect(rules).toEqual([])
  })

  it('injects the real lesson even when suppressed noise is newer and fills the budget', () => {
    // This is the measured production shape: 10 suppressed CI artifacts ahead of a genuine lesson.
    const input = [
      ...suppressed(10),
      mem({
        dontRule: 'never say "tests pass" without the row',
        criticVerdict: { status: 'keep' },
      }),
    ]
    const rules = selectInjectableNegativeRules(input, { limit: 10 })
    expect(rules).toContain('never say "tests pass" without the row')
    expect(rules.some((r) => r.includes('Quality gate rejected'))).toBe(false)
  })

  it('prefers the critic revision when it rewrote the rule', () => {
    const rules = selectInjectableNegativeRules(
      [mem({ dontRule: 'raw', criticVerdict: { status: 'revise', revisedRule: 'revised' } })],
      { limit: 10 },
    )
    expect(rules).toEqual(['revised'])
  })

  it('respects the limit', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      mem({ dontRule: `rule ${i}`, criticVerdict: { status: 'keep' } }),
    )
    expect(selectInjectableNegativeRules(many, { limit: 10 })).toHaveLength(10)
  })
})

/**
 * Issue #75 — relevance mode. Quality (the critic gate) decides what MAY inject; relevance
 * decides what a GIVEN PROMPT actually receives. Pinned rules bypass relevance the same way
 * they already bypass the critic and confidence gates, and a floor keeps universally-phrased
 * guardrails circulating when the prompt matches nothing (a guardrail can apply to a task
 * without sharing its words).
 */
describe('selectInjectableNegativeRules — relevance mode (issue #75)', () => {
  const prompt = 'why does the broker heartbeat retry loop hammer the backoff'
  const relevance = () => ({
    score: makePromptRelevanceScorer(prompt),
    floor: NEGATIVE_RULE_RELEVANCE_FLOOR,
  })
  const keep = (dontRule: string, over: Record<string, unknown> = {}) =>
    mem({ dontRule, criticVerdict: { status: 'keep' }, ...over })

  const ON_TOPIC = [
    keep('Never bypass the broker heartbeat retry backoff'),
    keep('Do not call the heartbeat poller from the retry loop'),
    keep('Never mock the broker heartbeat in retry tests'),
  ]
  const OFF_TOPIC = [
    keep('Do not hand-edit generated schema files'),
    keep('Never run destructive migrations on live data'),
  ]

  it('the critic gate still runs FIRST — a suppressed rule never injects, however relevant', () => {
    const rules = selectInjectableNegativeRules(
      [mem({ dontRule: 'broker heartbeat retry backoff', criticVerdict: { status: 'suppress' } })],
      { limit: 10, relevance: relevance() },
    )
    expect(rules).toEqual([])
  })

  it('keeps on-topic rules and drops off-topic ones when enough are relevant', () => {
    const rules = selectInjectableNegativeRules([...OFF_TOPIC, ...ON_TOPIC], {
      limit: 10,
      relevance: relevance(),
    })
    for (const m of ON_TOPIC) expect(rules).toContain(m.dontRule)
    for (const m of OFF_TOPIC) expect(rules).not.toContain(m.dontRule)
  })

  it('orders relevant rules best-match-first', () => {
    // Tighter coverage of the prompt outranks a looser match regardless of store order.
    const loose = keep('Never mock the broker heartbeat in retry tests when the sweep runs')
    const tight = keep('Never bypass the broker heartbeat retry backoff')
    const rules = selectInjectableNegativeRules([loose, tight, ...ON_TOPIC.slice(1)], {
      limit: 10,
      relevance: relevance(),
    })
    expect(rules.indexOf(tight.dontRule)).toBeLessThan(rules.indexOf(loose.dontRule))
  })

  it('a pinned flood cannot starve relevant rules — floor slots stay reserved for matches', () => {
    const flood = Array.from({ length: 12 }, (_, i) =>
      mem({ dontRule: `pinned governance rule ${i}`, pinned: true }),
    )
    const rules = selectInjectableNegativeRules([...flood, ...ON_TOPIC], {
      limit: 10,
      relevance: relevance(),
    })
    expect(rules).toHaveLength(10)
    // Pinned lead but cap at limit − floor; the last floor slots carry the actual matches.
    expect(rules.slice(0, 7)).toEqual(flood.slice(0, 7).map((m) => m.dontRule))
    for (const m of ON_TOPIC) expect(rules).toContain(m.dontRule)
  })

  it('with nothing relevant, pinned rules may still fill the whole limit', () => {
    const flood = Array.from({ length: 12 }, (_, i) =>
      mem({ dontRule: `pinned governance rule ${i}`, pinned: true }),
    )
    const rules = selectInjectableNegativeRules([...flood, ...OFF_TOPIC], {
      limit: 10,
      relevance: relevance(),
    })
    expect(rules).toEqual(flood.slice(0, 10).map((m) => m.dontRule))
  })

  it('a pinned rule always injects, even when fully off-topic', () => {
    const pinnedRule = mem({ dontRule: 'Never commit credentials to the repository', pinned: true })
    const rules = selectInjectableNegativeRules([...ON_TOPIC, pinnedRule], {
      limit: 10,
      relevance: relevance(),
    })
    expect(rules).toContain('Never commit credentials to the repository')
  })

  it('floor: nothing relevant → the first FLOOR eligible rules inject in store order', () => {
    const five = [
      ...OFF_TOPIC,
      keep('Do not skip the legacy database upgrade test'),
      keep('Never delete another live participant inbox'),
      keep('Do not open pull requests with open questions'),
    ]
    const rules = selectInjectableNegativeRules(five, { limit: 10, relevance: relevance() })
    expect(rules).toEqual(five.slice(0, NEGATIVE_RULE_RELEVANCE_FLOOR).map((m) => m.dontRule))
  })

  it('floor counts pinned: one pinned off-topic rule → topped up to FLOOR total', () => {
    const pinnedRule = mem({ dontRule: 'Never commit credentials to the repository', pinned: true })
    const rules = selectInjectableNegativeRules([...OFF_TOPIC, pinnedRule, ...OFF_TOPIC2()], {
      limit: 10,
      relevance: relevance(),
    })
    expect(rules).toHaveLength(NEGATIVE_RULE_RELEVANCE_FLOOR)
    expect(rules[0]).toBe('Never commit credentials to the repository') // pinned leads
    // Top-up preserves store order among the non-pinned rest.
    expect(rules.slice(1)).toEqual(OFF_TOPIC.map((m) => m.dontRule))
  })

  it('fewer eligible rules than the floor → all of them inject (never pads, never throws)', () => {
    const rules = selectInjectableNegativeRules(OFF_TOPIC, { limit: 10, relevance: relevance() })
    expect(rules).toEqual(OFF_TOPIC.map((m) => m.dontRule))
  })

  it('the limit still caps relevance mode', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      keep(`broker heartbeat retry backoff rule ${i}`),
    )
    expect(selectInjectableNegativeRules(many, { limit: 10, relevance: relevance() })).toHaveLength(
      10,
    )
  })

  it('relevance scores the INJECTED text — the critic revision, not the raw rule', () => {
    const revised = mem({
      dontRule: 'completely unrelated original wording',
      criticVerdict: {
        status: 'revise',
        revisedRule: 'Never bypass the broker heartbeat retry backoff',
      },
    })
    const rules = selectInjectableNegativeRules([...OFF_TOPIC, revised, ...OFF_TOPIC2()], {
      limit: 10,
      relevance: { score: makePromptRelevanceScorer(prompt), floor: 0 },
    })
    expect(rules).toEqual(['Never bypass the broker heartbeat retry backoff'])
  })

  it('without relevance opts the selection is unchanged (the flip-back path)', () => {
    const input = [...OFF_TOPIC, ...ON_TOPIC]
    expect(selectInjectableNegativeRules(input, { limit: 10 })).toEqual(
      input.map((m) => m.dontRule),
    )
  })

  /** Extra off-topic rules so the floor tests have a top-up pool beyond OFF_TOPIC. */
  function OFF_TOPIC2() {
    return [keep('Do not skip the legacy database upgrade test')]
  }
})

/**
 * The store sorts NEWEST-FIRST and then `slice(0, limit)`s — so any fetch page narrower than the
 * store TRUNCATES BEFORE the critic filter runs. Live-confirmed against the real vault (223
 * memories: 215 recent `suppress` CI artifacts, 8 genuine `keep` lessons from April–July): a
 * 200-row page contained zero eligible rules and the live block came back EMPTY. Filtering the
 * noise out is only half the job — the real lessons must still be reachable.
 */
describe('NEGATIVE_MEMORY_SCAN_LIMIT — the fetch page must not truncate before the filter', () => {
  it('exceeds the applicator page so both consumers see the same candidate set', () => {
    expect(NEGATIVE_MEMORY_SCAN_LIMIT).toBeGreaterThanOrEqual(1000)
  })

  it('surfaces an old eligible lesson sitting behind a full page of newer suppressed noise', () => {
    const store = [
      ...Array.from({ length: 215 }, (_, i) =>
        mem({ dontRule: `Quality gate rejected team ${i}`, criticVerdict: { status: 'suppress' } }),
      ),
      mem({
        dontRule: 'Do not claim functionality works without live verification',
        criticVerdict: { status: 'keep' },
      }),
    ]
    const page = store.slice(0, NEGATIVE_MEMORY_SCAN_LIMIT)
    expect(selectInjectableNegativeRules(page, { limit: 10 })).toEqual([
      'Do not claim functionality works without live verification',
    ])
  })
})
