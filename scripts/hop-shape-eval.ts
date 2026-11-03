/**
 * Step 2 (D2) — OFFLINE hop-shape evaluation harness (READ-ONLY; a thin CLI wrapper).
 *
 * Runs the shadow hop-shape classifier (`src/memory/hop-shape.ts`) over the labelled corpus in
 * `retrieval_experience` and reports its agreement with human accept/waste outcomes — the SAME
 * numbers, from the SAME code path (`renderRoutingAccuracySection`), that the Monday weekly review
 * renders. This is how the classifier is measurable from day one without touching the live path:
 * nothing here writes, and the store is opened `{ readonly, fileMustExist }`.
 *
 * USAGE:
 *   npx tsx scripts/hop-shape-eval.ts [path/to/experience.db] [--json] [--show N] [--settled-only]
 *     default path: ~/.scns/memory/experience.db (resolved through SCNS_HOME like everything else)
 *     --json           also print a machine-readable summary (report object) after the text
 *     --show N         print N sample classifications per shape, with their typed reasons, to eyeball
 *     --settled-only   restrict the samples to settled rows (outcome shown)
 *
 * The live corpus is the truth here, and the number may be poor. Report it as it is.
 */
import { join } from 'node:path'
import { resolveScnsHome } from '../src/shared/scns-home.js'
import { openExperienceStoreReadOnly } from '../src/memory/experience-store.js'
import { renderRoutingAccuracySection } from '../src/suggest/weekly-report.js'
import { loadRoutingRows, type RoutingRow } from '../src/reward/routing-accuracy.js'
import { classifyHopShape, HOP_SHAPES, type HopShape } from '../src/memory/hop-shape.js'
import { resolveBriefingTools } from '../src/memory/explore-router.js'

const argv = process.argv.slice(2)
const VALUE_FLAGS = new Set(['--show'])
const positional = argv.filter(
  (a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(argv[i - 1]!)),
)
const flag = (name: string): boolean => argv.includes(`--${name}`)
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const scnsDir = join(resolveScnsHome(), '.scns')
const dbPath = positional[0] ?? join(scnsDir, 'memory', 'experience.db')
const show = Number.parseInt(flagValue('show') ?? '0', 10) || 0
const settledOnly = flag('settled-only')

const section = renderRoutingAccuracySection({ scnsDir, dbPath })
console.log(`store: ${dbPath} (read-only) — live tools: ${resolveBriefingTools().join(', ')}`)
console.log(section.text)

if (section.report === null) {
  console.log(`\nno report: ${section.evidenceError ?? 'unknown'}`)
  process.exit(2)
}

if (show > 0) {
  const store = openExperienceStoreReadOnly(dbPath)
  let rows: RoutingRow[]
  try {
    rows = loadRoutingRows(store)
  } finally {
    store.close()
  }
  const live = new Set(section.report.tools)
  const pool = rows.filter((r) => live.has(r.tool) && (!settledOnly || r.humanOutcome !== null))
  const byShape = new Map<HopShape, RoutingRow[]>(HOP_SHAPES.map((s) => [s, []]))
  const classes = new Map<number, ReturnType<typeof classifyHopShape>>()
  for (const r of pool) {
    const c = classifyHopShape(r.queryText)
    classes.set(r.id, c)
    byShape.get(c.shape)!.push(r)
  }
  // Deterministic sample: evenly spaced through the id-ordered pool, so re-runs show the same rows.
  const sample = <T>(xs: readonly T[], n: number): T[] => {
    if (xs.length <= n) return [...xs]
    const step = xs.length / n
    return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step)]!)
  }
  for (const shape of HOP_SHAPES) {
    const xs = byShape.get(shape)!
    console.log(
      `\n=== ${shape}: ${xs.length} row(s)${settledOnly ? ' (settled only)' : ''} — showing ${Math.min(show, xs.length)}`,
    )
    for (const r of sample(xs, show)) {
      const c = classes.get(r.id)!
      const q = r.queryText.replace(/\s+/g, ' ').slice(0, 120)
      const outcome = r.humanOutcome === null ? '-' : r.humanOutcome.toFixed(1)
      console.log(
        `  #${r.id} ${r.tool.padEnd(13)} outcome=${outcome} [${c.reasons.join(',')}] ${q}`,
      )
    }
  }
}

if (flag('json')) {
  const r = section.report
  const summary = {
    store: dbPath,
    classifierVersion: r.classifierVersion,
    tools: r.tools,
    byTool: r.byTool,
    byShape: r.byShape.map((c) => ({
      shape: c.shape,
      recommendedTool: c.recommendedTool,
      served: c.served,
      settled: c.settled,
      directional: c.directional,
      underPowered: c.underPowered,
      byTool: Object.fromEntries(c.byTool),
    })),
    agreement: r.agreement,
    cutover: r.cutover,
  }
  console.log('\n' + JSON.stringify(summary, null, 2))
}
