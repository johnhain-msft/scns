/**
 * D1 — ideation signal gathering.
 *
 * `gatherIdeationSignals` is the core assembler: it pulls each signal from an
 * INJECTED source and tolerates a failing source (one bad read must never abort
 * a whole ideation cycle). The pure adapters below turn live data into the
 * compact, prompt-friendly shapes:
 *   - `telemetrySignalFromPatterns` ← otel `ExtractedPatterns`
 *   - `summarizeRecentOutcomes`     ← suggestion store records
 *   - `readCodebaseSignal`          ← the `src/` directory
 */

import { readdirSync, existsSync } from 'node:fs'
import { logger } from '../shared/logger.js'
import type { ExtractedPatterns } from '../otel/pattern-extractor.js'
import type {
  IdeationSignals,
  TelemetrySignal,
  CodebaseSignal,
  RecentOutcomesSignal,
  GapSignal,
  PriorProposalOutcome,
} from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_BUCKET_MAX = 15
const DEFAULT_TOP_N = 8

/** Injectable signal sources. Each is called once per `gatherIdeationSignals`. */
export interface IdeationSignalSources {
  readonly telemetry: () => TelemetrySignal | null
  readonly codebase: () => CodebaseSignal
  readonly recentOutcomes: () => RecentOutcomesSignal
  readonly openGaps: () => readonly GapSignal[]
  /** D2 hook — outcomes of prior proposals. Defaults to `[]` (D1). */
  readonly priorProposalOutcomes?: () => readonly PriorProposalOutcome[]
  /** Clock injection for deterministic tests. */
  readonly now?: () => Date
}

function safe<T>(label: string, fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), signal: label },
      'ideation-signals: source failed, using fallback',
    )
    return fallback
  }
}

export function gatherIdeationSignals(sources: IdeationSignalSources): IdeationSignals {
  const now = sources.now ?? (() => new Date())
  return {
    generatedAt: now().toISOString(),
    telemetry: safe('telemetry', sources.telemetry, null),
    codebase: safe('codebase', sources.codebase, { modules: [], description: '' }),
    recentOutcomes: safe('recentOutcomes', sources.recentOutcomes, {
      implemented: [],
      rejected: [],
      failed: [],
      pendingCount: 0,
    }),
    openGaps: safe('openGaps', sources.openGaps, []),
    priorProposalOutcomes: sources.priorProposalOutcomes
      ? safe('priorProposalOutcomes', sources.priorProposalOutcomes, [])
      : [],
  }
}

// ── Pure adapters ────────────────────────────────────────────────────

/** Map otel `ExtractedPatterns` → compact {@link TelemetrySignal}. */
export function telemetrySignalFromPatterns(
  patterns: ExtractedPatterns | null,
  opts: { topN?: number } = {},
): TelemetrySignal | null {
  if (patterns == null) return null
  const topN = opts.topN ?? DEFAULT_TOP_N

  let windowDays = 1
  if (patterns.analyzedFrom !== '' && patterns.analyzedTo !== '') {
    const from = Date.parse(patterns.analyzedFrom)
    const to = Date.parse(patterns.analyzedTo)
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from) {
      windowDays = Math.max(1, Math.round((to - from) / DAY_MS))
    }
  }

  return {
    totalSessions: patterns.totalSessions,
    windowDays,
    primaryModel: patterns.models.primaryModel,
    topTools: patterns.tools.topTools
      .slice(0, topN)
      .map((t) => ({ tool: t.tool, uses: t.totalUses })),
    topModels: patterns.models.models
      .slice(0, topN)
      .map((m) => ({ model: m.model, calls: m.totalCalls })),
    busiestHours: [...patterns.schedule.activeHours]
      .sort((a, b) => b.sessionCount - a.sessionCount)
      .slice(0, topN)
      .map((h) => ({ hour: h.hour, sessions: h.sessionCount })),
  }
}

/** Bucket suggestion-store records by status into a {@link RecentOutcomesSignal}. */
export function summarizeRecentOutcomes(
  suggestions: readonly { readonly title: string; readonly status: string }[],
  opts: { max?: number } = {},
): RecentOutcomesSignal {
  const max = opts.max ?? DEFAULT_BUCKET_MAX
  const bucket = (status: string): string[] =>
    suggestions
      .filter((s) => s.status === status)
      .map((s) => s.title)
      .slice(0, max)

  return {
    implemented: bucket('implemented'),
    rejected: bucket('rejected'),
    failed: bucket('failed'),
    pendingCount: suggestions.filter((s) => s.status === 'pending').length,
  }
}

/** List the immediate subdirectories of `srcDir` as module names. */
export function readCodebaseSignal(srcDir: string, description: string): CodebaseSignal {
  let modules: string[] = []
  if (existsSync(srcDir)) {
    try {
      modules = readdirSync(srcDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    } catch {
      modules = []
    }
  }
  return { modules, description }
}
