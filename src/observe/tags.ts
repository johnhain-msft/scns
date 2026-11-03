import type { ObservationType } from './types.js'

/** Format a structured tag as 'category:value' */
export function formatTag(category: string, value: string): string {
  return `${category.toLowerCase()}:${value.toLowerCase()}`
}

/** Parse a structured tag back into category and value */
export function parseTag(tag: string): { category: string; value: string } | null {
  const colonIdx = tag.indexOf(':')
  if (colonIdx <= 0) return null
  const category = tag.slice(0, colonIdx)
  const value = tag.slice(colonIdx + 1)
  if (value.length === 0) return null
  return { category, value }
}

/** Build structured tags for an observation */
export function buildTags(
  type: ObservationType,
  source: string,
  metadata?: Record<string, unknown>,
): string[] {
  const tags: string[] = [formatTag('type', type), formatTag('source', source)]

  if (metadata) {
    for (const [key, val] of Object.entries(metadata)) {
      if (typeof val === 'string') {
        tags.push(formatTag(key, val))
      }
    }
  }

  return tags
}
