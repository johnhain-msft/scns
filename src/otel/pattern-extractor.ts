/**
 * Pattern extractor — extracts behavioral patterns from session history.
 *
 * Analyzes work schedule, tool preferences, model choices, MCP usage,
 * and skill usage across multiple session summaries.
 */

import type { MemoryEntry } from '../dream/memory-entries.js'
import type { SessionSummary } from './session-extractor.js'

// ── Types ────────────────────────────────────────────────────

export interface WorkSchedulePattern {
  readonly activeHours: ReadonlyArray<{ readonly hour: number; readonly sessionCount: number }>
  readonly activeDays: ReadonlyArray<{ readonly day: string; readonly sessionCount: number }>
  readonly avgSessionDuration: number | null
  readonly avgTokensPerSession: { readonly input: number; readonly output: number }
}

export interface ToolPreferences {
  readonly topTools: ReadonlyArray<{
    readonly tool: string
    readonly totalUses: number
    readonly avgDurationMs: number | null
  }>
  readonly mcpServers: ReadonlyArray<{ readonly server: string; readonly sessionCount: number }>
  readonly skills: ReadonlyArray<{ readonly skill: string; readonly sessionCount: number }>
}

export interface ModelPreferences {
  readonly models: ReadonlyArray<{
    readonly model: string
    readonly totalCalls: number
    readonly sessionCount: number
  }>
  readonly primaryModel: string | null
}

export interface ExtractedPatterns {
  readonly schedule: WorkSchedulePattern
  readonly tools: ToolPreferences
  readonly models: ModelPreferences
  readonly totalSessions: number
  readonly analyzedFrom: string
  readonly analyzedTo: string
  readonly extractedAt: string
}

// ── Day name mapping ─────────────────────────────────────────

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

// ── Schedule extraction ──────────────────────────────────────

function extractSchedule(summaries: ReadonlyArray<SessionSummary>): WorkSchedulePattern {
  if (summaries.length === 0) {
    return {
      activeHours: [],
      activeDays: [],
      avgSessionDuration: null,
      avgTokensPerSession: { input: 0, output: 0 },
    }
  }

  const hourCounts = new Map<number, number>()
  const dayCounts = new Map<string, number>()

  for (const s of summaries) {
    const date = new Date(s.startTime)
    const hour = date.getUTCHours()
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1)

    const day = DAY_NAMES[date.getUTCDay()]!
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1)
  }

  const activeHours = [...hourCounts.entries()]
    .map(([hour, sessionCount]) => ({ hour, sessionCount }))
    .sort((a, b) => b.sessionCount - a.sessionCount)

  const activeDays = [...dayCounts.entries()]
    .map(([day, sessionCount]) => ({ day, sessionCount }))
    .sort((a, b) => b.sessionCount - a.sessionCount)

  const durations = summaries.map((s) => s.durationMs).filter((d): d is number => d !== null)
  const avgSessionDuration =
    durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null

  const totalInput = summaries.reduce((acc, s) => acc + s.totalInputTokens, 0)
  const totalOutput = summaries.reduce((acc, s) => acc + s.totalOutputTokens, 0)

  return {
    activeHours,
    activeDays,
    avgSessionDuration,
    avgTokensPerSession: {
      input: Math.round(totalInput / summaries.length),
      output: Math.round(totalOutput / summaries.length),
    },
  }
}

// ── Tool preference extraction ───────────────────────────────

function extractToolPreferences(summaries: ReadonlyArray<SessionSummary>): ToolPreferences {
  const toolMap = new Map<
    string,
    { totalUses: number; totalDurationWeighted: number; durationUseCount: number }
  >()

  for (const s of summaries) {
    for (const t of s.tools) {
      const existing = toolMap.get(t.tool) ?? {
        totalUses: 0,
        totalDurationWeighted: 0,
        durationUseCount: 0,
      }
      existing.totalUses += t.callCount
      if (t.avgDurationMs !== null) {
        existing.totalDurationWeighted += t.avgDurationMs * t.callCount
        existing.durationUseCount += t.callCount
      }
      toolMap.set(t.tool, existing)
    }
  }

  const topTools = [...toolMap.entries()]
    .map(([tool, data]) => ({
      tool,
      totalUses: data.totalUses,
      avgDurationMs:
        data.durationUseCount > 0
          ? Math.round(data.totalDurationWeighted / data.durationUseCount)
          : null,
    }))
    .sort((a, b) => b.totalUses - a.totalUses)

  // MCP servers — count by session, not by individual use
  const mcpMap = new Map<string, number>()
  for (const s of summaries) {
    for (const server of s.mcpServers) {
      mcpMap.set(server, (mcpMap.get(server) ?? 0) + 1)
    }
  }
  const mcpServers = [...mcpMap.entries()]
    .map(([server, sessionCount]) => ({ server, sessionCount }))
    .sort((a, b) => b.sessionCount - a.sessionCount)

  // Skills — count by session
  const skillMap = new Map<string, number>()
  for (const s of summaries) {
    for (const skill of s.skills) {
      skillMap.set(skill, (skillMap.get(skill) ?? 0) + 1)
    }
  }
  const skills = [...skillMap.entries()]
    .map(([skill, sessionCount]) => ({ skill, sessionCount }))
    .sort((a, b) => b.sessionCount - a.sessionCount)

  return { topTools, mcpServers, skills }
}

// ── Model preference extraction ──────────────────────────────

function extractModelPreferences(summaries: ReadonlyArray<SessionSummary>): ModelPreferences {
  const modelMap = new Map<string, { totalCalls: number; sessions: Set<string> }>()

  for (const s of summaries) {
    for (const m of s.models) {
      const existing = modelMap.get(m.model) ?? {
        totalCalls: 0,
        sessions: new Set<string>(),
      }
      existing.totalCalls += m.callCount
      existing.sessions.add(s.sessionId)
      modelMap.set(m.model, existing)
    }
  }

  const models = [...modelMap.entries()]
    .map(([model, data]) => ({
      model,
      totalCalls: data.totalCalls,
      sessionCount: data.sessions.size,
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls)

  const primaryModel = models.length > 0 ? models[0]!.model : null

  return { models, primaryModel }
}

// ── Main extraction ──────────────────────────────────────────

/** Extract behavioral patterns from session summaries. */
export function extractPatterns(summaries: ReadonlyArray<SessionSummary>): ExtractedPatterns {
  const now = new Date().toISOString()

  if (summaries.length === 0) {
    return {
      schedule: extractSchedule([]),
      tools: extractToolPreferences([]),
      models: extractModelPreferences([]),
      totalSessions: 0,
      analyzedFrom: '',
      analyzedTo: '',
      extractedAt: now,
    }
  }

  const startTimes = summaries.map((s) => s.startTime).sort()

  return {
    schedule: extractSchedule(summaries),
    tools: extractToolPreferences(summaries),
    models: extractModelPreferences(summaries),
    totalSessions: summaries.length,
    analyzedFrom: startTimes[0]!,
    analyzedTo: startTimes[startTimes.length - 1]!,
    extractedAt: now,
  }
}

// ── Memory entry conversion ──────────────────────────────────

function formatDurationMinutes(ms: number | null): string {
  if (ms === null) return 'unknown'
  return `${Math.round(ms / 60_000)} minutes`
}

/** Convert extracted patterns into MemoryEntry objects for consolidation. */
export function patternsToMemoryEntries(patterns: ExtractedPatterns): ReadonlyArray<MemoryEntry> {
  const entries: MemoryEntry[] = []

  // Work schedule entry
  const topHours = patterns.schedule.activeHours.slice(0, 5)
  const topDays = patterns.schedule.activeDays.slice(0, 7)

  entries.push({
    type: 'project',
    name: 'work-schedule',
    description: 'Typical work schedule patterns extracted from session history',
    content: [
      `Based on ${patterns.totalSessions} sessions (${patterns.analyzedFrom} to ${patterns.analyzedTo}):`,
      '',
      topHours.length > 0
        ? `Most active hours (UTC): ${topHours.map((h) => `${h.hour}:00 (${h.sessionCount} sessions)`).join(', ')}`
        : 'No active hours data.',
      topDays.length > 0
        ? `Most active days: ${topDays.map((d) => `${d.day} (${d.sessionCount} sessions)`).join(', ')}`
        : 'No active days data.',
      `Average session duration: ${formatDurationMinutes(patterns.schedule.avgSessionDuration)}`,
      `Average tokens per session: ${patterns.schedule.avgTokensPerSession.input} input, ${patterns.schedule.avgTokensPerSession.output} output`,
    ].join('\n'),
    source: 'pattern-extractor',
  })

  // Tool preferences entry
  const topToolsList = patterns.tools.topTools.slice(0, 10)

  entries.push({
    type: 'project',
    name: 'tool-preferences',
    description: 'Preferred tools, MCP servers, and skills from session history',
    content: [
      topToolsList.length > 0
        ? `Top tools: ${topToolsList.map((t) => `${t.tool} (${t.totalUses} uses)`).join(', ')}`
        : 'No tool usage data.',
      patterns.tools.mcpServers.length > 0
        ? `MCP servers: ${patterns.tools.mcpServers.map((m) => `${m.server} (${m.sessionCount} sessions)`).join(', ')}`
        : 'No MCP server data.',
      patterns.tools.skills.length > 0
        ? `Skills: ${patterns.tools.skills.map((s) => `${s.skill} (${s.sessionCount} sessions)`).join(', ')}`
        : 'No skill data.',
    ].join('\n'),
    source: 'pattern-extractor',
  })

  // Model preferences entry
  entries.push({
    type: 'project',
    name: 'model-preferences',
    description: 'Preferred AI models from session history',
    content: [
      patterns.models.primaryModel !== null
        ? `Primary model: ${patterns.models.primaryModel}`
        : 'No primary model identified.',
      patterns.models.models.length > 0
        ? `All models: ${patterns.models.models.map((m) => `${m.model} (${m.totalCalls} calls across ${m.sessionCount} sessions)`).join(', ')}`
        : 'No model usage data.',
    ].join('\n'),
    source: 'pattern-extractor',
  })

  return entries
}
