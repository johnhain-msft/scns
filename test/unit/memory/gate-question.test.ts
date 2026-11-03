import { describe, it, expect } from 'vitest'
import {
  buildClarifyingQuestionPrompt,
  parseClarifyingQuestion,
  GATE_QUESTION_SYSTEM_PROMPT,
  NULL_GATE_QUESTION_PROVIDER,
} from '../../../src/memory/gate-question.js'
import { createAcpGateQuestionProvider } from '../../../src/memory/gate-question-acp.js'

// ── GATE Part B — the informative clarifying-QUESTION generator ("what to ask") ───────────────────
// The faithful GATE mechanism (arXiv:2310.11589, "Generative open-ended questions"): prompt an LM to
// generate the SINGLE most informative clarifying question that reveals the most about the desired
// behavior BEYOND what has already been asked, addressing a DIFFERENT aspect, kept BITE-SIZED. The
// informativeness is delegated to the LM in the prompt (no info-gain math) — verbatim to the paper's
// authors' code. Transport is a deny-all ACP spawn (mirrors fact-extractor-acp.ts); fail-safe to ''.

describe('buildClarifyingQuestionPrompt — GATE open-ended prompt (verbatim structure)', () => {
  it('embeds the task description and the GATE informativeness instruction', () => {
    const p = buildClarifyingQuestionPrompt({ taskDescription: 'fix this' })
    expect(p).toContain('fix this')
    expect(p).toMatch(/most informative/i)
    expect(p).toMatch(/beyond what has already been/i)
    expect(p).toMatch(/different aspect/i)
    expect(p).toMatch(/bite-sized|one|single/i)
    // asks for the question ONLY (parseable output)
    expect(p).toMatch(/question and nothing else|only the question/i)
  })

  it('includes prior clarifying Q&A so a follow-up covers a NEW aspect (de-dup driver)', () => {
    const p = buildClarifyingQuestionPrompt({
      taskDescription: 'improve the retrieval',
      history: [{ question: 'Which file?', answer: 'the beam scorer' }],
    })
    expect(p).toContain('Which file?')
    expect(p).toContain('the beam scorer')
  })

  it('handles empty history (the first ask) without crashing', () => {
    const p = buildClarifyingQuestionPrompt({ taskDescription: 'make it better', history: [] })
    expect(p).toContain('make it better')
  })
})

describe('parseClarifyingQuestion — extract ONE clean question from raw LM output', () => {
  it('strips surrounding quotes and whitespace', () => {
    expect(parseClarifyingQuestion('  "Which module should I optimize?"  ')).toBe(
      'Which module should I optimize?',
    )
  })
  it('takes the first non-empty line when the model adds chatter', () => {
    expect(
      parseClarifyingQuestion('Sure! Here is a question:\nWhat output format do you want?\n\nHope that helps'),
    ).toMatch(/^What output format do you want\?/)
  })
  it('returns empty string for empty / whitespace output (fail-safe upstream)', () => {
    expect(parseClarifyingQuestion('')).toBe('')
    expect(parseClarifyingQuestion('   \n  ')).toBe('')
  })
  it('truncates an over-long question to a bounded length', () => {
    const long = 'Why '.repeat(200) + '?'
    expect(parseClarifyingQuestion(long).length).toBeLessThanOrEqual(300)
  })
})

describe('NULL_GATE_QUESTION_PROVIDER — CI-safe default (never spawns)', () => {
  it('always yields an empty question', async () => {
    expect(await NULL_GATE_QUESTION_PROVIDER.generate({ taskDescription: 'fix this' })).toBe('')
  })
})

describe('createAcpGateQuestionProvider — deny-all transport (injected fake client, no spawn)', () => {
  it('initialises, sends the GATE prompt, and returns the parsed question', async () => {
    let sawInit = false
    let sentPrompt = ''
    let allowAll: boolean | undefined
    const fakeClient = {
      async initialize() {
        sawInit = true
      },
      async createSession() {
        return 'sess-1'
      },
      async sendPrompt(_s: string, prompt: string) {
        sentPrompt = prompt
        return { stopReason: 'end_turn', output: '"Which specific file or behavior should I change?"' }
      },
      async close() {},
    }
    const provider = createAcpGateQuestionProvider({
      cwd: '/tmp/scns-gate-q-test-isolated',
      createClient: (opts) => {
        allowAll = opts.allowAllTools
        return fakeClient as never
      },
    })
    const q = await provider.generate({ taskDescription: 'fix this' })
    expect(sawInit).toBe(true)
    expect(sentPrompt).toContain('fix this')
    expect(q).toBe('Which specific file or behavior should I change?')
    // DENY-ALL: the question generator must never run tools (think-only turn)
    expect(allowAll).toBe(false)
  })

  it("returns '' (do no harm) when the client throws — the briefing is never affected", async () => {
    const throwing = {
      async initialize() {
        throw new Error('spawn failed')
      },
      async createSession() {
        return 's'
      },
      async sendPrompt() {
        return { stopReason: 'end_turn', output: '?' }
      },
      async close() {},
    }
    const provider = createAcpGateQuestionProvider({
      cwd: '/tmp/scns-gate-q-test-isolated',
      createClient: () => throwing as never,
    })
    expect(await provider.generate({ taskDescription: 'fix this' })).toBe('')
  })

  it('requires an isolated cwd (never the live checkout)', () => {
    expect(() => createAcpGateQuestionProvider({ cwd: '' })).toThrow(/isolated cwd/i)
  })

  it('exposes a non-empty system prompt describing the elicitation role', () => {
    expect(GATE_QUESTION_SYSTEM_PROMPT).toMatch(/clarif|elicit|question/i)
  })
})
