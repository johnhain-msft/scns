import { describe, it, expect } from 'vitest'
import {
  extractRuntimeClaims,
  verifyClaimEvidence,
} from '../../../../src/broker/services/claim-evidence-verifier.js'

describe('extractRuntimeClaims', () => {
  it('detects runtime-behavior signal words', () => {
    const text = [
      'The heartbeat poller runs live every 30s.',
      'The rotation watchdog is unwired.',
      'These scheduler rows are vestigial.',
      'Zombie cleanup is handled by the poller.',
    ].join('\n')
    const claims = extractRuntimeClaims(text)
    expect(claims.length).toBeGreaterThanOrEqual(4)
    const signals = claims.map((c) => c.signal)
    expect(signals.join(' ')).toMatch(/runs? live/i)
    expect(signals.join(' ')).toMatch(/unwired/i)
  })

  it('ignores prose with no runtime-behavior claims', () => {
    const text = 'This function sorts an array and returns the median value.'
    expect(extractRuntimeClaims(text)).toHaveLength(0)
  })

  it('detects the label attached to a claim (live-confirmed vs code-only)', () => {
    const text = [
      'heartbeat runs live (488 `zombie_cleaned` events) [live-confirmed]',
      'the watchdog never fires — no caller of createWatchdogDaemon [code-only]',
    ].join('\n')
    const claims = extractRuntimeClaims(text)
    const live = claims.find((c) => /runs? live/i.test(c.text))
    const code = claims.find((c) => /never fires/i.test(c.text))
    expect(live?.label).toBe('live-confirmed')
    expect(code?.label).toBe('code-only')
  })
})

describe('verifyClaimEvidence', () => {
  it('passes an analysis with no runtime claims (nothing to gate)', () => {
    const v = verifyClaimEvidence('We refactored the parser into three pure functions.')
    expect(v.kind).toBe('pass')
    expect(v.claims).toHaveLength(0)
  })

  it('FAILS a runtime claim asserted as fact with no evidence label (the guard-rca failure)', () => {
    // The exact shape of the 2026-07-09 overclaim: asserted from code-reading.
    const text =
      'The heartbeat-poller, zombie-cleanup and rotation-watchdog rows are ' +
      'vestigial — they are handled by separate pollers.'
    const v = verifyClaimEvidence(text)
    expect(v.kind).toBe('fail')
    expect(v.findings.join(' ')).toMatch(/unlabel|no.*evidence|assert/i)
  })

  it('passes when every runtime claim is live-confirmed with a quoted row', () => {
    const text =
      'heartbeat runs live via startHeartbeatPoller (488 `zombie_cleaned` ' +
      'events, all `cleanup_source: heartbeat_poller`) [live-confirmed]'
    const v = verifyClaimEvidence(text)
    expect(v.kind).toBe('pass')
  })

  it('passes when a runtime claim is honestly downgraded to code-only', () => {
    const text =
      'the rotation watchdog is unwired: no caller of `createWatchdogDaemon` ' +
      'found in source [code-only]'
    const v = verifyClaimEvidence(text)
    expect(v.kind).toBe('pass')
  })

  it('returns needs-evidence when a live-confirmed claim lacks a quoted row', () => {
    const text = 'heartbeat runs live, I checked and it works [live-confirmed]'
    const v = verifyClaimEvidence(text)
    expect(v.kind).toBe('needs-evidence')
    expect(v.findings.join(' ')).toMatch(/quote|evidence|row/i)
  })

  it('FAILS per-item: one unlabeled claim among several labeled ones', () => {
    const text = [
      'heartbeat runs live (488 `zombie_cleaned` events) [live-confirmed]',
      'the watchdog is unwired [code-only]',
      'and zombie cleanup is handled by the reaper.', // <-- unlabeled, asserted
    ].join('\n')
    const v = verifyClaimEvidence(text)
    expect(v.kind).toBe('fail')
    // The unlabeled claim must be the one flagged.
    expect(v.findings.join(' ')).toMatch(/handled by the reaper|zombie cleanup/i)
  })

  it('does not treat an exit code / HTTP 200 as evidence for a live claim', () => {
    const text = 'the endpoint runs live — it returned HTTP 200 [live-confirmed]'
    const v = verifyClaimEvidence(text)
    expect(v.kind).toBe('needs-evidence')
  })

  // ── Blind-test hardening (2026-07-11): paraphrases + doc-level disclaimer ──

  it('detects PARAPHRASED runtime/wiring claims a real agent used (not just §3a literals)', () => {
    const text = [
      'The rotation-watchdog is not wired to any handler.',
      'createWatchdogDaemon has no production caller.',
      'The broker does not execute newsletter-daily.',
      'Heartbeat cleanup runs through startHeartbeatPoller.',
      'That scheduler row is not active in production.',
    ].join('\n')
    const claims = extractRuntimeClaims(text)
    // All five paraphrases must be detected (previously missed → false negative).
    expect(claims.length).toBe(5)
  })

  it('FAILS paraphrased runtime claims asserted as bare fact (no disclaimer)', () => {
    const text =
      'The rotation-watchdog is not wired and createWatchdogDaemon has no caller; ' +
      'the newsletter job does not run.'
    const v = verifyClaimEvidence(text)
    expect(v.kind).toBe('fail')
  })

  it('PASSES honest code-only analysis: paraphrased claims under a document-level disclaimer', () => {
    // Shape of the real blind-test output: hedged as source-only, no per-item labels.
    const text = [
      'Evidence level: source-code investigation; broker was not run.',
      'The rotation-watchdog is not wired to any handler.',
      'createWatchdogDaemon has no production caller.',
      'Heartbeat cleanup runs through startHeartbeatPoller, not the scheduler.',
    ].join('\n')
    const v = verifyClaimEvidence(text)
    // Claims are detected, but the blanket "not run live" disclaimer makes them
    // honest code-only — the safe, non-overclaiming direction ⇒ pass.
    expect(v.claims.length).toBeGreaterThanOrEqual(3)
    expect(v.kind).toBe('pass')
  })

  it('a doc disclaimer does NOT rescue a live-confirmed claim that lacks a quoted row', () => {
    const text = [
      'Evidence level: source-code investigation; broker was not run.',
      'But heartbeat runs live in production [live-confirmed].',
    ].join('\n')
    const v = verifyClaimEvidence(text)
    expect(v.kind).toBe('needs-evidence')
  })

  it('PASSES a real disciplined agent report (live-test phrasings: code-traced / static investigation / not a live broker run)', () => {
    // Verbatim shape of the 2026-07-11 live tmux-agent output that false-positived
    // before this hardening — an exemplary code-only investigation.
    const text = [
      'All claims below are code-traced ([code-only]) — this was a read-only static investigation, not a live broker run.',
      'createWatchdogDaemon has no caller (unwired dead code).',
      'Heartbeat/zombie cleanup runs on its own 30s setInterval poller, separate from the scheduler.',
      'newsletter-daily and realestate-news-learner run via external launchd agents.',
      'Caveat: all conclusions are code-only/inferred (static read).',
    ].join('\n')
    const v = verifyClaimEvidence(text)
    expect(v.claims.length).toBeGreaterThanOrEqual(3)
    expect(v.kind).toBe('pass')
  })

  it('does not flag a benign "run on the scheduler tick" heading as a runtime claim', () => {
    const claims = extractRuntimeClaims('### Tasks that actually run on the scheduler tick')
    expect(claims).toHaveLength(0)
  })
})
