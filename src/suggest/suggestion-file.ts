/**
 * Suggestion file — markdown + frontmatter serialization for suggestions.
 */

import { SuggestionSchema } from './types.js'
import { ValidationError } from '../shared/errors.js'
import type { Suggestion } from './types.js'

/** Parse YAML-like frontmatter from a markdown string (no external deps) */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>
  body: string
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    throw new ValidationError('Invalid frontmatter: missing --- delimiters')
  }

  const rawFrontmatter = match[1]!
  const body = match[2]!

  const frontmatter: Record<string, unknown> = {}

  for (const line of rawFrontmatter.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    const rawValue = trimmed.slice(colonIdx + 1).trim()

    frontmatter[key] = parseValue(rawValue)
  }

  return { frontmatter, body }
}

/** Parse a single YAML-like value */
function parseValue(raw: string): unknown {
  // Empty string
  if (raw === '') return ''

  // Inline array: [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (inner === '') return []
    return parseArrayElements(inner)
  }

  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }

  // Booleans
  if (raw === 'true') return true
  if (raw === 'false') return false

  // Numbers
  const num = Number(raw)
  if (!Number.isNaN(num) && raw !== '') return num

  // Unquoted string
  return raw
}

/** Parse comma-separated array elements, handling quoted strings */
function parseArrayElements(inner: string): string[] {
  const results: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true
      quoteChar = ch
    } else if (ch === ',') {
      results.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }

  const last = current.trim()
  if (last !== '') results.push(last)

  return results
}

/** Serialize a record to YAML-like frontmatter with a body */
export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const lines: string[] = ['---']

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    lines.push(`${key}: ${serializeValue(value)}`)
  }

  lines.push('---')
  if (body) {
    lines.push(body)
  }

  return lines.join('\n') + '\n'
}

/** Serialize a single value for frontmatter */
function serializeValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[${value.join(', ')}]`
  }
  return `"${String(value)}"`
}

/** Serialize a Suggestion to markdown with frontmatter */
const FRONTMATTER_TEXT_LIMIT = 500
const TRUNCATION_NOTE = ' … [truncated — full text in ~/.scns/memory/decisions]'

/**
 * Make free text safe for this frontmatter serializer, which wraps values in double quotes and does
 * NOT escape their contents. An unescaped newline ends the value early and everything after it is
 * lost on the next read — silently, with no parse error to notice.
 *
 * Lossy by necessity (newlines become spaces, `"` becomes `'`, 500 chars max) and therefore applied
 * ONLY to fields that have a verbatim copy elsewhere or are diagnostic: John's exact words are kept
 * unmodified in the vault decision markdown, where they are fenced rather than quoted.
 */
export function sanitizeFrontmatterText(value: string): string {
  const flattened = value.replace(/[\r\n]+/g, ' ').replace(/"/g, "'")
  if (flattened.length <= FRONTMATTER_TEXT_LIMIT) return flattened
  // Truncation must be VISIBLE. `outcome-writer` forwards `reviewReason` straight into
  // `proposal_outcomes.rationale`, which is what the learner reads — a rationale cut off
  // mid-sentence with no marker reads as though John simply stopped talking, and silently degrades
  // the signal this change exists to improve. The marker also tells a human where the full text is.
  return `${flattened.slice(0, FRONTMATTER_TEXT_LIMIT - TRUNCATION_NOTE.length)}${TRUNCATION_NOTE}`
}

export function serializeSuggestion(suggestion: Suggestion): string {
  const frontmatterData: Record<string, unknown> = {
    id: suggestion.id,
    type: suggestion.type,
    title: suggestion.title,
    status: suggestion.status,
    confidence: suggestion.confidence,
    actionable: suggestion.actionable,
    estimatedComplexity: suggestion.estimatedComplexity,
    tags: suggestion.tags,
    createdAt: suggestion.createdAt,
    updatedAt: suggestion.updatedAt,
  }

  if (suggestion.suggestedRoles !== undefined) {
    frontmatterData['suggestedRoles'] = suggestion.suggestedRoles
  }
  if (suggestion.reviewedAt !== undefined) {
    frontmatterData['reviewedAt'] = suggestion.reviewedAt
  }
  if (suggestion.reviewReason !== undefined) {
    // Sanitised for exactly the same reason as `lastError` and `machineReason` below: this
    // frontmatter serializer wraps strings in double quotes WITHOUT escaping. Skipping it here
    // meant a newline in John's reason terminated the YAML value early and silently discarded the
    // rest of his sentence — on the one field the review loop exists to preserve. The verbatim
    // copy lives in the vault markdown (fenced, unescaped); this field must merely survive whole.
    frontmatterData['reviewReason'] = sanitizeFrontmatterText(suggestion.reviewReason)
  }
  if (suggestion.machineReason !== undefined) {
    frontmatterData['machineReason'] = sanitizeFrontmatterText(suggestion.machineReason)
  }
  if (suggestion.reviewVerdict !== undefined) {
    // A closed enum, so no sanitisation is needed or wanted — a value that failed to round-trip
    // would silently fall back to `status`, which is the very inference this field exists to stop.
    frontmatterData['reviewVerdict'] = suggestion.reviewVerdict
  }
  if (suggestion.escalation !== undefined) {
    // Closed enum, same reasoning as `reviewVerdict`: a value that failed to round-trip would fall
    // back to sniffing `machineReason`/`attemptCount`, which is the inference this field replaces.
    frontmatterData['escalation'] = suggestion.escalation
  }
  if (suggestion.blockedMetadata !== undefined) {
    frontmatterData['blockedRequiredLevel'] = suggestion.blockedMetadata.requiredLevel
    frontmatterData['blockedAt'] = suggestion.blockedMetadata.blockedAt
  }
  // Phase 13.12.9: failure/backoff tracking fields. Persist even when default
  // so round-trip is stable and the dashboard always sees the same shape.
  if (suggestion.attemptCount > 0) {
    frontmatterData['attemptCount'] = suggestion.attemptCount
  }
  if (suggestion.lastError !== null && suggestion.lastError !== undefined) {
    // Frontmatter serializer wraps strings in double quotes without
    // escaping. Collapse newlines and strip inner double-quotes so the
    // round-trip parses cleanly.
    const sanitized = sanitizeFrontmatterText(suggestion.lastError)
    frontmatterData['lastError'] = sanitized
  }
  if (suggestion.lastAttemptAt !== null && suggestion.lastAttemptAt !== undefined) {
    frontmatterData['lastAttemptAt'] = suggestion.lastAttemptAt
  }
  if (suggestion.nextRetryAt !== null && suggestion.nextRetryAt !== undefined) {
    frontmatterData['nextRetryAt'] = suggestion.nextRetryAt
  }
  // Phase 13.12.18: persist allowRepoWrites + browserPlan
  if (suggestion.allowRepoWrites === true) {
    frontmatterData['allowRepoWrites'] = true
  }
  // Phase 13.12.20: in-progress team linkage
  if (suggestion.inflightTeamId !== null && suggestion.inflightTeamId !== undefined) {
    frontmatterData['inflightTeamId'] = suggestion.inflightTeamId
  }

  // Phase 13.12.12: flatten tag-proposal payload into frontmatter. Parser
  // reassembles nested shape.
  if (suggestion.tagProposal !== undefined) {
    frontmatterData['tagProposalName'] = suggestion.tagProposal.tagName
    frontmatterData['tagProposalScope'] = suggestion.tagProposal.scope
    if (suggestion.tagProposal.project !== undefined) {
      frontmatterData['tagProposalProject'] = suggestion.tagProposal.project
    }
    if (suggestion.tagProposal.agent !== undefined) {
      frontmatterData['tagProposalAgent'] = suggestion.tagProposal.agent
    }
    frontmatterData['tagProposalLessons'] = suggestion.tagProposal.candidateLessonIds
    if (suggestion.tagProposal.rationale) {
      frontmatterData['tagProposalRationale'] = suggestion.tagProposal.rationale
        .replace(/[\r\n]+/g, ' ')
        .replace(/"/g, "'")
    }
  }

  const bodyParts: string[] = []

  // Description
  bodyParts.push(`\n## Description\n\n${suggestion.description}`)

  // Evidence
  if (suggestion.evidence.length > 0) {
    bodyParts.push('\n## Evidence\n')
    for (const e of suggestion.evidence) {
      bodyParts.push(
        `- **${e.source}**: ${e.detail} (weight: ${e.weight}, observed: ${e.observedAt})`,
      )
    }
  }

  // Implementation Plan
  if (suggestion.implementationPlan !== undefined) {
    bodyParts.push(`\n## Implementation Plan\n\n${suggestion.implementationPlan}`)
  }

  // Phase 13.12.18: browser plan (JSON in fenced block for lossless round-trip).
  if (suggestion.browserPlan !== undefined) {
    bodyParts.push(
      `\n## Browser Plan\n\n\`\`\`json\n${JSON.stringify(suggestion.browserPlan, null, 2)}\n\`\`\``,
    )
  }

  const body = bodyParts.join('\n')
  return serializeFrontmatter(frontmatterData, body)
}

/** Parse a markdown file with frontmatter back into a Suggestion */
export function parseSuggestion(content: string): Suggestion {
  const { frontmatter, body } = parseFrontmatter(content)

  // Extract description from body
  const descriptionMatch = body.match(/## Description\s*\n\n?([\s\S]*?)(?=\n## |\n*$)/)
  const description = descriptionMatch ? descriptionMatch[1]!.trim() : ''

  // Extract evidence from body
  const evidence = parseEvidenceSection(body)

  // Extract implementation plan from body
  const planMatch = body.match(/## Implementation Plan\s*\n\n?([\s\S]*?)(?=\n## |\n*$)/)
  const implementationPlan = planMatch ? planMatch[1]!.trim() : undefined

  const raw: Record<string, unknown> = {
    ...frontmatter,
    description,
    evidence,
  }

  if (implementationPlan) {
    raw['implementationPlan'] = implementationPlan
  }

  // Phase 13.12.18: parse browser plan JSON block
  const browserPlanMatch = body.match(
    /## Browser Plan\s*\n\n?```json\s*\n([\s\S]*?)\n```/,
  )
  if (browserPlanMatch) {
    try {
      raw['browserPlan'] = JSON.parse(browserPlanMatch[1]!)
    } catch {
      // ignore malformed block; schema validation will catch missing plan
    }
  }

  // Phase 13.12.2: reassemble flat blockedRequiredLevel/blockedAt fields
  // back into the nested blockedMetadata shape the schema expects.
  if (frontmatter['blockedRequiredLevel'] !== undefined && frontmatter['blockedAt'] !== undefined) {
    raw['blockedMetadata'] = {
      requiredLevel: frontmatter['blockedRequiredLevel'],
      blockedAt: frontmatter['blockedAt'],
    }
    delete raw['blockedRequiredLevel']
    delete raw['blockedAt']
  }

  // Phase 13.12.12: reassemble flat tagProposal* fields into nested payload.
  if (frontmatter['tagProposalName'] !== undefined) {
    raw['tagProposal'] = {
      tagName: frontmatter['tagProposalName'],
      scope: frontmatter['tagProposalScope'],
      ...(frontmatter['tagProposalProject'] !== undefined
        ? { project: frontmatter['tagProposalProject'] }
        : {}),
      ...(frontmatter['tagProposalAgent'] !== undefined
        ? { agent: frontmatter['tagProposalAgent'] }
        : {}),
      candidateLessonIds: Array.isArray(frontmatter['tagProposalLessons'])
        ? frontmatter['tagProposalLessons']
        : [],
      rationale: (frontmatter['tagProposalRationale'] as string | undefined) ?? '',
    }
    delete raw['tagProposalName']
    delete raw['tagProposalScope']
    delete raw['tagProposalProject']
    delete raw['tagProposalAgent']
    delete raw['tagProposalLessons']
    delete raw['tagProposalRationale']
  }

  return SuggestionSchema.parse(raw)
}

/** Parse the evidence section from the body markdown */
function parseEvidenceSection(
  body: string,
): Array<{ source: string; detail: string; observedAt: string; weight: number }> {
  const evidenceMatch = body.match(/## Evidence\s*\n([\s\S]*?)(?=\n## |\n*$)/)
  if (!evidenceMatch) return []

  const evidenceBlock = evidenceMatch[1]!
  const results: Array<{ source: string; detail: string; observedAt: string; weight: number }> = []
  const linePattern = /^- \*\*(.+?)\*\*: (.+?) \(weight: ([\d.]+), observed: (.+?)\)$/

  for (const line of evidenceBlock.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('#')) continue
    if (!trimmed.startsWith('- ')) continue

    const match = trimmed.match(linePattern)
    if (match) {
      results.push({
        source: match[1]!,
        detail: match[2]!,
        observedAt: match[4]!,
        weight: Number(match[3]!),
      })
    } else {
      results.push({
        source: 'file',
        detail: trimmed.replace(/^- /, '').trim(),
        observedAt: new Date().toISOString(),
        weight: 0.5,
      })
    }
  }

  return results
}
