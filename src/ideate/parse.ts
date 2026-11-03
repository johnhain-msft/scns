/**
 * D1 — ideation response parser (PURE).
 *
 * The ideation agent is asked for a strict JSON array, but real LLM output is
 * messy: markdown fences, leading prose, or an object envelope. This parser
 * recovers the JSON defensively, validates every entry against
 * {@link IdeationProposalSchema}, DROPS anything malformed (never trusts a
 * partial proposal), and caps the result. Garbage in → empty out (never throws).
 */

import { IdeationProposalSchema } from './types.js'
import type { IdeationProposal } from './types.js'

export interface ParseIdeationOptions {
  /** Maximum proposals to return (extras are discarded). */
  readonly max?: number
}

export interface ParseIdeationResult {
  readonly proposals: readonly IdeationProposal[]
  /** Count of entries that parsed as JSON but failed proposal validation. */
  readonly dropped: number
}

/** Strip a single surrounding markdown code fence, if present. */
function stripFence(text: string): string {
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i)
  return fence?.[1] ?? text
}

/** Candidate JSON substrings to attempt, most-specific first. */
function jsonCandidates(text: string): string[] {
  const candidates: string[] = []
  const trimmed = text.trim()
  if (trimmed !== '') candidates.push(trimmed)

  const unfenced = stripFence(trimmed).trim()
  if (unfenced !== '' && unfenced !== trimmed) candidates.push(unfenced)

  // First '[' .. last ']' (array form), then first '{' .. last '}' (object form).
  for (const src of [trimmed, unfenced]) {
    const lb = src.indexOf('[')
    const rb = src.lastIndexOf(']')
    if (lb !== -1 && rb > lb) candidates.push(src.slice(lb, rb + 1))
    const lc = src.indexOf('{')
    const rc = src.lastIndexOf('}')
    if (lc !== -1 && rc > lc) candidates.push(src.slice(lc, rc + 1))
  }
  return candidates
}

/** Coerce a parsed JSON value into a list of candidate objects. */
function toObjectList(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (parsed != null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    // Object envelope: first array-valued property (e.g. { proposals: [...] }).
    for (const key of ['proposals', 'ideas', 'items', 'suggestions']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[]
    }
    const firstArray = Object.values(obj).find((v) => Array.isArray(v))
    if (Array.isArray(firstArray)) return firstArray
    // A single bare proposal object.
    return [parsed]
  }
  return null
}

export function parseIdeationResponse(
  text: string,
  options: ParseIdeationOptions = {},
): ParseIdeationResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { proposals: [], dropped: 0 }
  }

  let objects: unknown[] | null = null
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate)
      const list = toObjectList(parsed)
      if (list != null) {
        objects = list
        break
      }
    } catch {
      // try the next candidate
    }
  }

  if (objects == null) return { proposals: [], dropped: 0 }

  const proposals: IdeationProposal[] = []
  let dropped = 0
  for (const obj of objects) {
    const result = IdeationProposalSchema.safeParse(obj)
    if (result.success) proposals.push(result.data)
    else dropped++
  }

  const max = options.max
  const capped =
    max != null && Number.isFinite(max) && max >= 0 ? proposals.slice(0, max) : proposals

  return { proposals: capped, dropped }
}
