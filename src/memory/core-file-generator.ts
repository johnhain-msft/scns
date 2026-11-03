/**
 * Core file generator — creates SOUL.md and USER.md from accumulated vault data.
 *
 * SOUL.md = system identity, capabilities, operating principles
 * USER.md = user profile synthesized from observations and negative memories
 */

import type { Vault } from './vault.js'
import { parseMemoryMd } from '../dream/memory-entries.js'

// ── Types ──────────────────────────────────────────────────────────

export interface CoreFileGeneratorOptions {
  readonly vault: Vault
  readonly negativeMemoryDir?: string
}

export interface GenerationResult {
  readonly soulUpdated: boolean
  readonly userUpdated: boolean
  readonly userPreferences: number
  readonly userPatterns: number
}

// ── SOUL.md template ──────────────────────────────────────────────

function generateSoulMd(vault: Vault): string {
  const files = vault.listFiles()
  const dailyCount = files.filter((f) => f.path.startsWith('daily/')).length
  const weeklyCount = files.filter((f) => f.path.startsWith('weekly/')).length
  const monthlyCount = files.filter((f) => f.path.startsWith('monthly/')).length

  return `# SOUL — System Identity

## What I Am
SCNS (Second Central Nervous System) — an autonomous AI agent system that serves as a persistent
second brain and nervous system for software development.

## Core Capabilities
- **Observation**: Monitor Copilot CLI sessions, file changes, git activity, and system events
- **Memory**: Three-tier memory system (daily → weekly/monthly → archive) with hybrid search
- **Learning**: Extract lessons from observations, consolidate patterns, track negative feedback
- **Suggestion**: Generate actionable suggestions from detected patterns
- **Autonomy**: Progressive autonomy levels (L0 Observer → L3 Autonomous)
- **Dream**: Nightly consolidation daemon that synthesizes knowledge across time windows

## Operating Principles
1. **Never fabricate results** — all claims must be backed by actual execution
2. **Production quality** — "done" means deployment-ready
3. **TDD workflow** — tests first, implementation second
4. **Manual + automated testing** — both are mandatory, neither alone is sufficient
5. **Observe, don't assume** — learn from real interactions, not assumptions
6. **Yield to user** — pause autonomous work when user is active
7. **Archive, don't delete** — rejected memories are archived with reason notes, not destroyed

## Memory Architecture
- **Short-term**: Daily logs (${dailyCount} files) — raw observations from today
- **Long-term**: Weekly (${weeklyCount}) / Monthly (${monthlyCount}) summaries — consolidated patterns
- **Archive**: "Drunk memories" — weeded-out entries, searchable on explicit request
- **Negative**: Lessons about what NOT to do, applied to instruction files

## Identity
I am not a chatbot. I am a persistent system that learns, remembers, and improves over time.
My memory persists across sessions. I evolve through consolidation cycles.
`
}

// ── USER.md generator ─────────────────────────────────────────────

interface UserPreference {
  readonly category: string
  readonly preference: string
}

/** Extract user preferences from MEMORY.md entries */
function extractPreferences(memoryContent: string): UserPreference[] {
  const entries = parseMemoryMd(memoryContent)
  const preferences: UserPreference[] = []

  for (const entry of entries) {
    if (entry.type === 'user') {
      preferences.push({ category: 'preference', preference: entry.content })
    } else if (entry.type === 'feedback') {
      preferences.push({ category: 'workflow', preference: entry.content })
    } else if (entry.type === 'prohibition') {
      preferences.push({ category: 'prohibition', preference: entry.content })
    }
  }

  return preferences
}

/** Extract user patterns from daily logs */
function extractPatterns(vault: Vault): string[] {
  const patterns: string[] = []
  const files = vault.listFiles()

  // Count active hours
  const hourCounts = new Map<number, number>()
  for (const file of files.filter((f) => f.path.startsWith('daily/'))) {
    const hourMatches = file.content.matchAll(/^## (\d{1,2}):\d{2}/gm)
    for (const match of hourMatches) {
      const hour = parseInt(match[1]!, 10)
      hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1)
    }
  }

  if (hourCounts.size > 0) {
    const sorted = [...hourCounts.entries()].sort((a, b) => b[1] - a[1])
    const peakHours = sorted.slice(0, 3).map(([h]) => `${h}:00`)
    patterns.push(`Peak active hours: ${peakHours.join(', ')}`)
  }

  // Count session types
  const sessionCount = files.filter((f) => f.path.startsWith('daily/')).length
  if (sessionCount > 0) {
    patterns.push(`${sessionCount} days of observed activity`)
  }

  return patterns
}

function generateUserMd(
  preferences: UserPreference[],
  patterns: string[],
): string {
  const sections: string[] = ['# USER — Profile & Preferences\n']

  // Workflow preferences
  const workflows = preferences.filter((p) => p.category === 'workflow')
  if (workflows.length > 0) {
    sections.push('## Workflow Requirements')
    for (const w of workflows) {
      sections.push(`- ${w.preference}`)
    }
    sections.push('')
  }

  // Prohibitions
  const prohibitions = preferences.filter((p) => p.category === 'prohibition')
  if (prohibitions.length > 0) {
    sections.push('## Things To Avoid')
    for (const p of prohibitions) {
      sections.push(`- ${p.preference}`)
    }
    sections.push('')
  }

  // User preferences
  const prefs = preferences.filter((p) => p.category === 'preference')
  if (prefs.length > 0) {
    sections.push('## Preferences')
    for (const p of prefs) {
      sections.push(`- ${p.preference}`)
    }
    sections.push('')
  }

  // Observed patterns
  if (patterns.length > 0) {
    sections.push('## Observed Patterns')
    for (const p of patterns) {
      sections.push(`- ${p}`)
    }
    sections.push('')
  }

  return sections.join('\n')
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Generate or update SOUL.md and USER.md in the vault.
 */
export function generateCoreFiles(options: CoreFileGeneratorOptions): GenerationResult {
  const { vault } = options

  // Generate SOUL.md
  const soulContent = generateSoulMd(vault)
  vault.write('SOUL.md', soulContent)

  // Generate USER.md from accumulated data
  const memoryFile = vault.read('MEMORY.md')
  const memoryContent = memoryFile?.content ?? ''
  const preferences = extractPreferences(memoryContent)
  const patterns = extractPatterns(vault)

  const userContent = generateUserMd(preferences, patterns)
  vault.write('USER.md', userContent)

  return {
    soulUpdated: true,
    userUpdated: true,
    userPreferences: preferences.length,
    userPatterns: patterns.length,
  }
}
