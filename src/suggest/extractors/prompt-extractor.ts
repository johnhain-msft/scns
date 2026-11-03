import type { SuggestionCandidate, PatternSources } from './types.js'

const MIN_SESSIONS = 3
const MODEL_DOMINANCE_RATIO = 0.6
const MIN_TOOL_USES_PER_SESSION = 3

export function extractPromptSuggestions(sources: PatternSources): readonly SuggestionCandidate[] {
  const { otel } = sources
  if (!otel || otel.totalSessions < MIN_SESSIONS) {
    return []
  }

  const candidates: SuggestionCandidate[] = []
  const now = new Date().toISOString()

  // Check for dominant model usage → suggest system prompt optimization
  for (const model of otel.models) {
    const ratio = model.sessionCount / otel.totalSessions
    if (ratio >= MODEL_DOMINANCE_RATIO) {
      candidates.push({
        type: 'prompt',
        title: `Optimize system prompt for ${model.model}`,
        description:
          `You use ${model.model} in ${model.sessionCount}/${otel.totalSessions} sessions ` +
          `(${Math.round(ratio * 100)}%). A tailored system prompt could improve response ` +
          `quality and reduce token usage for your primary model.`,
        evidence: [
          {
            source: 'otel-model',
            detail: `${model.model} used in ${model.sessionCount}/${otel.totalSessions} sessions with ${model.totalCalls} total calls`,
            observedAt: now,
            weight: ratio,
          },
        ],
        tags: ['prompt', 'model', model.model],
        observationCount: model.totalCalls,
        windowDays: otel.analyzedDays,
      })
    }
  }

  // Check for consistent tool patterns → suggest instruction file entries
  const highUsageTools = otel.topTools.filter(
    (t) => t.totalUses / otel.totalSessions >= MIN_TOOL_USES_PER_SESSION,
  )
  if (highUsageTools.length >= 2) {
    const toolNames = highUsageTools.map((t) => t.tool).join(', ')
    const totalUses = highUsageTools.reduce((sum, t) => sum + t.totalUses, 0)
    candidates.push({
      type: 'prompt',
      title: `Add instruction file entries for preferred tools`,
      description:
        `You consistently use ${toolNames} across sessions (avg ${Math.round(totalUses / otel.totalSessions)} ` +
        `uses/session). Adding these to your instruction file would help the AI ` +
        `prioritize these tools automatically.`,
      evidence: highUsageTools.map((t) => ({
        source: 'otel-tools',
        detail: `${t.tool}: ${t.totalUses} total uses across ${otel.totalSessions} sessions`,
        observedAt: now,
        weight: Math.min(1, t.totalUses / (otel.totalSessions * 5)),
      })),
      tags: ['prompt', 'tools', 'instruction-file'],
      observationCount: totalUses,
      windowDays: otel.analyzedDays,
    })
  }

  return candidates
}
