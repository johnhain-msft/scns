/**
 * Step 2 (D1) — the weekly review's ROUTING ACCURACY section: pure renderer.
 *
 * Carries every honesty invariant the retired promote/retire section had pinned — the three-state
 * evidence discriminant (FR-024/FR-026), "never render a zero as fact" (SC-005), separately-reported
 * exclusions (FR-019), no-longer-served tools named as such (FR-021/FR-022), and the three-state
 * caveat block (FR-038) — and adds the purpose-frame content: per-shape accept rates, agreement with
 * its interval, and the pre-framed cutover bar. And it must never speak the drift-era vocabulary.
 */
import { describe, it, expect } from 'vitest'
import {
  formatRoutingAccuracy,
  type RoutingAccuracyInput,
} from '../../../src/suggest/routing-format.js'
import { computeRoutingAccuracy, type RoutingRow } from '../../../src/reward/routing-accuracy.js'

const SINGLE = 'continue'
const MULTI = 'why is the brains consolidate branch the reason for the starvation?'
const AMBIG = 'ok'
const LIVE = ['magma', 'multihop-iter'] as const

let id = 1
const row = (tool: string, q: string, outcome: number | null): RoutingRow => ({
  id: id++,
  tool,
  queryText: q,
  humanOutcome: outcome,
  propensity: 0.5,
})

function typicalRows(): RoutingRow[] {
  const rows: RoutingRow[] = []
  for (let i = 0; i < 20; i++) rows.push(row('magma', SINGLE, i < 14 ? 1.0 : 0.2))
  for (let i = 0; i < 6; i++) rows.push(row('multihop-iter', SINGLE, i < 3 ? 1.0 : 0.2))
  for (let i = 0; i < 8; i++) rows.push(row('magma', MULTI, i < 4 ? 0.8 : 0.2))
  for (let i = 0; i < 4; i++) rows.push(row('multihop-iter', MULTI, i < 3 ? 1.0 : 0.2))
  for (let i = 0; i < 3; i++) rows.push(row('magma', AMBIG, 1.0))
  for (let i = 0; i < 40; i++) rows.push(row('magma', SINGLE, null))
  for (let i = 0; i < 10; i++) rows.push(row('multihop-iter', MULTI, null))
  for (let i = 0; i < 5; i++) rows.push(row('hybrid', SINGLE, null))
  return rows
}

function render(extra: Partial<RoutingAccuracyInput> = {}): string {
  return formatRoutingAccuracy({
    evidence: { status: 'ok' },
    report: computeRoutingAccuracy(typicalRows(), { tools: LIVE }),
    excluded: { unassigned: 0, machine: 0 },
    sampleCaveats: [],
    ...extra,
  })
}

describe('formatRoutingAccuracy — the purpose frame is stated, the drift frame is gone', () => {
  it('opens by naming what each tool is FOR, that assignment ignores the query, and that the classifier is shadow', () => {
    const r = render()
    expect(r).toMatch(/magma serves single-hop/i)
    expect(r).toMatch(/multihop-iter serves multi-hop/i)
    expect(r).toMatch(/independent of the query/i)
    expect(r).toMatch(/shadow/i)
    // it does NOT assert a balanced or random split it cannot know
    expect(r).not.toMatch(/Assignment today is RANDOM/)
  })

  it('notes when a purpose-routed tool is not among the tools the briefing serves today', () => {
    const r = render({
      report: computeRoutingAccuracy(typicalRows(), { tools: ['hybrid', 'multihop-iter'] }),
    })
    expect(r).toMatch(
      /NOTE: magma is not among the tools the briefing serves today \(hybrid, multihop-iter\)/,
    )
    expect(render()).not.toMatch(/NOTE: /)
  })

  it('never uses promote/retire/verdict/incumbent/challenger vocabulary (NEGATIVE-VOCABULARY SCAN)', () => {
    for (const r of [
      render(),
      render({ evidence: { status: 'failed', error: 'x' } }),
      render({ evidence: { status: 'absent', path: '/nope' } }),
      render({ sampleCaveats: undefined }),
      render({ sampleCaveats: ['FR-034 — 1 record'] }),
    ]) {
      expect(r).not.toMatch(/promot(e|ion|ed)/i)
      expect(r).not.toMatch(/\bretire/i)
      expect(r).not.toMatch(/verdict/i)
      expect(r).not.toMatch(/incumbent/i)
      expect(r).not.toMatch(/challenger/i)
      expect(r).not.toMatch(/\bHOLD\b/)
    }
  })

  it('names the classifier version it measured', () => {
    expect(render()).toMatch(/heuristic-v\d+/)
  })
})

describe('formatRoutingAccuracy — per-tool funnel with accept/waste', () => {
  it('prints settled-of-served, accepted/wasted, accept rate and mean outcome per live tool', () => {
    const r = render()
    expect(r).toMatch(
      /magma: 31 settled of 71 served — 21 accepted \/ 10 wasted \(accept rate 0\.68, mean outcome 0\.\d\d\)/,
    )
    expect(r).toMatch(
      /multihop-iter: 10 settled of 20 served — 6 accepted \/ 4 wasted \(accept rate 0\.60/,
    )
  })

  it('names a no-longer-served tool as such, separately, and never as a comparison party', () => {
    const r = render()
    expect(r).toMatch(/No longer served — records kept, sample frozen:/)
    expect(r).toMatch(/hybrid: 0 settled of 5 served/)
    // hybrid must not appear in the by-shape block
    const byShape = r.slice(r.indexOf('By predicted hop-shape'))
    expect(byShape).not.toMatch(/hybrid/)
  })

  it('omits the no-longer-served header when nothing is (NEGATIVE CONTROL)', () => {
    const rows = typicalRows().filter((x) => x.tool !== 'hybrid')
    const r = render({ report: computeRoutingAccuracy(rows, { tools: LIVE }) })
    expect(r).not.toMatch(/No longer served/)
  })

  it('a live tool with zero rows is reported as never served, not as a fabricated rate', () => {
    const rows = typicalRows().filter((x) => x.tool === 'magma')
    const r = render({ report: computeRoutingAccuracy(rows, { tools: LIVE }) })
    expect(r).toMatch(/multihop-iter: 0 settled — never served/)
    expect(r).not.toMatch(/multihop-iter: 0 settled of 0 served/)
  })

  it('a LIVE tool that was served but never labelled renders its counts with no rate (tried, not labelled ≠ never tried)', () => {
    const rows = [
      ...typicalRows().filter((x) => x.tool === 'magma'),
      row('multihop-iter', SINGLE, null),
      row('multihop-iter', SINGLE, null),
    ]
    const r = render({ report: computeRoutingAccuracy(rows, { tools: LIVE }) })
    expect(r).toMatch(/multihop-iter: 0 settled of 2 served — 0 accepted \/ 0 wasted\n/)
    expect(r).not.toMatch(
      /multihop-iter: 0 settled of 2 served — 0 accepted \/ 0 wasted \(accept rate/,
    )
    expect(r).not.toMatch(/multihop-iter: 0 settled — never served/)
  })

  it('renders the assignment mix of the settled rows (served split + logged propensities) instead of asserting balance', () => {
    const r = render()
    expect(r).toMatch(
      /Assignment mix among the settled rows — served: magma 31 \/ multihop-iter 10; logged assignment probability: p=0\.50: 41\./,
    )
    expect(r).toMatch(/stratified by shape so this does not move its chance level/)
  })

  it('reports exclusions on their own line, only when non-zero (FR-019)', () => {
    expect(render({ excluded: { unassigned: 9, machine: 2 } })).toMatch(
      /Excluded from the comparison: 9 unassigned \(no arm was recorded on the record\), 2 machine-authored/,
    )
    expect(render({ excluded: { unassigned: 0, machine: 0 } })).not.toMatch(
      /Excluded from the comparison/,
    )
  })
})

describe('formatRoutingAccuracy — by predicted hop-shape', () => {
  it('for each shape, prints the tool the shape calls for vs the other tool with n, and the directional reading', () => {
    const r = render()
    expect(r).toMatch(
      /single-hop \(calls for magma\): 26 settled of 66 served — magma 0\.70 \(n=20\) vs multihop-iter 0\.50 \(n=6\) → the tool the shape calls for did better/,
    )
    expect(r).toMatch(
      /multi-hop \(calls for multihop-iter\): 12 settled of 22 served — multihop-iter 0\.75 \(n=4\) vs magma 0\.50 \(n=8\) → the tool the shape calls for did better/,
    )
    expect(r).toMatch(
      /ambiguous \(no recommendation\): 3 settled of 3 served — magma 1\.00 \(n=3\), multihop-iter — \(n=0\)/,
    )
  })

  it('says "too few labels to separate the tools" when a cell is under-powered, naming the short cell', () => {
    const r = render()
    expect(r).toMatch(/single-hop.*too few labels to separate the tools \(multihop-iter n=6 < 10\)/)
  })

  it('reads "the other tool did better" honestly when the data point the other way', () => {
    const rows: RoutingRow[] = []
    for (let i = 0; i < 12; i++) rows.push(row('magma', SINGLE, 0.2))
    for (let i = 0; i < 12; i++) rows.push(row('multihop-iter', SINGLE, 1.0))
    const r = render({ report: computeRoutingAccuracy(rows, { tools: LIVE }) })
    expect(r).toMatch(/single-hop.*→ the OTHER tool did better/)
  })

  it('says a shape cannot be compared yet when one tool has no settled rows in it', () => {
    const rows = [row('magma', MULTI, 1.0), row('magma', MULTI, 0.2)]
    const r = render({ report: computeRoutingAccuracy(rows, { tools: LIVE }) })
    expect(r).toMatch(
      /multi-hop.*→ cannot compare yet \(one tool has no settled rows in this shape\)/,
    )
  })
})

describe('formatRoutingAccuracy — agreement, its interval, and the cutover bar', () => {
  // typicalRows: single-hop magma 14/20 = 0.70 vs multihop-iter 3/6 = 0.50 ⇒ 0.60 (w = 26/38);
  //              multi-hop  multihop-iter 3/4 = 0.75 vs magma 4/8 = 0.50 ⇒ 0.625 (w = 12/38)
  //              ⇒ (26·0.60 + 12·0.625) / 38 = 0.6079 → 0.61 on n=38
  it('prints the stratified agreement over the comparable rows with the chance level and the interval', () => {
    const report = computeRoutingAccuracy(typicalRows(), { tools: LIVE })
    const r = render({ report })
    const lo = report.agreement.lower95!.toFixed(2)
    const hi = report.agreement.upper95!.toFixed(2)
    expect(r).toContain(
      `Classifier-vs-outcome agreement: 0.61 (over 38 comparable settled rows; chance is 0.50; approximate 95% interval ${lo}–${hi}).`,
    )
    expect(r).toMatch(/0\.50 \+ half the average within-shape advantage/)
    expect(r).toMatch(/whatever the assignment ratio/)
  })

  it('states UNDER-POWERED when the interval includes chance, and neither confirms nor refutes', () => {
    const r = render()
    expect(r).toMatch(/UNDER-POWERED: the interval includes chance/)
    expect(r).toMatch(/neither confirms nor refutes/)
    expect(r).not.toMatch(/BELOW CHANCE/)
  })

  it('states clearly above chance when the lower bound clears it — an INFORMATIVE fixture, not an assignment artefact (POSITIVE CONTROL)', () => {
    // within single-hop, magma accepts 0.9 and multihop-iter 0.3, magma served 4× as often
    const rows: RoutingRow[] = []
    for (let i = 0; i < 160; i++) rows.push(row('magma', SINGLE, i % 10 === 0 ? 0.2 : 1.0))
    for (let i = 0; i < 40; i++) rows.push(row('multihop-iter', SINGLE, i % 10 < 3 ? 1.0 : 0.2))
    const r = render({ report: computeRoutingAccuracy(rows, { tools: LIVE }) })
    expect(r).toMatch(/whole interval sits above chance/i)
    expect(r).not.toMatch(/UNDER-POWERED/)
  })

  it('NEGATIVE CONTROL: an uninformative classifier under an 80/20 split does NOT read as informative', () => {
    const rows: RoutingRow[] = []
    for (let i = 0; i < 160; i++) rows.push(row('magma', SINGLE, i % 4 === 0 ? 0.2 : 1.0))
    for (let i = 0; i < 40; i++) rows.push(row('multihop-iter', SINGLE, i % 4 === 0 ? 0.2 : 1.0))
    const r = render({ report: computeRoutingAccuracy(rows, { tools: LIVE }) })
    expect(r).toMatch(/agreement: 0\.50 /)
    expect(r).toMatch(/UNDER-POWERED/)
    expect(r).not.toMatch(/whole interval sits above chance/i)
  })

  it('names a whole interval BELOW chance as anti-informative — a finding, never "not enough labels"', () => {
    const rows: RoutingRow[] = []
    for (let i = 0; i < 60; i++) rows.push(row('magma', SINGLE, i % 10 === 0 ? 1.0 : 0.2))
    for (let i = 0; i < 60; i++) rows.push(row('multihop-iter', SINGLE, i % 10 === 0 ? 0.2 : 1.0))
    const r = render({ report: computeRoutingAccuracy(rows, { tools: LIVE }) })
    expect(r).toMatch(/BELOW CHANCE: the whole interval sits below 0\.50/)
    expect(r).toMatch(/pointing[\s\S]*at the WRONG tool/)
    expect(r).not.toMatch(/UNDER-POWERED/)
    expect(r).not.toMatch(/not enough labels/)
  })

  it('shows the raw 2×2 for legibility, labelled as NOT the metric', () => {
    expect(render()).toMatch(
      /Raw 2×2 over all classified settled rows \(legible, but not the metric — its chance level moves with the served split\): accepted as recommended 17, wasted when not 7, accepted when not 7, wasted as recommended 7\./,
    )
  })

  it('says how many classified settled rows could not be compared (one tool unlabelled in their shape)', () => {
    const rows = [
      row('magma', SINGLE, 1.0),
      row('multihop-iter', SINGLE, 0.2),
      row('multihop-iter', MULTI, 1.0),
      row('multihop-iter', MULTI, 1.0),
    ]
    const r = render({ report: computeRoutingAccuracy(rows, { tools: LIVE }) })
    expect(r).toMatch(
      /Not counted: 2 classified settled row\(s\) in shapes where only one tool has labels so far\./,
    )
  })

  it("names the cutover bar and whether today meets it — and says the decision is John's", () => {
    const report = computeRoutingAccuracy(typicalRows(), { tools: LIVE })
    const r = render({ report })
    expect(r).toMatch(/Live cutover .* is John's decision/)
    expect(r).toMatch(/lower bound above 0\.55 on at least 100 comparable settled rows/)
    expect(r).toContain(
      `Today: lower bound ${report.agreement.lower95!.toFixed(2)} on n=38 — bar NOT met.`,
    )
  })

  it('when the bar IS met it still says nothing routes on it yet', () => {
    const rows: RoutingRow[] = []
    for (let i = 0; i < 160; i++) rows.push(row('magma', SINGLE, i % 10 === 0 ? 0.2 : 1.0))
    for (let i = 0; i < 40; i++) rows.push(row('multihop-iter', SINGLE, i % 10 < 3 ? 1.0 : 0.2))
    const r = render({ report: computeRoutingAccuracy(rows, { tools: LIVE }) })
    expect(r).toMatch(/bar MET \(a candidate for John's decision; nothing routes on it yet\)/)
  })

  it('with zero comparable settled rows says so instead of printing 0.00', () => {
    const rows = [row('magma', AMBIG, 1.0), row('magma', SINGLE, null), row('magma', SINGLE, 1.0)]
    const r = render({ report: computeRoutingAccuracy(rows, { tools: LIVE }) })
    expect(r).toMatch(/Classifier-vs-outcome agreement: no comparable settled rows yet/)
    expect(r).toMatch(
      /1 classified settled row\(s\) sit in shapes with only one tool labelled so far/,
    )
    expect(r).not.toMatch(/agreement: 0\.00/)
    expect(r).toMatch(/Today: no comparable settled rows \(n=0\) — bar NOT met\./)
  })
})

describe('formatRoutingAccuracy — evidence three-state (FR-024/FR-026/SC-005)', () => {
  it('FAILED: says the evidence base is UNKNOWN and prints NO per-tool count', () => {
    const r = render({
      evidence: { status: 'failed', error: 'SQLITE_CORRUPT: malformed' },
      report: undefined,
    })
    expect(r).toMatch(/could not read the experience store — SQLITE_CORRUPT: malformed/)
    expect(r).toMatch(/UNKNOWN/)
    expect(r).not.toMatch(/magma: \d/)
    expect(r).not.toMatch(/multihop-iter: \d/)
  })

  it('ABSENT: names itself absent, self-resolving, and prints NO per-tool count', () => {
    const r = render({
      evidence: { status: 'absent', path: '/tmp/none/experience.db' },
      report: undefined,
    })
    expect(r).toMatch(/no experience store at \/tmp\/none\/experience\.db/)
    expect(r).not.toMatch(/UNKNOWN/)
    expect(r).not.toMatch(/magma: \d/)
  })

  it('SCAN: neither failure state renders "<tool>: 0" as a fact', () => {
    for (const evidence of [
      { status: 'failed' as const, error: 'boom' },
      { status: 'absent' as const, path: '/x' },
    ]) {
      const r = render({ evidence, report: undefined })
      for (const t of ['magma', 'multihop-iter', 'hybrid']) expect(r).not.toContain(`${t}: 0`)
    }
  })

  it('OK but EMPTY renders as empty, not as unknown', () => {
    const r = render({ report: computeRoutingAccuracy([], { tools: LIVE }) })
    expect(r).not.toMatch(/UNKNOWN/)
    expect(r).toMatch(/magma: 0 settled — never served/)
    expect(r).toMatch(/no comparable settled rows yet/)
  })
})

describe('formatRoutingAccuracy — FR-038 caveats travel with the numbers, in three states', () => {
  it('names each open defect touching the sample', () => {
    const r = render({
      sampleCaveats: ['FR-034 — 3 record(s) carry no answer_source', 'issue #18 — dup binding'],
    })
    expect(r).toMatch(
      /Known open defects touching this sample — the numbers above are qualified by them:/,
    )
    expect(r).toMatch(/· FR-034 — 3 record\(s\) carry no answer_source/)
    expect(r).toMatch(/· issue #18 — dup binding/)
  })
  it('says explicitly when no known defect touches the sample', () => {
    expect(render({ sampleCaveats: [] })).toMatch(/No known open defect touches these records\./)
  })
  it('says NOT MEASURED — a third state — when the check did not run', () => {
    const r = render({ sampleCaveats: undefined })
    expect(r).toMatch(/NOT MEASURED/)
    expect(r).not.toMatch(/No known open defect/)
  })
})
