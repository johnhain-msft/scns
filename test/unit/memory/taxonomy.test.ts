import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseTaxonomy,
  serializeTaxonomy,
  createTaxonomyStore,
} from '../../../src/memory/taxonomy.js'

describe('taxonomy registry (13.12.12)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scns-taxonomy-'))
  })

  it('serialize → parse round-trip', () => {
    const orig = {
      tags: [
        { name: 'rate-limiting', scope: 'project' as const, project: 'scns', createdAt: '2026-04-19T00:00:00Z' },
        { name: 'auth', scope: 'global' as const, createdAt: '2026-04-19T01:00:00Z' },
      ],
    }
    const yaml = serializeTaxonomy(orig)
    const parsed = parseTaxonomy(yaml)
    expect(parsed.tags).toHaveLength(2)
    expect(parsed.tags[0]!.name).toBe('rate-limiting')
    expect(parsed.tags[0]!.project).toBe('scns')
    expect(parsed.tags[1]!.name).toBe('auth')
    expect(parsed.tags[1]!.project).toBeUndefined()
  })

  it('addTag is idempotent by (name, scope, project, agent)', () => {
    const path = join(dir, '.taxonomy.yml')
    const store = createTaxonomyStore({ path })
    const entry = {
      name: 'caching',
      scope: 'project' as const,
      project: 'scns',
      createdAt: '2026-04-19T00:00:00Z',
    }
    store.addTag(entry)
    store.addTag(entry)
    store.addTag(entry)
    const loaded = store.load()
    expect(loaded.tags.filter((t) => t.name === 'caching')).toHaveLength(1)
  })

  it('addTag writes file that can be re-loaded', () => {
    const path = join(dir, '.taxonomy.yml')
    const store = createTaxonomyStore({ path })
    store.addTag({ name: 'retries', scope: 'global', createdAt: '2026-04-19T00:00:00Z' })
    expect(existsSync(path)).toBe(true)
    const raw = readFileSync(path, 'utf-8')
    expect(raw).toContain('name: retries')
    expect(raw).toContain('scope: global')

    const store2 = createTaxonomyStore({ path })
    expect(store2.hasTag('retries')).toBe(true)
    expect(store2.hasTag('nonexistent')).toBe(false)
  })

  it('load returns empty when file missing', () => {
    const store = createTaxonomyStore({ path: join(dir, 'nope.yml') })
    expect(store.load().tags).toEqual([])
  })
})
