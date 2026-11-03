import type { SuggestionCandidate, PatternSources } from './types.js'

const MIN_SESSIONS_TOOL_COMBO = 3
const MIN_TOOL_AVG_USES = 3
const MIN_SKILL_SESSIONS = 3

export function extractAgenticWorkflowSuggestions(
  sources: PatternSources,
): readonly SuggestionCandidate[] {
  const { otel } = sources
  if (!otel || otel.totalSessions < MIN_SESSIONS_TOOL_COMBO) {
    return []
  }

  const candidates: SuggestionCandidate[] = []
  const now = new Date().toISOString()

  // Detect repeated tool combinations across sessions
  const frequentTools = otel.topTools.filter(
    (t) => t.totalUses / otel.totalSessions >= MIN_TOOL_AVG_USES,
  )

  if (frequentTools.length >= 2) {
    const toolNames = frequentTools.map((t) => t.tool).join(' → ')
    const totalUses = frequentTools.reduce((sum, t) => sum + t.totalUses, 0)

    candidates.push({
      type: 'agentic-workflow',
      title: `Automate ${toolNames} workflow`,
      description:
        `You frequently use ${toolNames} together across ${otel.totalSessions} sessions ` +
        `(${totalUses} total uses). An agentic workflow could chain these tools ` +
        `automatically with context-aware orchestration.`,
      evidence: frequentTools.map((t) => ({
        source: 'otel-tools',
        detail: `${t.tool}: ${t.totalUses} uses across ${otel.totalSessions} sessions (avg ${(t.totalUses / otel.totalSessions).toFixed(1)}/session)`,
        observedAt: now,
        weight: Math.min(1, t.totalUses / (otel.totalSessions * 5)),
      })),
      tags: ['agentic-workflow', 'tool-combo'],
      observationCount: totalUses,
      windowDays: otel.analyzedDays,
    })
  }

  // Detect repetitive skill usage
  for (const skill of otel.skills) {
    if (skill.sessionCount < MIN_SKILL_SESSIONS) continue

    const ratio = skill.sessionCount / otel.totalSessions

    candidates.push({
      type: 'agentic-workflow',
      title: `Automate ${skill.skill} skill workflow`,
      description:
        `You invoke the ${skill.skill} skill in ${skill.sessionCount}/${otel.totalSessions} sessions ` +
        `(${Math.round(ratio * 100)}%). An automated workflow could trigger this ` +
        `skill proactively based on context signals.`,
      evidence: [
        {
          source: 'otel-skills',
          detail: `${skill.skill} used in ${skill.sessionCount}/${otel.totalSessions} sessions`,
          observedAt: now,
          weight: ratio,
        },
      ],
      tags: ['agentic-workflow', 'skill-automation'],
      observationCount: skill.sessionCount,
      windowDays: otel.analyzedDays,
    })
  }

  return candidates
}
