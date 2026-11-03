/**
 * How the weekly review PRESENTS routing accuracy. Pure and I/O-free (the evidence read lives in
 * `weekly-report.ts`); ONE renderer for the Monday cron and `scns review weekly`.
 *
 * Purpose frame (NORTH_STAR "Retrieval design intent", 2026-08-14): the question is no longer which
 * arm wins but whether each query was sent to the tool its hop-shape required. The section therefore
 * reports per-tool accept/waste, the same split by the shadow classifier's predicted shape, the
 * stratified classifier-vs-outcome agreement with its interval, and the pre-framed cutover bar — with
 * the same honesty discipline the previous section had: the evidence discriminant is checked BEFORE
 * any count is rendered (FR-024/FR-026), a zero is never rendered as fact for a corpus that could not
 * be read (SC-005), exclusions are their own line (FR-019), a no-longer-served tool is named as such
 * (FR-021/FR-022), and data-integrity caveats travel with the numbers in three states (FR-038).
 * "Under-powered" is stated in words wherever an interval cannot separate a number from chance, and
 * a whole interval BELOW chance is named for what it is (anti-informative), never as "not enough data".
 */
import {
  ACCEPT_THRESHOLD,
  CELL_MIN_N,
  type AgreementTally,
  type CutoverPreframe,
  type RoutingAccuracyReport,
  type ShapeCell,
  type ToolTally,
} from '../reward/routing-accuracy.js'
import { TOOL_FOR_HOP_SHAPE } from '../memory/hop-shape.js'

export interface RoutingAccuracyInput {
  /**
   * WHETHER THE EVIDENCE COULD BE READ AT ALL — the discriminant that must be checked before any
   * count is rendered [FR-024, FR-026]. REQUIRED, deliberately: an optional-defaulting-to-`ok` field
   * re-creates the #20 defect by omission (a caller that never wires it silently asserts a clean read).
   */
  readonly evidence:
    | { readonly status: 'ok' }
    | { readonly status: 'absent'; readonly path: string }
    | { readonly status: 'failed'; readonly error: string }
  /** The computed report; present iff `evidence.status === 'ok'`. */
  readonly report?: RoutingAccuracyReport | undefined
  /** Settled records dropped from the arm sample, by reason (FR-019). Never merged into a tool. */
  readonly excluded?: { readonly unassigned: number; readonly machine: number }
  /**
   * Known OPEN defects touching the sample (FR-038): non-empty ⇒ list them; `[]` ⇒ "no known open
   * defect"; `undefined` ⇒ NOT MEASURED. Three states, never collapsed.
   */
  readonly sampleCaveats?: readonly string[] | undefined
}

const rate = (x: number | null): string => (x === null ? '—' : x.toFixed(2))

function renderIntro(report: RoutingAccuracyReport): string[] {
  const lines = [
    `${TOOL_FOR_HOP_SHAPE['single-hop']} serves single-hop retrieval and ${TOOL_FOR_HOP_SHAPE['multi-hop']} serves multi-hop retrieval — purpose-routed`,
    'tools, not rivals (design intent, NORTH_STAR 2026-08-14). Assignment is by the exploration policy,',
    `independent of the query; the hop-shape classifier (${report.classifierVersion}) runs in shadow and`,
    'routes nothing yet.',
  ]
  const missing = Object.values(TOOL_FOR_HOP_SHAPE).filter((t) => !report.tools.includes(t))
  if (missing.length > 0) {
    lines.push(
      `NOTE: ${missing.join(', ')} is not among the tools the briefing serves today (${report.tools.join(', ')}),`,
      '  so the shapes that call for it cannot be compared below.',
    )
  }
  return lines
}

function toolLine(t: ToolTally): string {
  if (t.served === 0) return `  · ${t.tool}: 0 settled — never served`
  const rates =
    t.settled > 0 ? ` (accept rate ${rate(t.acceptRate)}, mean outcome ${rate(t.meanOutcome)})` : ''
  return `  · ${t.tool}: ${t.settled} settled of ${t.served} served — ${t.accepted} accepted / ${t.wasted} wasted${rates}`
}

function renderTools(
  report: RoutingAccuracyReport,
  excluded: RoutingAccuracyInput['excluded'],
): string[] {
  const lines = [
    '',
    `Labels per tool (an outcome is settled when you accept or re-ask; accept = outcome above ${ACCEPT_THRESHOLD}):`,
  ]
  for (const t of report.byTool.filter((x) => x.live)) lines.push(toolLine(t))
  const gone = report.byTool.filter((x) => !x.live)
  if (gone.length > 0) {
    lines.push('', 'No longer served — records kept, sample frozen:')
    for (const t of gone) lines.push(`  · ${t.tool}: ${t.settled} settled of ${t.served} served`)
  }
  if (excluded && (excluded.unassigned > 0 || excluded.machine > 0)) {
    const parts: string[] = []
    if (excluded.unassigned > 0) {
      parts.push(`${excluded.unassigned} unassigned (no arm was recorded on the record)`)
    }
    if (excluded.machine > 0) parts.push(`${excluded.machine} machine-authored`)
    lines.push(
      '',
      `Excluded from the comparison: ${parts.join(', ')}. These are counted separately and never added to any tool.`,
    )
  }
  const mix = report.assignment
  const served = [...mix.servedByTool.entries()].map(([t, n]) => `${t} ${n}`).join(' / ')
  const props = [...mix.byPropensity.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([p, n]) => `${p === 'null' ? 'not recorded' : `p=${p}`}: ${n}`)
    .join(', ')
  lines.push(
    '',
    `Assignment mix among the settled rows — served: ${served}; logged assignment probability: ${props || 'none'}.`,
    '  (Not 50/50 — the comparison below is stratified by shape so this does not move its chance level.)',
  )
  return lines
}

function shapeTail(cell: ShapeCell): string {
  let tail: string
  switch (cell.directional) {
    case 'agrees':
      tail = ' → the tool the shape calls for did better'
      break
    case 'disagrees':
      tail = ' → the OTHER tool did better'
      break
    case 'tie':
      tail = ' → no difference on the evidence so far'
      break
    default:
      return ' → cannot compare yet (one tool has no settled rows in this shape)'
  }
  if (cell.underPowered) {
    const short = [...cell.byTool.values()]
      .filter((t) => t.settled < CELL_MIN_N)
      .map((t) => `${t.tool} n=${t.settled} < ${CELL_MIN_N}`)
      .join(', ')
    tail += `, but too few labels to separate the tools (${short})`
  }
  return tail
}

function shapeLine(cell: ShapeCell, tools: readonly string[]): string {
  const rec = cell.recommendedTool
  const head =
    rec === null
      ? `  · ${cell.shape} (no recommendation): ${cell.settled} settled of ${cell.served} served — `
      : `  · ${cell.shape} (calls for ${rec}): ${cell.settled} settled of ${cell.served} served — `
  const ordered = rec === null ? [...tools] : [rec, ...tools.filter((t) => t !== rec)]
  const parts = ordered.map((t) => {
    const x = cell.byTool.get(t)
    return `${t} ${rate(x?.acceptRate ?? null)} (n=${x?.settled ?? 0})`
  })
  if (rec === null) return head + parts.join(', ')
  return head + parts.join(' vs ') + shapeTail(cell)
}

function renderShapes(report: RoutingAccuracyReport): string[] {
  const lines = [
    '',
    'By predicted hop-shape — accept rate of the tool the shape calls for vs the other tool (each shape',
    'is a stratum in which both tools saw the same queries, because assignment ignores the query):',
  ]
  for (const cell of report.byShape) lines.push(shapeLine(cell, report.tools))
  return lines
}

function renderAgreement(a: AgreementTally): string[] {
  const lines: string[] = ['']
  if (a.n === 0 || a.rate === null || a.lower95 === null || a.upper95 === null) {
    lines.push(
      'Classifier-vs-outcome agreement: no comparable settled rows yet — a shape only counts once BOTH',
      'tools have settled rows in it. (Ambiguous rows are excluded by design; unsettled rows carry no outcome.)',
    )
    if (a.nNotComparable > 0) {
      lines.push(
        `  ${a.nNotComparable} classified settled row(s) sit in shapes with only one tool labelled so far.`,
      )
    }
    return lines
  }
  lines.push(
    `Classifier-vs-outcome agreement: ${a.rate.toFixed(2)} (over ${a.n} comparable settled rows; chance is ${a.chance.toFixed(2)}; approximate 95% interval ${a.lower95.toFixed(2)}–${a.upper95.toFixed(2)}).`,
    '  Agreement = 0.50 + half the average within-shape advantage of the tool the shape calls for (its',
    "  accept rate minus the other tool's, weighted by settled rows per shape). 0.50 means the tools do",
    '  equally well within every shape — the classifier carries no routing information — and that holds',
    '  whatever the assignment ratio or the base accept rate, so it is the honest chance level.',
  )
  if (a.upper95 < a.chance) {
    lines.push(
      '  BELOW CHANCE: the whole interval sits below 0.50, so on this evidence the classifier is pointing',
      '  at the WRONG tool more often than the right one. That is a finding, not a shortage of labels.',
    )
  } else if (a.lower95 <= a.chance) {
    lines.push(
      '  UNDER-POWERED: the interval includes chance, so this neither confirms nor refutes the',
      '  classifier — the honest reading is "not enough labels yet", not "right" or "wrong".',
    )
  } else {
    lines.push(
      '  The whole interval sits above chance: on the evidence so far the classifier is informative',
      '  about outcomes. (Still shadow — routing on it is a separate decision, below.)',
    )
  }
  if (a.nNotComparable > 0) {
    lines.push(
      `  Not counted: ${a.nNotComparable} classified settled row(s) in shapes where only one tool has labels so far.`,
    )
  }
  lines.push(
    `  Raw 2×2 over all classified settled rows (legible, but not the metric — its chance level moves with the served split): accepted as recommended ${a.agreeAccept}, wasted when not ${a.agreeWaste}, accepted when not ${a.disagreeAccept}, wasted as recommended ${a.disagreeWaste}.`,
  )
  return lines
}

function renderCutover(c: CutoverPreframe): string[] {
  return [
    '',
    "Live cutover (classify-then-route, with a residual exploration rate) is John's decision. Pre-framed bar:",
    `  agreement's 95% lower bound above ${c.lowerBoundThreshold.toFixed(2)} on at least ${c.minClassified} comparable settled rows.`,
    c.lowerBound === null
      ? `  Today: no comparable settled rows (n=${c.nClassified}) — bar NOT met.`
      : `  Today: lower bound ${c.lowerBound.toFixed(2)} on n=${c.nClassified} — bar ${c.met ? "MET (a candidate for John's decision; nothing routes on it yet)" : 'NOT met'}.`,
  ]
}

function renderCaveats(caveats: readonly string[] | undefined): string[] {
  if (caveats === undefined) {
    return [
      '',
      'Data-integrity defects touching these records: NOT MEASURED — the check did not run, so',
      'their integrity is unknown. Treat that as a reason to wait, not as a clean result.',
    ]
  }
  if (caveats.length === 0) return ['', 'No known open defect touches these records.']
  return [
    '',
    'Known open defects touching this sample — the numbers above are qualified by them:',
    ...caveats.map((cv) => `    · ${cv}`),
  ]
}

/** Render the section. Never throws for the ordinary states; the discriminant is honoured first. */
export function formatRoutingAccuracy(input: RoutingAccuracyInput): string {
  const { evidence } = input
  const lines: string[] = [
    '',
    'Routing accuracy — was each query sent to the tool its shape required?',
    '──────────────────────────────────────────────────────────────────────',
  ]

  // FR-024/FR-026/SC-005 — BEFORE any count. Both branches return early so NO tool can be printed
  // with a count; the invariant is checked by scanning the emitted text for `<tool>: 0`.
  if (evidence.status === 'failed') {
    lines.push(
      `I could not read the experience store — ${evidence.error}.`,
      'That leaves the evidence base UNKNOWN — per-tool counts omitted rather than shown as zero,',
      'because a failed read and an empty corpus both arrive here as an empty count, and only one',
      'of those is a fact about a tool. Nothing can be concluded about routing until it reads cleanly.',
    )
    return lines.join('\n')
  }
  if (evidence.status === 'absent') {
    lines.push(
      `There is no experience store at ${evidence.path} — the broker creates it on first retrieval.`,
      'Nothing has been recorded yet, so there is nothing to measure, and the per-tool counts are',
      'omitted rather than shown as zero. This is the expected state on a fresh install, not a',
      'failure — the cause is known and self-resolving.',
    )
    return lines.join('\n')
  }
  const report = input.report
  if (!report) {
    lines.push('The evidence base read cleanly but no report was computed — nothing to show.')
    return lines.join('\n')
  }
  lines.push(
    ...renderIntro(report),
    ...renderTools(report, input.excluded),
    ...renderShapes(report),
    ...renderAgreement(report.agreement),
    ...renderCutover(report.cutover),
    ...renderCaveats(input.sampleCaveats),
  )
  return lines.join('\n')
}
