/**
 * D2b — proposal outcomes: the per-entity "what landed" memory that closes the
 * read→write self-improvement loop (MAGMA Eq.2 `Mₜ₊₁ = Update(Mₜ, qₜ, oₜ)`,
 * design-m1.md §6).
 *
 * After a self-improvement PROPOSAL is acted on (quality-gate verdict / merge /
 * revert / reject), its outcome is recorded here keyed to the gazetteer entity it
 * targets. The D2a ideation read (`memory-self-improvement.ts`) aggregates these to
 * learn what lands for a concept over time — prioritising hot entities and
 * suppressing families that already landed or keep failing.
 *
 * This is ALSO the event/outcome-level causal-candidate source: a discrete
 * "proposal → outcome" record is a real cause→effect pair, unlike the mid-word
 * chunk fragments that capped M1.3 at ~0 edges (handoff "convergence" finding).
 *
 * Pure storage helper — no env, no I/O beyond the injected DB, never edits
 * guardrail files. The `proposal_outcomes` table is created by `openMemoryDb`
 * (db.ts SCHEMA) and is inert until written.
 */

import type Database from 'better-sqlite3'

/** How a proposal ultimately fared. */
export type ProposalVerdict =
  | 'implemented'
  | 'merged'
  | 'reverted'
  | 'rejected'
  | 'failed'
  | 'needs-human'
  | 'passed-gate'

/** Verdicts that count as a successful landing (favour adjacent next steps). */
export const LANDED_VERDICTS: ReadonlySet<ProposalVerdict> = new Set<ProposalVerdict>([
  'implemented',
  'merged',
])

/**
 * Verdicts that count as a failure (avoid re-proposing the same family).
 *
 * FR-059 — `failed` is deliberately NOT a member. It means *the machine could not build this*,
 * and the gradient this set feeds is a record of what the HUMAN refuses. Counting a build failure
 * as a refusal is the same conflation as labelling one `rejected`, one level down: it suppressed
 * the family at `memory-self-improvement.ts:193` on the strength of an agent that produced a
 * zero-byte diff. John, 2026-08-04: *"FAILED should not stay in failed verdicts after a human has
 * reviewed it — they should only be rejected."*
 *
 * `needs-human` is likewise absent, and always was — an exhausted implementation awaiting John's
 * call is not yet an outcome in either direction, which is why FR-056b could reuse it as the
 * escalation label without touching this set at all.
 *
 * ⚠️ Applied at READ time (`aggregateOutcomesByEntity`, :203), so this change is **retroactive**:
 * every historical `failed` row left the failed count the instant it shipped, and any family
 * suppressed purely by executor failures un-suppressed with it (FR-059b). That is intended. It
 * also means figures computed after this change are a NEW BASELINE — never splice them to a
 * reward or verdict series computed before it.
 */
export const FAILED_VERDICTS: ReadonlySet<ProposalVerdict> = new Set<ProposalVerdict>([
  'rejected',
  'reverted',
])

export interface ProposalOutcomeInput {
  /** Gazetteer canonical the proposal targets (caller canonicalizes). */
  readonly entity: string
  /** Template family / seed tag — the dedupe + suppression key. */
  readonly family: string
  readonly title: string
  readonly verdict: ProposalVerdict
  /** Quality-gate rubric score etc. (nullable). */
  readonly score?: number | null
  /** Source suggestion id; when present, (suggestion_id, entity, family) is idempotent. */
  readonly suggestionId?: string | null
  readonly rationale?: string | null
}

export interface ProposalOutcomeRow {
  readonly id: number
  readonly entity: string
  readonly family: string
  readonly title: string
  readonly verdict: ProposalVerdict
  readonly score: number | null
  readonly suggestion_id: string | null
  readonly rationale: string | null
  readonly created_at: string
}

export interface FamilyOutcome {
  readonly family: string
  readonly landed: number
  readonly failed: number
  /** Verdict of the most-recently-recorded outcome for this family. */
  readonly lastVerdict: ProposalVerdict
  readonly lastScore: number | null
  readonly lastAt: string
}

export interface EntityOutcomeAggregate {
  readonly entity: string
  readonly total: number
  readonly landed: number
  readonly failed: number
  readonly families: ReadonlyMap<string, FamilyOutcome>
}

/**
 * Idempotently create the table when callers pass a DB that did not run the full
 * `openMemoryDb` SCHEMA (defensive; cheap CREATE IF NOT EXISTS). Only the WRITER
 * ensures the schema — readers tolerate a missing table so a read never has a write
 * side-effect (and works against a readonly handle, e.g. the live-vault probe).
 */
export function ensureProposalOutcomesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposal_outcomes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      entity        TEXT NOT NULL,
      family        TEXT NOT NULL,
      title         TEXT NOT NULL,
      verdict       TEXT NOT NULL,
      score         REAL,
      suggestion_id TEXT,
      rationale     TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(suggestion_id, entity, family)
    );
    CREATE INDEX IF NOT EXISTS idx_proposal_outcomes_entity ON proposal_outcomes(entity);
  `)
}

/** True iff the proposal_outcomes table exists (so readers stay side-effect-free). */
function tableExists(db: Database.Database): boolean {
  const r = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proposal_outcomes'")
    .get() as { name?: string } | undefined
  return !!r?.name
}

/**
 * Record a proposal outcome. Idempotent when `suggestionId` is present — a second
 * call with the same (suggestion_id, entity, family) is a no-op that returns the
 * existing row (first write wins), so async completion hooks can't double-count.
 * With a null `suggestionId`, every call inserts (distinct NULLs in SQLite UNIQUE).
 */
export function recordProposalOutcome(
  db: Database.Database,
  input: ProposalOutcomeInput,
): ProposalOutcomeRow | null {
  ensureProposalOutcomesSchema(db)
  const suggestionId = input.suggestionId ?? null
  const info = db
    .prepare(
      `INSERT INTO proposal_outcomes
         (entity, family, title, verdict, score, suggestion_id, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(suggestion_id, entity, family) DO NOTHING`,
    )
    .run(
      input.entity,
      input.family,
      input.title,
      input.verdict,
      input.score ?? null,
      suggestionId,
      input.rationale ?? null,
    )

  if (info.changes === 0) {
    if (suggestionId) {
      const existing = db
        .prepare(
          'SELECT * FROM proposal_outcomes WHERE suggestion_id = ? AND entity = ? AND family = ?',
        )
        .get(suggestionId, input.entity, input.family) as ProposalOutcomeRow | undefined

      // FR-057 — first-write-wins is correct for AUTHORITATIVE verdicts, and wrong for `failed`.
      //
      // The `DO NOTHING` above exists so async completion hooks cannot double-count. That was
      // safe while a gate failure was terminal on attempt one: first row == last row. Phase 10f
      // makes the gate retry up to `MAX_ATTEMPTS_BEFORE_FAILED` times, so a proposal can now fail
      // attempt 1 and LAND on attempt 3 — and with an unconditional `DO NOTHING` the ledger would
      // permanently report the outcome of attempt one. A system that retries five times and then
      // reports the first result is the kind of thing that looks fine now and is inexplicable
      // later.
      //
      // So: a stored `failed` is provisional (the machine could not build it YET) and may be
      // superseded. Anything else — `rejected`, `reverted`, `implemented`, `merged` — is a human
      // decision or a landing, and keeps its original first-write-wins protection. In particular
      // a later `failed` can never overwrite an earlier `rejected`: John's refusal outranks a
      // build failure, which is the same precedence the whole phase is built on.
      if (existing && existing.verdict === 'failed' && input.verdict !== 'failed') {
        db.prepare(
          `UPDATE proposal_outcomes
              SET verdict = ?, score = ?, title = ?, rationale = ?
            WHERE suggestion_id = ? AND entity = ? AND family = ?`,
        ).run(
          input.verdict,
          input.score ?? null,
          input.title,
          input.rationale ?? null,
          suggestionId,
          input.entity,
          input.family,
        )
        const updated = db
          .prepare(
            'SELECT * FROM proposal_outcomes WHERE suggestion_id = ? AND entity = ? AND family = ?',
          )
          .get(suggestionId, input.entity, input.family) as ProposalOutcomeRow | undefined
        return updated ? { ...updated } : null
      }

      return existing ? { ...existing } : null
    }
    return null
  }

  const row = db
    .prepare('SELECT * FROM proposal_outcomes WHERE id = ?')
    .get(info.lastInsertRowid) as ProposalOutcomeRow | undefined
  return row ? { ...row } : null
}

interface RawRow {
  family: string
  verdict: ProposalVerdict
  score: number | null
  created_at: string
  id: number
}

/**
 * Aggregate every outcome for `entity` into landed/failed counts and a per-family
 * roll-up whose `lastVerdict`/`lastScore` reflect the most-recently-recorded
 * outcome (by created_at then id, so ties within the same second are stable).
 */
export function aggregateOutcomesByEntity(
  db: Database.Database,
  entity: string,
): EntityOutcomeAggregate {
  if (!tableExists(db)) {
    return { entity, total: 0, landed: 0, failed: 0, families: new Map() }
  }
  const rows = db
    .prepare(
      `SELECT id, family, verdict, score, created_at
       FROM proposal_outcomes
       WHERE entity = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(entity) as RawRow[]

  const families = new Map<string, FamilyOutcome>()
  let landed = 0
  let failed = 0

  for (const r of rows) {
    const isLanded = LANDED_VERDICTS.has(r.verdict)
    const isFailed = FAILED_VERDICTS.has(r.verdict)
    if (isLanded) landed++
    if (isFailed) failed++

    const prev = families.get(r.family)
    families.set(r.family, {
      family: r.family,
      landed: (prev?.landed ?? 0) + (isLanded ? 1 : 0),
      failed: (prev?.failed ?? 0) + (isFailed ? 1 : 0),
      // rows are ASC, so the last one seen is the most recent
      lastVerdict: r.verdict,
      lastScore: r.score,
      lastAt: r.created_at,
    })
  }

  return { entity, total: rows.length, landed, failed, families }
}

/** Distinct entities that have at least one recorded outcome. */
export function listOutcomeEntities(db: Database.Database): string[] {
  if (!tableExists(db)) return []
  const rows = db
    .prepare('SELECT DISTINCT entity FROM proposal_outcomes ORDER BY entity ASC')
    .all() as Array<{ entity: string }>
  return rows.map((r) => r.entity)
}
