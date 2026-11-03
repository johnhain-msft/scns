/**
 * Output formatting helpers for the suggestion review CLI.
 */

import type { Suggestion } from './types.js'
import type { SuggestionSummary, ReviewResult } from './review.js'
import type { ImplementationPlan } from './executor.js'
import type { ArtifactOutput } from './artifact-generators.js'

const MAX_TITLE_LEN = 40

const TYPE_SPECIFIC_LABELS: Record<string, string> = {
  prompt: 'Suggested prompt',
  extension: 'Extension config',
  lsp: 'LSP config',
  'github-action': 'Workflow preview',
  'agentic-workflow': 'Workflow steps',
  instruction: 'Instruction',
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function pad(s: string, len: number): string {
  return s.padEnd(len)
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10)
}

/** Format a suggestion summary as a single table row */
export function formatSummaryRow(summary: SuggestionSummary): string {
  const id = summary.id.slice(0, 8)
  const title = truncate(summary.title, MAX_TITLE_LEN)
  const confidence = pct(summary.confidence)
  const evidence = `${summary.evidenceCount} evidence`
  const date = dateOnly(summary.createdAt)
  return `${pad(id, 10)}${pad(summary.type, 14)}${pad(title, MAX_TITLE_LEN + 2)}${pad(confidence, 8)}${pad(evidence, 14)}${date}`
}

/** Format a list of summaries as an aligned table */
export function formatSummaryTable(summaries: readonly SuggestionSummary[]): string {
  if (summaries.length === 0) {
    return 'No pending suggestions'
  }

  const header = `${pad('ID', 10)}${pad('Type', 14)}${pad('Title', MAX_TITLE_LEN + 2)}${pad('Confidence', 8)}${pad('Evidence', 14)}Date`
  const separator = '─'.repeat(header.length)
  const rows = summaries.map(formatSummaryRow)
  return [header, separator, ...rows].join('\n')
}

/** Format a full suggestion detail view */
export function formatSuggestionDetail(suggestion: Suggestion): string {
  const lines: string[] = [
    `  Title:       ${suggestion.title}`,
    `  Type:        ${suggestion.type}`,
    `  Status:      ${suggestion.status}`,
    `  Confidence:  ${pct(suggestion.confidence)}`,
    `  ID:          ${suggestion.id}`,
    `  Created:     ${dateOnly(suggestion.createdAt)}`,
    '',
    '  Description:',
    `  ${suggestion.description}`,
  ]

  // Type-specific content sections
  const typeLabel = TYPE_SPECIFIC_LABELS[suggestion.type]
  if (typeLabel != null) {
    lines.push('', `  ${typeLabel}:`, `    ${suggestion.description}`)
  }

  if (suggestion.evidence.length > 0) {
    lines.push('', '  Evidence:')
    for (const e of suggestion.evidence) {
      lines.push(`    • [${e.source}] ${e.detail} (weight: ${e.weight})`)
    }
  }

  if (suggestion.tags.length > 0) {
    lines.push('', `  Tags: ${suggestion.tags.join(', ')}`)
  }

  if (suggestion.reviewReason) {
    lines.push('', `  Review reason: ${suggestion.reviewReason}`)
  }

  if (suggestion.implementationPlan) {
    lines.push('', '  Implementation plan:', `  ${suggestion.implementationPlan}`)
  }

  return lines.join('\n')
}

/** Format a review result for CLI output */
export function formatReviewResult(result: ReviewResult): string {
  if (!result.success) {
    return `Error: ${result.error}`
  }

  const suggestion = result.suggestion!
  if (suggestion.status === 'rejected') {
    const reason = suggestion.reviewReason ?? 'No reason given'
    return `Rejected: ${suggestion.title}\n  Reason: ${reason}`
  }

  // Approved
  const lines = [`Approved: ${suggestion.title}`]
  if (result.plan) {
    lines.push(`  Plan: ${result.plan.steps.length} steps, ~${result.plan.estimatedMinutes} min`)
  }
  if (result.execution) {
    lines.push(
      `  Executed: ${result.execution.stepsCompleted}/${result.execution.stepsTotal} steps completed`,
    )
  }
  return lines.join('\n')
}

/** Format an implementation plan for CLI output */
export function formatPlan(plan: ImplementationPlan): string {
  const lines = [
    `Plan for ${plan.suggestionId.slice(0, 8)}:`,
    `  Estimated: ${plan.estimatedMinutes} min | Requires approval: ${plan.requiresUserApproval ? 'yes' : 'no'}`,
    '',
    '  Steps:',
  ]

  for (const step of plan.steps) {
    let line = `    ${step.order}. [${step.action}] ${step.description}`
    if (step.target) {
      line += `\n       Target: ${step.target}`
    }
    lines.push(line)
  }

  return lines.join('\n')
}

/** Format an artifact preview for CLI output */
export function formatArtifactPreview(artifact: ArtifactOutput): string {
  const mode = artifact.overwrite ? 'overwrite' : 'append/create'
  const lines = [
    `Artifact Preview:`,
    `  Path:     ${artifact.path}`,
    `  Format:   ${artifact.format}`,
    `  Mode:     ${mode}`,
    '',
    '─'.repeat(60),
    artifact.content,
    '─'.repeat(60),
  ]

  return lines.join('\n')
}
