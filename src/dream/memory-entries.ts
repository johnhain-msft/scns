/**
 * Memory entry types, parsing, deduplication, and validation.
 */
import { z } from 'zod'

const MEMORY_ENTRY_TYPES = ['user', 'feedback', 'project', 'reference', 'prohibition'] as const

export interface MemoryEntry {
  readonly id?: string
  readonly type: (typeof MEMORY_ENTRY_TYPES)[number]
  readonly name: string
  readonly description: string
  readonly content: string
  readonly source?: string
  readonly createdAt?: string
}

const MemoryEntrySchema = z.object({
  id: z.string().optional(),
  type: z.enum(MEMORY_ENTRY_TYPES),
  name: z.string().min(1),
  description: z.string().min(1),
  content: z.string(),
  source: z.string().optional(),
  createdAt: z.string().optional(),
})

/** Zod-based validation of a single entry. */
export function validateMemoryEntry(entry: unknown): entry is MemoryEntry {
  return MemoryEntrySchema.safeParse(entry).success
}

/**
 * Parse a MEMORY.md file containing entries separated by `---` with YAML frontmatter.
 */
export function parseMemoryMd(content: string): MemoryEntry[] {
  if (!content.trim()) return []

  const entries: MemoryEntry[] = []

  // Split on `---` that appears as a separator between entries.
  // The file starts with `---` (opening frontmatter), then `---` closes it,
  // then content, then `---` opens next entry, etc.
  const blocks = splitIntoBlocks(content)

  for (const block of blocks) {
    const parsed = parseBlock(block)
    if (parsed) entries.push(parsed)
  }

  return entries
}

/** Split MEMORY.md content into raw blocks, each containing one entry's frontmatter + content. */
function splitIntoBlocks(content: string): string[] {
  // Regex: capture each frontmatter block (---\n...\n---\n...) up to next block or end
  const blocks: string[] = []
  const regex = /---\n([\s\S]*?)---\n([\s\S]*?)(?=\n---\n|$)/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(content)) !== null) {
    const frontmatter = match[1]!
    const body = match[2]!
    blocks.push(`---\n${frontmatter}---\n${body}`)
  }

  return blocks
}

/** Parse a single block with frontmatter into a MemoryEntry. */
function parseBlock(block: string): MemoryEntry | null {
  const fmMatch = /^---\n([\s\S]*?)\n?---\n([\s\S]*)$/.exec(block.trim())
  if (!fmMatch) return null

  const frontmatter = fmMatch[1]!
  const content = fmMatch[2]!.trim()

  const fields = parseSimpleYaml(frontmatter)
  if (!fields.name || !fields.description || !fields.type) return null

  const entry: Record<string, string> = {
    type: fields.type,
    name: fields.name,
    description: fields.description,
    content,
  }

  if (fields.id) entry['id'] = fields.id
  if (fields.source) entry['source'] = fields.source
  if (fields.createdAt) entry['createdAt'] = fields.createdAt

  return validateMemoryEntry(entry) ? (entry as unknown as MemoryEntry) : null
}

/** Simple YAML-like parser for frontmatter key: value pairs. */
function parseSimpleYaml(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key && value) result[key] = value
  }
  return result
}

/**
 * Serialize entries back to MEMORY.md format with frontmatter.
 */
export function serializeMemoryMd(entries: ReadonlyArray<MemoryEntry>): string {
  return entries.map(serializeEntry).join('\n\n')
}

function serializeEntry(entry: MemoryEntry): string {
  const fields: string[] = []

  if (entry.id) fields.push(`id: ${entry.id}`)
  fields.push(`name: ${entry.name}`)
  fields.push(`description: ${entry.description}`)
  fields.push(`type: ${entry.type}`)

  if (entry.source) fields.push(`source: ${entry.source}`)
  if (entry.createdAt) fields.push(`createdAt: ${entry.createdAt}`)

  return `---\n${fields.join('\n')}\n---\n${entry.content}`
}

/**
 * Find duplicate pairs by exact name match (case-insensitive) or high content similarity.
 * Returns [indexA, indexB] pairs.
 */
export function detectDuplicates(
  entries: ReadonlyArray<MemoryEntry>,
): ReadonlyArray<readonly [number, number]> {
  const pairs: Array<readonly [number, number]> = []

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!
      const b = entries[j]!

      if (a.name.toLowerCase() === b.name.toLowerCase()) {
        pairs.push([i, j] as const)
        continue
      }

      if (contentSimilarity(a.content, b.content) > 0.8) {
        pairs.push([i, j] as const)
      }
    }
  }

  return pairs
}

/** Normalize and compute character overlap ratio. */
function contentSimilarity(a: string, b: string): number {
  const na = normalize(a)
  const nb = normalize(b)
  if (na.length === 0 && nb.length === 0) return 1
  if (na.length === 0 || nb.length === 0) return 0

  const longer = na.length >= nb.length ? na : nb
  const shorter = na.length < nb.length ? na : nb

  let matches = 0
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) matches++
  }

  return matches / longer.length
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Remove duplicates, keeping the later entry (assumed more recent).
 */
export function deduplicateEntries(
  entries: ReadonlyArray<MemoryEntry>,
): ReadonlyArray<MemoryEntry> {
  const dupes = detectDuplicates(entries)
  const removeSet = new Set<number>()

  for (const [earlier] of dupes) {
    removeSet.add(earlier)
  }

  return entries.filter((_, i) => !removeSet.has(i))
}

/**
 * Resolve contradictions: same name → keep later; same type + similar name → keep latest.
 */
export function resolveContradictions(
  entries: ReadonlyArray<MemoryEntry>,
): ReadonlyArray<MemoryEntry> {
  const removeSet = new Set<number>()

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!
      const b = entries[j]!

      // Same name (case-insensitive) — later supersedes
      if (a.name.toLowerCase() === b.name.toLowerCase()) {
        removeSet.add(i)
        continue
      }

      // Same type and similar name — later supersedes
      if (a.type === b.type && nameSimilarity(a.name, b.name) > 0.8) {
        removeSet.add(i)
      }
    }
  }

  return entries.filter((_, i) => !removeSet.has(i))
}

function nameSimilarity(a: string, b: string): number {
  return contentSimilarity(a, b)
}

/**
 * Re-synthesize existing MEMORY.md entries through the synthesis pipeline.
 * Cleans typos, transforms raw prompts into actionable lessons, assigns IDs.
 */
export function resynthesizeMemoryEntries(
  entries: ReadonlyArray<MemoryEntry>,
  synthesize: (
    content: string,
    type: MemoryEntry['type'],
  ) => { name: string; description: string; content: string } | null,
  fixTyposFn: (text: string) => string,
): MemoryEntry[] {
  const results: MemoryEntry[] = []
  for (const entry of entries) {
    const synthesized = synthesize(entry.content, entry.type)
    if (synthesized) {
      results.push({
        ...entry,
        id: entry.id ?? crypto.randomUUID(),
        name: synthesized.name,
        description: synthesized.description,
        content: synthesized.content,
      })
    } else {
      // synthesize returned null (too short) — keep with cleaned typos
      results.push({
        ...entry,
        id: entry.id ?? crypto.randomUUID(),
        name: fixTyposFn(entry.name),
        description: fixTyposFn(entry.description),
        content: fixTyposFn(entry.content),
      })
    }
  }
  return results
}
