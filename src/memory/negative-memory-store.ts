/**
 * Negative Memory Store — vault-based storage for "don't do this" memories.
 *
 * Stores negative memories as markdown files in `negative/` subdirectory of
 * the vault. Each file has YAML frontmatter + content body, following the
 * same pattern as MEMORY.md entries.
 *
 * Files are automatically indexed by the vault indexer into FTS5 + sqlite-vec,
 * making them searchable via the existing hybrid search pipeline.
 */

import { randomUUID } from 'node:crypto'
import type { Vault } from './vault.js'
import type {
  NegativeMemory,
  NegativeMemoryInput,
  HeuristicNegativeMemoryInput,
  CriticVerdict,
  CriticStatus,
  CriticSource,
} from './negative-memory-types.js'
import type { RecommendedTarget, SentimentSignalType } from './sentiment-analyzer.js'
import { classifyPromptAuthorship } from './prompt-authorship.js'
import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'negative-memory-store' })

export interface NegativeMemoryStore {
  /** Store a negative memory from the Copilot tool (primary path). */
  storeFromTool(input: NegativeMemoryInput): NegativeMemory
  /** Store a negative memory from heuristic detection (secondary path). */
  storeFromHeuristic(input: HeuristicNegativeMemoryInput): NegativeMemory
  /** List negative memories, optionally filtered by target. */
  list(options?: { target?: RecommendedTarget; limit?: number }): readonly NegativeMemory[]
  /** Search negative memories by text (keyword search on vault files). */
  search(query: string, limit?: number): readonly NegativeMemory[]
  /** Get a negative memory by ID. */
  getById(id: string): NegativeMemory | null
  /** Count total negative memories. */
  count(): number
  /** Persist an updated critic verdict on an existing memory. */
  updateVerdict(id: string, verdict: CriticVerdict): NegativeMemory | null
  /** Toggle the pinned override on a memory. */
  setPinned(id: string, pinned: boolean): NegativeMemory | null
  /** Hard-delete a memory file from the vault. */
  delete(id: string): boolean
}

/** Parse a negative memory markdown file back into a NegativeMemory object. */
function parseNegativeMemoryFile(_path: string, content: string): NegativeMemory | null {
  const fmMatch = /^---\n([\s\S]*?)\n?---\n([\s\S]*)$/.exec(content.trim())
  if (!fmMatch) return null

  const frontmatter = fmMatch[1]!
  const body = fmMatch[2]!.trim()

  const fields: Record<string, string> = {}
  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key && value) fields[key] = value
  }

  if (!fields['id'] || !fields['dontRule']) return null

  let criticVerdict: CriticVerdict | null = null
  if (fields['criticStatus']) {
    const status = fields['criticStatus'] as CriticStatus
    if (status === 'keep' || status === 'suppress' || status === 'revise') {
      criticVerdict = {
        status,
        rationale: decodeFmValue(fields['criticRationale'] ?? ''),
        source: (fields['criticSource'] ?? 'heuristic') as CriticSource,
        reviewedAt: fields['criticReviewedAt'] ?? new Date(0).toISOString(),
        ...(fields['criticRevisedRule']
          ? { revisedRule: decodeFmValue(fields['criticRevisedRule']) }
          : {}),
        ...(fields['criticConsecutiveSuppressCount']
          ? {
              consecutiveSuppressCount: parseInt(fields['criticConsecutiveSuppressCount'], 10) || 0,
            }
          : {}),
      }
    }
  }

  const promptOrigin =
    fields['promptOrigin'] === 'human' || fields['promptOrigin'] === 'machine'
      ? fields['promptOrigin']
      : 'unknown'

  return {
    id: fields['id'],
    originalText: body,
    dontRule: fields['dontRule'],
    category: (fields['category'] ?? 'frustration') as SentimentSignalType,
    recommendedTarget: (fields['target'] ?? 'general') as RecommendedTarget,
    confidence: parseFloat(fields['confidence'] ?? '0.5'),
    sessionId: fields['sessionId'] || null,
    source: (fields['source'] ?? 'manual') as NegativeMemory['source'],
    targetApplied: fields['targetApplied'] === 'true',
    appliedTo: fields['appliedTo'] || null,
    createdAt: fields['createdAt'] ?? new Date().toISOString(),
    promptOrigin,
    ...(fields['promptOriginRule'] ? { promptOriginRule: fields['promptOriginRule'] } : {}),
    updatedAt: fields['updatedAt'] || fields['createdAt'] || undefined,
    criticVerdict,
    pinned: fields['pinned'] === 'true',
  }
}

/** Encode a frontmatter value: strip newlines/CR (frontmatter is line-based). */
function encodeFmValue(s: string): string {
  return s.replace(/\r?\n/g, ' ').trim()
}

/** Decode a frontmatter value (currently a no-op; reserved for future escapes). */
function decodeFmValue(s: string): string {
  return s
}

/** Serialize a NegativeMemory into markdown with YAML frontmatter. */
function serializeNegativeMemory(mem: NegativeMemory): string {
  const fields: string[] = [
    `id: ${mem.id}`,
    `dontRule: ${encodeFmValue(mem.dontRule)}`,
    `category: ${mem.category}`,
    `target: ${mem.recommendedTarget}`,
    `confidence: ${mem.confidence}`,
    `source: ${mem.source}`,
    `targetApplied: ${mem.targetApplied}`,
    `createdAt: ${mem.createdAt}`,
    `promptOrigin: ${mem.promptOrigin}`,
  ]
  if (mem.promptOriginRule) fields.push(`promptOriginRule: ${mem.promptOriginRule}`)
  if (mem.updatedAt && mem.updatedAt !== mem.createdAt) {
    fields.push(`updatedAt: ${mem.updatedAt}`)
  }
  if (mem.sessionId) fields.push(`sessionId: ${mem.sessionId}`)
  if (mem.appliedTo) fields.push(`appliedTo: ${mem.appliedTo}`)
  if (mem.pinned) fields.push(`pinned: true`)
  if (mem.criticVerdict) {
    fields.push(`criticStatus: ${mem.criticVerdict.status}`)
    if (mem.criticVerdict.rationale) {
      fields.push(`criticRationale: ${encodeFmValue(mem.criticVerdict.rationale)}`)
    }
    fields.push(`criticSource: ${mem.criticVerdict.source}`)
    fields.push(`criticReviewedAt: ${mem.criticVerdict.reviewedAt}`)
    if (mem.criticVerdict.revisedRule) {
      fields.push(`criticRevisedRule: ${encodeFmValue(mem.criticVerdict.revisedRule)}`)
    }
    if (
      mem.criticVerdict.consecutiveSuppressCount !== undefined &&
      mem.criticVerdict.consecutiveSuppressCount > 0
    ) {
      fields.push(`criticConsecutiveSuppressCount: ${mem.criticVerdict.consecutiveSuppressCount}`)
    }
  }

  return `---\n${fields.join('\n')}\n---\n${mem.originalText}`
}

/** Create a negative memory store backed by the vault. */
export function createNegativeMemoryStore(vault: Vault): NegativeMemoryStore {
  function storeFromTool(input: NegativeMemoryInput): NegativeMemory {
    const id = randomUUID()
    const now = new Date().toISOString()
    // W5.4: authorship is classified at THIS boundary (not trusted from the
    // caller) — the same discipline as retrieval_experience.prompt_origin.
    // Transport outranks prose shape: the classifier can only prove machine
    // markers, so a team-agent submission must never default to `human`.
    const authorship =
      input.transportOrigin === 'team-agent'
        ? ({ author: 'machine', rule: 'team-mode-transport' } as const)
        : classifyPromptAuthorship(input.feedback)

    const mem: NegativeMemory = {
      id,
      originalText: input.context
        ? `${input.feedback}\n\nContext: ${input.context}`
        : input.feedback,
      dontRule: input.feedback,
      category: input.category ?? 'behavior-complaint',
      recommendedTarget: input.target ?? 'general',
      confidence: input.severity === 'high' ? 0.95 : input.severity === 'medium' ? 0.8 : 0.6,
      sessionId: input.sessionId ?? null,
      source: 'copilot-tool',
      targetApplied: false,
      appliedTo: null,
      createdAt: now,
      promptOrigin: authorship.author,
      promptOriginRule: authorship.rule,
    }

    const content = serializeNegativeMemory(mem)
    vault.write(`negative/${id}.md`, content)
    log.info(
      { id, category: mem.category, target: mem.recommendedTarget },
      'Stored negative memory from tool',
    )
    return mem
  }

  function storeFromHeuristic(input: HeuristicNegativeMemoryInput): NegativeMemory {
    const id = randomUUID()
    const now = new Date().toISOString()

    const mem: NegativeMemory = {
      id,
      originalText: input.originalText.slice(0, 2000),
      dontRule: input.dontRule,
      category: input.category,
      recommendedTarget: input.recommendedTarget,
      confidence: input.confidence,
      sessionId: input.sessionId ?? null,
      source: 'heuristic',
      targetApplied: false,
      appliedTo: null,
      createdAt: now,
      // The heuristic pipeline is a machine author by construction — its
      // entries must never create human-origin tasks (W5.3).
      promptOrigin: 'machine',
      promptOriginRule: 'heuristic-pipeline',
    }

    const content = serializeNegativeMemory(mem)
    vault.write(`negative/${id}.md`, content)
    log.info(
      { id, confidence: mem.confidence, category: mem.category },
      'Stored negative memory from heuristic',
    )
    return mem
  }

  function loadAll(): NegativeMemory[] {
    const files = vault.listFiles()
    const memories: NegativeMemory[] = []

    for (const file of files) {
      if (!file.path.startsWith('negative/') || !file.path.endsWith('.md')) continue
      const mem = parseNegativeMemoryFile(file.path, file.content)
      if (mem) memories.push(mem)
    }

    // Sort newest first
    memories.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return memories
  }

  function list(options?: {
    target?: RecommendedTarget
    limit?: number
  }): readonly NegativeMemory[] {
    let memories = loadAll()
    if (options?.target) {
      memories = memories.filter((m) => m.recommendedTarget === options.target)
    }
    const limit = options?.limit ?? 20
    return memories.slice(0, limit)
  }

  function search(query: string, limit = 10): readonly NegativeMemory[] {
    if (!query.trim()) return []
    const lowerQuery = query.toLowerCase()
    const words = lowerQuery.split(/\s+/).filter((w) => w.length > 2)
    if (words.length === 0) return []

    const memories = loadAll()
    const scored = memories
      .map((m) => {
        const text = `${m.dontRule} ${m.originalText} ${m.category}`.toLowerCase()
        let score = 0
        for (const word of words) {
          if (text.includes(word)) score++
        }
        return { memory: m, score }
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return scored.map((s) => s.memory)
  }

  function getById(id: string): NegativeMemory | null {
    const file = vault.read(`negative/${id}.md`)
    if (!file) return null
    return parseNegativeMemoryFile(file.path, file.content)
  }

  function count(): number {
    return loadAll().length
  }

  function updateVerdict(id: string, verdict: CriticVerdict): NegativeMemory | null {
    const existing = getById(id)
    if (!existing) return null
    // Use verdict.reviewedAt as updatedAt so a freshly-judged memory's
    // verdict is considered "current" on the next critic pass.
    const updated: NegativeMemory = {
      ...existing,
      criticVerdict: verdict,
      updatedAt: verdict.reviewedAt,
    }
    vault.write(`negative/${id}.md`, serializeNegativeMemory(updated))
    return updated
  }

  function setPinned(id: string, pinned: boolean): NegativeMemory | null {
    const existing = getById(id)
    if (!existing) return null
    const updated: NegativeMemory = {
      ...existing,
      pinned,
      updatedAt: new Date().toISOString(),
    }
    vault.write(`negative/${id}.md`, serializeNegativeMemory(updated))
    return updated
  }

  function deleteMemory(id: string): boolean {
    const file = vault.read(`negative/${id}.md`)
    if (!file) return false
    const v = vault as { remove?: (p: string) => void; delete?: (p: string) => void }
    if (typeof v.remove === 'function') {
      v.remove(`negative/${id}.md`)
      return true
    }
    if (typeof v.delete === 'function') {
      v.delete(`negative/${id}.md`)
      return true
    }
    vault.write(`negative/${id}.md`, '')
    return true
  }

  return {
    storeFromTool,
    storeFromHeuristic,
    list,
    search,
    getById,
    count,
    updateVerdict,
    setPinned,
    delete: deleteMemory,
  }
}
