/**
 * D1 — the ideation inbox (filesystem store).
 *
 * Production rootDir is `~/.scns/ideation/`; tests inject a temp dir. Each
 * record is one `<id>.json` file. Proposals land here as `status:'new'` for
 * human review — D1 NEVER auto-spawns them. `markOutcome` is the D2 hook that
 * records what ultimately happened to a proposal so ideation can learn.
 *
 * Safety: every path is built from a validated UUID under `rootDir`, so a
 * caller-supplied id can never escape the inbox directory.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../shared/logger.js'
import { IdeationRecordSchema, IdeationStatus } from './types.js'
import type {
  IdeationProposal,
  IdeationRecord,
  IdeationOutcome,
  IdeationStatus as IdeationStatusType,
} from './types.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AppendMeta {
  readonly model?: string
  /** Provenance stamp; defaults to 'llm-ideation' for back-compat. */
  readonly source?: 'llm-ideation' | 'synth-ideation'
}

export interface IdeationInbox {
  /** Persist proposals as fresh `new` records and return them. */
  append(proposals: readonly IdeationProposal[], meta?: AppendMeta): readonly IdeationRecord[]
  /** All valid records, newest first. Malformed files are skipped. */
  list(): readonly IdeationRecord[]
  /** A single record by id, or null if missing / invalid id. */
  get(id: string): IdeationRecord | null
  /** D2 hook: attach a realized outcome to a record. */
  markOutcome(id: string, outcome: IdeationOutcome): IdeationRecord | null
  /** Move a record through its lifecycle. */
  setStatus(id: string, status: IdeationStatusType): IdeationRecord | null
}

export function createIdeationInbox(rootDir: string): IdeationInbox {
  function ensureDir(): void {
    mkdirSync(rootDir, { recursive: true })
  }

  function pathFor(id: string): string | null {
    if (!UUID_RE.test(id)) return null
    return join(rootDir, `${id}.json`)
  }

  function readRecord(filePath: string): IdeationRecord | null {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
      const result = IdeationRecordSchema.safeParse(parsed)
      return result.success ? result.data : null
    } catch {
      return null
    }
  }

  function write(record: IdeationRecord): void {
    ensureDir()
    const filePath = pathFor(record.id)
    if (filePath == null) throw new Error(`refusing to write record with invalid id: ${record.id}`)
    writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8')
  }

  function append(
    proposals: readonly IdeationProposal[],
    meta: AppendMeta = {},
  ): readonly IdeationRecord[] {
    const now = new Date().toISOString()
    const records: IdeationRecord[] = []
    for (const proposal of proposals) {
      const record: IdeationRecord = {
        ...proposal,
        id: randomUUID(),
        createdAt: now,
        source: meta.source ?? 'llm-ideation',
        model: meta.model ?? '',
        status: IdeationStatus.New,
        outcome: null,
      }
      write(record)
      records.push(record)
    }
    return records
  }

  function list(): readonly IdeationRecord[] {
    if (!existsSync(rootDir)) return []
    const records: IdeationRecord[] = []
    for (const file of readdirSync(rootDir)) {
      if (!file.endsWith('.json')) continue
      const record = readRecord(join(rootDir, file))
      if (record != null) records.push(record)
      else logger.debug({ file }, 'ideation-inbox: skipped malformed record')
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  function get(id: string): IdeationRecord | null {
    const filePath = pathFor(id)
    if (filePath == null || !existsSync(filePath)) return null
    return readRecord(filePath)
  }

  function update(
    id: string,
    mutate: (record: IdeationRecord) => IdeationRecord,
  ): IdeationRecord | null {
    const existing = get(id)
    if (existing == null) return null
    const updated = mutate(existing)
    write(updated)
    return updated
  }

  function markOutcome(id: string, outcome: IdeationOutcome): IdeationRecord | null {
    return update(id, (r) => ({ ...r, outcome }))
  }

  function setStatus(id: string, status: IdeationStatusType): IdeationRecord | null {
    return update(id, (r) => ({ ...r, status }))
  }

  return { append, list, get, markOutcome, setStatus }
}
