/**
 * Cross-Tool Digest — generates human-readable session digests
 * that summarize activity across multiple observation sources.
 */

import {
  createCrossSourceCorrelator,
  type CrossSourceEvent,
  type CrossSourcePattern,
} from './correlator.js'

/** A cross-tool activity digest for a time period */
export interface CrossToolDigest {
  readonly period: { readonly start: string; readonly end: string }
  readonly sources: readonly string[]
  readonly totalEvents: number
  readonly patterns: readonly CrossSourcePattern[]
  readonly summary: string
  readonly generatedAt: string
}

/** Generate a cross-tool digest for a set of events within a period */
export function generateCrossToolDigest(
  events: readonly CrossSourceEvent[],
  period: { readonly start: string; readonly end: string },
): CrossToolDigest {
  const correlator = createCrossSourceCorrelator()
  correlator.addEvents(events)

  const patterns = correlator.detectPatterns()
  const sourceCounts = correlator.getSourceCounts()
  const sources = [...sourceCounts.keys()].sort()

  const summary = buildSummary(events.length, sources, sourceCounts, patterns, period)

  return {
    period,
    sources,
    totalEvents: events.length,
    patterns,
    summary,
    generatedAt: new Date().toISOString(),
  }
}

/** Build a human-readable markdown summary */
function buildSummary(
  totalEvents: number,
  sources: readonly string[],
  sourceCounts: ReadonlyMap<string, number>,
  patterns: readonly CrossSourcePattern[],
  period: { readonly start: string; readonly end: string },
): string {
  const lines: string[] = []

  lines.push('# Cross-Tool Activity Digest')
  lines.push('')
  lines.push(`**Period:** ${period.start} — ${period.end}`)
  lines.push('')

  if (totalEvents === 0) {
    lines.push('No activity recorded during this period.')
    return lines.join('\n')
  }

  lines.push(`## Activity Summary`)
  lines.push('')
  lines.push(`**Total events:** ${totalEvents}`)
  lines.push(`**Sources:** ${sources.join(', ')}`)
  lines.push('')

  // Per-source breakdown
  lines.push('| Source | Events |')
  lines.push('|--------|--------|')
  for (const source of sources) {
    lines.push(`| ${source} | ${sourceCounts.get(source) ?? 0} |`)
  }
  lines.push('')

  // Patterns section
  if (patterns.length > 0) {
    lines.push('## Detected Patterns')
    lines.push('')
    for (const pattern of patterns) {
      lines.push(`### ${pattern.name}`)
      lines.push('')
      lines.push(pattern.description)
      lines.push('')
      lines.push(`- **Confidence:** ${(pattern.confidence * 100).toFixed(0)}%`)
      lines.push(`- **Frequency:** ${pattern.frequency}`)
      lines.push(`- **Sources:** ${pattern.sources.join(', ')}`)
      lines.push('')
    }
  } else if (sources.length > 1) {
    lines.push('## Patterns')
    lines.push('')
    lines.push('No cross-source patterns detected in this period.')
    lines.push('')
  }

  return lines.join('\n')
}
