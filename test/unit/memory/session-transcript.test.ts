import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSessionTranscript,
  resolveSessionStorePath,
  parseTurnTimestamp,
  DEFAULT_SESSION_STORE_ENV,
} from '../../../src/memory/session-transcript.js'

// ── The transcript ORACLE — ground truth for "did a human type this?" ────────────────────────────
// The Copilot CLI keeps its own transcript at ~/.copilot/session-store.db (turns.user_message).
// Verified read-only 2026-07-24 against every GATE row in the live store: for session
// 4f2c4f11 the CLI records exactly John's 6 prompts + a <skill-context> injection, and the two
// prompts that contaminated the ACCEPT (experience rows 680/681 — a sub-agent brief and an
// agent-finished notice) are NOT turns at all. That makes authorship a lookup, not a guess.

const dirs: string[] = []
const mkdir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'scns-transcript-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Build a fixture store mirroring the real CLI schema (verified via .schema turns). */
function makeStore(
  rows: Array<{ session: string; idx: number; msg: string | null; ts?: string }>,
): string {
  const path = join(mkdir(), 'session-store.db')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, summary TEXT, created_at TEXT);
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      turn_index INTEGER NOT NULL,
      user_message TEXT,
      assistant_response TEXT,
      timestamp TEXT DEFAULT (datetime('now')),
      UNIQUE(session_id, turn_index)
    );`)
  const insSession = db.prepare('INSERT OR IGNORE INTO sessions (id) VALUES (?)')
  const ins = db.prepare(
    'INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES (?,?,?,?)',
  )
  for (const r of rows) {
    insSession.run(r.session)
    ins.run(r.session, r.idx, r.msg, r.ts ?? '2026-07-17T14:00:00.000Z')
  }
  db.close()
  return path
}

// The real transcript of session 4f2c4f11, verbatim shape.
const SESSION = '4f2c4f11-1aa9-40a0-b6d0-1976b6e44f9e'
const realTurns = [
  {
    session: SESSION,
    idx: 0,
    msg: 'this is investigative *only* do not change any code.',
    ts: '2026-07-17T14:00:00.000Z',
  },
  {
    session: SESSION,
    idx: 1,
    msg: 'should i inntegrate this in before or after',
    ts: '2026-07-17T14:05:00.000Z',
  },
  { session: SESSION, idx: 2, msg: 'yes', ts: '2026-07-17T14:10:00.000Z' },
  {
    session: SESSION,
    idx: 3,
    msg: 'okay -- second investigation.',
    ts: '2026-07-17T14:15:00.000Z',
  },
  {
    session: SESSION,
    idx: 4,
    msg: "i'm working onn fixing cosmere right now",
    ts: '2026-07-17T14:20:00.000Z',
  },
  {
    session: SESSION,
    idx: 5,
    msg: 'why was your previous framing wrong',
    ts: '2026-07-17T14:25:00.000Z',
  },
  {
    session: SESSION,
    idx: 6,
    msg: "1. lets update north star so it isnn't stale.",
    ts: '2026-07-17T14:30:00.000Z',
  },
  {
    session: SESSION,
    idx: 7,
    msg: '<skill-context name="handoff">\nBase directory',
    ts: '2026-07-17T14:35:00.000Z',
  },
]

describe('createSessionTranscript — oracle mode', () => {
  it('returns the human turns for a session, in order, excluding injections', () => {
    const t = createSessionTranscript({ path: makeStore(realTurns) })
    expect(t.mode).toBe('oracle')
    const turns = t.humanTurns(SESSION)
    expect(turns.map((x) => x.turnIndex)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(turns.at(-1)?.text).toContain('lets update north star')
    t.close()
  })

  it('excludes the <skill-context> injection the CLI stores as a user_message', () => {
    const t = createSessionTranscript({ path: makeStore(realTurns) })
    expect(t.humanTurns(SESSION).some((x) => x.text.includes('skill-context'))).toBe(false)
    t.close()
  })

  it('excludes NULL and blank turns', () => {
    const t = createSessionTranscript({
      path: makeStore([
        { session: 's', idx: 0, msg: 'real question from the human' },
        { session: 's', idx: 1, msg: null },
        { session: 's', idx: 2, msg: '   \n ' },
      ]),
    })
    expect(t.humanTurns('s').map((x) => x.turnIndex)).toEqual([0])
    t.close()
  })

  it('scopes strictly to the requested session (no cross-session bleed)', () => {
    const t = createSessionTranscript({
      path: makeStore([
        { session: 'a', idx: 0, msg: 'belongs to a' },
        { session: 'b', idx: 0, msg: 'belongs to b' },
      ]),
    })
    expect(t.humanTurns('a').map((x) => x.text)).toEqual(['belongs to a'])
    expect(t.humanTurns('unknown-session')).toEqual([])
    t.close()
  })

  it('parses timestamps so a turn can be ordered against a delivery time', () => {
    const t = createSessionTranscript({ path: makeStore(realTurns) })
    const turns = t.humanTurns(SESSION)
    const t5 = turns.find((x) => x.turnIndex === 5)!
    const t6 = turns.find((x) => x.turnIndex === 6)!
    expect(t5.timestampMs).not.toBeNull()
    expect(t6.timestampMs! > t5.timestampMs!).toBe(true)
    t.close()
  })
})

describe('createSessionTranscript — fallback mode (fail-safe, never throws)', () => {
  it('falls back when the store file does not exist, and never creates it', () => {
    const missing = join(mkdir(), 'nope.db')
    const t = createSessionTranscript({ path: missing })
    expect(t.mode).toBe('fallback')
    expect(t.reason).toMatch(/not found|unreadable/i)
    expect(t.humanTurns(SESSION)).toEqual([])
    // read-only contract: a missing store must NOT be conjured into existence
    expect(() => new Database(missing, { fileMustExist: true })).toThrow()
    t.close()
  })

  it('falls back when the file is not a database', () => {
    const bad = join(mkdir(), 'garbage.db')
    writeFileSync(bad, 'this is not sqlite')
    const t = createSessionTranscript({ path: bad })
    expect(t.mode).toBe('fallback')
    expect(t.humanTurns(SESSION)).toEqual([])
    t.close()
  })

  it('falls back when the schema lacks a turns table (CLI schema drift)', () => {
    const p = join(mkdir(), 'other.db')
    const db = new Database(p)
    db.exec('CREATE TABLE unrelated (x INTEGER)')
    db.close()
    const t = createSessionTranscript({ path: p })
    expect(t.mode).toBe('fallback')
    expect(t.reason).toMatch(/schema/i)
    t.close()
  })

  it('names a MISCONFIGURED override explicitly so the startup notice is actionable', () => {
    const t = createSessionTranscript({
      env: { [DEFAULT_SESSION_STORE_ENV]: '/definitely/not/here/session-store.db' },
    })
    expect(t.mode).toBe('fallback')
    expect(t.reason).toContain(DEFAULT_SESSION_STORE_ENV)
    t.close()
  })

  it('returns [] rather than throwing when a session id is empty', () => {
    const t = createSessionTranscript({ path: makeStore(realTurns) })
    expect(t.humanTurns('')).toEqual([])
    expect(t.humanTurns(undefined as unknown as string)).toEqual([])
    t.close()
  })
})

describe('resolveSessionStorePath', () => {
  it('prefers the env override', () => {
    expect(resolveSessionStorePath({ [DEFAULT_SESSION_STORE_ENV]: '/custom/x.db' })).toBe(
      '/custom/x.db',
    )
  })

  it('defaults to the Copilot CLI location under the home dir', () => {
    const p = resolveSessionStorePath({ HOME: '/home/jh' })
    // join(): the resolver builds the path with the native separator.
    expect(p).toBe(join('/home/jh', '.copilot', 'session-store.db'))
  })
})

describe('parseTurnTimestamp', () => {
  it('parses the ISO form the CLI writes', () => {
    expect(parseTurnTimestamp('2026-07-25T01:22:50.907Z')).toBe(
      Date.parse('2026-07-25T01:22:50.907Z'),
    )
  })

  it("parses SQLite's default 'YYYY-MM-DD HH:MM:SS' form as UTC", () => {
    expect(parseTurnTimestamp('2026-07-25 01:22:50')).toBe(Date.parse('2026-07-25T01:22:50Z'))
  })

  it('returns null on junk rather than NaN', () => {
    expect(parseTurnTimestamp('not-a-date')).toBeNull()
    expect(parseTurnTimestamp(null)).toBeNull()
  })
})
