/**
 * Step 2 (D2) — the HOP-SHAPE classifier: single-hop vs multi-hop vs ambiguous.
 *
 * Purpose frame (NORTH_STAR "Retrieval design intent", 2026-08-14): `magma` serves single-hop
 * retrieval, `multihop-iter` serves multi-hop retrieval, routed by what the query needs. This
 * classifier is the heuristic-first, OFFLINE/shadow-first cut (Adaptive-RAG, arXiv:2403.14403,
 * adapted: route by query complexity; here the complexity signal is query STRUCTURE, not a learned
 * model yet). It never touches arm selection in Step 2.
 *
 * Controls are drawn from the live corpus's real prompt shapes (typo-laden coding-assistant traffic),
 * not from textbook QA — because that is what it will be measured on.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyHopShape,
  toolForHopShape,
  HOP_SHAPES,
  HOP_SHAPE_CLASSIFIER_VERSION,
  HOP_SHAPE_MARGIN,
  HOP_SHAPE_MULTI_MIN_EVIDENCE,
} from '../../../src/memory/hop-shape.js'
import { extractHopShapeSignals } from '../../../src/memory/hop-shape-signals.js'

const shapeOf = (q: string) => classifyHopShape(q).shape
const reasonsOf = (q: string) => classifyHopShape(q).reasons

const MULTI_REASONS = [
  'multi-entity-relation',
  'causal-chain',
  'temporal-chain',
  'comparison',
  'aggregation',
  'multi-question',
  'reference-following',
  'sequence-chain',
  'multi-referent',
] as const
const SINGLE_REASONS = [
  'short-directive',
  'file-directive',
  'single-referent',
  'yes-no-status',
  'plain-request',
] as const

describe('hop-shape — CLEAR SINGLE-HOP (positive controls for the magma tool)', () => {
  const cases: Array<[string, string]> = [
    ['continue', 'short-directive'],
    ['try again', 'short-directive'],
    ['analyze', 'short-directive'],
    ['create the tasks', 'short-directive'],
    [
      'Read the file at /var/folders/tv/w7m7yb7j57lchccf9s9yjktc0000gn/T/tmpau63gag3.md and follow the instructions inside it exactly. Output only what is requested.',
      'file-directive',
    ],
    [
      'read /Users/dev/.copilot/session-state/8d1f0484/handoff.md and execute it.',
      'file-directive',
    ],
    ['are we ready for the speckit plan agent to create the implementation plan?', 'yes-no-status'],
    ["PR #26 is the work you completed -- we've already had copilot review it?", 'single-referent'],
    ['is PR #26 merged?', 'yes-no-status'],
    [
      'running from broker is fine; however, it needs to actually open a terminal so i can interact with it.',
      'plain-request',
    ],
  ]
  for (const [q, reason] of cases) {
    it(`"${q.slice(0, 60)}" → single-hop, carrying reason ${reason}`, () => {
      const c = classifyHopShape(q)
      expect(c.shape).toBe('single-hop')
      expect(c.reasons).toContain(reason)
      expect(c.recommendedTool).toBe('magma')
    })
  }

  it('NEGATIVE CONTROL: a bare directive carries NO multi-hop reason at all', () => {
    for (const q of ['continue', 'try again', 'analyze']) {
      const r = reasonsOf(q)
      for (const m of MULTI_REASONS) expect(r).not.toContain(m)
    }
  })
})

describe('hop-shape — CLEAR MULTI-HOP (positive controls for the multihop-iter tool)', () => {
  const cases: Array<[string, string]> = [
    [
      'how does the fix we need to implement fit into the existing tasks? is this something that plugs in nicely?',
      'multi-entity-relation',
    ],
    ['why is the brains consolidate branch the reason for the starvation?', 'causal-chain'],
    ['map the workflow against what we have and the remaining tasks.', 'multi-entity-relation'],
    [
      "how could minN=5 not be met on Monday? i've been talking to scns and other sessions non-stop for days.",
      'causal-chain',
    ],
    [
      'lets do a quick standup for where we left off. its been a few days. i want to pick back up where we left off.',
      'temporal-chain',
    ],
    ['what changed between PR #24 and PR #26, and why did the review fail?', 'comparison'],
    ['summarize what we have done so far and where we are overall', 'aggregation'],
    [
      'did we address these bugs or at least create issues so they could be picked up?',
      'reference-following',
    ],
    [
      "advise on where we are... time to push, merge, and handoff to a fresh session to tackle next batch? sounds like we're starting at T043?",
      'aggregation',
    ],
  ]
  for (const [q, reason] of cases) {
    it(`"${q.slice(0, 60)}" → multi-hop, carrying reason ${reason}`, () => {
      const c = classifyHopShape(q)
      expect(c.shape).toBe('multi-hop')
      expect(c.reasons).toContain(reason)
      expect(c.recommendedTool).toBe('multihop-iter')
    })
  }

  it('NEGATIVE CONTROL: a causal/relational question is never labelled a short directive', () => {
    const r = reasonsOf('why is the brains consolidate branch the reason for the starvation?')
    expect(r).not.toContain('short-directive')
    expect(r).not.toContain('file-directive')
  })

  it('a long many-referent brief is NOT confidently single-hop', () => {
    const brief =
      'Read /Users/dev/.copilot/session-state/ac19cad1/handoff.md in full before doing anything. ' +
      'You are picking up spec 003 at Phase 4 / User Story 2 — the #16 guard hoist (P1). Repo ' +
      '/Users/dev/Coding_Projects/scns_root/scns, branch off main @ 3e8c822. Read specs/003-label-integrity-defects/tasks.md ' +
      'and reconcile T022–T030 against PR #24 findings; FR-034 and SC-009 are binding. Why did T016 regress? ' +
      'Compare the corrected gate with the naive one before touching src/memory/query-chain.ts.'
    expect(shapeOf(brief)).not.toBe('single-hop')
  })
})

describe('hop-shape — AMBIGUOUS is an explicit class, never a coin flip', () => {
  it('empty and whitespace-only prompts are ambiguous with reason no-signal', () => {
    for (const q of ['', '   ', '\n\t']) {
      const c = classifyHopShape(q)
      expect(c.shape).toBe('ambiguous')
      expect(c.reasons).toEqual(['no-signal'])
      expect(c.recommendedTool).toBeNull()
    }
  })

  it('a bare acknowledgement has no query structure to read → ambiguous, not single-hop', () => {
    for (const q of ['ok', 'yes', 'thanks', 'sounds good']) {
      const c = classifyHopShape(q)
      expect(c.shape).toBe('ambiguous')
      expect(c.reasons).toContain('no-signal')
    }
  })

  it('balanced conflicting signals resolve to ambiguous with reason conflicting-signals', () => {
    // one referent + a yes/no opener (single) against a second question + a temporal cue (multi)
    const c = classifyHopShape('did PR #26 land? and what changed since?')
    expect(c.shape).toBe('ambiguous')
    expect(c.reasons).toContain('conflicting-signals')
    expect(c.recommendedTool).toBeNull()
    expect(Math.abs(c.scores.multi - c.scores.single)).toBeLessThan(HOP_SHAPE_MARGIN)
  })

  it('a LONE weak multi-hop cue (one "then", nothing else) is ambiguous with reason weak-signal — not a multi-hop call', () => {
    const c = classifyHopShape(
      'lets commit and merge the current branch for right now. then we can start on main. after its done i will paste what you gave me above',
    )
    expect(c.shape).toBe('ambiguous')
    expect(c.reasons).toContain('weak-signal')
    expect(c.reasons).toContain('sequence-chain')
    expect(c.recommendedTool).toBeNull()
    expect(c.scores.multi).toBeLessThan(HOP_SHAPE_MULTI_MIN_EVIDENCE)
  })

  it('TWO weak cues together DO clear the bar (POSITIVE CONTROL for the weak-signal rule)', () => {
    // one "then" (sequence-chain, 1) + a second question (multi-question, 1) = 2 ≥ 1.5
    const c = classifyHopShape('did it pass? then what is next?')
    expect(c.scores.multi).toBeGreaterThanOrEqual(HOP_SHAPE_MULTI_MIN_EVIDENCE)
    expect(c.reasons).not.toContain('weak-signal')
  })

  it('an ambiguous classification still lists the evidence it saw (typed reasons, not prose)', () => {
    const c = classifyHopShape('did PR #26 land? and what changed since?')
    const known = new Set<string>([
      ...MULTI_REASONS,
      ...SINGLE_REASONS,
      'no-signal',
      'conflicting-signals',
      'weak-signal',
    ])
    for (const r of c.reasons) expect(known.has(r)).toBe(true)
    expect(c.reasons.length).toBeGreaterThan(1)
  })
})

describe('hop-shape — contract', () => {
  it('is deterministic and pure', () => {
    const q = 'why is the brains consolidate branch the reason for the starvation?'
    expect(classifyHopShape(q)).toEqual(classifyHopShape(q))
  })

  it('is case- and whitespace-insensitive', () => {
    const a = classifyHopShape(
      'WHY is the   brains consolidate branch\nthe reason for the starvation?',
    )
    const b = classifyHopShape(
      'why is the brains consolidate branch the reason for the starvation?',
    )
    expect(a.shape).toBe(b.shape)
    expect(a.reasons).toEqual(b.reasons)
  })

  it('names its version so a report can say which heuristic it measured', () => {
    expect(HOP_SHAPE_CLASSIFIER_VERSION).toMatch(/^heuristic-v\d+$/)
    expect(classifyHopShape('continue').version).toBe(HOP_SHAPE_CLASSIFIER_VERSION)
  })

  it('maps shape → tool exactly as the design intent states, and ambiguous → no tool', () => {
    expect(HOP_SHAPES).toEqual(['single-hop', 'multi-hop', 'ambiguous'])
    expect(toolForHopShape('single-hop')).toBe('magma')
    expect(toolForHopShape('multi-hop')).toBe('multihop-iter')
    expect(toolForHopShape('ambiguous')).toBeNull()
  })

  it('never recommends the tool the shape argues against (cross-check over the controls)', () => {
    const singles = ['continue', 'is PR #26 merged?']
    const multis = ['why is the brains consolidate branch the reason for the starvation?']
    for (const q of singles) expect(classifyHopShape(q).recommendedTool).not.toBe('multihop-iter')
    for (const q of multis) expect(classifyHopShape(q).recommendedTool).not.toBe('magma')
  })

  it('reasons are ordered by weight (strongest first) and never duplicated', () => {
    const r = reasonsOf('what changed between PR #24 and PR #26, and why did the review fail?')
    expect(new Set(r).size).toBe(r.length)
    expect(r[0]).toMatch(/^(comparison|causal-chain|multi-entity-relation)$/)
  })

  it('never throws on hostile input (very long, control characters, or unicode)', () => {
    expect(() => classifyHopShape('x'.repeat(200_000))).not.toThrow()
    expect(() => classifyHopShape(' �​'.repeat(50))).not.toThrow()
    expect(() => classifyHopShape('¿por qué falló el último run? — 何が変わった？')).not.toThrow()
  })

  it('stays linear on ADVERSARIAL input: a 20K-char run of `a.` / `a-` classifies in well under a second', () => {
    // The independent review measured ~15 s here before the referent patterns were anchored with a
    // lookbehind (`\\b` inside a `[\\w.-]+` run made the scan O(n²)). This runs synchronously inside
    // the broker's weekly handler, so it must stay cheap on ANY stored query_text.
    for (const hostile of [
      'a.'.repeat(10_000),
      'a-'.repeat(10_000),
      'x.'.repeat(10_000),
      'a.b/'.repeat(5_000),
    ]) {
      const t0 = performance.now()
      classifyHopShape(hostile)
      expect(performance.now() - t0).toBeLessThan(500)
    }
  })
})

describe('hop-shape — signals', () => {
  it('counts work-noun LEMMAS once: singular and plural of the same noun are one entity', () => {
    const wn = (q: string) => extractHopShapeSignals(q).workNouns
    expect(wn('the issue and the issues')).toBe(1)
    expect(wn('the fix and the fixes')).toBe(1)
    expect(wn('the branch and the branches')).toBe(1)
    expect(wn('the change and the changes')).toBe(1)
    expect(wn('the bug and the issue')).toBe(2)
  })

  it('counts a path, its filename and its trailing a/b token as ONE referent (containment dedupe)', () => {
    expect(extractHopShapeSignals('read /var/folders/tv/x/T/tmpau63gag3.md now').referents).toBe(1)
    expect(extractHopShapeSignals('PR #26 and PR #26 again').referents).toBe(1) // same text twice
    expect(extractHopShapeSignals('PR #26 vs PR #24').referents).toBe(2)
  })
})
