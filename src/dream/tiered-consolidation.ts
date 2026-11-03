/**
 * Tiered consolidation — weekly and monthly rollups of daily logs.
 *
 * Weekly: Reads 7 daily logs → deduplicates → extracts lessons → produces weekly/YYYY-WNN.md
 * Monthly: Reads weekly summaries → identifies stable patterns → produces monthly/YYYY-MM.md
 *
 * Both promote high-value entries to long-term memory and archive low-value ones.
 */

import type { Vault } from '../memory/vault.js'
import type { ArchivedEntry } from '../memory/archive-store.js'
import { classifyPromptAuthorship } from '../memory/prompt-authorship.js'

// ── Types ──────────────────────────────────────────────────────────

export interface WeeklyConsolidationInput {
  readonly vault: Vault
  readonly archiveStore: { archive: (entry: ArchivedEntry) => void }
  readonly weekId: string
  readonly dailyLogDates: ReadonlyArray<string>
}

export interface WeeklyConsolidationResult {
  readonly success: boolean
  readonly weekId: string
  readonly dailyLogsProcessed: number
  readonly lessonsExtracted: number
  readonly duplicatesRemoved: number
  readonly archivedCount: number
  readonly error?: string
}

export interface MonthlyConsolidationInput {
  readonly vault: Vault
  readonly archiveStore: { archive: (entry: ArchivedEntry) => void }
  readonly monthId: string
  readonly weeklyIds: ReadonlyArray<string>
}

export interface MonthlyConsolidationResult {
  readonly success: boolean
  readonly monthId: string
  readonly weeklyLogsProcessed: number
  readonly stablePatternsFound: number
  readonly archivedWeeklies: number
  readonly error?: string
}

// ── Lesson extraction helpers ──────────────────────────────────────

interface ExtractedLesson {
  readonly text: string
  readonly normalized: string
  readonly occurrences: number
  readonly sources: string[]
  readonly isHighConfidence: boolean
  readonly isLowValue: boolean
}

const LOW_VALUE_PATTERNS = [
  /^session debug:/i,
  /^debug:/i,
  /^trace:/i,
  /^noise:/i,
  /^\s*$/,
  /^tags:/i,
  /^\*\*\[active-app\]\*\*$/,
  /^\*\*\[session-hook\]\*\*\s*(tool used|session .+ (started|ended))/i,
]

function isLowValue(text: string): boolean {
  return LOW_VALUE_PATTERNS.some((p) => p.test(text))
}

function normalizeLesson(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract lessons from daily log content.
 * Handles both bullet-point format AND observation log format:
 * - `- lesson text` → direct extraction
 * - `**[session-hook]** User prompt: text` → user intent/feedback extraction
 * - `**[session-hook]** Tool used: name` → tool usage pattern (aggregated)
 * - `**[active-app]** appname` → app usage pattern (aggregated)
 */
function extractLessonsFromDailyContent(content: string, date: string): ExtractedLesson[] {
  const lines = content.split('\n')
  const lessons: ExtractedLesson[] = []
  const toolCounts = new Map<string, number>()
  const appCounts = new Map<string, number>()

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('Tags:')) continue

    // Bullet-point lessons (e.g., from memory files)
    const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed)
    if (bulletMatch) {
      const text = bulletMatch[1]!
      if (!isLowValue(text)) {
        lessons.push({
          text,
          normalized: normalizeLesson(text),
          occurrences: 1,
          sources: [date],
          isHighConfidence: false,
          isLowValue: false,
        })
      }
      continue
    }

    // User prompts — extract user intent/feedback
    const promptMatch = /\*\*\[session-hook\]\*\*\s*User prompt:\s*(.+)/i.exec(trimmed)
    if (promptMatch) {
      const prompt = promptMatch[1]!.trim()
      // Same authorship gate as extractFromLog: the daily log records sub-agent dispatch briefs in
      // the same slot as the human's own prompts, and without this they become "User request: You
      // are slidesmith…" lessons — repeated briefs get promoted to High-Confidence Lessons and
      // monthly Stable Patterns, all indexed for retrieval.
      // Only extract meaningful prompts (skip very short ones)
      if (prompt.length > 20 && classifyPromptAuthorship(prompt).author !== 'machine') {
        // Extract the core request/lesson (first 120 chars)
        const text = `User request: ${prompt.slice(0, 120)}`
        lessons.push({
          text,
          normalized: normalizeLesson(prompt.slice(0, 80)),
          occurrences: 1,
          sources: [date],
          isHighConfidence: false,
          isLowValue: false,
        })
      }
      continue
    }

    // Tool usage — aggregate
    const toolMatch = /\*\*\[session-hook\]\*\*\s*Tool used:\s*(\S+)/i.exec(trimmed)
    if (toolMatch) {
      const tool = toolMatch[1]!
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1)
      continue
    }

    // Active app — aggregate
    const appMatch = /\*\*\[active-app\]\*\*\s*(.+)/i.exec(trimmed)
    if (appMatch && !appMatch[1]!.startsWith('Tags:')) {
      const app = appMatch[1]!.trim()
      if (app) appCounts.set(app, (appCounts.get(app) ?? 0) + 1)
    }
  }

  // Synthesize tool usage patterns (top tools)
  const sortedTools = Array.from(toolCounts.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)

  if (sortedTools.length > 0) {
    const toolSummary = sortedTools.map(([name, count]) => `${name}(${count})`).join(', ')
    lessons.push({
      text: `Tool usage pattern: ${toolSummary}`,
      normalized: 'tool usage pattern',
      occurrences: 1,
      sources: [date],
      isHighConfidence: false,
      isLowValue: false,
    })
  }

  // Synthesize app usage patterns (top apps)
  const sortedApps = Array.from(appCounts.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)

  if (sortedApps.length > 0) {
    const appSummary = sortedApps.map(([name, count]) => `${name}(${count})`).join(', ')
    lessons.push({
      text: `Active app pattern: ${appSummary}`,
      normalized: 'active app pattern',
      occurrences: 1,
      sources: [date],
      isHighConfidence: false,
      isLowValue: false,
    })
  }

  return lessons
}

function deduplicateLessons(allLessons: ExtractedLesson[]): ExtractedLesson[] {
  const byNorm = new Map<string, ExtractedLesson>()

  for (const lesson of allLessons) {
    if (lesson.normalized === '') continue
    const existing = byNorm.get(lesson.normalized)
    if (existing) {
      byNorm.set(lesson.normalized, {
        text: existing.text,
        normalized: existing.normalized,
        occurrences: existing.occurrences + 1,
        sources: [...existing.sources, ...lesson.sources],
        isHighConfidence: existing.occurrences + 1 >= 3,
        isLowValue: existing.isLowValue && lesson.isLowValue,
      })
    } else {
      byNorm.set(lesson.normalized, lesson)
    }
  }

  return Array.from(byNorm.values())
}

// ── Weekly consolidation ───────────────────────────────────────────

export function runWeeklyConsolidation(input: WeeklyConsolidationInput): WeeklyConsolidationResult {
  const { vault, archiveStore, weekId, dailyLogDates } = input

  if (dailyLogDates.length === 0) {
    return {
      success: true,
      weekId,
      dailyLogsProcessed: 0,
      lessonsExtracted: 0,
      duplicatesRemoved: 0,
      archivedCount: 0,
    }
  }

  try {
    // Read all daily logs for the period
    const allLessons: ExtractedLesson[] = []
    let processedCount = 0

    for (const date of dailyLogDates) {
      const file = vault.read(`daily/${date}.md`)
      if (!file) continue
      processedCount++

      const lessons = extractLessonsFromDailyContent(file.content, date)
      allLessons.push(...lessons)
    }

    // Deduplicate across the week
    const totalBeforeDedup = allLessons.length
    const dedupedLessons = deduplicateLessons(allLessons)
    const duplicatesRemoved = totalBeforeDedup - dedupedLessons.length

    // Separate high-value from low-value
    const highConfidence = dedupedLessons.filter((l) => l.isHighConfidence && !l.isLowValue)
    const normalLessons = dedupedLessons.filter((l) => !l.isHighConfidence && !l.isLowValue)
    const lowValue = dedupedLessons.filter((l) => l.isLowValue)

    // Archive low-value entries
    const now = new Date().toISOString()
    for (const lesson of lowValue) {
      archiveStore.archive({
        id: `${weekId}-${lesson.normalized.slice(0, 20).replace(/\s/g, '-')}`,
        name: lesson.text.slice(0, 80),
        type: 'observation',
        content: lesson.text,
        source: `weekly-consolidation:${weekId}`,
        createdAt: lesson.sources[0] ?? now,
        archivedAt: now,
        archiveReason: 'low-value',
      })
    }

    // Build weekly summary markdown
    const sections: string[] = [
      `# Weekly Summary: ${weekId}`,
      '',
      `> Generated: ${now}`,
      `> Daily logs processed: ${processedCount}`,
      `> Lessons extracted: ${highConfidence.length + normalLessons.length}`,
      `> Duplicates removed: ${duplicatesRemoved}`,
      `> Archived (low-value): ${lowValue.length}`,
      '',
    ]

    if (highConfidence.length > 0) {
      sections.push('### High-Confidence Lessons')
      sections.push('_(Appeared 3+ times this week)_')
      sections.push('')
      for (const lesson of highConfidence) {
        sections.push(
          `- **${lesson.text}** _(${lesson.occurrences}x across ${lesson.sources.length} days)_`,
        )
      }
      sections.push('')
    }

    if (normalLessons.length > 0) {
      sections.push('### Lessons')
      sections.push('')
      for (const lesson of normalLessons) {
        sections.push(`- ${lesson.text}`)
      }
      sections.push('')
    }

    if (highConfidence.length === 0 && normalLessons.length === 0) {
      sections.push('_No significant lessons extracted this week._')
      sections.push('')
    }

    vault.write(`weekly/${weekId}.md`, sections.join('\n'))

    return {
      success: true,
      weekId,
      dailyLogsProcessed: processedCount,
      lessonsExtracted: highConfidence.length + normalLessons.length,
      duplicatesRemoved,
      archivedCount: lowValue.length,
    }
  } catch (err) {
    return {
      success: false,
      weekId,
      dailyLogsProcessed: 0,
      lessonsExtracted: 0,
      duplicatesRemoved: 0,
      archivedCount: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ── Monthly consolidation ──────────────────────────────────────────

function extractLessonsFromWeeklyContent(content: string): string[] {
  const lines = content.split('\n')
  const lessons: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    // Match both regular and bold lessons
    const bulletMatch = /^[-*]\s+(?:\*\*)?(.+?)(?:\*\*)?(?:\s*_\(.+\)_)?$/.exec(trimmed)
    if (bulletMatch) {
      lessons.push(bulletMatch[1]!)
    }
  }

  return lessons
}

export function runMonthlyConsolidation(
  input: MonthlyConsolidationInput,
): MonthlyConsolidationResult {
  const { vault, archiveStore, monthId, weeklyIds } = input

  if (weeklyIds.length === 0) {
    return {
      success: true,
      monthId,
      weeklyLogsProcessed: 0,
      stablePatternsFound: 0,
      archivedWeeklies: 0,
    }
  }

  try {
    const allLessons: string[] = []
    let processedCount = 0

    for (const weekId of weeklyIds) {
      const file = vault.read(`weekly/${weekId}.md`)
      if (!file) continue
      processedCount++

      const lessons = extractLessonsFromWeeklyContent(file.content)
      allLessons.push(...lessons)
    }

    // Count frequency for stable pattern detection
    const freq = new Map<string, { text: string; count: number }>()
    for (const lesson of allLessons) {
      const norm = normalizeLesson(lesson)
      if (norm === '') continue
      const existing = freq.get(norm)
      if (existing) {
        freq.set(norm, { text: existing.text, count: existing.count + 1 })
      } else {
        freq.set(norm, { text: lesson, count: 1 })
      }
    }

    // Stable patterns = lessons that appear in 2+ weekly summaries
    const stablePatterns = Array.from(freq.values()).filter((e) => e.count >= 2)
    const otherLessons = Array.from(freq.values()).filter((e) => e.count < 2)

    // Build monthly summary
    const now = new Date().toISOString()
    const sections: string[] = [
      `# Monthly Summary: ${monthId}`,
      '',
      `> Generated: ${now}`,
      `> Weekly logs processed: ${processedCount}`,
      `> Stable patterns found: ${stablePatterns.length}`,
      '',
    ]

    if (stablePatterns.length > 0) {
      sections.push('### Stable Patterns')
      sections.push('_(Confirmed across multiple weeks)_')
      sections.push('')
      for (const pattern of stablePatterns) {
        sections.push(`- **${pattern.text}** _(appeared in ${pattern.count} weeks)_`)
      }
      sections.push('')
    }

    if (otherLessons.length > 0) {
      sections.push('### Other Lessons')
      sections.push('')
      for (const lesson of otherLessons) {
        sections.push(`- ${lesson.text}`)
      }
      sections.push('')
    }

    vault.write(`monthly/${monthId}.md`, sections.join('\n'))

    // Archive processed weeklies (move content, mark as superseded)
    let archivedWeeklies = 0
    for (const weekId of weeklyIds) {
      const file = vault.read(`weekly/${weekId}.md`)
      if (!file) continue

      archiveStore.archive({
        id: `monthly-${monthId}-${weekId}`,
        name: `Weekly summary: ${weekId}`,
        type: 'weekly-summary',
        content: file.content,
        source: `monthly-consolidation:${monthId}`,
        createdAt: now,
        archivedAt: now,
        archiveReason: 'pruned',
      })
      archivedWeeklies++
    }

    return {
      success: true,
      monthId,
      weeklyLogsProcessed: processedCount,
      stablePatternsFound: stablePatterns.length,
      archivedWeeklies,
    }
  } catch (err) {
    return {
      success: false,
      monthId,
      weeklyLogsProcessed: 0,
      stablePatternsFound: 0,
      archivedWeeklies: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
