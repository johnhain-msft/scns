/**
 * Unit tests for sentiment analyzer — strict heuristic-based negative sentiment detection.
 * TDD: tests written first, implementation follows.
 */

import { describe, it, expect } from 'vitest'
import {
  analyzeSentiment,
  type _SentimentAnalysis,
  type _SentimentSignalType,
} from '../../../src/memory/sentiment-analyzer.js'

describe('analyzeSentiment', () => {
  // ── Frustration detection ──────────────────────────────────────

  it('detects explicit frustration with strong language', () => {
    const result = analyzeSentiment('why would you lie about taking screenshots and checking?')
    expect(result.isNegative).toBe(true)
    expect(result.overallScore).toBeGreaterThanOrEqual(0.75)
    expect(result.signals.some((s) => s.type === 'frustration')).toBe(true)
  })

  it('detects frustration from "this is broken"', () => {
    const result = analyzeSentiment('the dashboard no longer shows live sessions, this is broken')
    expect(result.isNegative).toBe(true)
    expect(result.signals.some((s) => s.type === 'frustration')).toBe(true)
  })

  it('detects frustration from repeated failures', () => {
    const result = analyzeSentiment(
      'yeah still not working though is it. instead of saying ive fixed it, you need to actually run the tests',
    )
    expect(result.isNegative).toBe(true)
    expect(result.overallScore).toBeGreaterThanOrEqual(0.75)
  })

  // ── Correction detection ───────────────────────────────────────

  it('detects correction when user says "that is not what I meant"', () => {
    const result = analyzeSentiment("that's not what I meant, I wanted you to run the actual tests")
    expect(result.isNegative).toBe(true)
    expect(result.signals.some((s) => s.type === 'correction')).toBe(true)
  })

  it('detects correction from "I didn\'t ask for"', () => {
    const result = analyzeSentiment("I didn't ask for a refactor, just fix the bug")
    expect(result.isNegative).toBe(true)
    expect(result.signals.some((s) => s.type === 'correction')).toBe(true)
  })

  // ── Prohibition detection ──────────────────────────────────────

  it('detects prohibition from "never do X"', () => {
    const result = analyzeSentiment(
      'never claim to have verified something without actually doing it',
    )
    expect(result.isNegative).toBe(true)
    expect(result.signals.some((s) => s.type === 'prohibition')).toBe(true)
  })

  it('detects prohibition from "stop doing X"', () => {
    const result = analyzeSentiment('stop making up test results, you need to run them for real')
    expect(result.isNegative).toBe(true)
    expect(result.signals.some((s) => s.type === 'prohibition')).toBe(true)
  })

  // ── Behavior complaint detection ──────────────────────────────

  it('detects behavior complaint from "you should have"', () => {
    const result = analyzeSentiment('you should have run the e2e tests before claiming it works')
    expect(result.isNegative).toBe(true)
    expect(result.signals.some((s) => s.type === 'behavior-complaint')).toBe(true)
  })

  it('detects behavior complaint from accusation of lying', () => {
    const result = analyzeSentiment('why would you lie about checking the dashboard?')
    expect(result.isNegative).toBe(true)
    expect(result.signals.some((s) => s.type === 'behavior-complaint')).toBe(true)
  })

  // ── Quality complaint detection ────────────────────────────────

  it('detects quality complaint from "terrible output"', () => {
    const result = analyzeSentiment('the code quality is terrible, this output is garbage')
    expect(result.isNegative).toBe(true)
    expect(result.signals.some((s) => s.type === 'quality-complaint')).toBe(true)
  })

  // ── False positive resistance (critical!) ──────────────────────

  it('does NOT flag normal coding instructions containing "don\'t"', () => {
    const result = analyzeSentiment("don't use var, use const instead")
    expect(result.isNegative).toBe(false)
  })

  it('does NOT flag questions about errors', () => {
    const result = analyzeSentiment("what's wrong with this error? why is the test failing?")
    expect(result.isNegative).toBe(false)
  })

  it('does NOT flag descriptions of broken third-party code', () => {
    const result = analyzeSentiment('the upstream API is broken, returns 500 errors intermittently')
    expect(result.isNegative).toBe(false)
  })

  it('does NOT flag code inside code blocks', () => {
    const result = analyzeSentiment(
      'Here is the fix:\n```\n// don\'t use deprecated API\nthrow new Error("this is terrible")\n```',
    )
    expect(result.isNegative).toBe(false)
  })

  it('does NOT flag technical discussion about stopping processes', () => {
    const result = analyzeSentiment('how do I stop it from restarting automatically?')
    expect(result.isNegative).toBe(false)
  })

  it('does NOT flag positive sentiment or gratitude', () => {
    const result = analyzeSentiment('great work, that fixed the issue perfectly!')
    expect(result.isNegative).toBe(false)
  })

  it('does NOT flag neutral status updates', () => {
    const result = analyzeSentiment('the build passed, all 3500 tests green')
    expect(result.isNegative).toBe(false)
  })

  // ── Edge cases ─────────────────────────────────────────────────

  it('returns neutral for empty string', () => {
    const result = analyzeSentiment('')
    expect(result.isNegative).toBe(false)
    expect(result.overallScore).toBe(0)
    expect(result.signals).toHaveLength(0)
  })

  it('handles very long text without crashing', () => {
    const longText = 'this is terrible '.repeat(1000)
    const result = analyzeSentiment(longText)
    expect(typeof result.isNegative).toBe('boolean')
  })

  it('handles mixed signals — negative wins when strong', () => {
    const result = analyzeSentiment(
      "I appreciate the effort but you completely ignored my instructions. You didn't run the tests at all and just said you did.",
    )
    expect(result.isNegative).toBe(true)
    expect(result.overallScore).toBeGreaterThanOrEqual(0.7)
  })

  // ── Subject extraction ─────────────────────────────────────────

  it('extracts subject from the negative feedback', () => {
    const result = analyzeSentiment("you didn't actually run the e2e tests and check the dashboard")
    expect(result.isNegative).toBe(true)
    expect(result.subject).toBeTruthy()
    expect(result.subject.length).toBeGreaterThan(0)
    expect(result.subject.length).toBeLessThanOrEqual(200)
  })

  // ── Don't rule synthesis ───────────────────────────────────────

  it('synthesizes a dont rule from prohibition', () => {
    const result = analyzeSentiment(
      'never claim to have tested something without actually running the tests',
    )
    expect(result.isNegative).toBe(true)
    expect(result.dontRule).toBeTruthy()
    expect(result.dontRule.length).toBeGreaterThan(0)
  })

  it('synthesizes a dont rule from behavioral correction', () => {
    const result = analyzeSentiment(
      'stop lying about taking screenshots, you need to do the actual work',
    )
    expect(result.isNegative).toBe(true)
    expect(result.dontRule).toBeTruthy()
  })

  // ── Recommended target ─────────────────────────────────────────

  it('defaults recommendedTarget to general for unclassifiable targets', () => {
    const result = analyzeSentiment('this is terrible, you messed everything up')
    expect(result.isNegative).toBe(true)
    expect(result.recommendedTarget).toBe('general')
  })

  // ── Agent bootstrap / orchestration prompt suppression (issue #5 family) ────────
  // The `user-prompt` hook also fires on the session's opening *instructions* to the
  // agent. Those standing directives are dense with "ALWAYS…/never…/HARD-STOP" but are
  // NOT interactive user corrections — scraping them mints garbage "don't" rules. The
  // heuristic path must suppress them (the LLM tool path remains the primary detector).

  it('does NOT flag an agent bootstrap/handoff prompt despite "never claim success…"', () => {
    // Verbatim body the broker captured for the garbage neg-mem 0ee0b9cf (this-session bug).
    const bootstrap = [
      'Continue SCNS (memory-first phase). Standing model: autonomous self-improvement on',
      "John's REAL machine (non-sandboxed). ALWAYS quote a real test line / event row /",
      'number / hash — never claim success without live verification. Default sub-agent',
      'model = claude-opus-4.8 (pass explicitly).',
      '',
      'WHERE WE ARE (GO-LIVE LADDER): L0 M0 live · L1 M1.1+M1.2 LIVE+validated · L2 M1.3',
      'causal edges BUILT + COMMITTED LOCALLY (e6206b0, NOT pushed, default-OFF).',
    ].join('\n')
    const result = analyzeSentiment(bootstrap)
    expect(result.isNegative).toBe(false)
    expect(result.dontRule).toBe('')
  })

  it('does NOT flag the prior bootstrap that minted "Avoid: Continue SCNS…"', () => {
    const bootstrap =
      'Continue SCNS (memory-first phase). Standing model: autonomous self-improvement on ' +
      "John's REAL machine. ALWAYS quote a real test line / event row / number / hash — " +
      'never claim success without live verification. Default sub-agent model = claude-opus-4.8.'
    const result = analyzeSentiment(bootstrap)
    expect(result.isNegative).toBe(false)
  })

  it('does NOT flag an agent system/role prompt ("[[PLAN]] You are the SCNS … agent")', () => {
    const agentPrompt =
      '[[PLAN]] You are the SCNS Phase-1 DEV agent (sibling) on branch selfopt-phase1-wedge. ' +
      'An outer orchestrator drives you and will INDEPENDENTLY re-verify every claim. Quote real ' +
      'command-output rows as evidence — never say "tests pass" without the row.'
    const result = analyzeSentiment(agentPrompt)
    expect(result.isNegative).toBe(false)
  })

  it('STILL flags a genuine correction that mentions a single tooling token (vitest)', () => {
    // One weak marker alone must NOT suppress real feedback (precision guard).
    const result = analyzeSentiment(
      "you didn't actually run vitest before claiming the build passed",
    )
    expect(result.isNegative).toBe(true)
    expect(result.signals.some((s) => s.type === 'behavior-complaint')).toBe(true)
  })
})
