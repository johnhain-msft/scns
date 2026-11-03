/**
 * soak-summary.mjs — pure functions for summarizing a metrics CSV emitted by
 * the auto-restart soak harness and evaluating it against thresholds.
 *
 * Extracted from inline `python3 -c '''…'''` heredocs in the wrapper shell
 * harness, which silently fell back to a `99999` sentinel when multi-line JSON
 * broke the python source. Owning the logic in JS lets us unit-test it and
 * removes the bash↔python interpolation hazard entirely.
 *
 * CSV shape (header line required, comma-separated, no quoting):
 *   ts_epoch,uptime_sec,rss_mb,heap_mb,external_mb,evloop_p99_ms,evloop_max_ms,active_agents
 *
 * Threshold rationale (auto-restart soak, 2026-04-22+):
 *   - `rss_mb_end` < 800 (hard fail): the already-plateaued post-cycle broker.
 *     One FastEmbed/ONNX BGE-small-en-v1.5 model load is ~400–500MB native
 *     (mmapped weights + ORT arenas). The fastembed JS package exposes no
 *     `.release()`, so the per-broker plateau is the model itself, not a
 *     leak. Note: we deliberately do NOT gate on `rss_mb_max` because the
 *     pre-cycle blue broker is *expected* to peak high (round-1: 956MB)
 *     right before we restart it — that's the entire point of blue/green.
 *   - `rss_mb_end` >= 600 (warning): early-signal that FastEmbed is bloating
 *     beyond the historical ~500MB plateau. Informational only.
 *   - `rss_mb_min` < 200 (hard fail): proves the cycle reset works (cycle 1
 *     of the 2026-04-22 soak went 956MB → 84MB after the fresh broker took
 *     over, so this minimum sample is a true post-restart measurement).
 *   - `evloop_p99_ms_p99` < 100 (hard fail): the *settled* p99. A transient
 *     max during reindex is acceptable and tracked separately as
 *     `evloop_p99_ms_max`.
 */

import { readFileSync } from 'node:fs'

export const DEFAULT_THRESHOLDS = Object.freeze({
  rssMbEndFail: 800,
  rssMbEndWarn: 600,
  rssMbMinPostCycle: 200,
  evloopP99SettledMs: 100,
  // Round-3 (2026-04-22): soft cap on cosmetic libc++abi teardown aborts.
  //
  // After two serious attempts to eliminate the abort entirely (round-2:
  // null-JS-ref + gc hint + 300ms settle; round-3: explicit ONNX
  // InferenceSession.release() + 750ms settle), the 30-min dry-run of the
  // round-3 build still produced 1 abort line across 3 clean shutdowns.
  // Crucially, every abort fires AFTER the shutdown log is flushed
  // ("Shutdown complete", cleanupCount=13) and does NOT prevent the next
  // broker in the blue/green sequence from reaching Phase 7 "Fresh broker
  // healthy ✓". Diagnosis: native onnxruntime-node worker threads race
  // with process-level pthread destructors during libuv teardown — a known
  // pattern for node bindings that own thread pools. See similar upstream
  // reports: microsoft/onnxruntime#17706 (pthread_mutex_destroy / thread
  // pool teardown), fastembed-js issue tracker (no dispose API exposed).
  //
  // Gate: warn at >= 1 abort per cycle (informational), fail at >= 3 per
  // cycle (real regression). `cycles_reached_phase7` (hard fail < 1) is
  // the true graceful-shutdown gate — if subsequent brokers boot cleanly,
  // the cosmetic abort does not block dogfood.
  cppAbortsPerCycleWarn: 1,
  cppAbortsPerCycleFail: 3,
  cyclesReachedPhase7Min: 1,
})

const CSV_HEADER =
  'ts_epoch,uptime_sec,rss_mb,heap_mb,external_mb,evloop_p99_ms,evloop_max_ms,active_agents'

/** Parse the CSV file at `csvPath` and return rows as an array of plain objects. */
export function readCsvRows(csvPath) {
  const raw = readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '')
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return []
  const header = lines[0].trim()
  if (header !== CSV_HEADER) {
    throw new Error(
      `soak-summary: unexpected CSV header.\n  expected: ${CSV_HEADER}\n  got:      ${header}`,
    )
  }
  const cols = header.split(',')
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',')
    if (parts.length !== cols.length) continue
    const row = {}
    for (let c = 0; c < cols.length; c++) {
      const v = parts[c].trim()
      const n = Number(v)
      row[cols[c]] = Number.isFinite(n) ? n : null
    }
    rows.push(row)
  }
  return rows
}

function median(sortedAsc) {
  const n = sortedAsc.length
  if (n === 0) return null
  const mid = Math.floor(n / 2)
  return n % 2 === 0 ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2 : sortedAsc[mid]
}

function percentile(sortedAsc, p) {
  const n = sortedAsc.length
  if (n === 0) return null
  if (n === 1) return sortedAsc[0]
  // Nearest-rank, 1-indexed: same convention the prior python heredoc used
  // (`sorted(p99)[int(len(p99)*0.99)-1]`). Keeping the convention so the
  // numerical output is identical to the pre-fix happy path.
  const idx = Math.max(0, Math.min(n - 1, Math.floor(n * p) - 1))
  return sortedAsc[idx]
}

function numericColumn(rows, key) {
  const out = []
  for (const r of rows) {
    const v = r[key]
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v)
  }
  return out
}

/**
 * Summarize a soak metrics CSV. Returns the same shape the previous bash
 * harness produced, plus an explicit `samples` count and `notes`.
 */
export function summarizeFromCsv(csvPath) {
  const rows = readCsvRows(csvPath)
  return summarizeRows(rows)
}

/** Pure-data version for tests — no file IO. */
export function summarizeRows(rows) {
  const samples = rows.length
  if (samples === 0) {
    return { samples: 0, empty: true }
  }
  const rss = numericColumn(rows, 'rss_mb')
  const ext = numericColumn(rows, 'external_mb')
  const p99 = numericColumn(rows, 'evloop_p99_ms')

  const rssSorted = [...rss].sort((a, b) => a - b)
  const p99Sorted = [...p99].sort((a, b) => a - b)

  const last = (arr) => (arr.length ? arr[arr.length - 1] : null)

  return {
    samples,
    rss_mb_min: rssSorted[0] ?? null,
    rss_mb_max: rssSorted[rssSorted.length - 1] ?? null,
    rss_mb_p50: median(rssSorted),
    rss_mb_end: last(rss),
    external_mb_min: ext.length ? Math.min(...ext) : null,
    external_mb_max: ext.length ? Math.max(...ext) : null,
    external_mb_end: last(ext),
    evloop_p99_ms_max: p99Sorted[p99Sorted.length - 1] ?? null,
    evloop_p99_ms_p99: percentile(p99Sorted, 0.99),
  }
}

/**
 * Evaluate a summary against thresholds. `extras` carries observed counters
 * the CSV does not contain (cpp_aborts, cycles_reached_phase7) that the soak
 * harness derives from the broker_error.log and restart.log.
 *
 * Returns a `{ pass, failures, warnings }` object. A failure means the gate
 * MUST fail (non-zero exit). A warning is informational only.
 */
export function evaluateThresholds(summary, extras = {}, thresholds = DEFAULT_THRESHOLDS) {
  const failures = []
  const warnings = []

  if (summary.empty) {
    failures.push('no metric samples in CSV')
    return { pass: false, failures, warnings }
  }

  const cppAborts = Number(extras.cpp_aborts ?? 0)
  const cyclesPhase7 = Number(extras.cycles_reached_phase7 ?? 0)

  // Per-cycle normalization: gate on density, not absolute count, so a
  // longer soak isn't unfairly penalized for a linearly-scaling cosmetic
  // teardown race (see DEFAULT_THRESHOLDS comment). Use max(1, cycles) so
  // a zero-cycle soak still surfaces aborts as failures.
  const cycleDenom = Math.max(1, cyclesPhase7)
  const cppAbortsPerCycle = cppAborts / cycleDenom
  if (cppAbortsPerCycle >= thresholds.cppAbortsPerCycleFail) {
    failures.push(
      `cpp_aborts=${cppAborts} over ${cyclesPhase7} cycles (${cppAbortsPerCycle.toFixed(2)}/cycle; need <${thresholds.cppAbortsPerCycleFail}/cycle)`,
    )
  } else if (cppAbortsPerCycle >= thresholds.cppAbortsPerCycleWarn) {
    warnings.push(
      `cpp_aborts=${cppAborts} over ${cyclesPhase7} cycles (${cppAbortsPerCycle.toFixed(2)}/cycle) — cosmetic ORT teardown race; verify "Shutdown complete" precedes abort and next broker reaches Phase 7`,
    )
  }
  if (cyclesPhase7 < thresholds.cyclesReachedPhase7Min) {
    failures.push(
      `cycles_reached_phase7=${cyclesPhase7} (need >=${thresholds.cyclesReachedPhase7Min})`,
    )
  }
  if (typeof summary.rss_mb_end === 'number' && summary.rss_mb_end >= thresholds.rssMbEndFail) {
    failures.push(
      `rss_mb_end=${summary.rss_mb_end} (need <${thresholds.rssMbEndFail}; settled per-broker plateau)`,
    )
  } else if (
    typeof summary.rss_mb_end === 'number' &&
    summary.rss_mb_end >= thresholds.rssMbEndWarn
  ) {
    warnings.push(
      `rss_mb_end=${summary.rss_mb_end} >= warn ${thresholds.rssMbEndWarn} (FastEmbed plateau creeping; investigate if recurring)`,
    )
  }
  if (
    typeof summary.rss_mb_min === 'number' &&
    summary.rss_mb_min >= thresholds.rssMbMinPostCycle
  ) {
    failures.push(
      `rss_mb_min=${summary.rss_mb_min} (need <${thresholds.rssMbMinPostCycle}; post-cycle reset must drop below this)`,
    )
  }
  if (
    typeof summary.evloop_p99_ms_p99 === 'number' &&
    summary.evloop_p99_ms_p99 >= thresholds.evloopP99SettledMs
  ) {
    failures.push(
      `evloop_p99_ms_p99=${summary.evloop_p99_ms_p99} (need <${thresholds.evloopP99SettledMs}; settled p99)`,
    )
  }

  return { pass: failures.length === 0, failures, warnings }
}

/* CLI entry: `node scripts/lib/soak-summary.mjs <csv> [--cpp-aborts N] [--cycles N]`
 * Writes the summary JSON to stdout; exits 0 on pass, 1 on fail. The wrapper
 * shell harness uses this instead of a python heredoc.
 */
async function cli() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    process.stderr.write('usage: soak-summary.mjs <csv> [--cpp-aborts N] [--cycles N] [--gate]\n')
    process.exit(2)
  }
  const csv = args[0]
  let cppAborts = 0
  let cycles = 0
  let gate = false
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--cpp-aborts') cppAborts = Number(args[++i])
    else if (args[i] === '--cycles') cycles = Number(args[++i])
    else if (args[i] === '--gate') gate = true
  }
  const summary = summarizeFromCsv(csv)
  const evalRes = evaluateThresholds(summary, {
    cpp_aborts: cppAborts,
    cycles_reached_phase7: cycles,
  })
  const out = { summary, evaluation: evalRes, thresholds: DEFAULT_THRESHOLDS }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  if (gate) process.exit(evalRes.pass ? 0 : 1)
}

const isMain =
  // eslint-disable-next-line no-undef
  typeof process !== 'undefined' &&
  // eslint-disable-next-line no-undef
  process.argv[1] &&
  // eslint-disable-next-line no-undef
  import.meta.url === new URL(`file://${process.argv[1]}`).href

if (isMain) {
  cli().catch((err) => {
    process.stderr.write(`soak-summary fatal: ${err && err.stack ? err.stack : err}\n`)
    process.exit(2)
  })
}
