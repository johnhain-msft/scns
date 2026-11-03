/**
 * Runtime metrics — RSS / heap / event-loop lag / spawner stats.
 *
 * Powers `GET /api/metrics/runtime`, the stress test, and the live soak
 * harness (`scripts/auto-restart-soak.mjs`). This is the instrumentation the
 * auto-restart runaway fix is evaluated against: bounded RSS, bounded active
 * agents, and event-loop lag that doesn't degrade under load.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import type { AgentSpawner, SpawnStats } from './agent-spawner.js'

export interface RuntimeMetricsSnapshot {
  readonly timestampMs: number
  readonly uptimeSec: number
  readonly memory: {
    readonly rssMb: number
    readonly heapUsedMb: number
    readonly externalMb: number
  }
  readonly eventLoop: {
    readonly meanMs: number
    readonly p50Ms: number
    readonly p99Ms: number
    readonly maxMs: number
  }
  readonly spawner: SpawnStats | null
}

export interface RuntimeMetrics {
  snapshot(): RuntimeMetricsSnapshot
  /** Reset the event-loop histogram — called after each snapshot serve so p99/max are per-window, not lifetime. */
  reset(): void
  stop(): void
}

function bytesToMb(n: number): number {
  return Math.round((n / (1024 * 1024)) * 100) / 100
}

function nanosToMs(n: number): number {
  return Math.round((n / 1_000_000) * 100) / 100
}

export function createRuntimeMetrics(options?: {
  readonly spawner?: AgentSpawner
  readonly resolutionMs?: number
}): RuntimeMetrics {
  const histogram: IntervalHistogram = monitorEventLoopDelay({
    resolution: options?.resolutionMs ?? 50,
  })
  histogram.enable()

  const startTime = Date.now()

  return {
    snapshot(): RuntimeMetricsSnapshot {
      const mem = process.memoryUsage()
      return {
        timestampMs: Date.now(),
        uptimeSec: Math.round(process.uptime()),
        memory: {
          rssMb: bytesToMb(mem.rss),
          heapUsedMb: bytesToMb(mem.heapUsed),
          externalMb: bytesToMb(mem.external),
        },
        eventLoop: {
          meanMs: nanosToMs(histogram.mean),
          p50Ms: nanosToMs(histogram.percentile(50)),
          p99Ms: nanosToMs(histogram.percentile(99)),
          maxMs: nanosToMs(histogram.max),
        },
        spawner: options?.spawner ? options.spawner.getSpawnStats() : null,
      }
    },
    reset(): void {
      histogram.reset()
    },
    stop(): void {
      histogram.disable()
    },
  }
  void startTime // reserved for future per-window metrics
}
