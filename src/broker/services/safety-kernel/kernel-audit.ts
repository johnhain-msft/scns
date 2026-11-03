/**
 * WS-0 Safety Kernel — immutable audit log (Gate 4).
 *
 * An append-only, hash-chained record of EVERY gated decision (allow AND
 * deny). The writer exposes no UPDATE/DELETE path; `verifyAuditChain`
 * recomputes the chain and reports the first tampered/broken row, making
 * any in-place mutation or MID-CHAIN deletion detectable.
 *
 * ── HONEST LIMITATION (tail-truncation; L0 / AWAITING-JOHN) ─────────────
 * A pure hash-chain cannot detect deletion of the MOST RECENT row(s): the
 * remaining prefix still verifies cleanly against GENESIS. Detecting
 * tail-truncation requires an external trust anchor (a separately-persisted
 * head hash / row count) and is NOT implemented this cycle. Two facts bound
 * the risk: the writer has no delete path (raw DB access is required to
 * truncate at all), and every decision is independently mirrored to the
 * append-only `events` table (`kernel.decision`), giving an out-of-band
 * cross-check. A persisted head-anchor is the scheduled L0 hardening. Do
 * NOT claim this chain alone detects tail-truncation.
 *
 * row_hash = sha256( prev_hash + '\n' + canonicalJSON(content) )
 * where content = { ts, actionKind, sessionId, gate, allow, detail, payload }.
 * Row 1's prev_hash is the GENESIS constant.
 */
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

export const KERNEL_AUDIT_GENESIS_HASH = 'GENESIS'

export interface AuditInput {
  readonly actionKind: string
  readonly sessionId?: string | null
  readonly gate: string
  readonly allow: boolean
  readonly detail: string
  readonly payload?: unknown
  /** Override timestamp (tests / determinism). Defaults to now(). */
  readonly ts?: string
}

export interface AuditRow {
  readonly id: number
  readonly ts: string
  readonly actionKind: string
  readonly sessionId: string | null
  readonly gate: string
  readonly allow: boolean
  readonly detail: string
  readonly payload: string | null
  readonly prevHash: string
  readonly rowHash: string
}

interface AuditDbRow {
  id: number
  ts: string
  action_kind: string
  session_id: string | null
  gate: string
  allow: number
  detail: string
  payload: string | null
  prev_hash: string
  row_hash: string
}

export function ensureKernelAuditTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kernel_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      session_id TEXT,
      gate TEXT NOT NULL,
      allow INTEGER NOT NULL,
      detail TEXT NOT NULL,
      payload TEXT,
      prev_hash TEXT NOT NULL,
      row_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kernel_audit_session ON kernel_audit(session_id);
    CREATE INDEX IF NOT EXISTS idx_kernel_audit_gate ON kernel_audit(gate, allow);
  `)
}

interface HashContent {
  ts: string
  actionKind: string
  sessionId: string | null
  gate: string
  allow: boolean
  detail: string
  payload: string | null
}

/** Canonical (stable-key-order) hash of a row's content, chained to prevHash. */
export function computeRowHash(prevHash: string, c: HashContent): string {
  const canonical = JSON.stringify([
    c.ts,
    c.actionKind,
    c.sessionId,
    c.gate,
    c.allow ? 1 : 0,
    c.detail,
    c.payload,
  ])
  return createHash('sha256').update(prevHash + '\n' + canonical).digest('hex')
}

function lastRowHash(db: Database.Database): string {
  const row = db.prepare('SELECT row_hash FROM kernel_audit ORDER BY id DESC LIMIT 1').get() as
    | { row_hash: string }
    | undefined
  return row?.row_hash ?? KERNEL_AUDIT_GENESIS_HASH
}

function toRow(r: AuditDbRow): AuditRow {
  return {
    id: r.id,
    ts: r.ts,
    actionKind: r.action_kind,
    sessionId: r.session_id,
    gate: r.gate,
    allow: r.allow !== 0,
    detail: r.detail,
    payload: r.payload,
    prevHash: r.prev_hash,
    rowHash: r.row_hash,
  }
}

/** Append one decision to the immutable chain. Returns the persisted row. */
export function appendAudit(db: Database.Database, input: AuditInput): AuditRow {
  const ts = input.ts ?? new Date().toISOString()
  const sessionId = input.sessionId ?? null
  const payload = input.payload === undefined ? null : JSON.stringify(input.payload)
  const prevHash = lastRowHash(db)
  const rowHash = computeRowHash(prevHash, {
    ts,
    actionKind: input.actionKind,
    sessionId,
    gate: input.gate,
    allow: input.allow,
    detail: input.detail,
    payload,
  })
  const result = db
    .prepare(
      `INSERT INTO kernel_audit (ts, action_kind, session_id, gate, allow, detail, payload, prev_hash, row_hash)
       VALUES (@ts, @action_kind, @session_id, @gate, @allow, @detail, @payload, @prev_hash, @row_hash)`,
    )
    .run({
      ts,
      action_kind: input.actionKind,
      session_id: sessionId,
      gate: input.gate,
      allow: input.allow ? 1 : 0,
      detail: input.detail,
      payload,
      prev_hash: prevHash,
      row_hash: rowHash,
    })
  return {
    id: Number(result.lastInsertRowid),
    ts,
    actionKind: input.actionKind,
    sessionId,
    gate: input.gate,
    allow: input.allow,
    detail: input.detail,
    payload,
    prevHash,
    rowHash,
  }
}

export function getAuditRows(db: Database.Database): AuditRow[] {
  const rows = db.prepare('SELECT * FROM kernel_audit ORDER BY id').all() as AuditDbRow[]
  return rows.map(toRow)
}

/**
 * Verify the hash chain end-to-end. Returns the first row id whose stored
 * prev_hash or row_hash is inconsistent with the recomputed chain (catches
 * tampered fields AND mid-chain deletion, both of which break the prev-link).
 *
 * LIMIT: tail-truncation (deleting the newest row[s]) leaves a valid prefix
 * and is NOT detectable by the chain alone — see the module header. The
 * append-only `events` mirror is the out-of-band cross-check; a persisted
 * head-anchor is the scheduled L0 hardening.
 */
export function verifyAuditChain(db: Database.Database): {
  ok: boolean
  brokenAtId?: number
  count: number
} {
  const rows = getAuditRows(db)
  let expectedPrev = KERNEL_AUDIT_GENESIS_HASH
  for (const r of rows) {
    if (r.prevHash !== expectedPrev) return { ok: false, brokenAtId: r.id, count: rows.length }
    const recomputed = computeRowHash(r.prevHash, {
      ts: r.ts,
      actionKind: r.actionKind,
      sessionId: r.sessionId,
      gate: r.gate,
      allow: r.allow,
      detail: r.detail,
      payload: r.payload,
    })
    if (recomputed !== r.rowHash) return { ok: false, brokenAtId: r.id, count: rows.length }
    expectedPrev = r.rowHash
  }
  return { ok: true, count: rows.length }
}
