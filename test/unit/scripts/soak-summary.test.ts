import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  summarizeRows,
  summarizeFromCsv,
  evaluateThresholds,
  DEFAULT_THRESHOLDS,
} from '../../../scripts/lib/soak-summary.mjs'

function mkCsv(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'soak-summary-'))
  const path = join(dir, 'metrics.csv')
  const header =
    'ts_epoch,uptime_sec,rss_mb,heap_mb,external_mb,evloop_p99_ms,evloop_max_ms,active_agents'
  const body = rows
    .map((r) =>
      [
        r.ts_epoch,
        r.uptime_sec,
        r.rss_mb,
        r.heap_mb,
        r.external_mb,
        r.evloop_p99_ms,
        r.evloop_max_ms,
        r.active_agents,
      ].join(','),
    )
    .join('\n')
  writeFileSync(path, `${header}\n${body}\n`)
  return path
}

describe('soak-summary', () => {
  it('summarizeRows computes exact min/max/p50/end for known input (regression for 99999 sentinel bug)', () => {
    const rows = [
      { ts_epoch: 1, uptime_sec: 1, rss_mb: 100, heap_mb: 20, external_mb: 3, evloop_p99_ms: 50, evloop_max_ms: 60, active_agents: 0 },
      { ts_epoch: 2, uptime_sec: 16, rss_mb: 200, heap_mb: 21, external_mb: 4, evloop_p99_ms: 60, evloop_max_ms: 70, active_agents: 0 },
      { ts_epoch: 3, uptime_sec: 31, rss_mb: 300, heap_mb: 22, external_mb: 5, evloop_p99_ms: 70, evloop_max_ms: 80, active_agents: 0 },
      { ts_epoch: 4, uptime_sec: 46, rss_mb: 400, heap_mb: 23, external_mb: 6, evloop_p99_ms: 80, evloop_max_ms: 90, active_agents: 0 },
      { ts_epoch: 5, uptime_sec: 61, rss_mb: 528.32, heap_mb: 24, external_mb: 3.72, evloop_p99_ms: 90, evloop_max_ms: 95, active_agents: 0 },
    ]
    const s = summarizeRows(rows)
    expect(s.samples).toBe(5)
    expect(s.rss_mb_min).toBe(100)
    expect(s.rss_mb_max).toBe(528.32)
    expect(s.rss_mb_p50).toBe(300)
    expect(s.rss_mb_end).toBe(528.32)
    expect(s.external_mb_min).toBeCloseTo(3, 5)
    expect(s.external_mb_max).toBeCloseTo(6, 5)
    expect(s.external_mb_end).toBeCloseTo(3.72, 5)
    expect(s.evloop_p99_ms_max).toBe(90)
    expect(s.evloop_p99_ms_p99).toBeTypeOf('number')

    // Critical: NO 99999 sentinel anywhere. The whole point of this module
    // is that the previous bash↔python heredoc silently substituted 99999 on
    // any parse error.
    for (const v of Object.values(s)) {
      if (typeof v === 'number') expect(v).not.toBe(99999)
    }
  })

  it('summarizeFromCsv reads the same CSV format the soak harness writes', () => {
    const csv = mkCsv([
      { ts_epoch: 1, uptime_sec: 1, rss_mb: 100.5, heap_mb: 20, external_mb: 3, evloop_p99_ms: 52.3, evloop_max_ms: 60, active_agents: 0 },
      { ts_epoch: 2, uptime_sec: 16, rss_mb: 528.32, heap_mb: 21, external_mb: 3.72, evloop_p99_ms: 1378.88, evloop_max_ms: 1400, active_agents: 0 },
    ])
    const s = summarizeFromCsv(csv)
    expect(s.rss_mb_end).toBe(528.32)
    expect(s.evloop_p99_ms_max).toBe(1378.88)
  })

  it('returns empty marker for zero-sample CSV', () => {
    expect(summarizeRows([])).toEqual({ samples: 0, empty: true })
  })

  it('rejects malformed CSV header so silent corruption cannot recur', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak-summary-bad-'))
    const path = join(dir, 'metrics.csv')
    writeFileSync(path, 'wrong,header\n1,2\n')
    expect(() => summarizeFromCsv(path)).toThrow(/unexpected CSV header/)
  })

  describe('evaluateThresholds', () => {
    const cleanSummary = {
      samples: 100,
      rss_mb_min: 84,
      rss_mb_max: 528.32,
      rss_mb_p50: 300,
      rss_mb_end: 528.32,
      external_mb_min: 3,
      external_mb_max: 4,
      external_mb_end: 3.72,
      evloop_p99_ms_max: 1378.88,
      evloop_p99_ms_p99: 52.63,
    }

    it('passes when all thresholds met (round-1 numbers post-fix)', () => {
      const r = evaluateThresholds(cleanSummary, { cpp_aborts: 0, cycles_reached_phase7: 2 })
      expect(r.pass).toBe(true)
      expect(r.failures).toEqual([])
    })

    it('warns (but does not fail) when rss plateau >= 600', () => {
      const r = evaluateThresholds(cleanSummary, { cpp_aborts: 0, cycles_reached_phase7: 2 })
      expect(r.pass).toBe(true)
      expect(r.warnings.some((w) => w.includes('rss_mb_end='))).toBe(false)
      const warned = evaluateThresholds(
        { ...cleanSummary, rss_mb_end: 650 },
        { cpp_aborts: 0, cycles_reached_phase7: 2 },
      )
      expect(warned.pass).toBe(true)
      expect(warned.warnings.some((w) => w.includes('rss_mb_end=650'))).toBe(true)
    })

    it('warns but does NOT fail on cpp_aborts=1 per cycle (round-3 soft cap)', () => {
      const r = evaluateThresholds(cleanSummary, { cpp_aborts: 1, cycles_reached_phase7: 1 })
      expect(r.pass).toBe(true)
      expect(r.warnings.some((w) => w.startsWith('cpp_aborts='))).toBe(true)
    })

    it('fails on cpp_aborts >= 3 per cycle (round-3 hard cap)', () => {
      const r = evaluateThresholds(cleanSummary, { cpp_aborts: 6, cycles_reached_phase7: 2 })
      expect(r.pass).toBe(false)
      expect(r.failures.some((f) => f.startsWith('cpp_aborts='))).toBe(true)
    })

    it('fails on rss_mb_end >= 800 (settled per-broker hard ceiling)', () => {
      const r = evaluateThresholds(
        { ...cleanSummary, rss_mb_end: 850 },
        { cpp_aborts: 0, cycles_reached_phase7: 2 },
      )
      expect(r.pass).toBe(false)
      expect(r.failures.some((f) => f.includes('rss_mb_end=850'))).toBe(true)
    })

    it('does NOT fail on rss_mb_max alone (pre-cycle blue broker peak is expected)', () => {
      // Round-1 evidence: rss_mb_max=956 was the blue broker right before we
      // restarted it on purpose. Gate must not flag this.
      const r = evaluateThresholds(
        { ...cleanSummary, rss_mb_max: 956.31 },
        { cpp_aborts: 0, cycles_reached_phase7: 2 },
      )
      expect(r.pass).toBe(true)
    })

    it('fails on rss_mb_min >= 200 (post-cycle reset must drop below)', () => {
      const r = evaluateThresholds(
        { ...cleanSummary, rss_mb_min: 250 },
        { cpp_aborts: 0, cycles_reached_phase7: 2 },
      )
      expect(r.pass).toBe(false)
      expect(r.failures.some((f) => f.includes('rss_mb_min=250'))).toBe(true)
    })

    it('fails on settled p99 >= 100ms', () => {
      const r = evaluateThresholds(
        { ...cleanSummary, evloop_p99_ms_p99: 150 },
        { cpp_aborts: 0, cycles_reached_phase7: 2 },
      )
      expect(r.pass).toBe(false)
      expect(r.failures.some((f) => f.includes('evloop_p99_ms_p99=150'))).toBe(true)
    })

    it('fails on cycles_reached_phase7 < 1', () => {
      const r = evaluateThresholds(cleanSummary, { cpp_aborts: 0, cycles_reached_phase7: 0 })
      expect(r.pass).toBe(false)
      expect(r.failures.some((f) => f.includes('cycles_reached_phase7=0'))).toBe(true)
    })

    it('exposes default thresholds for harness consumption', () => {
      expect(DEFAULT_THRESHOLDS.rssMbEndFail).toBe(800)
      expect(DEFAULT_THRESHOLDS.rssMbEndWarn).toBe(600)
      expect(DEFAULT_THRESHOLDS.rssMbMinPostCycle).toBe(200)
      expect(DEFAULT_THRESHOLDS.evloopP99SettledMs).toBe(100)
    })
  })
})
