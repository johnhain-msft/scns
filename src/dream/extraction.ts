/**
 * Daily log parsing and memory entry extraction.
 *
 * Pure functions — no file I/O. Content is passed as strings.
 */

import type { MemoryEntry } from './memory-entries.js'
import { deduplicateEntries } from './memory-entries.js'
import { classifyPromptAuthorship } from '../memory/prompt-authorship.js'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DailyLogEntry {
  readonly date: string
  readonly time: string
  readonly sessionId: string | null
  readonly lines: ReadonlyArray<string>
}

interface Classification {
  readonly type: MemoryEntry['type']
  readonly confidence: number
}

// ---------------------------------------------------------------------------
// Keyword patterns for classification
// ---------------------------------------------------------------------------

const STRONG_CONFIDENCE = 0.9
const WEAK_CONFIDENCE = 0.6

type PatternDef = readonly [RegExp, number]

const USER_PATTERNS: readonly PatternDef[] = [
  [/\bprefers?\b/i, STRONG_CONFIDENCE],
  [/\balways wants?\b/i, STRONG_CONFIDENCE],
  [/\blikes?\b/i, WEAK_CONFIDENCE],
  [/\bdislikes?\b/i, STRONG_CONFIDENCE],
  [/\bstyle\b/i, WEAK_CONFIDENCE],
  [/\bconvention\b/i, WEAK_CONFIDENCE],
]

const FEEDBACK_PATTERNS: readonly PatternDef[] = [
  [/\bshould\b/i, WEAK_CONFIDENCE],
  [/\bdon['']t\b/i, STRONG_CONFIDENCE],
  [/\bremember to\b/i, STRONG_CONFIDENCE],
  [/\bbetter to\b/i, STRONG_CONFIDENCE],
  [/\blesson learned\b/i, STRONG_CONFIDENCE],
]

const PROJECT_PATTERNS: readonly PatternDef[] = [
  [/\bdecided\b/i, STRONG_CONFIDENCE],
  [/\busing\b/i, WEAK_CONFIDENCE],
  [/\barchitecture\b/i, STRONG_CONFIDENCE],
  [/\bdatabase\b/i, WEAK_CONFIDENCE],
  [/\bdeployed\b/i, STRONG_CONFIDENCE],
  [/\bconfigured\b/i, WEAK_CONFIDENCE],
]

const REFERENCE_PATTERNS: readonly PatternDef[] = [
  [/\bURL\b/i, STRONG_CONFIDENCE],
  [/\blink\b/i, WEAK_CONFIDENCE],
  [/\bdashboard at\b/i, STRONG_CONFIDENCE],
  [/\bdocs at\b/i, STRONG_CONFIDENCE],
  [/\bAPI at\b/i, STRONG_CONFIDENCE],
  [/\blocated at\b/i, STRONG_CONFIDENCE],
  [/https?:\/\//i, WEAK_CONFIDENCE],
]

const PROHIBITION_PATTERNS: readonly PatternDef[] = [
  [/\bnever (do|claim|say|assume|make|lie|skip|write|mark)\b/i, STRONG_CONFIDENCE],
  [/\bstop (doing|making|saying|lying|claiming|ignoring|skipping)\b/i, STRONG_CONFIDENCE],
  [/\bdo not (ever|again|assume|claim|skip)\b/i, STRONG_CONFIDENCE],
  [/\bmust not\b/i, STRONG_CONFIDENCE],
  [/\bavoid\b.*\b(always|never|must)\b/i, WEAK_CONFIDENCE],
  [/\bnegative feedback\b/i, WEAK_CONFIDENCE],
  [/\bprohibit/i, STRONG_CONFIDENCE],
]

// ---------------------------------------------------------------------------
// parseDailyLog
// ---------------------------------------------------------------------------

/** Old format: ### HH:MM optionally followed by " — Session <id>" */
const OLD_HEADER_RE = /^###\s+(\d{1,2}:\d{2})(?:\s+[—–-]\s+Session\s+(\S+))?$/

/** Production format: ## HH:MM:SS (written by vault.appendDailyLog) */
const PROD_HEADER_RE = /^##\s+(\d{1,2}:\d{2}:\d{2})\s*$/

/** Tags line: extracts source and session-id */
const TAGS_RE = /^Tags:\s*(.+)$/

/** Content line: **[type]** optional content */
const CONTENT_RE = /^\*\*\[([^\]]+)\]\*\*\s*(.*)$/

/** Noise source types that should be filtered during extraction */
const NOISE_SOURCES = new Set([
  'pre-tool-use',
  'post-tool-use',
  'tool-use',
  'session-start',
  'session-end',
])

/** Parse a Tags: line into a map of key→value pairs */
function parseTags(tagsLine: string): Map<string, string> {
  const tags = new Map<string, string>()
  for (const part of tagsLine.split(',')) {
    const trimmed = part.trim()
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue
    const key = trimmed.slice(0, colonIdx).trim()
    const value = trimmed.slice(colonIdx + 1).trim()
    if (key && value) tags.set(key, value)
  }
  return tags
}

/** Strip wrapper labels from content (e.g., "User prompt: actual text" → "actual text") */
function stripContentWrapper(content: string): string {
  const wrappers = [
    /^User prompt:\s*/i,
    /^Tool used:\s*/i,
    /^Pre-tool:\s*/i,
    /^Post-tool:\s*/i,
    /^Session\s+\S+\s+(started|ended)\s*/i,
  ]
  for (const re of wrappers) {
    const match = re.exec(content)
    if (match) return content.slice(match[0].length).trim()
  }
  return content
}

/**
 * Parse a daily log markdown file into structured session entries.
 * Supports both old format (### HH:MM — Session xxx) and
 * production format (## HH:MM:SS + **[type]** content + Tags:).
 */
export function parseDailyLog(content: string, date: string): DailyLogEntry[] {
  if (!content.trim()) return []

  const results: DailyLogEntry[] = []
  let current: { time: string; sessionId: string | null; lines: string[] } | null = null
  // Track whether the current entry's source is noise (to skip it entirely)
  let currentIsNoise = false

  const rawLines = content.split('\n')

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!.trimEnd()

    // Check old format header first (### HH:MM)
    const oldMatch = OLD_HEADER_RE.exec(line)
    if (oldMatch) {
      if (current && !currentIsNoise) {
        results.push({
          date,
          time: current.time,
          sessionId: current.sessionId,
          lines: current.lines,
        })
      }
      current = { time: oldMatch[1]!, sessionId: oldMatch[2] ?? null, lines: [] }
      currentIsNoise = false
      continue
    }

    // Check production format header (## HH:MM:SS)
    const prodMatch = PROD_HEADER_RE.exec(line)
    if (prodMatch) {
      if (current && !currentIsNoise) {
        results.push({
          date,
          time: current.time,
          sessionId: current.sessionId,
          lines: current.lines,
        })
      }
      current = { time: prodMatch[1]!, sessionId: null, lines: [] }
      currentIsNoise = false
      continue
    }

    if (!current) continue

    // Parse Tags: line — extract session-id and check for noise source
    const tagsMatch = TAGS_RE.exec(line)
    if (tagsMatch) {
      const tags = parseTags(tagsMatch[1]!)
      const sessionId = tags.get('session-id')
      if (sessionId && !current.sessionId) {
        current.sessionId = sessionId
      }
      const source = tags.get('source')
      if (source && NOISE_SOURCES.has(source)) {
        currentIsNoise = true
        current.lines = [] // clear any content already parsed
      }
      continue
    }

    // Parse **[type]** content line
    const contentMatch = CONTENT_RE.exec(line)
    if (contentMatch) {
      const rawContent = contentMatch[2]!.trim()
      if (rawContent) {
        const stripped = stripContentWrapper(rawContent)
        if (stripped) {
          current.lines.push(stripped)
        }
      }
      continue
    }

    // Bullet line: strip "- " prefix
    if (line.startsWith('- ')) {
      current.lines.push(line.slice(2))
      continue
    }

    // Non-empty, non-header lines (paragraphs, etc.) — include as-is
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('## ')) {
      current.lines.push(trimmed)
    }
  }

  // Flush last entry
  if (current && !currentIsNoise) {
    results.push({ date, time: current.time, sessionId: current.sessionId, lines: current.lines })
  }

  // Filter out entries with no meaningful content
  return results.filter((e) => e.lines.some((l) => l.trim().length > 0))
}

// ---------------------------------------------------------------------------
// classifyEntry
// ---------------------------------------------------------------------------

/**
 * Classify a bullet-point line into a memory entry type using keyword heuristics.
 * Returns null when the line is routine noise (status updates, actions).
 */
export function classifyEntry(line: string): Classification | null {
  // Check each category in priority order.
  // "prohibition" first — explicit "never/stop/don't" rules are highest priority.
  // Then "reference" so that URLs trump weaker project/user matches.
  const prohibition = matchPatterns(line, PROHIBITION_PATTERNS)
  if (prohibition) return { type: 'prohibition', confidence: prohibition }

  const ref = matchPatterns(line, REFERENCE_PATTERNS)
  if (ref) return { type: 'reference', confidence: ref }

  const user = matchPatterns(line, USER_PATTERNS)
  if (user) return { type: 'user', confidence: user }

  const feedback = matchPatterns(line, FEEDBACK_PATTERNS)
  if (feedback) return { type: 'feedback', confidence: feedback }

  const project = matchPatterns(line, PROJECT_PATTERNS)
  if (project) return { type: 'project', confidence: project }

  return null
}

function matchPatterns(line: string, patterns: readonly PatternDef[]): number | null {
  let best: number | null = null
  for (const [regex, confidence] of patterns) {
    if (regex.test(line)) {
      if (best === null || confidence > best) {
        best = confidence
      }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// generateEntryName
// ---------------------------------------------------------------------------

const FILLER_WORDS = new Set(['the', 'a', 'an'])

/**
 * Generate a concise, descriptive name from content.
 */
export function generateEntryName(content: string): string {
  if (!content.trim()) return ''

  // Strip leading bullet markers
  let text = content.replace(/^[-*•]\s+/, '').trim()

  // Take first clause (before comma, period, or dash separator)
  const clauseMatch = /^([^,.\-—–]+)/.exec(text)
  if (clauseMatch) {
    text = clauseMatch[1]!.trim()
  }

  // Remove leading filler words
  const words = text.split(/\s+/)
  while (words.length > 1 && FILLER_WORDS.has(words[0]!.toLowerCase())) {
    words.shift()
  }

  // Title case
  const titled = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

  // Truncate to max 60 chars (break at word boundary)
  if (titled.length <= 60) return titled
  const truncated = titled.slice(0, 60)
  const lastSpace = truncated.lastIndexOf(' ')
  return lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated
}

// ---------------------------------------------------------------------------
// synthesizeEntry — transform raw prompts into actionable lessons
// ---------------------------------------------------------------------------

/** Common typo corrections the user frequently makes */
const TYPO_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bii\b/gi, 'I'],
  [/\bsi\b/gi, 'is'],
  [/\bteh\b/gi, 'the'],
  [/\bconmcludnig\b/gi, 'concluding'],
  [/\bdoone\b/gi, 'done'],
  [/\bfinshed\b/gi, 'finished'],
  [/\bbasaically\b/gi, 'basically'],
  [/\bfundamentaal\b/gi, 'fundamental'],
  [/\bresettnig\b/gi, 'resetting'],
  [/\bbuiilid\b/gi, 'build'],
  [/\bregressoin\b/gi, 'regression'],
  [/\bautomatted\b/gi, 'automated'],
  [/\btestnig\b/gi, 'testing'],
  [/\bdiid\b/gi, 'did'],
  [/\baall\b/gi, 'all'],
  [/\bfunctionnaliity\b/gi, 'functionality'],
  [/\binfastructure\b/gi, 'infrastructure'],
  [/\bpiipeliine\b/gi, 'pipeline'],
  [/\biimplementation\b/gi, 'implementation'],
  [/\breccomend/gi, 'recommend'],
  [/\bwht\b/gi, 'what'],
  [/\baanythiinig\b/gi, 'anything'],
  [/\bstattus\b/gi, 'status'],
  [/\bguessiing\b/gi, 'guessing'],
  [/\bsomee\b/gi, 'some'],
  [/\bidk\b/gi, "I don't know"],
]

/** Synthesis patterns: match raw prompt → produce distilled lesson */
const SYNTHESIS_RULES: ReadonlyArray<{
  readonly match: RegExp
  readonly type: MemoryEntry['type']
  readonly transform: (text: string) => { name: string; description: string }
}> = [
  {
    match: /\bfollow TDD\b/i,
    type: 'feedback',
    transform: () => ({
      name: 'Follow TDD Workflow',
      description:
        'Always follow Test-Driven Development: write tests first, implement to pass, then verify with both automated and manual testing before declaring work complete.',
    }),
  },
  {
    match: /\bmanual\s*(and|&|\+)\s*automated\s*test/i,
    type: 'feedback',
    transform: () => ({
      name: 'Require Both Manual And Automated Testing',
      description:
        'Both manual and automated testing are required before declaring work complete. Automated tests alone are not sufficient.',
    }),
  },
  {
    match: /\bproduction\s*(ready|quality)\b/i,
    type: 'feedback',
    transform: () => ({
      name: 'Production Quality Standard',
      description:
        'Declaring work "done" means production-ready quality. Treat every completion as a production deployment.',
    }),
  },
  {
    match: /\bquality[- ]gate\b/i,
    type: 'feedback',
    transform: () => ({
      name: 'Run Quality Gate Before Completion',
      description:
        'Run the quality-gate skill on completed work to ensure it meets quality standards before declaring done.',
    }),
  },
  {
    match: /\bwhy\s+would\s+you\s+(lie|skip|ignore)\b/i,
    type: 'prohibition',
    transform: (text: string) => {
      if (/test/i.test(text)) {
        return {
          name: 'Never Fabricate Test Results',
          description:
            'Never claim tests pass without actually running them. Always verify with real execution.',
        }
      }
      return {
        name: 'Never Misrepresent Work Status',
        description:
          'Never claim work is complete or tested without actual verification. Honesty about status is mandatory.',
      }
    },
  },
  {
    match: /\bstop\s+(doing|making|ignoring|skipping|lying)\b/i,
    type: 'prohibition',
    transform: (text: string) => {
      if (/test/i.test(text)) {
        return {
          name: 'Never Skip Required Testing',
          description:
            'Testing requirements are non-negotiable. Do not skip manual or automated testing steps.',
        }
      }
      if (/ignor/i.test(text)) {
        return {
          name: 'Always Follow User Instructions',
          description:
            'User instructions must be followed precisely. Do not ignore or reinterpret explicit requirements.',
        }
      }
      return {
        name: 'Follow All Quality Requirements',
        description: 'Follow all stated quality requirements without shortcuts or omissions.',
      }
    },
  },
  {
    match: /\bblue[/-]green\b/i,
    type: 'project',
    transform: () => ({
      name: 'Blue-Green Deployment For Broker',
      description:
        'The broker uses blue/green deployment for daily restarts to ensure zero downtime with clean context.',
    }),
  },
  {
    match: /\bobserv(?:ing|ation|e)\b.*\bconversation/i,
    type: 'project',
    transform: () => ({
      name: 'Observe All Conversations',
      description:
        'SCNS should observe all Copilot CLI conversations, extract lessons, and use them for recommendations and memory consolidation.',
    }),
  },
  {
    match: /\bdream(?:ing)?\b/i,
    type: 'project',
    transform: () => ({
      name: 'Dream Consolidation Pipeline',
      description:
        'The dream daemon consolidates daily observations into weekly/monthly tiers, extracts lessons, and manages long-term memory.',
    }),
  },
]

/** Fix common typos in text */
export function fixTypos(text: string): string {
  let result = text
  for (const [pattern, replacement] of TYPO_MAP) {
    result = result.replace(pattern, replacement)
  }
  return result
}

/**
 * Synthesize a raw prompt into a distilled, actionable lesson.
 * Returns null if the text should not be synthesized (kept as-is or skipped).
 */
export function synthesizeEntry(
  rawText: string,
  type: MemoryEntry['type'],
): { name: string; description: string; content: string } | null {
  // Try rule-based synthesis first
  for (const rule of SYNTHESIS_RULES) {
    if (rule.match.test(rawText)) {
      const { name, description } = rule.transform(rawText)
      return { name, description, content: description }
    }
  }

  // For non-matching entries, clean up typos and normalize
  const cleaned = fixTypos(rawText)

  // Skip very short or nonsensical entries
  if (cleaned.length < 15) return null

  // For prohibition/feedback types, try to extract the core instruction
  if (type === 'prohibition' || type === 'feedback') {
    const normalized = cleanProhibitionFeedback(cleaned)
    if (normalized) {
      return {
        name: generateEntryName(normalized),
        description: normalized,
        content: normalized,
      }
    }
  }

  // For other types, return cleaned version
  return {
    name: generateEntryName(cleaned),
    description: cleaned,
    content: cleaned,
  }
}

/** Clean up prohibition/feedback entries — remove emotional tone, extract actionable rule */
function cleanProhibitionFeedback(text: string): string | null {
  // Remove question marks and emotional phrasing
  let cleaned = text
    .replace(/\?\s*$/g, '.')
    .replace(/^why\s+would\s+you\s+/i, '')
    .replace(/^what\s+gives?\s*/i, '')
    .replace(/\s+what\s+give[s.]?\s*$/i, '.')
    .trim()

  // Capitalize first letter
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  }

  // Ensure it ends with a period
  if (cleaned.length > 0 && !cleaned.endsWith('.')) {
    cleaned += '.'
  }

  return cleaned.length > 10 ? cleaned : null
}

// ---------------------------------------------------------------------------
// extractFromLog
// ---------------------------------------------------------------------------

/**
 * Full extraction pipeline: parse → classify → synthesize → build MemoryEntry objects.
 *
 * Machine-authored lines are dropped before classification. The daily log records sub-agent
 * dispatch prompts in the same slot as the human's own utterances, so without this gate a brief
 * such as "You are slidesmith. ... Read .orchestrator/deck-e19f65/kickoff-build-5.md ... you must
 * NOT touch slides" matches PROHIBITION_PATTERNS on its "must NOT", becomes `type: 'prohibition'`,
 * and is rendered into USER.md under "Things To Avoid" — a file injected into the briefing of every
 * session in every directory. Three such briefs from one deck project leaked that way (harvested
 * 2026-09-25, removed 2026-10-12) and are the most plausible cause of an unrelated app spec twice
 * inventing a slide-deck surface the product does not have.
 *
 * `classifyPromptAuthorship` is the same detector the negative-feedback path already uses; it is a
 * negative filter, so a `human` verdict means only "no machine marker matched". That asymmetry is
 * the right one here: the cost of dropping a genuine human line is one lost memory, while the cost
 * of keeping a machine line is a false global prohibition.
 */
export function extractFromLog(content: string, date: string): ReadonlyArray<MemoryEntry> {
  const parsed = parseDailyLog(content, date)
  const entries: MemoryEntry[] = []

  for (const session of parsed) {
    // One daily-log entry is one observation, so when its text is machine-authored every line of
    // it is — and a multi-line dispatch brief puts its role preamble and its prohibition sentence
    // on DIFFERENT physical lines (parseDailyLog splits on newlines; nothing upstream collapses
    // them). A per-line check would pass the prohibition line, whose only marker is on line 1.
    // Classify the entry as a whole first, then still gate each line so a machine line inside an
    // otherwise-human multi-bullet entry is dropped too.
    if (classifyPromptAuthorship(session.lines.join('\n')).author === 'machine') continue

    for (const line of session.lines) {
      if (classifyPromptAuthorship(line).author === 'machine') continue

      const classification = classifyEntry(line)
      if (!classification) continue

      // Normalize time: HH:MM → HH:MM:00, HH:MM:SS → as-is
      const time = session.time.includes(':')
        ? session.time.split(':').length === 3
          ? session.time
          : `${session.time}:00`
        : `${session.time}:00`

      // Synthesize raw text into an actionable lesson
      const synthesized = synthesizeEntry(line, classification.type)
      if (!synthesized) continue

      entries.push({
        id: randomUUID(),
        type: classification.type,
        name: synthesized.name,
        description: synthesized.description,
        content: synthesized.content,
        source: `daily-log:${date}`,
        createdAt: `${date}T${time}Z`,
      })
    }
  }

  return entries
}

// ---------------------------------------------------------------------------
// extractFromMultipleLogs
// ---------------------------------------------------------------------------

/**
 * Run extraction across multiple daily logs, deduplicate, and sort by date.
 */
export function extractFromMultipleLogs(
  logs: ReadonlyArray<{ content: string; date: string }>,
): ReadonlyArray<MemoryEntry> {
  const allEntries: MemoryEntry[] = []

  for (const log of logs) {
    allEntries.push(...extractFromLog(log.content, log.date))
  }

  // Sort by createdAt ascending (earlier entries first)
  allEntries.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))

  // Deduplicate — deduplicateEntries keeps the later entry when names match
  return deduplicateEntries(allEntries)
}
