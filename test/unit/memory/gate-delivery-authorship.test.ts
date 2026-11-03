import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openExperienceStore,
  logRetrievalExperience,
  type ExperienceStore,
} from '../../../src/memory/experience-store.js'
import {
  setGateQuestion,
  findDeliverableGateQuestion,
  markGateDelivered,
  findGateAnswer,
  settleGateAnswered,
} from '../../../src/memory/gate-elicitation.js'
import {
  createSessionTranscript,
  type SessionTranscript,
} from '../../../src/memory/session-transcript.js'

// ── GATE 3(c): a clarifying question may only be DELIVERED into a briefing the HUMAN will read ────
//
// THE LIVE INCIDENT (experience.db, read-only, 2026-07-28). Row 843 asked John a clarifying question.
// The very next briefing request was the assistant's own sub-agent brief ("You are an INDEPENDENT
// fresh-context grader..."), logged as row 844. The question was appended to THAT briefing, so it
// entered the sub-agent's context and John never saw it — yet `gate_delivered` was set anyway:
//
//   843: transcriptHumanTurn=YES(pos=2) hasGateQ=Y delivered=1 ref=844 settled=NULL
//   844: transcriptHumanTurn=NO  shapeClassifier=machine
//   => resolveAnswerFromTranscript deliveryPos = -1 => returns null => 843 can NEVER settle
//      redeliverable now: NONE (gate_delivered=1 is terminal)
//
// The SETTLE side already refuses to invent an answer for a machine delivery ("the question was
// surfaced into a machine briefing ... The human never saw it"). The DELIVERY side had no such guard —
// even though the ARM-SELECTION decision immediately above it in `cli.ts` already applies exactly this
// `classifyPromptAuthorship` negative filter, for exactly this reason ("a row that can never settle").
//
// This is a CORRECTNESS fix, not a loosening: it makes delivery STRICTER. Nothing here widens any
// abstention rule, and no new settle path is introduced.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeTranscript(sessionId: string, messages: string[]): SessionTranscript {
  const dir = mkdtempSync(join(tmpdir(), 'scns-gate-deliver-'))
  dirs.push(dir)
  const path = join(dir, 'session-store.db')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      turn_index INTEGER NOT NULL,
      user_message TEXT,
      timestamp TEXT,
      UNIQUE(session_id, turn_index)
    );`)
  db.prepare('INSERT INTO sessions (id) VALUES (?)').run(sessionId)
  const ins = db.prepare(
    'INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES (?,?,?,?)',
  )
  messages.forEach((m, i) => ins.run(sessionId, i, m, '2026-07-28T03:00:00.000Z'))
  db.close()
  return createSessionTranscript({ path })
}

const mk = (store: ExperienceStore, conversationId: string, queryText: string): number =>
  logRetrievalExperience(store, {
    queryText,
    levers: { traverse: true, synthesize: true },
    retrievedChunkIds: [1, 2],
    conversationId,
  })

const col = <T>(store: ExperienceStore, id: number, name: string): T =>
  (store.db.prepare(`SELECT ${name} AS v FROM retrieval_experience WHERE id = ?`).get(id) as {
    v: T
  }).v

// Verbatim from the live store (truncated only in length, not in shape).
const SUBAGENT_BRIEF =
  'You are an INDEPENDENT fresh-context grader (producer != grader). You did NOT write this code and ' +
  'you must NOT trust the producer\u2019s report, numbers, or claims.'
const AGENT_NOTICE =
  'Agent "judge" (general-purpose) has finished processing and is now idle. Use read_agent with ' +
  'agent_id "judge" to read the result.'
const HUMAN_TURN_843 =
  'not completely following -- did we fix this overall -- you ran a while -- didn\u2019t launch an ' +
  'independent judge subagent to grade it?'
const HUMAN_TURN_845 =
  'to clariify -- the funnel that will allow it to self-improve is unblocked? I thought we fixed the ' +
  'grader that was over-claiming?'
const HUMAN_TURN_851 =
  'whaat do you men my next message settles 843 nad 845? why were the curl commands captured aasa ' +
  'human traffic?'

describe('findDeliverableGateQuestion — authorship guard on the DELIVERY vehicle', () => {
  it('NEGATIVE: refuses to deliver into a machine-authored briefing (the sub-agent brief)', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, 'sess-A', HUMAN_TURN_843)
    setGateQuestion(store, id, 'Which subsystem do you mean?')
    expect(
      findDeliverableGateQuestion(store, {
        conversationId: 'sess-A',
        deliveryPrompt: SUBAGENT_BRIEF,
      }),
    ).toBeNull()
    store.close()
  })

  it('NEGATIVE: refuses an agent-completion notice as the delivery vehicle', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, 'sess-A', HUMAN_TURN_843)
    setGateQuestion(store, id, 'Which subsystem do you mean?')
    expect(
      findDeliverableGateQuestion(store, {
        conversationId: 'sess-A',
        deliveryPrompt: AGENT_NOTICE,
      }),
    ).toBeNull()
    store.close()
  })

  it('NEGATIVE: an empty/absent delivery prompt is never a human — refuses', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, 'sess-A', HUMAN_TURN_843)
    setGateQuestion(store, id, 'Which subsystem do you mean?')
    expect(
      findDeliverableGateQuestion(store, { conversationId: 'sess-A', deliveryPrompt: '   ' }),
    ).toBeNull()
    store.close()
  })

  it('POSITIVE: still delivers into a human-authored briefing', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, 'sess-A', HUMAN_TURN_843)
    setGateQuestion(store, id, 'Which subsystem do you mean?')
    expect(
      findDeliverableGateQuestion(store, {
        conversationId: 'sess-A',
        deliveryPrompt: HUMAN_TURN_845,
      }),
    ).toEqual({ experienceId: id, question: 'Which subsystem do you mean?' })
    store.close()
  })

  it('the question SURVIVES a machine turn and is still deliverable to the next human turn', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, 'sess-A', HUMAN_TURN_843)
    setGateQuestion(store, id, 'Which subsystem do you mean?')
    // machine briefing passes through — no delivery, and crucially NO BURN
    expect(
      findDeliverableGateQuestion(store, { conversationId: 'sess-A', deliveryPrompt: SUBAGENT_BRIEF }),
    ).toBeNull()
    expect(col<number>(store, id, 'gate_delivered')).toBe(0)
    // the next human briefing still gets it
    expect(
      findDeliverableGateQuestion(store, { conversationId: 'sess-A', deliveryPrompt: HUMAN_TURN_845 })
        ?.experienceId,
    ).toBe(id)
    store.close()
  })
})

describe('COUNTERFACTUAL REPLAY of the live row-843 incident', () => {
  // The real session's human turns, in order, as recorded by the Copilot CLI transcript oracle.
  const CONV = 'sess-843'
  const HUMAN_TURNS = [
    'Implement the SCNS learning-loop unblock in the repo on branch track2/cosmere-federation-phase1.',
    '5000ms is an arbitrary position; however, we donn\u2019t want to cause too much delay during real use.',
    HUMAN_TURN_843,
    HUMAN_TURN_845,
    HUMAN_TURN_851,
  ]

  it('WITHOUT the guard the question is burned on the sub-agent brief and can never settle', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript(CONV, HUMAN_TURNS)
    const gateId = mk(store, CONV, HUMAN_TURN_843)
    setGateQuestion(store, gateId, 'Which subsystem do you mean?')
    // reproduce the bug exactly: deliver onto the machine brief
    const machineId = mk(store, CONV, SUBAGENT_BRIEF)
    markGateDelivered(store, gateId, { deliveredByExperienceId: machineId })
    expect(col<number>(store, gateId, 'gate_delivered')).toBe(1)
    // John's real next turn cannot settle it — the delivery turn is not in his transcript
    expect(
      findGateAnswer(store, { conversationId: CONV, prompt: HUMAN_TURN_851, transcript }),
    ).toBeNull()
    expect(col<number | null>(store, gateId, 'human_outcome')).toBeNull()
    transcript.close()
    store.close()
  })

  it('WITH the guard the question rides the next HUMAN briefing and settles ACCEPT', () => {
    const store = openExperienceStore(':memory:')
    const transcript = makeTranscript(CONV, HUMAN_TURNS)
    const gateId = mk(store, CONV, HUMAN_TURN_843)
    setGateQuestion(store, gateId, 'Which subsystem do you mean?')

    // turn: the assistant's own sub-agent brief — guard refuses, question is NOT burned
    const machineId = mk(store, CONV, SUBAGENT_BRIEF)
    expect(machineId).toBeGreaterThan(0)
    expect(
      findDeliverableGateQuestion(store, { conversationId: CONV, deliveryPrompt: SUBAGENT_BRIEF }),
    ).toBeNull()

    // turn: John's real next prompt — the question is delivered here
    const humanId = mk(store, CONV, HUMAN_TURN_845)
    const deliverable = findDeliverableGateQuestion(store, {
      conversationId: CONV,
      deliveryPrompt: HUMAN_TURN_845,
    })
    expect(deliverable?.experienceId).toBe(gateId)
    markGateDelivered(store, gateId, { deliveredByExperienceId: humanId })

    // turn: John answers -> the transcript oracle can now locate the delivery turn and settle
    const answer = findGateAnswer(store, {
      conversationId: CONV,
      prompt: HUMAN_TURN_851,
      transcript,
    })
    expect(answer?.experienceId).toBe(gateId)
    expect(answer?.source).toBe('transcript-oracle:turn-4')
    expect(settleGateAnswered(store, answer!.experienceId, answer!.answer, answer!.source)).toBe(true)
    expect(col<number>(store, gateId, 'human_outcome')).toBe(1.0)
    expect(col<string>(store, gateId, 'elicited_intent')).toBe(HUMAN_TURN_851)
    transcript.close()
    store.close()
  })
})
