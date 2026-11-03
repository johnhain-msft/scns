import type { SuggestionCandidate, PatternSources } from './types.js'

const MIN_SESSIONS = 5
const MODEL_DOMINANCE_RATIO = 0.5
const MIN_TOOL_USES_PER_SESSION = 2
const MIN_MCP_SESSION_RATIO = 0.5

export function extractInstructionSuggestions(
  sources: PatternSources,
): readonly SuggestionCandidate[] {
  const { otel } = sources
  if (!otel || otel.totalSessions < MIN_SESSIONS) {
    return []
  }

  const candidates: SuggestionCandidate[] = []
  const now = new Date().toISOString()

  // Check for consistent model preference
  for (const model of otel.models) {
    const ratio = model.sessionCount / otel.totalSessions
    if (ratio >= MODEL_DOMINANCE_RATIO) {
      candidates.push({
        type: 'instruction',
        title: `Add default model preference for ${model.model}`,
        description:
          `You use ${model.model} in ${Math.round(ratio * 100)}% of sessions. ` +
          `Adding a model preference to your instruction file would ensure ` +
          `consistent model selection without manual specification.`,
        evidence: [
          {
            source: 'otel-model',
            detail: `${model.model}: ${model.sessionCount}/${otel.totalSessions} sessions, ${model.totalCalls} total calls`,
            observedAt: now,
            weight: ratio,
          },
        ],
        tags: ['instruction', 'model-preference'],
        observationCount: model.totalCalls,
        windowDays: otel.analyzedDays,
      })
      break // Only suggest the top model
    }
  }

  // Check for consistent tool preferences
  const consistentTools = otel.topTools.filter(
    (t) => t.totalUses / otel.totalSessions >= MIN_TOOL_USES_PER_SESSION,
  )
  if (consistentTools.length >= 2) {
    const toolNames = consistentTools.map((t) => t.tool).join(', ')
    const totalUses = consistentTools.reduce((sum, t) => sum + t.totalUses, 0)

    candidates.push({
      type: 'instruction',
      title: `Add preferred tools instruction (${toolNames})`,
      description:
        `You consistently use ${toolNames} across ${otel.totalSessions} sessions ` +
        `(${totalUses} total uses). Adding tool preferences to your instruction ` +
        `file would guide the AI to prioritize these tools.`,
      evidence: consistentTools.map((t) => ({
        source: 'otel-tools',
        detail: `${t.tool}: ${t.totalUses} uses across ${otel.totalSessions} sessions`,
        observedAt: now,
        weight: Math.min(1, t.totalUses / (otel.totalSessions * 5)),
      })),
      tags: ['instruction', 'tool-preference'],
      observationCount: totalUses,
      windowDays: otel.analyzedDays,
    })
  }

  // Check for consistent MCP server usage
  const consistentServers = otel.mcpServers.filter(
    (s) => s.sessionCount / otel.totalSessions >= MIN_MCP_SESSION_RATIO,
  )
  if (consistentServers.length > 0) {
    const serverNames = consistentServers.map((s) => s.server).join(', ')
    const totalSessions = consistentServers.reduce((sum, s) => sum + s.sessionCount, 0)

    candidates.push({
      type: 'instruction',
      title: `Add MCP server preferences (${serverNames})`,
      description:
        `You use ${serverNames} in most sessions. Adding MCP server preferences ` +
        `to your instruction file would ensure these servers are always available.`,
      evidence: consistentServers.map((s) => ({
        source: 'otel-mcp',
        detail: `${s.server}: used in ${s.sessionCount}/${otel.totalSessions} sessions`,
        observedAt: now,
        weight: s.sessionCount / otel.totalSessions,
      })),
      tags: ['instruction', 'mcp-preference'],
      observationCount: totalSessions,
      windowDays: otel.analyzedDays,
    })
  }

  return candidates
}
