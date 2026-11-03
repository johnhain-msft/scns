/**
 * Session extractor — derives per-session summaries from OTel spans.
 *
 * Groups spans by an effective session key: if any span in a trace has
 * a non-null session_id, that value is used for the whole trace;
 * otherwise the trace_id is used as the session identifier.
 */

import type Database from 'better-sqlite3'
import { logger } from '../shared/logger.js'

// ── Types ────────────────────────────────────────────────────

export interface SessionSummary {
  readonly sessionId: string
  readonly startTime: string
  readonly endTime: string | null
  readonly durationMs: number | null
  readonly models: ReadonlyArray<{ readonly model: string; readonly callCount: number }>
  readonly tools: ReadonlyArray<{
    readonly tool: string
    readonly callCount: number
    readonly avgDurationMs: number | null
  }>
  readonly mcpServers: readonly string[]
  readonly skills: readonly string[]
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly errorCount: number
  readonly spanCount: number
  readonly traceIds: readonly string[]
}

export interface ExtractSessionsOptions {
  readonly since?: string
  readonly limit?: number
  readonly sessionId?: string
}

// ── Internal row types ───────────────────────────────────────

interface SessionGroupRow {
  readonly eff_session: string
  readonly earliest: string
}

interface SpanRow {
  readonly trace_id: string
  readonly span_id: string
  readonly name: string
  readonly start_time: string
  readonly end_time: string | null
  readonly duration_ms: number | null
  readonly status: string | null
  readonly attributes_json: string
  readonly events_json: string
  readonly eff_session: string
}

// ── MCP server extraction ────────────────────────────────────

const MCP_SERVER_NAME_RE = /^(.+-mcp-server)/

/** Extract MCP server name from a tool span name or attributes. */
function extractMcpServer(toolName: string, attrs: Record<string, unknown>): string | undefined {
  const explicit = attrs['mcp.server']
  if (typeof explicit === 'string' && explicit.length > 0) return explicit

  const match = MCP_SERVER_NAME_RE.exec(toolName)
  if (match?.[1]) return match[1]

  return undefined
}

// ── Skill extraction ─────────────────────────────────────────

function extractSkill(attrs: Record<string, unknown>): string | undefined {
  for (const key of ['skill', 'skill.name'] as const) {
    const val = attrs[key]
    if (typeof val === 'string' && val.length > 0) return val
  }
  return undefined
}

function extractSkillsFromEvents(eventsJson: string): string[] {
  try {
    const events = JSON.parse(eventsJson) as unknown[]
    if (!Array.isArray(events)) return []
    const skills: string[] = []
    for (const event of events) {
      if (typeof event !== 'object' || event === null) continue
      const e = event as Record<string, unknown>
      if (typeof e['name'] === 'string' && e['name'].toLowerCase().includes('skill')) {
        const attrs = e['attributes'] as Record<string, unknown> | undefined
        if (attrs) {
          const skill = extractSkill(attrs)
          if (skill) skills.push(skill)
        }
      }
    }
    return skills
  } catch {
    return []
  }
}

// ── Safe JSON parse ──────────────────────────────────────────

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

// ── Build summary from span rows ─────────────────────────────

function buildSummary(sessionId: string, spans: readonly SpanRow[]): SessionSummary {
  let startTime = spans[0]?.start_time ?? ''
  let endTime: string | null = null
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let errorCount = 0
  const traceIdSet = new Set<string>()
  const modelCounts = new Map<string, number>()
  const toolDurations = new Map<string, number[]>()
  const mcpServerSet = new Set<string>()
  const skillSet = new Set<string>()

  for (const span of spans) {
    // Time range
    if (span.start_time < startTime) startTime = span.start_time
    if (span.end_time !== null && (endTime === null || span.end_time > endTime)) {
      endTime = span.end_time
    }

    // Trace IDs
    traceIdSet.add(span.trace_id)

    // Error counting
    if (span.status === 'ERROR') errorCount++

    const attrs = safeParseJson(span.attributes_json)

    // Models from `chat <model>` spans
    if (span.name.startsWith('chat ')) {
      const model = span.name.slice(5)
      if (model.length > 0) {
        modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1)
      }
      // Token counting — only from chat spans to avoid double-counting
      const inp = attrs['gen_ai.usage.input_tokens']
      const out = attrs['gen_ai.usage.output_tokens']
      if (typeof inp === 'number') totalInputTokens += inp
      if (typeof out === 'number') totalOutputTokens += out
    }

    // Tools from `execute_tool <tool>` spans
    if (span.name.startsWith('execute_tool ')) {
      const tool = span.name.slice(13)
      if (tool.length > 0) {
        const durations = toolDurations.get(tool) ?? []
        if (span.duration_ms !== null) durations.push(span.duration_ms)
        toolDurations.set(tool, durations)

        // MCP server from tool name or attributes
        const server = extractMcpServer(tool, attrs)
        if (server) mcpServerSet.add(server)
      }
    }

    // Skills from attributes or events
    const skill = extractSkill(attrs)
    if (skill) skillSet.add(skill)

    const eventSkills = extractSkillsFromEvents(span.events_json)
    for (const s of eventSkills) skillSet.add(s)
  }

  // Compute duration
  let durationMs: number | null = null
  if (endTime !== null) {
    const startMs = new Date(startTime).getTime()
    const endMs = new Date(endTime).getTime()
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
      durationMs = endMs - startMs
    }
  }

  // Build models array sorted by count desc
  const models = [...modelCounts.entries()]
    .map(([model, callCount]) => ({ model, callCount }))
    .sort((a, b) => b.callCount - a.callCount)

  // Build tools array sorted by count desc
  const tools = [...toolDurations.entries()]
    .map(([tool, durations]) => ({
      tool,
      callCount: durations.length > 0 ? durations.length : 1,
      avgDurationMs:
        durations.length > 0 ? durations.reduce((sum, d) => sum + d, 0) / durations.length : null,
    }))
    .sort((a, b) => b.callCount - a.callCount)

  return {
    sessionId,
    startTime,
    endTime,
    durationMs,
    models,
    tools,
    mcpServers: [...mcpServerSet].sort(),
    skills: [...skillSet].sort(),
    totalInputTokens,
    totalOutputTokens,
    errorCount,
    spanCount: spans.length,
    traceIds: [...traceIdSet].sort(),
  }
}

// ── Public API ────────────────────────────────────────────────

/**
 * Extract per-session summaries from OTel spans.
 *
 * Groups spans by effective session key: if any span in a trace has
 * a non-null session_id, that value is used for the entire trace;
 * otherwise the trace_id itself serves as the session identifier.
 */
export function extractSessionSummaries(
  db: Database.Database,
  options?: ExtractSessionsOptions,
): ReadonlyArray<SessionSummary> {
  const limit = options?.limit ?? 50
  const since = options?.since
  const sessionId = options?.sessionId

  // Step 1: determine effective session key per trace
  // Step 2: find which sessions to return
  // Step 3: fetch all spans for those sessions

  const sinceConditions: string[] = []
  const sinceParams: unknown[] = []

  if (since) {
    sinceConditions.push('s.start_time > ?')
    sinceParams.push(since)
  }

  const traceSessionCte = `
    trace_sessions AS (
      SELECT
        trace_id,
        COALESCE(MAX(session_id), trace_id) AS eff_session
      FROM otel_spans
      GROUP BY trace_id
    )`

  // Build session group query
  const sessionConditions = [...sinceConditions]
  const sessionParams = [...sinceParams]

  if (sessionId) {
    sessionConditions.push('ts.eff_session = ?')
    sessionParams.push(sessionId)
  }

  const sessionWhere =
    sessionConditions.length > 0 ? `WHERE ${sessionConditions.join(' AND ')}` : ''

  const groupSql = `
    WITH ${traceSessionCte}
    SELECT ts.eff_session, MIN(s.start_time) AS earliest
    FROM otel_spans s
    JOIN trace_sessions ts ON s.trace_id = ts.trace_id
    ${sessionWhere}
    GROUP BY ts.eff_session
    ORDER BY earliest DESC
    LIMIT ?
  `
  sessionParams.push(limit)

  const groups = db.prepare(groupSql).all(...sessionParams) as SessionGroupRow[]

  if (groups.length === 0) return []

  logger.debug({ sessionCount: groups.length }, 'extracting session summaries')

  // Step 3: fetch all spans for selected sessions in one batch
  const placeholders = groups.map(() => '?').join(', ')
  const effSessions = groups.map((g) => g.eff_session)

  const spanSql = `
    WITH ${traceSessionCte}
    SELECT
      s.trace_id,
      s.span_id,
      s.name,
      s.start_time,
      s.end_time,
      s.duration_ms,
      s.status,
      s.attributes_json,
      s.events_json,
      ts.eff_session
    FROM otel_spans s
    JOIN trace_sessions ts ON s.trace_id = ts.trace_id
    WHERE ts.eff_session IN (${placeholders})
    ORDER BY ts.eff_session, s.start_time ASC
  `

  const allSpans = db.prepare(spanSql).all(...effSessions) as SpanRow[]

  // Group spans by effective session
  const spansBySession = new Map<string, SpanRow[]>()
  for (const span of allSpans) {
    const key = span.eff_session
    const group = spansBySession.get(key) ?? []
    group.push(span)
    spansBySession.set(key, group)
  }

  // Build summaries in the same order as groups (most recent first)
  const summaries: SessionSummary[] = []
  for (const group of groups) {
    const spans = spansBySession.get(group.eff_session)
    if (spans && spans.length > 0) {
      summaries.push(buildSummary(group.eff_session, spans))
    }
  }

  return summaries
}

/** Extract a summary for a single session by ID. */
export function extractSessionSummary(
  db: Database.Database,
  sessionId: string,
): SessionSummary | undefined {
  const results = extractSessionSummaries(db, { sessionId, limit: 1 })
  return results[0]
}
