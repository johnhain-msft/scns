import { describe, it, expect } from 'vitest'
import {
  classifyPromptAuthorship,
  isSystemInjectedTurn,
  MACHINE_RULES,
} from '../../../src/memory/prompt-authorship.js'

// ── Deterministic authorship classifier — the FALLBACK for when the Copilot CLI transcript oracle
// (session-transcript.ts) is unavailable. Every fixture below is a REAL prompt observed in the live
// experience store (~/.scns/memory/experience.db, read-only, 2026-07-24) — not an invented string.
//
// Why this exists: 58.1% of the logged corpus is machine-authored (445 agent-spawn prompts + 14
// agent-finished notices of 752 rows), so "the next prompt in the session" is more likely to be a
// machine than the human. Settling an ACCEPT on that is authorship bias — the Joachims (SIGIR 2005)
// implicit-feedback caution adopted in docs/research/intent-prior-art.md §3.
//
// The classifier is deliberately a NEGATIVE filter: it recognizes known machine shapes with high
// precision. It CANNOT prove a prompt is human — only the oracle can. Callers must treat 'human'
// here as "not a recognized machine shape", which is why the oracle is the default.

describe('classifyPromptAuthorship — machine shapes (real observed rows)', () => {
  it('flags the agent-finished notification that contaminated experience row 678', () => {
    // verbatim experience.db row 681 — the notice that would have settled the accept
    const v = classifyPromptAuthorship(
      '\nAgent "gate-ruberduck" (rubber-duck) has finished processing and is now idle. ' +
        'Use read_agent with agent_id "gate-ruberduck" to read the results, or write_agent to send follow-up messages.\n',
    )
    expect(v.author).toBe('machine')
    expect(v.rule).toBe('agent-completion-notice')
  })

  it('flags the agent-finished notice recorded as the "answer" for row 382', () => {
    const v = classifyPromptAuthorship(
      'Agent "mem-isolation" (explore) has finished processing and is now idle. ' +
        'Use read_agent with agent_id "mem-isolation" to read the results, or write_ag',
    )
    expect(v.author).toBe('machine')
    expect(v.rule).toBe('agent-completion-notice')
  })

  it('flags "You are ..." agent role preambles (445 of 752 live rows)', () => {
    for (const p of [
      'You are a strict news-desk fact-checker for a CATCH-UP developer briefing.\nYour only job: decide',
      'You are worker-1783553630669, a worker agent on team __fleet__.\n\nSESSION DETAILS:',
      'You are the SCNS claim verifier — an INDEPENDENT producer≠verifier critic.',
      'You are the impl-worker. Implement EXACTLY ONE task: T023.',
    ]) {
      const v = classifyPromptAuthorship(p)
      expect(v.author, p.slice(0, 40)).toBe('machine')
      expect(v.rule).toBe('agent-role-preamble')
    }
  })

  it('flags the fleet-mode harness wrapper (real row 384)', () => {
    const v = classifyPromptAuthorship(
      'You are now in fleet mode. Dispatch sub-agents (via the task tool) in parallel to do the work.\n\n' +
        '**Getting Started**\n1. Check for existing todos',
    )
    expect(v.author).toBe('machine')
  })

  it('flags an orchestrator dispatch brief with no role preamble', () => {
    // The module's documented blind spot: a brief that skips "You are …" but
    // still instructs the reader to open a kickoff file under `.orchestrator/`.
    for (const p of [
      'Read .orchestrator/deck-e19f65/kickoff-build-5.md IN FULL and execute it exactly.',
      'Short DELTA pass. Read the brief at .orchestrator/deck-e19f65/brief-challenge.md first.',
      'Open .orchestrator\\deck-e19f65\\kickoff-build-5.md and follow it.',
    ]) {
      const v = classifyPromptAuthorship(p)
      expect(v.author, p.slice(0, 40)).toBe('machine')
      expect(v.rule).toBe('orchestrator-dispatch-brief')
    }
  })

  it('flags runtime-injected system blocks', () => {
    expect(classifyPromptAuthorship('<system_reminder>\nIMPORTANT: tools listed').author).toBe(
      'machine',
    )
    expect(classifyPromptAuthorship('<skill-context name="handoff">\nBase directory').author).toBe(
      'machine',
    )
  })
})

describe('classifyPromptAuthorship — human prompts (real observed rows)', () => {
  it('does NOT flag John\u2019s real prompts, including typos and short replies', () => {
    for (const p of [
      'this is investigative *only* do not change any code. look at our memory system',
      'should i inntegrate this in before or after i focus on finishing the "learning" aspect',
      'yes',
      'okay -- second investigation. do we have enough information collected yet',
      "i'm working onn fixing cosmere right now -- it had some bugs",
      'why was your previous framing wrong -- what gave you that incorrect initial conclusion',
      "1. lets update north star so it isnn't stale. 2. before adding the new conclusions",
      'did we fix n1 or do we need to fix it? what are next steps for this?',
      'we dont have a productiion envrionment yet -- it can be default on',
    ]) {
      const v = classifyPromptAuthorship(p)
      expect(v.author, p.slice(0, 40)).toBe('human')
    }
  })

  it('does not flag a human prompt that merely mentions an agent', () => {
    expect(
      classifyPromptAuthorship('should we create the new aaagents before we investigate?').author,
    ).toBe('human')
  })

  it('does not flag a human DEBUGGING the orchestrator who mentions its paths', () => {
    // This classifier feeds ~a dozen call sites whose verdicts persist (gate
    // settle, experience-store prompt_origin): a bare `.orchestrator/`
    // substring rule would durably mis-label every such prompt. The rule
    // requires the dispatch shape — an imperative telling the reader to open
    // the brief — not the path alone.
    for (const p of [
      'why does .orchestrator/deck-x/kickoff-build-5.md skip row 2?',
      'the .orchestrator/deck-x tree looks stale — can we prune it',
      'i think the bug is in how .orchestrator\\deck-x\\state.json gets written on windows',
    ]) {
      const v = classifyPromptAuthorship(p)
      expect(v.author, p.slice(0, 40)).toBe('human')
    }
  })
})

describe('classifyPromptAuthorship — honest limits', () => {
  it('CANNOT catch a sub-agent task brief that lacks a machine marker (row 680)', () => {
    // The real contaminator. It has no "You are" preamble and is not a completion notice, so the
    // deterministic fallback mis-labels it 'human'. This test PINS that known gap so it is never
    // mistaken for coverage — it is exactly why the transcript oracle is the default mechanism.
    const v = classifyPromptAuthorship(
      'Rubber-duck my understanding of the SCNS "GATE intent-elicitation" subsystem BEFORE I commit ' +
        'these conclusions to a planning doc (docs/NORTH_STAR.md). READ THE ACTUAL CODE to verify',
    )
    expect(v.author).toBe('human')
    expect(v.rule).toBe('no-machine-marker')
  })

  it('treats blank input as machine (never settles an ACCEPT on nothing)', () => {
    expect(classifyPromptAuthorship('').author).toBe('machine')
    expect(classifyPromptAuthorship('   \n  ').author).toBe('machine')
  })

  it('exposes its rule set so the fallback notice can name what it can and cannot see', () => {
    expect(MACHINE_RULES.length).toBeGreaterThan(0)
    expect(MACHINE_RULES.map((r) => r.name)).toContain('agent-completion-notice')
  })
})

describe('isSystemInjectedTurn', () => {
  it('recognizes the injected blocks that appear in the CLI transcript as user_message', () => {
    expect(isSystemInjectedTurn('<skill-context name="handoff">\nBase directory')).toBe(true)
    expect(isSystemInjectedTurn('<system_reminder>\nIMPORTANT')).toBe(true)
    expect(isSystemInjectedTurn('  <system-reminder>x')).toBe(true)
  })

  it('does not treat ordinary human text as injected', () => {
    expect(isSystemInjectedTurn('why was your previous framing wrong')).toBe(false)
    expect(isSystemInjectedTurn('yes')).toBe(false)
  })

  it('treats empty/whitespace turns as non-human', () => {
    expect(isSystemInjectedTurn('')).toBe(true)
    expect(isSystemInjectedTurn('   ')).toBe(true)
  })
})
