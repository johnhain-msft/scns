// Evidence gathering from detected observation patterns

import type {
  DetectedPatterns,
  ToolFrequencyPattern,
  WorkSchedulePattern,
  ProjectFocusPattern,
} from '../observe/pattern-detector.js'
import type { Evidence } from './types.js'

// ── Public interfaces ────────────────────────────────────────────────

export interface EvidenceGathererOptions {
  readonly maxEvidencePerSuggestion?: number
}

export interface OtelPatterns {
  readonly topTools?: ReadonlyArray<{ tool: string; totalUses: number }>
  readonly mcpServers?: ReadonlyArray<{ server: string; sessionCount: number }>
  readonly skills?: ReadonlyArray<{ skill: string; sessionCount: number }>
  readonly models?: ReadonlyArray<{ model: string; totalCalls: number }>
  readonly sessionCount?: number
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_MAX_EVIDENCE = 5

const TYPE_TO_SOURCES: Record<string, readonly string[]> = {
  skill: ['toolFrequency'],
  agent: ['toolFrequency', 'projectFocus'],
  mcp: ['toolFrequency'],
  automation: ['projectFocus', 'workSchedule'],
  workflow: ['workSchedule'],
  prompt: ['otelPatterns'],
  extension: ['toolFrequency', 'otelPatterns'],
  lsp: ['projectFocus'],
  'github-action': ['projectFocus', 'workSchedule'],
  'agentic-workflow': ['toolFrequency', 'otelPatterns'],
  instruction: ['otelPatterns'],
}

// ── Helpers ──────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString()
}

function averageBreak(gaps: readonly number[]): number {
  if (gaps.length === 0) return 0
  return Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
}

// ── Factory ──────────────────────────────────────────────────────────

export function createEvidenceGatherer(options?: EvidenceGathererOptions) {
  const maxEvidence = options?.maxEvidencePerSuggestion ?? DEFAULT_MAX_EVIDENCE

  function gatherToolEvidence(toolFrequency: ToolFrequencyPattern): readonly Evidence[] {
    const maxCount = Math.max(...[...toolFrequency.appCounts.values()], 1)
    const evidence: Evidence[] = []

    for (const app of toolFrequency.topApps) {
      const count = toolFrequency.appCounts.get(app) ?? 0
      if (count <= 0) continue
      evidence.push({
        source: 'tool-frequency',
        detail: `Tool '${app}' used ${count} times`,
        observedAt: now(),
        weight: count / maxCount,
      })
      if (evidence.length >= maxEvidence) break
    }

    return evidence
  }

  function gatherScheduleEvidence(workSchedule: WorkSchedulePattern): readonly Evidence[] {
    const evidence: Evidence[] = []
    const ts = now()
    const weight = 0.6

    evidence.push({
      source: 'work-schedule',
      detail: `Most active at ${workSchedule.peakHour}:00`,
      observedAt: ts,
      weight,
    })

    evidence.push({
      source: 'work-schedule',
      detail: `Average session ${workSchedule.averageSessionMinutes} minutes`,
      observedAt: ts,
      weight,
    })

    if (workSchedule.breakGaps.length > 0) {
      const avg = averageBreak(workSchedule.breakGaps)
      evidence.push({
        source: 'work-schedule',
        detail: `Typical breaks of ${avg} minutes`,
        observedAt: ts,
        weight,
      })
    }

    return evidence.slice(0, maxEvidence)
  }

  function gatherProjectEvidence(projectFocus: ProjectFocusPattern): readonly Evidence[] {
    const evidence: Evidence[] = []
    const ts = now()
    const maxCount = Math.max(...[...projectFocus.repoCounts.values()], 1)

    for (const repo of projectFocus.topRepos) {
      const count = projectFocus.repoCounts.get(repo) ?? 0
      evidence.push({
        source: 'project-focus',
        detail: `Repo '${repo}' had ${count} commits`,
        observedAt: ts,
        weight: count / maxCount,
      })
      if (evidence.length >= maxEvidence) break
    }

    if (projectFocus.recentFocus != null) {
      evidence.push({
        source: 'project-focus',
        detail: `Currently focused on ${projectFocus.recentFocus}`,
        observedAt: ts,
        weight: 0.8,
      })
    }

    // Top file type
    const topFileType = [...projectFocus.fileTypeCounts.entries()].sort((a, b) => b[1] - a[1])[0]
    if (topFileType) {
      evidence.push({
        source: 'project-focus',
        detail: `Most changed file type: ${topFileType[0]}`,
        observedAt: ts,
        weight: 0.5,
      })
    }

    return evidence.slice(0, maxEvidence)
  }

  function gatherOtelEvidence(otelPatterns: OtelPatterns): readonly Evidence[] {
    const evidence: Evidence[] = []
    const ts = now()

    if (otelPatterns.topTools) {
      const maxUses = Math.max(...otelPatterns.topTools.map((t) => t.totalUses), 1)
      for (const entry of otelPatterns.topTools) {
        if (evidence.length >= maxEvidence) break
        evidence.push({
          source: 'otel-patterns',
          detail: `Tool '${entry.tool}' used ${entry.totalUses} times`,
          observedAt: ts,
          weight: entry.totalUses / maxUses,
        })
      }
    }

    if (otelPatterns.mcpServers) {
      for (const entry of otelPatterns.mcpServers) {
        if (evidence.length >= maxEvidence) break
        evidence.push({
          source: 'otel-patterns',
          detail: `MCP server '${entry.server}' in ${entry.sessionCount} sessions`,
          observedAt: ts,
          weight: 0.7,
        })
      }
    }

    if (otelPatterns.skills) {
      for (const entry of otelPatterns.skills) {
        if (evidence.length >= maxEvidence) break
        evidence.push({
          source: 'otel-patterns',
          detail: `Skill '${entry.skill}' used in ${entry.sessionCount} sessions`,
          observedAt: ts,
          weight: 0.6,
        })
      }
    }

    if (otelPatterns.models) {
      for (const entry of otelPatterns.models) {
        if (evidence.length >= maxEvidence) break
        evidence.push({
          source: 'otel-patterns',
          detail: `Model '${entry.model}' called ${entry.totalCalls} times`,
          observedAt: ts,
          weight: 0.5,
        })
      }
    }

    return evidence.slice(0, maxEvidence)
  }

  function gatherFromPatterns(
    patterns: DetectedPatterns,
    type: string,
    otelPatterns?: OtelPatterns,
  ): readonly Evidence[] {
    const sources = TYPE_TO_SOURCES[type] ?? []
    const evidence: Evidence[] = []

    for (const source of sources) {
      if (source === 'toolFrequency' && patterns.toolFrequency != null) {
        evidence.push(...gatherToolEvidence(patterns.toolFrequency))
      }
      if (source === 'projectFocus' && patterns.projectFocus != null) {
        evidence.push(...gatherProjectEvidence(patterns.projectFocus))
      }
      if (source === 'workSchedule' && patterns.workSchedule != null) {
        evidence.push(...gatherScheduleEvidence(patterns.workSchedule))
      }
      if (source === 'otelPatterns' && otelPatterns != null) {
        evidence.push(...gatherOtelEvidence(otelPatterns))
      }
    }

    return evidence.slice(0, maxEvidence)
  }

  function formatEvidence(evidence: readonly Evidence[]): string {
    if (evidence.length === 0) return ''
    return evidence
      .map((e) => `- **${e.source}**: ${e.detail} (weight: ${e.weight}, observed: ${e.observedAt})`)
      .join('\n')
  }

  return {
    gatherFromPatterns,
    gatherToolEvidence,
    gatherScheduleEvidence,
    gatherProjectEvidence,
    gatherOtelEvidence,
    formatEvidence,
  }
}
