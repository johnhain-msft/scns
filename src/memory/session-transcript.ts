/**
 * The Copilot CLI transcript ORACLE — ground truth for "did the human actually type this?".
 *
 * ## Why an oracle instead of a classifier
 * The GATE settle needs to know whether a prompt was authored by the human. Inferring that from the
 * text is a guess: measured on the live store (2026-07-24), prompt length barely separates the
 * classes (human p50 158 chars vs machine p50 1588, tails overlapping past 8k), and the prompt that
 * actually contaminated an ACCEPT (experience row 680, a sub-agent task brief) carries no machine
 * marker at all.
 *
 * But the Copilot CLI already keeps its OWN transcript at `~/.copilot/session-store.db`
 * (`turns.user_message`), and it is exact. Verified read-only against every GATE row:
 *
 *   session 4f2c4f11 -> the CLI records precisely John's 6 prompts plus one `<skill-context>`
 *   injection. The two prompts that contaminated the label (experience rows 680 = a sub-agent
 *   brief, 681 = `Agent "gate-ruberduck" ... has finished processing`) are **not turns at all**.
 *
 * So authorship becomes a LOOKUP. `humanTurns()` returns what the human really said, which also
 * means the settled `elicited_intent` is a genuine human utterance rather than whatever the loop
 * happened to observe next.
 *
 * ## Contract
 * - **Read-only.** Opened `readonly + fileMustExist`; a missing store is never created.
 * - **Fail-safe.** Any problem (missing file, not a database, CLI schema drift, bad session id)
 *   degrades to `mode: 'fallback'` with a human-readable `reason` and an empty turn list. It never
 *   throws into the briefing path.
 * - **Overridable.** `SCNS_COPILOT_SESSION_STORE` points at a different store; a misconfigured
 *   override is reported by name so the startup notice is actionable.
 *
 * When `mode` is `'fallback'`, callers must degrade to the shape-based negative filter in
 * `prompt-authorship.ts` and surface `describeAuthorshipFallback()` at startup.
 */

import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isSystemInjectedTurn } from './prompt-authorship.js'

/** Env var that overrides the Copilot CLI session-store location. */
export const DEFAULT_SESSION_STORE_ENV = 'SCNS_COPILOT_SESSION_STORE'

export type TranscriptMode = 'oracle' | 'fallback'

export interface HumanTurn {
  readonly turnIndex: number
  readonly text: string
  /** Epoch ms, or null when the CLI wrote a timestamp we cannot parse. */
  readonly timestampMs: number | null
}

export interface SessionTranscript {
  readonly mode: TranscriptMode
  /** Why we are in fallback (empty in oracle mode) — surfaced verbatim in the startup notice. */
  readonly reason: string
  readonly path: string | null
  /** Human-authored turns for a session, ascending by turn_index. Empty when unavailable. */
  humanTurns(sessionId: string): readonly HumanTurn[]
  close(): void
}

export interface TranscriptOptions {
  readonly path?: string
  readonly env?: Record<string, string | undefined>
}

/** Resolve the store path: explicit override first, else the CLI's default home location. */
export function resolveSessionStorePath(env: Record<string, string | undefined> = {}): string {
  const override = env[DEFAULT_SESSION_STORE_ENV]?.trim()
  if (override) return override
  const home = env['HOME']?.trim() || homedir()
  return join(home, '.copilot', 'session-store.db')
}

/**
 * Parse a CLI turn timestamp. The store mixes ISO-8601 (`2026-07-25T01:22:50.907Z`, written by the
 * CLI) with SQLite's `datetime('now')` default (`2026-07-25 01:22:50`, which is UTC but carries no
 * zone). Returns null instead of NaN so callers can treat "unknown time" explicitly.
 */
export function parseTurnTimestamp(raw: string | null | undefined): number | null {
  const s = raw?.trim()
  if (!s) return null
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)
    ? `${s.replace(' ', 'T')}Z`
    : s
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

const EMPTY: readonly HumanTurn[] = Object.freeze([])

function fallback(reason: string, path: string | null): SessionTranscript {
  return {
    mode: 'fallback',
    reason,
    path,
    humanTurns: () => EMPTY,
    close: () => {},
  }
}

/**
 * Open the CLI transcript read-only. Never throws; inspect `mode` to learn whether ground truth is
 * actually available.
 */
export function createSessionTranscript(opts: TranscriptOptions = {}): SessionTranscript {
  const env = opts.env ?? {}
  const explicit = opts.path?.trim()
  const overridden = !explicit && !!env[DEFAULT_SESSION_STORE_ENV]?.trim()
  const path = explicit || resolveSessionStorePath(env)

  let db: Database.Database
  try {
    db = new Database(path, { readonly: true, fileMustExist: true })
  } catch (err) {
    const why = `${path} not found or unreadable (${(err as Error).message})`
    return fallback(overridden ? `${DEFAULT_SESSION_STORE_ENV} misconfigured: ${why}` : why, path)
  }

  let query: Database.Statement
  try {
    // Probe the schema up front so drift in the CLI's private store degrades cleanly at startup
    // rather than throwing on the first briefing.
    query = db.prepare(
      `SELECT turn_index, user_message, timestamp FROM turns
        WHERE session_id = ? ORDER BY turn_index ASC`,
    )
    query.get('__schema_probe__')
  } catch (err) {
    try {
      db.close()
    } catch {
      /* nothing to do */
    }
    return fallback(
      `${path} has an incompatible schema — no readable turns table (${(err as Error).message})`,
      path,
    )
  }

  return {
    mode: 'oracle',
    reason: '',
    path,
    humanTurns(sessionId: string): readonly HumanTurn[] {
      const id = sessionId?.trim?.()
      if (!id) return EMPTY
      try {
        const rows = query.all(id) as Array<{
          turn_index: number
          user_message: string | null
          timestamp: string | null
        }>
        const out: HumanTurn[] = []
        for (const r of rows) {
          if (isSystemInjectedTurn(r.user_message)) continue
          out.push({
            turnIndex: r.turn_index,
            text: (r.user_message ?? '').trim(),
            timestampMs: parseTurnTimestamp(r.timestamp),
          })
        }
        return out
      } catch {
        return EMPTY
      }
    },
    close() {
      try {
        db.close()
      } catch {
        /* already closed */
      }
    },
  }
}
