/**
 * Suggestion type values — MUST stay in sync with backend `SuggestionType`
 * in `src/suggest/types.ts`. A parity test in
 * `test/unit/suggest/dashboard-type-parity.test.ts` reads this file and
 * asserts the arrays match so backend-type additions can't silently drift.
 *
 * Phase 13.12.7.
 */

export const SUGGESTION_TYPES = [
  'skill',
  'agent',
  'mcp',
  'automation',
  'workflow',
  'prompt',
  'extension',
  'lsp',
  'github-action',
  'agentic-workflow',
  'instruction',
  'tag-proposal',
  'browser-automation',
  'arm-promotion',
] as const

export type SuggestionTypeValue = (typeof SUGGESTION_TYPES)[number]

/** Human-friendly label for a suggestion type (title-case). */
export function labelForType(type: string): string {
  const explicit: Record<string, string> = {
    mcp: 'MCP',
    lsp: 'LSP',
    'github-action': 'GitHub Action',
    'agentic-workflow': 'Agentic Workflow',
    'tag-proposal': 'Tag proposal',
    'browser-automation': 'Browser Automation',
    'arm-promotion': 'Retrieval arm promotion',
  }
  if (explicit[type]) return explicit[type]
  return type
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
}
