/**
 * Memory exporter — export SCNS suggestions and patterns as structured data
 * for consumption by other tools.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Suggestion } from './types.js'
import type { ExtractedPatterns } from '../otel/pattern-extractor.js'

export interface ExportOptions {
  readonly outputDir: string
  readonly format: 'json' | 'markdown'
  readonly maxEntries?: number
}

export interface ExportResult {
  readonly path: string
  readonly entriesExported: number
  readonly exportedAt: string
}

export interface SuggestionFilter {
  readonly type?: string
  readonly status?: string
  readonly tags?: readonly string[]
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function timestamp(): string {
  return new Date().toISOString()
}

function filterSuggestions(
  suggestions: readonly Suggestion[],
  filter?: SuggestionFilter,
): readonly Suggestion[] {
  if (!filter) return suggestions

  return suggestions.filter((s) => {
    if (filter.type && s.type !== filter.type) return false
    if (filter.status && s.status !== filter.status) return false
    if (filter.tags && filter.tags.length > 0) {
      const hasTags = filter.tags.some((t) => s.tags.includes(t))
      if (!hasTags) return false
    }
    return true
  })
}

function suggestionsToMarkdown(suggestions: readonly Suggestion[]): string {
  const lines = [
    '# Suggestions Export',
    '',
    `Exported at: ${timestamp()}`,
    '',
    `Total: ${suggestions.length}`,
    '',
  ]

  for (const s of suggestions) {
    lines.push(`## ${s.title}`, '')
    lines.push(`- **Type**: ${s.type}`)
    lines.push(`- **Status**: ${s.status}`)
    lines.push(`- **Confidence**: ${Math.round(s.confidence * 100)}%`)
    lines.push(`- **Tags**: ${s.tags.join(', ') || 'none'}`)
    lines.push('')
    lines.push(s.description)
    lines.push('')

    if (s.evidence.length > 0) {
      lines.push('### Evidence', '')
      for (const e of s.evidence) {
        lines.push(`- **${e.source}**: ${e.detail} (weight: ${e.weight})`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

function patternsToMarkdown(patterns: ExtractedPatterns): string {
  const lines = [
    '# Patterns Export',
    '',
    `Exported at: ${timestamp()}`,
    '',
    `- **Total sessions**: ${patterns.totalSessions}`,
    `- **Analyzed from**: ${patterns.analyzedFrom}`,
    `- **Analyzed to**: ${patterns.analyzedTo}`,
    '',
    '## Schedule',
    '',
  ]

  if (patterns.schedule.activeHours.length > 0) {
    const hours = patterns.schedule.activeHours
      .map((h) => `${h.hour}h (${h.sessionCount})`)
      .join(', ')
    lines.push(`- **Active hours**: ${hours}`)
  }

  if (patterns.schedule.activeDays.length > 0) {
    const days = patterns.schedule.activeDays.map((d) => `${d.day} (${d.sessionCount})`).join(', ')
    lines.push(`- **Active days**: ${days}`)
  }

  if (patterns.schedule.avgSessionDuration !== null) {
    lines.push(`- **Avg session duration**: ${patterns.schedule.avgSessionDuration}ms`)
  }

  lines.push('', '## Tools', '')

  for (const tool of patterns.tools.topTools) {
    lines.push(`- **${tool.tool}**: ${tool.totalUses} uses`)
  }

  lines.push('', '## Models', '')

  if (patterns.models.primaryModel) {
    lines.push(`- **Primary model**: ${patterns.models.primaryModel}`)
  }

  for (const m of patterns.models.models) {
    lines.push(`- **${m.model}**: ${m.totalCalls} calls across ${m.sessionCount} sessions`)
  }

  return lines.join('\n')
}

/** Create a memory exporter for suggestions and patterns */
export function createMemoryExporter(options: ExportOptions) {
  const { outputDir, format, maxEntries } = options

  function exportSuggestions(
    suggestions: readonly Suggestion[],
    filter?: SuggestionFilter,
  ): ExportResult {
    ensureDir(outputDir)

    let filtered = filterSuggestions(suggestions, filter)
    if (maxEntries !== undefined && filtered.length > maxEntries) {
      filtered = filtered.slice(0, maxEntries)
    }

    const exportedAt = timestamp()
    const ext = format === 'json' ? 'json' : 'md'
    const filePath = join(outputDir, `suggestions-export.${ext}`)

    if (format === 'json') {
      const data = filtered.map((s) => ({
        id: s.id,
        type: s.type,
        title: s.title,
        description: s.description,
        status: s.status,
        confidence: s.confidence,
        evidence: s.evidence,
        tags: s.tags,
        createdAt: s.createdAt,
      }))
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
    } else {
      writeFileSync(filePath, suggestionsToMarkdown(filtered), 'utf-8')
    }

    return {
      path: filePath,
      entriesExported: filtered.length,
      exportedAt,
    }
  }

  function exportPatterns(patterns: ExtractedPatterns): ExportResult {
    ensureDir(outputDir)

    const exportedAt = timestamp()
    const ext = format === 'json' ? 'json' : 'md'
    const filePath = join(outputDir, `patterns-export.${ext}`)

    if (format === 'json') {
      writeFileSync(filePath, JSON.stringify(patterns, null, 2), 'utf-8')
    } else {
      writeFileSync(filePath, patternsToMarkdown(patterns), 'utf-8')
    }

    return {
      path: filePath,
      entriesExported: 1,
      exportedAt,
    }
  }

  return { exportSuggestions, exportPatterns }
}
