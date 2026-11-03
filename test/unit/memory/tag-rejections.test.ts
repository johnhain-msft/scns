import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTagRejectionStore,
  rejectionSignature,
} from '../../../src/memory/tag-rejections.js'

describe('tag rejection store (13.12.12)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scns-tagrej-'))
  })

  it('signature is order-independent and case-insensitive on tag name', () => {
    const a = rejectionSignature('Rate-Limiting', ['b', 'a', 'c'])
    const b = rejectionSignature('rate-limiting', ['c', 'b', 'a'])
    expect(a).toBe(b)
  })

  it('records and reloads rejections', () => {
    const path = join(dir, '.tag-rejections.jsonl')
    const store = createTagRejectionStore({ path })
    store.record({ tagName: 'retries', candidateLessonIds: ['l1', 'l2', 'l3'], reason: 'too broad' })
    store.record({ tagName: 'auth', candidateLessonIds: ['l4', 'l5', 'l6'] })
    const store2 = createTagRejectionStore({ path })
    const loaded = store2.load()
    expect(loaded).toHaveLength(2)
    expect(loaded[0]!.tagName).toBe('retries')
    expect(loaded[0]!.reason).toBe('too broad')
  })

  it('isRejected matches same signature regardless of ordering', () => {
    const path = join(dir, '.rej.jsonl')
    const store = createTagRejectionStore({ path })
    store.record({ tagName: 'caching', candidateLessonIds: ['a', 'b', 'c'] })
    expect(store.isRejected('caching', ['c', 'b', 'a'])).toBe(true)
    expect(store.isRejected('caching', ['a', 'b'])).toBe(false)
    expect(store.isRejected('retries', ['a', 'b', 'c'])).toBe(false)
  })

  it('load ignores malformed lines', async () => {
    const path = join(dir, '.bad.jsonl')
    const store = createTagRejectionStore({ path })
    store.record({ tagName: 'x', candidateLessonIds: ['1', '2'] })
    // Append a garbage line directly
    const { appendFileSync } = await import('node:fs')
    appendFileSync(path, 'this is not json\n{"incomplete":true}\n')
    expect(store.load()).toHaveLength(1)
  })
})
