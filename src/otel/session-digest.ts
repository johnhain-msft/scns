/**
 * Session digest — generates markdown digests and memory entries from SessionSummary.
 *
 * Produces structured MemoryEntry objects for AutoDream consolidation and
 * markdown files for vault storage.
 */

import type { MemoryEntry } from '../dream/memory-entries.js'
import type { Vault } from '../memory/vault.js'
import type { SessionSummary } from './session-extractor.js'

// ── Types ────────────────────────────────────────────────────

export interface SessionDigest {
  readonly sessionId: string
  readonly sessionDate: string
  readonly markdown: string
  readonly memoryEntries: ReadonlyArray<MemoryEntry>
  readonly generatedAt: string
}

// ── Formatting helpers ───────────────────────────────────────

/** Format milliseconds as human-readable duration. */
function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return 'Unknown'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainSec = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainSec}s`
  const hours = Math.floor(minutes / 60)
  const remainMin = minutes % 60
  return `${hours}h ${remainMin}m`
}

/** Format a number with comma separators. */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** Truncate a session ID for display (first 8 chars). */
function truncateId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** Extract YYYY-MM-DD from an ISO timestamp, with fallback. */
function extractDate(isoTimestamp: string): string {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(isoTimestamp)
  return match ? match[0] : new Date().toISOString().slice(0, 10)
}

/** Sanitize a string for use as a filename (keep alphanumeric, dash, underscore). */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200)
}

// ── Markdown generation ──────────────────────────────────────

function generateMarkdown(summary: SessionSummary): string {
  const sections: string[] = []
  const date = extractDate(summary.startTime)
  const shortId = truncateId(summary.sessionId)

  // Header
  sections.push(`# Session Digest: ${shortId}`)
  sections.push(`**Date:** ${date}  `)
  sections.push(`**Duration:** ${formatDuration(summary.durationMs)}  `)
  sections.push(`**Spans:** ${formatNumber(summary.spanCount)}  `)
  sections.push(`**Traces:** ${summary.traceIds.length}`)

  // Models
  sections.push('\n## Models\n')
  if (summary.models.length === 0) {
    sections.push('No model usage recorded.')
  } else {
    sections.push('| Model | Calls |')
    sections.push('|-------|-------|')
    for (const m of summary.models) {
      sections.push(`| ${m.model} | ${formatNumber(m.callCount)} |`)
    }
  }

  // Tools (top 10)
  sections.push('\n## Tools\n')
  if (summary.tools.length === 0) {
    sections.push('No tool usage recorded.')
  } else {
    const top = summary.tools.slice(0, 10)
    sections.push('| Tool | Calls | Avg Duration |')
    sections.push('|------|-------|-------------|')
    for (const t of top) {
      const avgStr = t.avgDurationMs !== null ? formatDuration(t.avgDurationMs) : 'N/A'
      sections.push(`| ${t.tool} | ${formatNumber(t.callCount)} | ${avgStr} |`)
    }
    if (summary.tools.length > 10) {
      sections.push(`\n*...and ${summary.tools.length - 10} more tools*`)
    }
  }

  // MCP Servers
  if (summary.mcpServers.length > 0) {
    sections.push('\n## MCP Servers\n')
    for (const s of summary.mcpServers) {
      sections.push(`- ${s}`)
    }
  }

  // Skills
  if (summary.skills.length > 0) {
    sections.push('\n## Skills\n')
    for (const s of summary.skills) {
      sections.push(`- ${s}`)
    }
  }

  // Token Usage
  const total = summary.totalInputTokens + summary.totalOutputTokens
  sections.push('\n## Token Usage\n')
  sections.push(`- **Input:** ${formatNumber(summary.totalInputTokens)} tokens`)
  sections.push(`- **Output:** ${formatNumber(summary.totalOutputTokens)} tokens`)
  sections.push(`- **Total:** ${formatNumber(total)} tokens`)

  // Errors
  if (summary.errorCount > 0) {
    sections.push('\n## Errors\n')
    sections.push(`${formatNumber(summary.errorCount)} error(s) detected during this session.`)
  }

  return sections.join('\n')
}

// ── Memory entry generation ──────────────────────────────────

const TOOL_PREFERENCE_THRESHOLD = 5
const MAX_TOOL_PREFERENCES = 5

function deriveCreatedAt(summary: SessionSummary): string {
  return summary.endTime ?? summary.startTime
}

function buildSessionSummaryEntry(summary: SessionSummary): MemoryEntry {
  const duration = formatDuration(summary.durationMs)
  const modelNames = summary.models.map((m) => m.model).join(', ') || 'none'
  const toolCount = summary.tools.length
  const total = summary.totalInputTokens + summary.totalOutputTokens

  return {
    type: 'project',
    name: `session-${summary.sessionId}`,
    description: `Session ${truncateId(summary.sessionId)}: ${duration}, ${toolCount} tools, ${formatNumber(total)} tokens`,
    content: [
      `Duration: ${duration}`,
      `Models: ${modelNames}`,
      `Tools used: ${toolCount}`,
      `Tokens: ${formatNumber(total)} (${formatNumber(summary.totalInputTokens)} in / ${formatNumber(summary.totalOutputTokens)} out)`,
      `Errors: ${summary.errorCount}`,
      `Spans: ${summary.spanCount}`,
    ].join('\n'),
    source: 'session-digest',
    createdAt: deriveCreatedAt(summary),
  }
}

function buildModelUsageEntry(summary: SessionSummary): MemoryEntry {
  const lines = summary.models.map((m) => `- ${m.model}: ${formatNumber(m.callCount)} calls`)

  return {
    type: 'project',
    name: `model-usage-${summary.sessionId}`,
    description: `Model usage for session ${truncateId(summary.sessionId)}`,
    content: lines.length > 0 ? lines.join('\n') : 'No models used.',
    source: 'session-digest',
    createdAt: deriveCreatedAt(summary),
  }
}

function buildToolPreferenceEntries(summary: SessionSummary): ReadonlyArray<MemoryEntry> {
  const createdAt = deriveCreatedAt(summary)
  return summary.tools
    .filter((t) => t.callCount >= TOOL_PREFERENCE_THRESHOLD)
    .slice(0, MAX_TOOL_PREFERENCES)
    .map((t) => ({
      type: 'project' as const,
      name: `tool-pref-${t.tool}`,
      description: `Tool ${t.tool} used ${formatNumber(t.callCount)} times`,
      content: [
        `Tool: ${t.tool}`,
        `Call count: ${t.callCount}`,
        `Avg duration: ${t.avgDurationMs !== null ? formatDuration(t.avgDurationMs) : 'N/A'}`,
        `Session: ${summary.sessionId}`,
      ].join('\n'),
      source: 'session-digest',
      createdAt,
    }))
}

function buildErrorEntry(summary: SessionSummary): MemoryEntry {
  return {
    type: 'feedback',
    name: `error-summary-${summary.sessionId}`,
    description: `${formatNumber(summary.errorCount)} error(s) in session ${truncateId(summary.sessionId)}`,
    content: [
      `Session: ${summary.sessionId}`,
      `Error count: ${summary.errorCount}`,
      `Duration: ${formatDuration(summary.durationMs)}`,
      `Spans: ${summary.spanCount}`,
    ].join('\n'),
    source: 'session-digest',
    createdAt: deriveCreatedAt(summary),
  }
}

function generateMemoryEntries(summary: SessionSummary): ReadonlyArray<MemoryEntry> {
  const entries: MemoryEntry[] = []

  entries.push(buildSessionSummaryEntry(summary))
  entries.push(buildModelUsageEntry(summary))
  entries.push(...buildToolPreferenceEntries(summary))

  if (summary.errorCount > 0) {
    entries.push(buildErrorEntry(summary))
  }

  return entries
}

// ── Public API ───────────────────────────────────────────────

/**
 * Generate a session digest from a SessionSummary.
 * Produces formatted markdown and structured MemoryEntry objects.
 */
export function generateSessionDigest(summary: SessionSummary): SessionDigest {
  const now = new Date().toISOString()
  return {
    sessionId: summary.sessionId,
    sessionDate: extractDate(summary.startTime),
    markdown: generateMarkdown(summary),
    memoryEntries: generateMemoryEntries(summary),
    generatedAt: now,
  }
}

/**
 * Store a session digest in the vault.
 * Writes to `sessions/YYYY-MM-DD/{sessionId}.md`.
 * Returns the vault file path used.
 */
export function storeSessionDigest(vault: Vault, digest: SessionDigest): string {
  const safeName = sanitizeFilename(digest.sessionId)
  const path = `sessions/${digest.sessionDate}/${safeName}.md`
  vault.write(path, digest.markdown)
  return path
}

/**
 * Generate digests for multiple session summaries.
 */
export function generateBatchDigests(
  summaries: ReadonlyArray<SessionSummary>,
): ReadonlyArray<SessionDigest> {
  return summaries.map(generateSessionDigest)
}
