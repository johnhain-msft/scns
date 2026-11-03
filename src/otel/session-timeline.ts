/**
 * Session timeline — aggregates hook events + OTel spans into a unified
 * chronological session view.
 */

import type Database from 'better-sqlite3'
import { logger } from '../shared/logger.js'
import type { Observation } from '../observe/types.js'
import type { SessionSummary } from './session-extractor.js'
import { extractSessionSummary, extractSessionSummaries } from './session-extractor.js'
import { findSpansByTraceId, type OtelSpan } from './otel-repository.js'

// ── Types ────────────────────────────────────────────────────

export interface TimelineEntry {
  readonly timestamp: string
  readonly type: 'hook' | 'span' | 'observation'
  readonly event: string
  readonly details: string
  readonly durationMs?: number
  readonly metadata?: Record<string, unknown>
}

export interface SessionTimeline {
  readonly sessionId: string
  readonly startTime: string
  readonly endTime: string | null
  readonly durationMs: number | null
  readonly entries: ReadonlyArray<TimelineEntry>
  readonly summary: SessionSummary | null
}

export interface BuildTimelineOptions {
  readonly db: Database.Database
  readonly sessionId: string
  readonly observations?: ReadonlyArray<Observation>
}

export interface BuildRecentTimelinesOptions {
  readonly db: Database.Database
  readonly observations?: ReadonlyArray<Observation>
  readonly limit?: number
  readonly since?: string
}

// ── Helpers ──────────────────────────────────────────────────

/** Parse tag value from `prefix:value` format. */
function getTagValue(tags: readonly string[], prefix: string): string | undefined {
  for (const tag of tags) {
    if (tag.startsWith(prefix)) {
      return tag.slice(prefix.length)
    }
  }
  return undefined
}

/** Collect all tag values matching a prefix. */
function getTagValues(tags: readonly string[], prefix: string): string[] {
  const values: string[] = []
  for (const tag of tags) {
    if (tag.startsWith(prefix)) {
      values.push(tag.slice(prefix.length))
    }
  }
  return values
}

/** Filter observations belonging to a session by session-id or trace tags. */
function filterObservationsForSession(
  observations: ReadonlyArray<Observation>,
  sessionId: string,
  traceIds: readonly string[],
): Observation[] {
  const traceIdSet = new Set(traceIds)

  return observations.filter((obs) => {
    const obsSessionId = getTagValue(obs.tags, 'session-id:')
    if (obsSessionId === sessionId) return true

    const obsTraceIds = getTagValues(obs.tags, 'trace:')
    return obsTraceIds.some((tid) => traceIdSet.has(tid))
  })
}

function safeParseJson(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore
  }
  return {}
}

/** Convert an OTel span into a timeline entry. */
function spanToEntry(span: OtelSpan): TimelineEntry {
  const attrs = safeParseJson(span.attributes_json)
  const meta: Record<string, unknown> = {
    traceId: span.trace_id,
    spanId: span.span_id,
  }

  let details: string
  if (span.name.startsWith('chat ')) {
    const model = span.name.slice(5)
    const parts = [`LLM call to ${model}`]
    const inp = attrs['gen_ai.usage.input_tokens']
    const out = attrs['gen_ai.usage.output_tokens']
    if (typeof inp === 'number' || typeof out === 'number') {
      parts.push(`(${inp ?? '?'} in / ${out ?? '?'} out tokens)`)
    }
    details = parts.join(' ')
    meta.model = model
  } else if (span.name.startsWith('execute_tool ')) {
    const tool = span.name.slice(13)
    const parts = [`Tool execution: ${tool}`]
    if (span.duration_ms !== null) {
      parts.push(`(${span.duration_ms}ms)`)
    }
    details = parts.join(' ')
    meta.tool = tool
  } else {
    details = span.name
  }

  if (span.status === 'ERROR') {
    meta.error = true
  }

  return {
    timestamp: span.start_time,
    type: 'span',
    event: span.name,
    details,
    ...(span.duration_ms !== null ? { durationMs: span.duration_ms } : {}),
    metadata: meta,
  }
}

/** Convert an observation into a timeline entry. */
function observationToEntry(obs: Observation): TimelineEntry {
  const isHook = obs.type === 'session-hook'
  const meta: Record<string, unknown> = { observationId: obs.id }

  if (obs.metadata) {
    Object.assign(meta, obs.metadata)
  }

  // Extract useful info from tags
  const tool = getTagValue(obs.tags, 'tool:')
  const model = getTagValue(obs.tags, 'model:')
  const mcp = getTagValue(obs.tags, 'mcp:')
  const skill = getTagValue(obs.tags, 'skill:')
  if (tool) meta.tool = tool
  if (model) meta.model = model
  if (mcp) meta.mcpServer = mcp
  if (skill) meta.skill = skill

  return {
    timestamp: obs.timestamp,
    type: isHook ? 'hook' : 'observation',
    event: obs.source,
    details: obs.content,
    metadata: meta,
  }
}

/** Compute timeline bounds from sorted entries. */
function computeBounds(entries: ReadonlyArray<TimelineEntry>): {
  startTime: string
  endTime: string | null
  durationMs: number | null
} {
  if (entries.length === 0) {
    return { startTime: '', endTime: null, durationMs: null }
  }

  const startTime = entries[0]!.timestamp
  const endTime = entries.length > 1 ? entries[entries.length - 1]!.timestamp : null

  let durationMs: number | null = null
  if (endTime !== null) {
    const startMs = new Date(startTime).getTime()
    const endMs = new Date(endTime).getTime()
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
      durationMs = endMs - startMs
    }
  }

  return { startTime, endTime, durationMs }
}

/** Extract unique session IDs from observations. */
function extractSessionIdsFromObservations(observations: ReadonlyArray<Observation>): Set<string> {
  const ids = new Set<string>()
  for (const obs of observations) {
    const sid = getTagValue(obs.tags, 'session-id:')
    if (sid) ids.add(sid)
  }
  return ids
}

// ── Public API ────────────────────────────────────────────────

/**
 * Build a unified timeline for a single session by merging OTel spans
 * and observations into chronologically sorted entries.
 */
export function buildSessionTimeline(options: BuildTimelineOptions): SessionTimeline {
  const { db, sessionId, observations } = options

  // Fetch OTel summary
  const summary = extractSessionSummary(db, sessionId) ?? null

  // Collect span entries
  const entries: TimelineEntry[] = []

  if (summary) {
    const seenSpans = new Set<string>()
    for (const traceId of summary.traceIds) {
      const spans = findSpansByTraceId(db, traceId)
      for (const span of spans) {
        if (!seenSpans.has(span.span_id)) {
          seenSpans.add(span.span_id)
          entries.push(spanToEntry(span))
        }
      }
    }
  }

  // Merge observations
  if (observations && observations.length > 0) {
    const traceIds = summary?.traceIds ?? []
    const matching = filterObservationsForSession(observations, sessionId, traceIds)
    for (const obs of matching) {
      entries.push(observationToEntry(obs))
    }
  }

  // Sort chronologically
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  const bounds = computeBounds(entries)

  logger.debug(
    { sessionId, spanEntries: summary?.spanCount ?? 0, totalEntries: entries.length },
    'built session timeline',
  )

  return {
    sessionId,
    startTime: bounds.startTime,
    endTime: bounds.endTime,
    durationMs: bounds.durationMs,
    entries,
    summary,
  }
}

/**
 * Build timelines for recent sessions, merging OTel and observation data.
 * Discovers sessions from both OTel spans and observations.
 */
export function buildRecentTimelines(
  options: BuildRecentTimelinesOptions,
): ReadonlyArray<SessionTimeline> {
  const { db, observations, limit = 10, since } = options

  // Get session IDs from OTel data
  const summaries = extractSessionSummaries(db, { limit, since })
  const sessionIds = new Set(summaries.map((s) => s.sessionId))

  // Discover additional session IDs from observations
  if (observations && observations.length > 0) {
    const obsSessionIds = extractSessionIdsFromObservations(observations)
    for (const id of obsSessionIds) {
      sessionIds.add(id)
    }
  }

  // Build timelines
  const timelines: SessionTimeline[] = []
  for (const sessionId of sessionIds) {
    const timeline = buildSessionTimeline({ db, sessionId, observations })
    // Skip empty timelines
    if (timeline.entries.length > 0) {
      timelines.push(timeline)
    }
  }

  // Sort by start time descending (most recent first), then limit
  timelines.sort((a, b) => b.startTime.localeCompare(a.startTime))

  return timelines.slice(0, limit)
}
