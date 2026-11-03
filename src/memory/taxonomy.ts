/**
 * Tag taxonomy registry — a YAML file at `<memoryRoot>/.taxonomy.yml` that
 * records which tags have been promoted into the lesson corpus, along with
 * the scope they apply to and when they were added.
 *
 * Phase 13.12.12 — tag suggestion + taxonomy learning.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LessonScope } from './lessons.js'

export interface TaxonomyEntry {
  readonly name: string
  readonly scope: LessonScope
  readonly project?: string
  readonly agent?: string
  readonly createdAt: string
}

export interface Taxonomy {
  readonly tags: readonly TaxonomyEntry[]
}

/** Parse the taxonomy file content (minimal YAML subset — array of objects under `tags:`). */
export function parseTaxonomy(raw: string): Taxonomy {
  const tags: TaxonomyEntry[] = []
  const lines = raw.split('\n')
  let i = 0
  // find `tags:` line
  while (i < lines.length && lines[i]!.trim() !== 'tags:') i++
  if (i >= lines.length) return { tags }
  i++
  let current: { -readonly [K in keyof TaxonomyEntry]?: TaxonomyEntry[K] } = {}
  const flush = (): void => {
    if (current.name && current.scope && current.createdAt) {
      tags.push({
        name: current.name,
        scope: current.scope,
        createdAt: current.createdAt,
        ...(current.project ? { project: current.project } : {}),
        ...(current.agent ? { agent: current.agent } : {}),
      })
    }
    current = {}
  }
  for (; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (/^-\s+name:/.test(trimmed)) {
      flush()
      const val = trimmed.replace(/^-\s+name:\s*/, '').replace(/^["']|["']$/g, '')
      current.name = val
      continue
    }
    const m = /^([a-zA-Z]+):\s*(.*)$/.exec(trimmed)
    if (!m) continue
    const key = m[1]!
    const val = m[2]!.replace(/^["']|["']$/g, '')
    if (key === 'name') current.name = val
    else if (key === 'scope') current.scope = val as LessonScope
    else if (key === 'project') current.project = val
    else if (key === 'agent') current.agent = val
    else if (key === 'createdAt') current.createdAt = val
  }
  flush()
  return { tags }
}

export function serializeTaxonomy(tx: Taxonomy): string {
  const lines: string[] = ['# SCNS tag taxonomy — managed file', 'tags:']
  for (const t of tx.tags) {
    lines.push(`  - name: ${t.name}`)
    lines.push(`    scope: ${t.scope}`)
    if (t.project) lines.push(`    project: ${t.project}`)
    if (t.agent) lines.push(`    agent: ${t.agent}`)
    lines.push(`    createdAt: ${t.createdAt}`)
  }
  return lines.join('\n') + '\n'
}

export interface TaxonomyStoreConfig {
  readonly path: string
}

export function createTaxonomyStore(config: TaxonomyStoreConfig) {
  const { path } = config

  function load(): Taxonomy {
    if (!existsSync(path)) return { tags: [] }
    try {
      return parseTaxonomy(readFileSync(path, 'utf-8'))
    } catch {
      return { tags: [] }
    }
  }

  function save(tx: Taxonomy): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, serializeTaxonomy(tx), 'utf-8')
  }

  /** Add a tag entry idempotently, keyed by (name, scope, project, agent). */
  function addTag(entry: TaxonomyEntry): Taxonomy {
    const current = load()
    const sig = (e: TaxonomyEntry): string =>
      `${e.name}|${e.scope}|${e.project ?? ''}|${e.agent ?? ''}`
    const existing = new Set(current.tags.map(sig))
    if (existing.has(sig(entry))) return current
    const next: Taxonomy = { tags: [...current.tags, entry] }
    save(next)
    return next
  }

  function hasTag(name: string): boolean {
    return load().tags.some((t) => t.name === name)
  }

  return { load, save, addTag, hasTag, path }
}

export type TaxonomyStore = ReturnType<typeof createTaxonomyStore>
