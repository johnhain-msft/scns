/**
 * The belt-and-braces snapshot. Isolated: temp dirs only, `~/.scns` is never read or written.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotSuggestions, snapshotStamp } from '../../../src/suggest/review-snapshot.js'

let dir: string
let sourceDir: string
let snapshotRootDir: string

const JOHN = 'human:unblocks-loop: this unblocks the weekly loop — keep the "why"'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scns-review-snapshot-'))
  sourceDir = join(dir, 'suggestions')
  snapshotRootDir = join(dir, 'suggestions-snapshots')
  mkdirSync(join(sourceDir, 'approved'), { recursive: true })
  writeFileSync(
    join(sourceDir, 'approved', 'a.md'),
    `---\nid: a\nreviewReason: '${JOHN}'\n---\nbody\n`,
  )
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('snapshotSuggestions', () => {
  it('copies the corpus byte-for-byte, nested directories included', () => {
    const res = snapshotSuggestions({ sourceDir, snapshotRootDir })

    expect(res.taken).toBe(true)
    const copied = readFileSync(join(res.path!, 'approved', 'a.md'), 'utf-8')
    expect(copied).toContain(JOHN)
    // Byte-identical, not merely "contains": the whole point is that nothing interprets the file.
    expect(copied).toBe(readFileSync(join(sourceDir, 'approved', 'a.md'), 'utf-8'))
  })

  it('survives a later erasure of the live file — the recovery this exists for', () => {
    const res = snapshotSuggestions({ sourceDir, snapshotRootDir })
    // Simulate the defect: some path rewrites the file with the reason gone.
    writeFileSync(join(sourceDir, 'approved', 'a.md'), `---\nid: a\nreviewReason: ''\n---\nbody\n`)

    expect(readFileSync(join(sourceDir, 'approved', 'a.md'), 'utf-8')).not.toContain(JOHN)
    expect(readFileSync(join(res.path!, 'approved', 'a.md'), 'utf-8')).toContain(JOHN)
  })

  it('keeps successive snapshots side by side instead of overwriting', () => {
    const a = snapshotSuggestions({ sourceDir, snapshotRootDir, now: new Date('2026-08-03T09:00:00Z') })
    const b = snapshotSuggestions({ sourceDir, snapshotRootDir, now: new Date('2026-08-10T09:00:00Z') })

    expect(a.path).not.toBe(b.path)
    expect(readdirSync(snapshotRootDir).sort()).toEqual([
      snapshotStamp(new Date('2026-08-03T09:00:00Z')),
      snapshotStamp(new Date('2026-08-10T09:00:00Z')),
    ])
  })

  it('reports an absent source instead of claiming a snapshot it never took', () => {
    const res = snapshotSuggestions({ sourceDir: join(dir, 'nope'), snapshotRootDir })

    expect(res.taken).toBe(false)
    expect(res.reason).toContain('no suggestions directory')
    expect(res.path).toBeUndefined()
  })

  it('never throws — a snapshot failure must not fail the review that just succeeded', () => {
    // A file where the snapshot root must be a directory: mkdir will fail with ENOTDIR/EEXIST.
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'not a directory')

    const res = snapshotSuggestions({ sourceDir, snapshotRootDir: join(blocked, 'sub') })

    expect(res.taken).toBe(false)
    expect(res.reason).toBeTruthy()
  })

  it('stamps a filesystem-legal, sortable name', () => {
    const s = snapshotStamp(new Date('2026-08-03T14:30:00.123Z'))
    expect(s).toBe('2026-08-03T14-30-00-123Z')
    expect(s).not.toContain(':')
    expect(
      snapshotStamp(new Date('2026-08-03T09:00:00Z')) <
        snapshotStamp(new Date('2026-08-10T09:00:00Z')),
    ).toBe(true)
  })
})
