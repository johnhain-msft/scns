import type { SuggestionCandidate, PatternSources } from './types.js'

const MIN_TOOL_USES = 5

interface ToolComboPattern {
  readonly name: string
  readonly tools: readonly string[]
  readonly extensionName: string
  readonly tag: string
  readonly description: string
}

const TOOL_COMBOS: readonly ToolComboPattern[] = [
  {
    name: 'code-search',
    tools: ['grep', 'view'],
    extensionName: 'code-search',
    tag: 'code-search',
    description:
      'A code-search extension could combine grep and view into a single semantic search tool.',
  },
  {
    name: 'file-management',
    tools: ['edit', 'create'],
    extensionName: 'file-management',
    tag: 'file-management',
    description:
      'A file-management extension could streamline edit and create operations with templates and scaffolding.',
  },
  {
    name: 'task-runner',
    tools: ['bash'],
    extensionName: 'task-runner',
    tag: 'task-runner',
    description:
      'A task-runner extension could wrap common bash commands into reusable, documented tasks.',
  },
]

export function extractExtensionSuggestions(
  sources: PatternSources,
): readonly SuggestionCandidate[] {
  const { otel } = sources
  if (!otel) {
    return []
  }

  const toolUsage = new Map<string, number>()
  for (const t of otel.topTools) {
    toolUsage.set(t.tool, (toolUsage.get(t.tool) ?? 0) + t.totalUses)
  }

  const candidates: SuggestionCandidate[] = []
  const now = new Date().toISOString()
  const emittedExtensions = new Set<string>()

  for (const combo of TOOL_COMBOS) {
    if (emittedExtensions.has(combo.name)) continue

    const matchingTools = combo.tools.filter((tool) => {
      const uses = toolUsage.get(tool) ?? 0
      return uses >= MIN_TOOL_USES
    })

    if (matchingTools.length < combo.tools.length) continue

    const totalUses = matchingTools.reduce((sum, tool) => sum + (toolUsage.get(tool) ?? 0), 0)

    candidates.push({
      type: 'extension',
      title: `Create ${combo.extensionName} extension`,
      description: `${combo.description} You've used these tools ${totalUses} times across ${otel.totalSessions} sessions.`,
      evidence: matchingTools.map((tool) => ({
        source: 'otel-tools',
        detail: `${tool}: ${toolUsage.get(tool)} uses`,
        observedAt: now,
        weight: Math.min(1, (toolUsage.get(tool) ?? 0) / (otel.totalSessions * 5)),
      })),
      tags: ['extension', combo.tag],
      observationCount: totalUses,
      windowDays: otel.analyzedDays,
    })

    emittedExtensions.add(combo.name)
  }

  return candidates
}
