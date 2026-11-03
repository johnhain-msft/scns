/**
 * Filesystem-based handoff document persistence.
 * Stores handoff documents as markdown + JSON metadata files.
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
  statSync,
} from 'node:fs'
import {
  HandoffStatus,
  type HandoffDocument,
  type HandoffDocumentSummary,
} from './handoff-types.js'
import { createHandoffGenerator } from './handoff-generator.js'

// ── Public interface ─────────────────────────────────────────────────

export interface HandoffStore {
  save(doc: HandoffDocument): string
  load(id: string): HandoffDocument | null
  loadLatest(sessionId: string): HandoffDocument | null
  list(filter?: { status?: HandoffStatus; sessionId?: string }): readonly HandoffDocumentSummary[]
  markConsumed(id: string, targetSessionId: string): void
  markExpired(id: string): void
  cleanup(maxAgeDays?: number): number
}

// ── Factory ──────────────────────────────────────────────────────────

export function createHandoffStore(options: { rootDir: string }): HandoffStore {
  const { rootDir } = options
  const generator = createHandoffGenerator()
  let dirCreated = false

  function ensureDir(): void {
    if (!dirCreated) {
      mkdirSync(rootDir, { recursive: true })
      dirCreated = true
    }
  }

  function mdPath(id: string): string {
    return `${rootDir}/${id}.md`
  }

  function jsonPath(id: string): string {
    return `${rootDir}/${id}.json`
  }

  function writeMeta(doc: HandoffDocument): void {
    const meta: HandoffDocumentSummary = {
      id: doc.id,
      sourceSessionId: doc.sourceSessionId,
      targetSessionId: doc.targetSessionId,
      status: doc.status,
      createdAt: doc.createdAt,
    }
    writeFileSync(jsonPath(doc.id), JSON.stringify(meta, null, 2), 'utf-8')
  }

  function readMeta(id: string): HandoffDocumentSummary | null {
    const path = jsonPath(id)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as HandoffDocumentSummary
    } catch {
      return null
    }
  }

  function listIds(): string[] {
    if (!existsSync(rootDir)) return []
    return readdirSync(rootDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
  }

  return {
    save(doc: HandoffDocument): string {
      ensureDir()
      const md = generator.toMarkdown(doc)
      writeFileSync(mdPath(doc.id), md, 'utf-8')
      writeMeta(doc)
      return mdPath(doc.id)
    },

    load(id: string): HandoffDocument | null {
      const path = mdPath(id)
      if (!existsSync(path)) return null
      try {
        const md = readFileSync(path, 'utf-8')
        return generator.fromMarkdown(md)
      } catch {
        return null
      }
    },

    loadLatest(sessionId: string): HandoffDocument | null {
      const ids = listIds()
      let latest: HandoffDocumentSummary | null = null
      for (const id of ids) {
        const meta = readMeta(id)
        if (!meta || meta.sourceSessionId !== sessionId) continue
        if (!latest || meta.createdAt > latest.createdAt) {
          latest = meta
        }
      }
      if (!latest) return null
      return this.load(latest.id)
    },

    list(filter?: {
      status?: HandoffStatus
      sessionId?: string
    }): readonly HandoffDocumentSummary[] {
      const ids = listIds()
      const results: HandoffDocumentSummary[] = []
      for (const id of ids) {
        const meta = readMeta(id)
        if (!meta) continue
        if (filter?.status && meta.status !== filter.status) continue
        if (filter?.sessionId && meta.sourceSessionId !== filter.sessionId) continue
        results.push(meta)
      }
      return results
    },

    markConsumed(id: string, targetSessionId: string): void {
      const meta = readMeta(id)
      if (!meta) return
      const updated: HandoffDocumentSummary = {
        ...meta,
        status: HandoffStatus.Consumed,
        targetSessionId,
      }
      writeFileSync(jsonPath(id), JSON.stringify(updated, null, 2), 'utf-8')
    },

    markExpired(id: string): void {
      const meta = readMeta(id)
      if (!meta) return
      const updated: HandoffDocumentSummary = { ...meta, status: HandoffStatus.Expired }
      writeFileSync(jsonPath(id), JSON.stringify(updated, null, 2), 'utf-8')
    },

    cleanup(maxAgeDays?: number): number {
      const maxAge = maxAgeDays ?? 30
      const cutoff = Date.now() - maxAge * 24 * 60 * 60 * 1000
      const ids = listIds()
      let count = 0

      for (const id of ids) {
        const path = jsonPath(id)
        try {
          const stat = statSync(path)
          if (stat.mtimeMs < cutoff) {
            if (existsSync(mdPath(id))) unlinkSync(mdPath(id))
            unlinkSync(path)
            count++
          }
        } catch {
          // skip files that can't be stat'd
        }
      }

      return count
    },
  }
}
