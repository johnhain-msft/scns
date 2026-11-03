/**
 * Tag rejection log — JSONL file at `<memoryRoot>/.tag-rejections.jsonl`.
 * Records tag-proposal suggestions rejected by the human so the
 * tag-suggestion extractor can avoid re-proposing the same cluster.
 *
 * Phase 13.12.12 — tag suggestion + taxonomy learning.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface TagRejection {
  readonly tagName: string
  readonly candidateLessonIds: readonly string[]
  readonly rejectedAt: string
  readonly reason?: string
  /** If true, the human silently removed the tag after an L2+ auto-approve. */
  readonly implicit?: boolean
}

export interface TagRejectionStoreConfig {
  readonly path: string
}

/**
 * Signature for a rejection — normalized so order of lesson IDs doesn't matter.
 * Future proposals with the same {tagName, candidateLessonIds} signature are suppressed.
 */
export function rejectionSignature(tagName: string, candidateLessonIds: readonly string[]): string {
  const sorted = [...candidateLessonIds].sort()
  return `${tagName.toLowerCase()}::${sorted.join(',')}`
}

export function createTagRejectionStore(config: TagRejectionStoreConfig) {
  const { path } = config

  function load(): readonly TagRejection[] {
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf-8')
    const out: TagRejection[] = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const parsed = JSON.parse(t) as TagRejection
        if (
          typeof parsed.tagName === 'string' &&
          Array.isArray(parsed.candidateLessonIds) &&
          typeof parsed.rejectedAt === 'string'
        ) {
          out.push(parsed)
        }
      } catch {
        /* skip malformed */
      }
    }
    return out
  }

  function record(rej: Omit<TagRejection, 'rejectedAt'> & { rejectedAt?: string }): TagRejection {
    const entry: TagRejection = {
      tagName: rej.tagName,
      candidateLessonIds: [...rej.candidateLessonIds],
      rejectedAt: rej.rejectedAt ?? new Date().toISOString(),
      ...(rej.reason ? { reason: rej.reason } : {}),
      ...(rej.implicit ? { implicit: true } : {}),
    }
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8')
    return entry
  }

  function signatures(): Set<string> {
    const out = new Set<string>()
    for (const r of load()) {
      out.add(rejectionSignature(r.tagName, r.candidateLessonIds))
    }
    return out
  }

  function isRejected(tagName: string, candidateLessonIds: readonly string[]): boolean {
    return signatures().has(rejectionSignature(tagName, candidateLessonIds))
  }

  return { load, record, signatures, isRejected, path }
}

export type TagRejectionStore = ReturnType<typeof createTagRejectionStore>
