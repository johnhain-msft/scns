/**
 * Cross-Source Correlator — detects patterns that span multiple observation sources.
 *
 * Pattern detection rules:
 * 1. Tool switching — alternating between sources in a session
 * 2. Session handoff — one source ends, another starts within 5 min
 * 3. Time-based usage — certain sources used at certain times of day
 */

import { randomUUID } from 'node:crypto'

/** An event from any observation source, normalized for cross-source analysis */
export interface CrossSourceEvent {
  readonly source: string
  readonly timestamp: string
  readonly eventType: string
  readonly sessionId?: string
  readonly tools?: readonly string[]
  readonly tags: readonly string[]
}

/** A pattern detected across multiple observation sources */
export interface CrossSourcePattern {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly sources: readonly string[]
  readonly frequency: number
  readonly confidence: number
  readonly events: readonly CrossSourceEvent[]
  readonly detectedAt: string
}

const HANDOFF_WINDOW_MS = 5 * 60 * 1000 // 5 minutes

/** Create a cross-source pattern correlator */
export function createCrossSourceCorrelator() {
  let events: CrossSourceEvent[] = []

  function addEvents(newEvents: readonly CrossSourceEvent[]): void {
    events = [...events, ...newEvents]
  }

  function getSourceCounts(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>()
    for (const event of events) {
      counts.set(event.source, (counts.get(event.source) ?? 0) + 1)
    }
    return counts
  }

  function reset(): void {
    events = []
  }

  function getUniqueSources(): readonly string[] {
    return [...new Set(events.map((e) => e.source))]
  }

  function detectPatterns(): readonly CrossSourcePattern[] {
    const sources = getUniqueSources()
    if (sources.length < 2) return []

    const sorted = [...events].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )

    const patterns: CrossSourcePattern[] = []
    const now = new Date().toISOString()

    // 1. Tool switching detection
    const toolSwitchPattern = detectToolSwitching(sorted, sources, now)
    if (toolSwitchPattern) patterns.push(toolSwitchPattern)

    // 2. Session handoff detection
    const handoffPatterns = detectSessionHandoffs(sorted, now)
    if (handoffPatterns) patterns.push(handoffPatterns)

    // 3. Time-based usage detection
    const timePattern = detectTimeBasedUsage(sorted, sources, now)
    if (timePattern) patterns.push(timePattern)

    return patterns
  }

  return { addEvents, detectPatterns, reset, getSourceCounts }
}

/** Detect alternating source usage (A → B → A) */
function detectToolSwitching(
  sorted: readonly CrossSourceEvent[],
  _sources: readonly string[],
  now: string,
): CrossSourcePattern | null {
  if (sorted.length < 3) return null

  let switchCount = 0
  const involvedEvents: CrossSourceEvent[] = []

  for (let i = 2; i < sorted.length; i++) {
    const prev2 = sorted[i - 2]!
    const prev1 = sorted[i - 1]!
    const curr = sorted[i]!

    // A → B → A pattern
    if (
      prev2.source !== prev1.source &&
      prev1.source !== curr.source &&
      prev2.source === curr.source
    ) {
      switchCount++
      involvedEvents.push(prev2, prev1, curr)
    }
  }

  if (switchCount === 0) return null

  const involvedSources = [...new Set(involvedEvents.map((e) => e.source))]
  const confidence = Math.min(switchCount / Math.max(sorted.length - 2, 1), 1)

  return {
    id: randomUUID(),
    name: 'tool-switching',
    description: `Detected ${switchCount} tool-switching sequence(s) across ${involvedSources.join(', ')}`,
    sources: involvedSources,
    frequency: switchCount,
    confidence,
    events: [...new Set(involvedEvents)],
    detectedAt: now,
  }
}

/** Detect session handoffs: session-end from one source followed by session-start from another within 5 min */
function detectSessionHandoffs(
  sorted: readonly CrossSourceEvent[],
  now: string,
): CrossSourcePattern | null {
  const endEvents = sorted.filter((e) => e.eventType === 'session-end')
  const startEvents = sorted.filter((e) => e.eventType === 'session-start')

  let handoffCount = 0
  const handoffEvents: CrossSourceEvent[] = []
  const handoffSources = new Set<string>()

  for (const end of endEvents) {
    const endTime = new Date(end.timestamp).getTime()

    for (const start of startEvents) {
      if (start.source === end.source) continue
      const startTime = new Date(start.timestamp).getTime()
      const gap = startTime - endTime

      if (gap >= 0 && gap <= HANDOFF_WINDOW_MS) {
        handoffCount++
        handoffEvents.push(end, start)
        handoffSources.add(end.source)
        handoffSources.add(start.source)
      }
    }
  }

  if (handoffCount === 0) return null

  return {
    id: randomUUID(),
    name: 'session-handoff',
    description: `Detected ${handoffCount} session handoff(s) between ${[...handoffSources].join(' and ')}`,
    sources: [...handoffSources],
    frequency: handoffCount,
    confidence: Math.min(handoffCount * 0.3, 1),
    events: handoffEvents,
    detectedAt: now,
  }
}

/** Detect time-of-day usage patterns per source */
function detectTimeBasedUsage(
  sorted: readonly CrossSourceEvent[],
  _sources: readonly string[],
  now: string,
): CrossSourcePattern | null {
  // Group events by source → array of hours
  const sourceHours = new Map<string, number[]>()
  for (const event of sorted) {
    const hour = new Date(event.timestamp).getUTCHours()
    const hours = sourceHours.get(event.source) ?? []
    hours.push(hour)
    sourceHours.set(event.source, hours)
  }

  // Check if sources have distinct time preferences
  // A source has a "time preference" if its events cluster in a time band
  const sourceAverages = new Map<string, number>()
  for (const [source, hours] of sourceHours) {
    if (hours.length < 2) continue
    const avg = hours.reduce((sum, h) => sum + h, 0) / hours.length
    sourceAverages.set(source, avg)
  }

  if (sourceAverages.size < 2) return null

  // Check if there's meaningful separation between source averages
  const averages = [...sourceAverages.values()]
  const maxDiff = Math.max(...averages) - Math.min(...averages)

  // Need at least 4 hours of separation to be a meaningful pattern
  if (maxDiff < 4) return null

  const descriptions: string[] = []
  for (const [source, avg] of sourceAverages) {
    const period = avg < 12 ? 'morning' : avg < 17 ? 'afternoon' : 'evening'
    descriptions.push(`${source}=${period}`)
  }

  const confidence = Math.min(maxDiff / 12, 1)

  return {
    id: randomUUID(),
    name: 'time-based-usage',
    description: `Time-of-day usage pattern: ${descriptions.join(', ')}`,
    sources: [...sourceAverages.keys()],
    frequency: sorted.length,
    confidence,
    events: sorted,
    detectedAt: now,
  }
}
