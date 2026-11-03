/**
 * D1 — ideation prompt builder (PURE).
 *
 * Turns assembled {@link IdeationSignals} into the structured prompt the real
 * Copilot ACP session receives. The agent is asked for exactly K concrete,
 * NOVEL, high-value improvements that DON'T yet exist, emitted as a STRICT JSON
 * array (no prose / no markdown) so {@link parseIdeationResponse} can read it
 * deterministically.
 */

import { IDEATION_PROPOSAL_FIELDS } from './types.js'
import type { IdeationSignals } from './types.js'

export interface BuildIdeationPromptOptions {
  /** How many proposals to request. Must be a positive integer. */
  readonly k: number
}

function renderTelemetry(signals: IdeationSignals): string {
  const t = signals.telemetry
  if (t == null) {
    return '## Telemetry\n(telemetry unavailable for this window)'
  }
  const tools = t.topTools.map((x) => `${x.tool} (${x.uses})`).join(', ') || '(none)'
  const models = t.topModels.map((x) => `${x.model} (${x.calls})`).join(', ') || '(none)'
  const hours = t.busiestHours.map((x) => `${x.hour}:00 (${x.sessions})`).join(', ') || '(none)'
  return [
    '## Telemetry (otel/OM)',
    `- Sessions analyzed: ${t.totalSessions} over ~${t.windowDays}d`,
    `- Primary model: ${t.primaryModel ?? '(unknown)'}`,
    `- Top tools: ${tools}`,
    `- Top models: ${models}`,
    `- Busiest hours: ${hours}`,
  ].join('\n')
}

function renderCodebase(signals: IdeationSignals): string {
  const modules = signals.codebase.modules.join(', ') || '(none)'
  return ['## Codebase', `- ${signals.codebase.description}`, `- src/ modules: ${modules}`].join(
    '\n',
  )
}

function renderList(label: string, items: readonly string[]): string {
  if (items.length === 0) return `- ${label}: (none)`
  return `- ${label}:\n${items.map((i) => `  - ${i}`).join('\n')}`
}

function renderRecentOutcomes(signals: IdeationSignals): string {
  const r = signals.recentOutcomes
  return [
    '## Recent suggestion outcomes (do NOT re-propose these)',
    renderList('Implemented', r.implemented),
    renderList('Rejected', r.rejected),
    renderList('Failed', r.failed),
    `- Pending: ${r.pendingCount}`,
  ].join('\n')
}

function renderGaps(signals: IdeationSignals): string {
  if (signals.openGaps.length === 0) return '## Open gaps\n- (none recorded)'
  return [
    '## Open gaps',
    ...signals.openGaps.map((g) => `- [${g.source}] ${g.detail}`),
  ].join('\n')
}

function renderPriorOutcomes(signals: IdeationSignals): string {
  if (signals.priorProposalOutcomes.length === 0) {
    return '## Outcomes of your prior proposals\n- (none yet — this is an early cycle)'
  }
  return [
    '## Outcomes of your prior proposals (learn from what landed)',
    ...signals.priorProposalOutcomes.map((p) => `- "${p.title}" → ${p.outcome}`),
  ].join('\n')
}

/** Build the field-by-field JSON shape description shared with the parser. */
function renderJsonShape(): string {
  const fields = IDEATION_PROPOSAL_FIELDS.map((f) => `    "${f}": "<string>"`).join(',\n')
  return ['[', '  {', fields, '  }', '  // ... one object per proposal', ']'].join('\n')
}

/**
 * Compose the full ideation prompt. Throws when `k` is not a positive integer.
 */
export function buildIdeationPrompt(
  signals: IdeationSignals,
  options: BuildIdeationPromptOptions,
): string {
  const { k } = options
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(`buildIdeationPrompt requires a positive integer k (got ${k})`)
  }

  const fieldList = IDEATION_PROPOSAL_FIELDS.map((f) => `\`${f}\``).join(', ')

  return [
    '# SCNS Ideation Engine',
    '',
    'You are the ideation engine for SCNS, an autonomous self-improving multi-agent',
    'system that runs on a real machine. Your job is NOT to validate or refine an',
    'existing change — it is to INVENT. Reason over the real signals below and',
    `propose exactly ${k} concrete, NOVEL, high-value improvements to SCNS that DO`,
    'NOT yet exist: new agents, features, capabilities, or fixes. Each idea must be:',
    '',
    '- Novel: not already present and not in the "recent suggestion outcomes" list.',
    '- Grounded: justified by the signals below (telemetry, gaps, codebase).',
    '- High-value: it should meaningfully improve the system, not be cosmetic.',
    '- Testable: small enough that a single objective criterion can prove it works.',
    '- Self-contained: you have NO tool access in this session — do NOT try to read',
    '  files, list directories, or run commands (such attempts are denied and only',
    '  waste your turn). Reason ONLY from the signals provided below.',
    '',
    '## Signals',
    '',
    renderTelemetry(signals),
    '',
    renderCodebase(signals),
    '',
    renderRecentOutcomes(signals),
    '',
    renderGaps(signals),
    '',
    renderPriorOutcomes(signals),
    '',
    '## Required output',
    '',
    `Return ONLY a strict JSON array of exactly ${k} objects. Output nothing but`,
    'the JSON — no prose, no explanation, no markdown fences, do not wrap it in',
    'backticks. Each object MUST have all of these string fields: ' + fieldList + '.',
    '',
    'Shape:',
    '',
    renderJsonShape(),
  ].join('\n')
}
