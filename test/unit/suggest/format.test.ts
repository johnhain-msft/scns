import { describe, it, expect } from 'vitest'
import {
  formatSummaryRow,
  formatSuggestionDetail,
  formatSummaryTable,
  formatReviewResult,
  formatPlan,
} from '../../../src/suggest/format.js'
import type { SuggestionSummary, ReviewResult } from '../../../src/suggest/review.js'
import type { Suggestion } from '../../../src/suggest/types.js'
import type { ImplementationPlan } from '../../../src/suggest/executor.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<SuggestionSummary> = {}): SuggestionSummary {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'skill',
    title: 'Create git helper skill',
    confidence: 0.85,
    evidenceCount: 3,
    createdAt: '2025-01-15T10:00:00Z',
    tags: ['git', 'automation'],
    ...overrides,
  }
}

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'skill',
    title: 'Create git helper skill',
    description: 'You frequently run the same git commit pattern.',
    status: 'pending',
    confidence: 0.85,
    evidence: [
      {
        source: 'tool-frequency',
        detail: 'Git used 45 times in last 7 days',
        observedAt: '2025-01-15T10:00:00Z',
        weight: 0.8,
      },
      {
        source: 'project-focus',
        detail: 'Commits to scns repo daily',
        observedAt: '2025-01-15T11:00:00Z',
        weight: 0.6,
      },
    ],
    tags: ['git', 'automation'],
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:00:00Z',
    ...overrides,
  }
}

function makePlan(overrides: Partial<ImplementationPlan> = {}): ImplementationPlan {
  return {
    suggestionId: '550e8400-e29b-41d4-a716-446655440000',
    steps: [
      {
        order: 1,
        action: 'create-file',
        description: 'Create skill file',
        target: '/skills/git.md',
      },
      { order: 2, action: 'configure-agent', description: 'Register skill in agent config' },
    ],
    estimatedMinutes: 5,
    requiresUserApproval: true,
    ...overrides,
  }
}

// ── formatSummaryRow ─────────────────────────────────────────────────

describe('formatSummaryRow', () => {
  it('includes truncated ID (first 8 chars)', () => {
    const row = formatSummaryRow(makeSummary())
    expect(row).toContain('550e8400')
    expect(row).not.toContain('550e8400-e29b-41d4-a716-446655440000')
  })

  it('includes type, title, and evidence count', () => {
    const row = formatSummaryRow(makeSummary())
    expect(row).toContain('skill')
    expect(row).toContain('Create git helper skill')
    expect(row).toContain('3')
  })

  it('formats confidence as percentage', () => {
    const row = formatSummaryRow(makeSummary({ confidence: 0.85 }))
    expect(row).toContain('85%')
  })

  it('truncates long titles', () => {
    const longTitle =
      'A very long suggestion title that should be truncated for display purposes in the table'
    const row = formatSummaryRow(makeSummary({ title: longTitle }))
    expect(row).toContain('…')
    expect(row.length).toBeLessThan(longTitle.length + 80)
  })

  it('handles zero evidence', () => {
    const row = formatSummaryRow(makeSummary({ evidenceCount: 0 }))
    expect(row).toContain('0')
  })

  it('includes date portion of createdAt', () => {
    const row = formatSummaryRow(makeSummary({ createdAt: '2025-01-15T10:00:00Z' }))
    expect(row).toContain('2025-01-15')
  })
})

// ── formatSummaryTable ───────────────────────────────────────────────

describe('formatSummaryTable', () => {
  it('includes header row with column names', () => {
    const table = formatSummaryTable([makeSummary()])
    expect(table).toContain('ID')
    expect(table).toContain('Type')
    expect(table).toContain('Title')
    expect(table).toContain('Confidence')
  })

  it('renders multiple rows aligned', () => {
    const summaries = [
      makeSummary({ id: '550e8400-e29b-41d4-a716-446655440001', confidence: 0.9 }),
      makeSummary({ id: '550e8400-e29b-41d4-a716-446655440002', confidence: 0.5 }),
    ]
    const table = formatSummaryTable(summaries)
    const lines = table.split('\n').filter(Boolean)
    // Header + separator + 2 data rows = at least 4 lines
    expect(lines.length).toBeGreaterThanOrEqual(4)
  })

  it('returns "No pending suggestions" for empty list', () => {
    const table = formatSummaryTable([])
    expect(table).toContain('No pending suggestions')
  })
})

// ── formatSuggestionDetail ───────────────────────────────────────────

describe('formatSuggestionDetail', () => {
  it('includes all core suggestion fields', () => {
    const detail = formatSuggestionDetail(makeSuggestion())
    expect(detail).toContain('Create git helper skill')
    expect(detail).toContain('skill')
    expect(detail).toContain('pending')
    expect(detail).toContain('85%')
    expect(detail).toContain('You frequently run the same git commit pattern.')
  })

  it('formats evidence as bullet list', () => {
    const detail = formatSuggestionDetail(makeSuggestion())
    expect(detail).toContain('tool-frequency')
    expect(detail).toContain('Git used 45 times in last 7 days')
    expect(detail).toContain('project-focus')
  })

  it('displays tags', () => {
    const detail = formatSuggestionDetail(makeSuggestion())
    expect(detail).toContain('git')
    expect(detail).toContain('automation')
  })

  it('shows implementation plan when present', () => {
    const detail = formatSuggestionDetail(
      makeSuggestion({ implementationPlan: 'Create a skill file and register it' }),
    )
    expect(detail).toContain('Create a skill file and register it')
  })

  it('handles missing optional fields gracefully', () => {
    const suggestion = makeSuggestion({
      tags: [],
      evidence: [],
      implementationPlan: undefined,
      reviewReason: undefined,
    })
    const detail = formatSuggestionDetail(suggestion)
    expect(detail).toContain('Create git helper skill')
    // Should not throw or contain "undefined"
    expect(detail).not.toContain('undefined')
  })

  it('shows status and confidence visibly', () => {
    const detail = formatSuggestionDetail(makeSuggestion({ status: 'approved', confidence: 0.92 }))
    expect(detail).toContain('approved')
    expect(detail).toContain('92%')
  })
})

// ── formatReviewResult ───────────────────────────────────────────────

describe('formatReviewResult', () => {
  it('shows success message with plan summary on approve', () => {
    const result: ReviewResult = {
      success: true,
      suggestion: makeSuggestion({ status: 'approved' }),
      plan: makePlan(),
    }
    const output = formatReviewResult(result)
    expect(output).toContain('Approved')
    expect(output).toContain('2 steps')
    expect(output).toContain('5 min')
  })

  it('shows rejection confirmation on reject', () => {
    const result: ReviewResult = {
      success: true,
      suggestion: makeSuggestion({ status: 'rejected', reviewReason: 'Not needed' }),
    }
    const output = formatReviewResult(result)
    expect(output).toContain('Rejected')
    expect(output).toContain('Not needed')
  })

  it('shows error message on failure', () => {
    const result: ReviewResult = {
      success: false,
      suggestion: null,
      error: 'Suggestion abc not found',
    }
    const output = formatReviewResult(result)
    expect(output).toContain('Error')
    expect(output).toContain('Suggestion abc not found')
  })
})

// ── formatPlan ───────────────────────────────────────────────────────

describe('formatPlan', () => {
  it('numbers steps sequentially', () => {
    const output = formatPlan(makePlan())
    expect(output).toContain('1.')
    expect(output).toContain('2.')
  })

  it('shows action and description for each step', () => {
    const output = formatPlan(makePlan())
    expect(output).toContain('create-file')
    expect(output).toContain('Create skill file')
    expect(output).toContain('configure-agent')
    expect(output).toContain('Register skill in agent config')
  })

  it('shows target path when present', () => {
    const output = formatPlan(makePlan())
    expect(output).toContain('/skills/git.md')
  })

  it('shows estimated minutes', () => {
    const output = formatPlan(makePlan({ estimatedMinutes: 10 }))
    expect(output).toContain('10')
    expect(output).toContain('min')
  })
})

// ── formatSuggestionDetail — type-specific formatting ────────────────

describe('formatSuggestionDetail type-specific formatting', () => {
  it('formats prompt type with prompt label', () => {
    const detail = formatSuggestionDetail(
      makeSuggestion({ type: 'prompt', description: 'Optimize system prompt for claude-sonnet-4' }),
    )
    expect(detail).toContain('prompt')
    expect(detail).toContain('Suggested prompt')
  })

  it('formats extension type with extension label', () => {
    const detail = formatSuggestionDetail(
      makeSuggestion({
        type: 'extension',
        description: 'Create a code-search extension to combine grep and view',
      }),
    )
    expect(detail).toContain('extension')
    expect(detail).toContain('Extension config')
  })

  it('formats lsp type with config label', () => {
    const detail = formatSuggestionDetail(
      makeSuggestion({ type: 'lsp', description: 'Configure TypeScript LSP with strict mode' }),
    )
    expect(detail).toContain('lsp')
    expect(detail).toContain('LSP config')
  })

  it('formats github-action type with workflow label', () => {
    const detail = formatSuggestionDetail(
      makeSuggestion({ type: 'github-action', description: 'Create CI/CD workflow for scns' }),
    )
    expect(detail).toContain('github-action')
    expect(detail).toContain('Workflow preview')
  })

  it('formats agentic-workflow type with steps label', () => {
    const detail = formatSuggestionDetail(
      makeSuggestion({ type: 'agentic-workflow', description: 'Automate bash → edit workflow' }),
    )
    expect(detail).toContain('agentic-workflow')
    expect(detail).toContain('Workflow steps')
  })

  it('formats instruction type with instruction label', () => {
    const detail = formatSuggestionDetail(
      makeSuggestion({
        type: 'instruction',
        description: 'Add default model preference for claude-sonnet-4',
      }),
    )
    expect(detail).toContain('instruction')
    expect(detail).toContain('Instruction')
  })

  it('does not add type-specific section for standard types', () => {
    const detail = formatSuggestionDetail(makeSuggestion({ type: 'skill' }))
    expect(detail).not.toContain('Suggested prompt')
    expect(detail).not.toContain('Extension config')
    expect(detail).not.toContain('LSP config')
    expect(detail).not.toContain('Workflow preview')
    expect(detail).not.toContain('Workflow steps')
    expect(detail).not.toContain('Instruction')
  })
})
