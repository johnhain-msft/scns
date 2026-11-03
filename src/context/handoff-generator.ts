/**
 * Handoff document generator.
 * Creates, renders, parses, and validates rich handoff documents.
 */

import { randomUUID } from 'node:crypto'
import {
  HandoffStatus,
  type HandoffDocument,
  type WorkItem,
  type BlockedItem,
  type Decision,
  type FileChange,
} from './handoff-types.js'

// ── Dependency injection ─────────────────────────────────────────────

export interface SessionInfo {
  readonly purpose: string
  readonly workingDir: string
  readonly startedAt: string
  readonly status: string
}

export interface TeamInfo {
  readonly teamId: string
  readonly role: string
  readonly phase: string
}

export interface HandoffGeneratorDeps {
  readonly getSessionInfo?: (sessionId: string) => SessionInfo | null
  readonly getTeamInfo?: (sessionId: string) => TeamInfo | null
}

// ── Input / output types ─────────────────────────────────────────────

export interface HandoffInput {
  readonly sessionId: string
  readonly currentTask?: string
  readonly pendingWork?: readonly WorkItem[]
  readonly completedWork?: readonly string[]
  readonly blockedWork?: readonly BlockedItem[]
  readonly keyDecisions?: readonly Decision[]
  readonly discoveredFacts?: readonly string[]
  readonly warnings?: readonly string[]
  readonly filesModified?: readonly FileChange[]
  readonly filesCreated?: readonly string[]
  readonly filesDeleted?: readonly string[]
  readonly relevantMemoryRefs?: readonly string[]
  readonly suggestedMemoryUpdates?: readonly string[]
  readonly resumptionInstructions?: string
}

export interface ValidationResult {
  readonly valid: boolean
  readonly completeness: number
  readonly missingFields: readonly string[]
  readonly warnings: readonly string[]
}

// ── Public interface ─────────────────────────────────────────────────

export interface HandoffGenerator {
  generate(input: HandoffInput): HandoffDocument
  toMarkdown(doc: HandoffDocument): string
  fromMarkdown(markdown: string): HandoffDocument
  validate(doc: HandoffDocument): ValidationResult
  markConsumed(doc: HandoffDocument, targetSessionId: string): HandoffDocument
}

// ── Priority ordering for sorting ────────────────────────────────────

const PRIORITY_ORDER: Record<WorkItem['priority'], number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
}

// ── Factory ──────────────────────────────────────────────────────────

export function createHandoffGenerator(deps?: HandoffGeneratorDeps): HandoffGenerator {
  const getSessionInfo = deps?.getSessionInfo ?? (() => null)
  const getTeamInfo = deps?.getTeamInfo ?? (() => null)

  function generate(input: HandoffInput): HandoffDocument {
    const sessionInfo = getSessionInfo(input.sessionId)
    const teamInfo = getTeamInfo(input.sessionId)
    const now = new Date()

    let elapsedMinutes = 0
    if (sessionInfo?.startedAt) {
      const startedAt = new Date(sessionInfo.startedAt)
      elapsedMinutes = Math.round((now.getTime() - startedAt.getTime()) / 60_000)
    }

    const sorted = input.pendingWork
      ? [...input.pendingWork].sort(
          (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
        )
      : []

    return {
      id: randomUUID(),
      sourceSessionId: input.sessionId,
      targetSessionId: null,
      createdAt: now.toISOString(),
      status: HandoffStatus.Ready,

      sessionPurpose: sessionInfo?.purpose ?? 'Unknown',
      workingDir: sessionInfo?.workingDir ?? process.cwd(),
      elapsedMinutes,
      tokenUsage: { estimated: 0, max: 200_000, percent: 0 },

      currentTask: input.currentTask ?? null,
      pendingWork: sorted,
      completedWork: input.completedWork ?? [],
      blockedWork: input.blockedWork ?? [],

      keyDecisions: input.keyDecisions ?? [],
      discoveredFacts: input.discoveredFacts ?? [],
      warnings: input.warnings ?? [],

      filesModified: input.filesModified ?? [],
      filesCreated: input.filesCreated ?? [],
      filesDeleted: input.filesDeleted ?? [],

      teamId: teamInfo?.teamId ?? null,
      teamRole: teamInfo?.role ?? null,
      teamPhase: teamInfo?.phase ?? null,

      relevantMemoryRefs: input.relevantMemoryRefs ?? [],
      suggestedMemoryUpdates: input.suggestedMemoryUpdates ?? [],

      resumptionInstructions: input.resumptionInstructions ?? '',
    }
  }

  function toMarkdown(doc: HandoffDocument): string {
    const lines: string[] = []

    lines.push(`# Session Handoff: ${doc.id}`)
    lines.push('')

    // Source session
    lines.push('## Source Session')
    lines.push(`- **Session ID**: ${doc.sourceSessionId}`)
    lines.push(`- **Purpose**: ${doc.sessionPurpose}`)
    lines.push(`- **Working Dir**: ${doc.workingDir}`)
    lines.push(`- **Duration**: ${doc.elapsedMinutes} minutes`)
    lines.push(
      `- **Token Usage**: ${doc.tokenUsage.estimated}/${doc.tokenUsage.max} (${doc.tokenUsage.percent}%)`,
    )
    lines.push('')

    // Current task
    lines.push('## Current Task')
    lines.push(doc.currentTask ?? 'No active task')
    lines.push('')

    // Pending work
    if (doc.pendingWork.length > 0) {
      lines.push('## Pending Work')
      for (const item of doc.pendingWork) {
        lines.push(`- [ ] ${item.description} [${item.priority}]`)
      }
      lines.push('')
    }

    // Completed work
    if (doc.completedWork.length > 0) {
      lines.push('## Completed Work')
      for (const item of doc.completedWork) {
        lines.push(`- [x] ${item}`)
      }
      lines.push('')
    }

    // Blocked work
    if (doc.blockedWork.length > 0) {
      lines.push('## Blocked Work')
      for (const item of doc.blockedWork) {
        lines.push(`- ⛔ ${item.description} — blocked by: ${item.blockedBy}`)
      }
      lines.push('')
    }

    // Key decisions
    if (doc.keyDecisions.length > 0) {
      lines.push('## Key Decisions')
      for (let i = 0; i < doc.keyDecisions.length; i++) {
        const d = doc.keyDecisions[i]!
        lines.push(`${i + 1}. **${d.description}**: ${d.rationale}`)
      }
      lines.push('')
    }

    // Discovered facts
    if (doc.discoveredFacts.length > 0) {
      lines.push('## Discovered Facts')
      for (const fact of doc.discoveredFacts) {
        lines.push(`- ${fact}`)
      }
      lines.push('')
    }

    // Warnings
    if (doc.warnings.length > 0) {
      lines.push('## Warnings')
      for (const warning of doc.warnings) {
        lines.push(`- ⚠️ ${warning}`)
      }
      lines.push('')
    }

    // Files changed
    if (
      doc.filesModified.length > 0 ||
      doc.filesCreated.length > 0 ||
      doc.filesDeleted.length > 0
    ) {
      lines.push('## Files Changed')
      lines.push('| File | Action | Summary |')
      lines.push('|------|--------|---------|')
      for (const f of doc.filesModified) {
        lines.push(`| ${f.path} | ${f.changeType} | ${f.summary ?? ''} |`)
      }
      for (const path of doc.filesCreated) {
        lines.push(`| ${path} | created | |`)
      }
      for (const path of doc.filesDeleted) {
        lines.push(`| ${path} | deleted | |`)
      }
      lines.push('')
    }

    // Team context
    if (doc.teamId !== null) {
      lines.push('## Team Context')
      lines.push(`- **Team**: ${doc.teamId}`)
      lines.push(`- **Role**: ${doc.teamRole}`)
      lines.push(`- **Phase**: ${doc.teamPhase}`)
      lines.push('')
    }

    // Memory references
    if (doc.relevantMemoryRefs.length > 0) {
      lines.push('## Memory References')
      for (const ref of doc.relevantMemoryRefs) {
        lines.push(`- ${ref}`)
      }
      lines.push('')
    }

    // Suggested memory updates
    if (doc.suggestedMemoryUpdates.length > 0) {
      lines.push('## Suggested Memory Updates')
      for (const update of doc.suggestedMemoryUpdates) {
        lines.push(`- ${update}`)
      }
      lines.push('')
    }

    // Resumption instructions
    if (doc.resumptionInstructions) {
      lines.push('## Resumption Instructions')
      lines.push(doc.resumptionInstructions)
      lines.push('')
    }

    // Footer
    lines.push('---')
    lines.push(`*Generated at ${doc.createdAt} | Status: ${doc.status}*`)

    return lines.join('\n')
  }

  function fromMarkdown(markdown: string): HandoffDocument {
    const lines = markdown.split('\n')

    // Parse header: # Session Handoff: {id}
    const headerMatch = lines[0]?.match(/^# Session Handoff:\s+(.+)$/)
    const id = headerMatch?.[1] ?? ''

    // Helper to find a section
    function findSection(heading: string): string[] {
      const idx = lines.findIndex((l) => l.trim() === `## ${heading}`)
      if (idx === -1) return []
      const result: string[] = []
      for (let i = idx + 1; i < lines.length; i++) {
        const line = lines[i]!
        if (line.startsWith('## ') || line.startsWith('# ') || line === '---') break
        if (line.trim() !== '') result.push(line)
      }
      return result
    }

    // Parse source session
    const sourceLines = findSection('Source Session')
    function extractField(fieldLines: string[], label: string): string {
      const line = fieldLines.find((l) => l.includes(`**${label}**`))
      return line?.replace(new RegExp(`^-\\s+\\*\\*${label}\\*\\*:\\s*`), '').trim() ?? ''
    }

    const sourceSessionId = extractField(sourceLines, 'Session ID')
    const sessionPurpose = extractField(sourceLines, 'Purpose')
    const workingDir = extractField(sourceLines, 'Working Dir')
    const durationStr = extractField(sourceLines, 'Duration')
    const elapsedMinutes = parseInt(durationStr, 10) || 0
    const tokenUsageStr = extractField(sourceLines, 'Token Usage')
    const tokenMatch = tokenUsageStr.match(/(\d+)\/(\d+)\s*\((\d+)%\)/)
    const tokenUsage = tokenMatch
      ? {
          estimated: parseInt(tokenMatch[1]!, 10),
          max: parseInt(tokenMatch[2]!, 10),
          percent: parseInt(tokenMatch[3]!, 10),
        }
      : { estimated: 0, max: 200_000, percent: 0 }

    // Current task
    const taskLines = findSection('Current Task')
    const currentTask =
      taskLines.length > 0 && taskLines[0] !== 'No active task' ? taskLines.join('\n') : null

    // Pending work
    const pendingLines = findSection('Pending Work')
    const pendingWork: WorkItem[] = pendingLines
      .filter((l) => l.startsWith('- [ ] '))
      .map((l) => {
        const match = l.match(/^- \[ \]\s+(.+?)\s+\[(critical|high|normal|low)\]$/)
        if (!match) return { description: l.replace('- [ ] ', ''), priority: 'normal' as const }
        return { description: match[1]!, priority: match[2]! as WorkItem['priority'] }
      })

    // Completed work
    const completedLines = findSection('Completed Work')
    const completedWork = completedLines
      .filter((l) => l.startsWith('- [x] '))
      .map((l) => l.replace('- [x] ', ''))

    // Blocked work
    const blockedLines = findSection('Blocked Work')
    const blockedWork: BlockedItem[] = blockedLines
      .filter((l) => l.includes('⛔'))
      .map((l) => {
        const match = l.match(/^- ⛔\s+(.+?)\s+—\s+blocked by:\s+(.+)$/)
        if (!match) return { description: l, blockedBy: 'unknown', since: '' }
        return { description: match[1]!, blockedBy: match[2]!, since: '' }
      })

    // Key decisions
    const decisionLines = findSection('Key Decisions')
    const keyDecisions: Decision[] = decisionLines
      .filter((l) => /^\d+\.\s+\*\*/.test(l))
      .map((l) => {
        const match = l.match(/^\d+\.\s+\*\*(.+?)\*\*:\s+(.+)$/)
        if (!match) return { description: l, rationale: '' }
        return { description: match[1]!, rationale: match[2]! }
      })

    // Discovered facts
    const factLines = findSection('Discovered Facts')
    const discoveredFacts = factLines
      .filter((l) => l.startsWith('- '))
      .map((l) => l.replace(/^- /, ''))

    // Warnings
    const warningLines = findSection('Warnings')
    const warnings = warningLines
      .filter((l) => l.includes('⚠️'))
      .map((l) => l.replace(/^- ⚠️\s*/, ''))

    // Files changed
    const fileLines = findSection('Files Changed')
    const filesModified: FileChange[] = []
    const filesCreated: string[] = []
    const filesDeleted: string[] = []
    for (const line of fileLines) {
      if (line.startsWith('|') && !line.includes('------') && !line.includes('File')) {
        const parts = line
          .split('|')
          .map((p) => p.trim())
          .filter(Boolean)
        if (parts.length >= 2) {
          const path = parts[0]!
          const action = parts[1]!
          const summary = parts[2] ?? ''
          if (action === 'created' && !summary) {
            filesCreated.push(path)
          } else if (action === 'deleted' && !summary) {
            filesDeleted.push(path)
          } else {
            filesModified.push({
              path,
              changeType: action as FileChange['changeType'],
              summary: summary || undefined,
            })
          }
        }
      }
    }

    // Team context
    const teamLines = findSection('Team Context')
    const teamId = extractField(teamLines, 'Team') || null
    const teamRole = extractField(teamLines, 'Role') || null
    const teamPhase = extractField(teamLines, 'Phase') || null

    // Memory references
    const memRefLines = findSection('Memory References')
    const relevantMemoryRefs = memRefLines
      .filter((l) => l.startsWith('- '))
      .map((l) => l.replace(/^- /, ''))

    // Suggested memory updates
    const memUpdateLines = findSection('Suggested Memory Updates')
    const suggestedMemoryUpdates = memUpdateLines
      .filter((l) => l.startsWith('- '))
      .map((l) => l.replace(/^- /, ''))

    // Resumption instructions
    const resumptionLines = findSection('Resumption Instructions')
    const resumptionInstructions = resumptionLines.join('\n')

    // Footer: parse status and createdAt
    const footerLine = lines.find((l) => l.startsWith('*Generated at'))
    const footerMatch = footerLine?.match(/\*Generated at (.+?) \| Status: (.+?)\*/)
    const createdAt = footerMatch?.[1] ?? new Date().toISOString()
    const status = (footerMatch?.[2] ?? HandoffStatus.Ready) as HandoffStatus

    return {
      id,
      sourceSessionId,
      targetSessionId: null,
      createdAt,
      status,
      sessionPurpose,
      workingDir,
      elapsedMinutes,
      tokenUsage,
      currentTask,
      pendingWork,
      completedWork,
      blockedWork,
      keyDecisions,
      discoveredFacts,
      warnings,
      filesModified,
      filesCreated,
      filesDeleted,
      teamId,
      teamRole,
      teamPhase,
      relevantMemoryRefs,
      suggestedMemoryUpdates,
      resumptionInstructions,
    }
  }

  function validate(doc: HandoffDocument): ValidationResult {
    const missingFields: string[] = []
    const warnings: string[] = []

    // Required / important fields
    const checks: Array<{ field: string; present: boolean; weight: number }> = [
      { field: 'sourceSessionId', present: !!doc.sourceSessionId, weight: 15 },
      {
        field: 'sessionPurpose',
        present: doc.sessionPurpose !== 'Unknown' && doc.sessionPurpose !== '',
        weight: 10,
      },
      { field: 'currentTask', present: doc.currentTask !== null, weight: 10 },
      { field: 'pendingWork', present: doc.pendingWork.length > 0, weight: 15 },
      { field: 'completedWork', present: doc.completedWork.length > 0, weight: 10 },
      { field: 'keyDecisions', present: doc.keyDecisions.length > 0, weight: 10 },
      {
        field: 'filesModified',
        present:
          doc.filesModified.length > 0 ||
          doc.filesCreated.length > 0 ||
          doc.filesDeleted.length > 0,
        weight: 10,
      },
      { field: 'resumptionInstructions', present: !!doc.resumptionInstructions, weight: 15 },
      { field: 'discoveredFacts', present: doc.discoveredFacts.length > 0, weight: 5 },
    ]

    let total = 0
    let earned = 0
    for (const check of checks) {
      total += check.weight
      if (check.present) {
        earned += check.weight
      } else {
        missingFields.push(check.field)
      }
    }

    const completeness = total > 0 ? Math.round((earned / total) * 100) : 0

    if (!doc.resumptionInstructions) {
      warnings.push('Missing resumption instructions — the next session may lack context')
    }

    if (doc.pendingWork.length === 0 && doc.completedWork.length === 0) {
      warnings.push('No work items recorded — handoff may be incomplete')
    }

    return {
      valid: completeness >= 50,
      completeness,
      missingFields,
      warnings,
    }
  }

  function markConsumed(doc: HandoffDocument, targetSessionId: string): HandoffDocument {
    return {
      ...doc,
      status: HandoffStatus.Consumed,
      targetSessionId,
    }
  }

  return { generate, toMarkdown, fromMarkdown, validate, markConsumed }
}
