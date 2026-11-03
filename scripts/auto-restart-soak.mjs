#!/usr/bin/env node
/**
 * auto-restart-soak.mjs — live soak harness for the auto-restart runaway fix.
 *
 * Launches the real SCNS broker (dist/cli.js start) with
 * SCNS_MAX_CONCURRENT_AGENTS=4, polls GET /api/metrics/runtime every 5s for
 * 15 min, and simulates a SIGTERM + relaunch every 120s to exercise the
 * F3 (crash-loop-aware recovery) and F4 (bounded recovery fan-out) code
 * paths under realistic churn.
 *
 * The harness FAILS the run (non-zero exit) if any of the following thresholds
 * are breached sustained for 30s:
 *   - rss_mb > 1500
 *   - active_agents > cap (=4)
 *   - spawn_per_min > 20
 *   - event_loop_lag_p99_ms > 500
 *
 * Memory plateau rationale (added 2026-04-22 after soak round 2):
 *   The per-broker RSS plateau under realistic dogfood is ~500MB. This is
 *   the FastEmbed BGE-small-en-v1.5 ONNX session itself (mmapped weights +
 *   ORT inference arenas), NOT a leak. The `fastembed` JS package exposes no
 *   `.release()` API to drop it short of process exit, so blue/green nightly
 *   restart is the actual reset mechanism (verified: cycle 1 of the
 *   2026-04-22 soak went 956MB → 84MB after the fresh broker took over).
 *   The wrapper harness (scripts/lib/soak-summary.mjs) enforces:
 *     - per-broker rss_mb_max < 800 (hard fail)
 *     - per-broker rss_mb_max >= 600 (warning, early signal)
 *     - post-cycle rss_mb_min < 200 (hard fail; proves the cycle reset)
 *   Keep `resetEmbeddingClient()` after each reindex batch — it still
 *   prevents per-batch tensor accumulation (heap stays flat at ~28MB across
 *   12 reindex ticks proves this is doing useful work).
 *
 * Artefacts emitted:
 *   - out/auto-restart-soak-<timestamp>.csv    (per-sample raw data)
 *   - docs/evidence/auto-restart-soak-<timestamp>.json  (summary for PR)
 *
 * Usage:
 *   node scripts/auto-restart-soak.mjs [--duration-sec 900] [--restart-sec 120] [--port 34567]
 *
 * The user explicitly demanded "real measurable evidence" before re-enabling
 * the launchd auto-restart plists. This harness produces that evidence. Do
 * NOT fabricate results — run the script and commit the generated JSON.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(__dirname, '..')

function parseArgs(argv) {
  const args = { durationSec: 900, restartSec: 120, port: 34567, pollSec: 5, cap: 4 }
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    if (k === '--duration-sec') args.durationSec = Number(v)
    else if (k === '--restart-sec') args.restartSec = Number(v)
    else if (k === '--port') args.port = Number(v)
    else if (k === '--poll-sec') args.pollSec = Number(v)
    else if (k === '--cap') args.cap = Number(v)
    else continue
    i++
  }
  return args
}

const args = parseArgs(process.argv)
const TS = new Date().toISOString().replace(/[:.]/g, '-')
const OUT_DIR = join(repoRoot, 'out')
const EVIDENCE_DIR = join(repoRoot, 'docs', 'evidence')
mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(EVIDENCE_DIR, { recursive: true })

const CSV_PATH = join(OUT_DIR, `auto-restart-soak-${TS}.csv`)
const JSON_PATH = join(EVIDENCE_DIR, `auto-restart-soak-${TS}.json`)

const CSV_HEADER =
  'sample_t,broker_uptime_s,rss_mb,heap_mb,event_loop_mean_ms,event_loop_p50_ms,event_loop_p99_ms,event_loop_max_ms,active_agents,pending_agents,max_concurrent,spawns_last_60s,broker_gen\n'
writeFileSync(CSV_PATH, CSV_HEADER)

// Thresholds for fail-the-run logic.
const TH = {
  rssMb: 1500,
  activeCap: args.cap,
  spawnPerMin: 20,
  eventLoopP99Ms: 500,
  breachHoldSec: 30,
}

const samples = []
let brokerProc = null
let brokerGen = 0
let shuttingDown = false

function log(msg) {
  console.log(`[soak ${new Date().toISOString()}] ${msg}`)
}

function startBroker() {
  brokerGen += 1
  const gen = brokerGen
  log(`starting broker gen=${gen} (SCNS_MAX_CONCURRENT_AGENTS=${args.cap}, port=${args.port})`)
  const proc = spawn(
    process.execPath,
    [join(repoRoot, 'dist', 'cli.js'), 'start', '--port', String(args.port), '--autonomy', '0'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SCNS_MAX_CONCURRENT_AGENTS: String(args.cap),
        SCNS_SOAK_GEN: String(gen),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  proc.stdout.on('data', (d) => process.stdout.write(`[broker ${gen}] ${d}`))
  proc.stderr.on('data', (d) => process.stderr.write(`[broker ${gen}] ${d}`))
  proc.on('exit', (code, signal) => {
    log(`broker gen=${gen} exited code=${code} signal=${signal}`)
  })
  return proc
}

async function stopBroker(proc) {
  if (!proc || proc.exitCode !== null) return
  return new Promise((res) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      res()
    }, 10_000)
    proc.once('exit', () => { clearTimeout(timer); res() })
    try { proc.kill('SIGTERM') } catch {}
  })
}

async function waitForMetrics(maxWaitMs) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${args.port}/api/metrics/runtime`)
      if (res.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function pollOnce() {
  try {
    const res = await fetch(`http://127.0.0.1:${args.port}/api/metrics/runtime`, {
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function csvEscape(v) {
  if (v === null || v === undefined) return ''
  return String(v)
}

function appendSample(sample) {
  const row = [
    sample.sample_t,
    sample.broker_uptime_s,
    sample.rss_mb,
    sample.heap_mb,
    sample.event_loop_mean_ms,
    sample.event_loop_p50_ms,
    sample.event_loop_p99_ms,
    sample.event_loop_max_ms,
    sample.active_agents,
    sample.pending_agents,
    sample.max_concurrent,
    sample.spawns_last_60s,
    sample.broker_gen,
  ].map(csvEscape).join(',') + '\n'
  appendFileSync(CSV_PATH, row)
  samples.push(sample)
}

function checkSustainedBreaches(samples, holdSec) {
  // Returns list of breach descriptors sustained for ≥ holdSec across
  // consecutive samples.
  const breaches = []
  const rules = [
    { key: 'rss_mb', limit: TH.rssMb, cmp: (v, l) => v > l, name: `rss_mb > ${TH.rssMb}` },
    { key: 'active_agents', limit: TH.activeCap, cmp: (v, l) => v > l, name: `active_agents > cap(${TH.activeCap})` },
    { key: 'spawns_last_60s', limit: TH.spawnPerMin, cmp: (v, l) => v > l, name: `spawns/min > ${TH.spawnPerMin}` },
    { key: 'event_loop_p99_ms', limit: TH.eventLoopP99Ms, cmp: (v, l) => v > l, name: `event_loop_p99_ms > ${TH.eventLoopP99Ms}` },
  ]
  for (const rule of rules) {
    let runStart = null
    for (const s of samples) {
      const v = s[rule.key]
      if (typeof v !== 'number') { runStart = null; continue }
      if (rule.cmp(v, rule.limit)) {
        if (runStart === null) runStart = s.sample_t
        const duration = (s.sample_t - runStart) / 1000
        if (duration >= holdSec) {
          breaches.push({ rule: rule.name, startedAt: runStart, durationSec: duration, value: v })
          break
        }
      } else {
        runStart = null
      }
    }
  }
  // Per-broker-lifecycle stricter check: p99 > 1000ms for >15s within any
  // single broker_gen AFTER the first 15s of uptime. Catches the 60-70s
  // startup CPU burn that coarse sustained thresholds can miss.
  const byGen = new Map()
  for (const s of samples) {
    if (typeof s.broker_gen !== 'number') continue
    const arr = byGen.get(s.broker_gen) ?? []
    arr.push(s)
    byGen.set(s.broker_gen, arr)
  }
  for (const [gen, genSamples] of byGen) {
    let runStart = null
    for (const s of genSamples) {
      if (typeof s.broker_uptime_s !== 'number' || s.broker_uptime_s < 15) {
        runStart = null
        continue
      }
      const v = s.event_loop_p99_ms
      if (typeof v !== 'number') { runStart = null; continue }
      if (v > 1000) {
        if (runStart === null) runStart = s.sample_t
        const duration = (s.sample_t - runStart) / 1000
        if (duration >= 15) {
          breaches.push({
            rule: `event_loop_p99_ms > 1000 sustained >15s (gen ${gen}, post-warmup)`,
            startedAt: runStart,
            durationSec: duration,
            value: v,
          })
          break
        }
      } else {
        runStart = null
      }
    }
  }
  return breaches
}

function summarize() {
  if (samples.length === 0) return { empty: true }
  const num = (key) => samples.map((s) => s[key]).filter((v) => typeof v === 'number')
  const max = (arr) => (arr.length ? Math.max(...arr) : null)
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)
  return {
    sampleCount: samples.length,
    rssMbPeak: max(num('rss_mb')),
    rssMbAvg: avg(num('rss_mb')),
    activeAgentsPeak: max(num('active_agents')),
    spawnsPerMinPeak: max(num('spawns_last_60s')),
    eventLoopP99MsPeak: max(num('event_loop_p99_ms')),
    eventLoopP99MsAvg: avg(num('event_loop_p99_ms')),
    eventLoopMaxMsPeak: max(num('event_loop_max_ms')),
    heapMbPeak: max(num('heap_mb')),
    brokerGenerations: brokerGen,
  }
}

process.on('SIGINT', () => { shuttingDown = true })
process.on('SIGTERM', () => { shuttingDown = true })

async function main() {
  log(`soak starting: duration=${args.durationSec}s, restart=${args.restartSec}s, cap=${args.cap}`)
  log(`csv -> ${CSV_PATH}`)
  log(`json -> ${JSON_PATH}`)

  brokerProc = startBroker()
  const ready = await waitForMetrics(30_000)
  if (!ready) {
    log('ERROR: broker did not expose /api/metrics/runtime within 30s')
    await stopBroker(brokerProc)
    writeFileSync(JSON_PATH, JSON.stringify({
      startedAt: new Date().toISOString(),
      failed: true,
      reason: 'broker-did-not-come-up',
      args,
    }, null, 2))
    process.exit(2)
  }
  log('broker is healthy — polling metrics')

  const startedAt = Date.now()
  const endAt = startedAt + args.durationSec * 1000
  let lastRestartAt = startedAt

  while (!shuttingDown && Date.now() < endAt) {
    const now = Date.now()
    const metrics = await pollOnce()
    if (metrics && !metrics.error) {
      const s = {
        sample_t: now,
        broker_uptime_s: metrics.uptimeSec ?? null,
        rss_mb: metrics.memory?.rssMb ?? null,
        heap_mb: metrics.memory?.heapUsedMb ?? null,
        event_loop_mean_ms: metrics.eventLoop?.meanMs ?? null,
        event_loop_p50_ms: metrics.eventLoop?.p50Ms ?? null,
        event_loop_p99_ms: metrics.eventLoop?.p99Ms ?? null,
        event_loop_max_ms: metrics.eventLoop?.maxMs ?? null,
        active_agents: metrics.spawner?.activeCount ?? null,
        pending_agents: metrics.spawner?.pendingCount ?? null,
        max_concurrent: metrics.spawner?.maxConcurrent ?? null,
        spawns_last_60s: metrics.spawner?.spawnsLast60s ?? null,
        broker_gen: brokerGen,
      }
      appendSample(s)
      if (samples.length % 12 === 0) {
        log(`[${samples.length}] rss=${s.rss_mb}MB active=${s.active_agents}/${s.max_concurrent} p99=${s.event_loop_p99_ms}ms spawns/60s=${s.spawns_last_60s}`)
      }
    } else if (metrics?.error) {
      log(`poll error: ${metrics.error}`)
    }

    // Restart cycle: kick the broker every restartSec to exercise F3/F4.
    if (now - lastRestartAt >= args.restartSec * 1000) {
      log('initiating simulated restart (SIGTERM + relaunch)')
      await stopBroker(brokerProc)
      brokerProc = startBroker()
      const ok = await waitForMetrics(30_000)
      if (!ok) {
        log('ERROR: broker failed to come back up after restart')
        break
      }
      lastRestartAt = Date.now()
      log('restart complete — resuming poll')
    }

    await new Promise((r) => setTimeout(r, args.pollSec * 1000))
  }

  log('soak loop finished — shutting down broker')
  await stopBroker(brokerProc)

  const summary = summarize()
  const breaches = checkSustainedBreaches(samples, TH.breachHoldSec)
  const passed = breaches.length === 0 && samples.length > 0
  const evidence = {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - startedAt) / 1000),
    args,
    thresholds: TH,
    passed,
    breaches,
    summary,
    csvPath: CSV_PATH,
    notes: [
      'Per-broker RSS plateau ~500MB is the FastEmbed/ONNX BGE-small-en-v1.5',
      'session itself (mmapped weights + ORT arenas), not a leak. The',
      'fastembed JS package exposes no .release() — blue/green restart is the',
      'reset mechanism (cycle 1 of 2026-04-22 soak: 956MB → 84MB).',
      'See scripts/lib/soak-summary.mjs for the wrapper-harness thresholds.',
    ].join(' '),
    note: 'Generated by scripts/auto-restart-soak.mjs. Do not edit by hand.',
  }
  writeFileSync(JSON_PATH, JSON.stringify(evidence, null, 2))
  log(`summary: passed=${passed}, breaches=${breaches.length}, samples=${samples.length}`)
  log(`evidence written: ${JSON_PATH}`)

  process.exit(passed ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL:', err)
  if (brokerProc) void stopBroker(brokerProc)
  process.exit(3)
})
