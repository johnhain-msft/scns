import { describe, it, expect } from 'vitest'
import {
  buildTeamMemberPrompt,
  buildImplementerPrompt,
  buildQaPrompt,
  buildResearcherPrompt,
} from '../../../src/cli/team-member-prompts.js'

const baseCtx = {
  teamId: 'team-sugg-abc12345',
  goal: 'Fix the dashboard',
  description: 'Exclude implemented items from in-flight.',
  projectRoot: '/repo',
} as const

describe('buildTeamMemberPrompt (Phase 13.12.23)', () => {
  it('routes scns-qa to the QA review-only prompt', () => {
    const out = buildTeamMemberPrompt({ ...baseCtx, role: 'scns-qa' })
    expect(out).toBe(buildQaPrompt({ ...baseCtx, role: 'scns-qa' }))
  })

  it('routes scns-dev (and other roles) to the implementer prompt', () => {
    const dev = buildTeamMemberPrompt({ ...baseCtx, role: 'scns-dev' })
    expect(dev).toBe(buildImplementerPrompt({ ...baseCtx, role: 'scns-dev' }))
    const other = buildTeamMemberPrompt({ ...baseCtx, role: 'custom-role' })
    expect(other).toBe(buildImplementerPrompt({ ...baseCtx, role: 'custom-role' }))
  })

  it('routes scns-researcher to the researcher (investigate-only) prompt', () => {
    const out = buildTeamMemberPrompt({ ...baseCtx, role: 'scns-researcher' })
    expect(out).toBe(buildResearcherPrompt({ ...baseCtx, role: 'scns-researcher' }))
    // Must NOT silently degrade to the implementer prompt.
    expect(out).not.toBe(buildImplementerPrompt({ ...baseCtx, role: 'scns-researcher' }))
  })
})

describe('RESEARCHER prompt content (Track 1 / 1C)', () => {
  const prompt = buildResearcherPrompt({ ...baseCtx, role: 'scns-researcher' })

  it('includes goal, description, and working dir', () => {
    expect(prompt).toContain('team-sugg-abc12345')
    expect(prompt).toContain('Fix the dashboard')
    expect(prompt).toContain('Exclude implemented items from in-flight.')
    expect(prompt).toContain('/repo')
  })

  it('identifies as investigate-only and forbids editing source', () => {
    expect(prompt).toMatch(/Your Role: RESEARCHER/)
    expect(prompt.toLowerCase()).toMatch(/investigat(e|ion)-only|investigate only/)
    expect(prompt).toMatch(/Do NOT edit source|not edit source|must not edit/i)
  })

  it('names its investigation modes: reproduction, prior-art, claim verification', () => {
    const lower = prompt.toLowerCase()
    expect(lower).toMatch(/reproduc/)
    expect(lower).toMatch(/prior[- ]art/)
    expect(lower).toMatch(/claim/)
  })

  it('enforces the claim-evidence discipline (live-confirmed vs code-only, quote the row)', () => {
    expect(prompt).toContain('live-confirmed')
    expect(prompt).toContain('code-only')
    // Must instruct quoting the actual row, not asserting from a code path.
    expect(prompt.toLowerCase()).toMatch(/quote.*(row|log|event|output)/)
    // run_count=0 != dead nuance carried through.
    expect(prompt.toLowerCase()).toMatch(/run_count|per item|per-item/)
  })

  it('reports structured findings to the team and does not stage/commit/push', () => {
    expect(prompt.toLowerCase()).toMatch(/send_message|message bus|report.*finding|findings.*team/)
    expect(prompt).toMatch(/Do NOT commit|do not commit|not commit/i)
    expect(prompt.toLowerCase()).toMatch(/do not.*(stage|git add)|not stage/)
  })
})

describe('IMPLEMENTER prompt content (Phase 13.12.23)', () => {
  const prompt = buildImplementerPrompt({ ...baseCtx, role: 'scns-dev' })

  it('includes suggestion metadata and working dir', () => {
    expect(prompt).toContain('team-sugg-abc12345')
    expect(prompt).toContain('Fix the dashboard')
    expect(prompt).toContain('Exclude implemented items from in-flight.')
    expect(prompt).toContain('/repo')
  })

  it('nudges staging incrementally with git add', () => {
    expect(prompt).toContain('git add -A')
    expect(prompt).toMatch(/small, frequent `git add`/)
    expect(prompt).toMatch(/partial\s+diff is better than no diff/)
  })

  it('forbids running the full npm test suite inside the prompt', () => {
    expect(prompt).toMatch(/Do NOT run `npm test`/)
    expect(prompt).toContain('npm run test:e2e')
    // QA-runs-them language present
    expect(prompt).toMatch(/QA teammate will run them/)
  })

  it('allows fast smoke checks', () => {
    expect(prompt).toContain('npm run typecheck')
    expect(prompt).toContain('vitest run')
  })

  it('forbids committing or pushing', () => {
    expect(prompt).toMatch(/Do NOT commit and do NOT push/)
  })

  it('includes a Reproduction Protocol instructing tests-fail-first (WS B)', () => {
    expect(prompt).toMatch(/Reproduction Protocol/)
    expect(prompt).toMatch(/fail.*before|before.*fix|demonstrate.*fail/i)
  })
})

describe('QA prompt content (Phase 13.12.23)', () => {
  const prompt = buildQaPrompt({ ...baseCtx, role: 'scns-qa' })

  it('identifies as review-only', () => {
    expect(prompt).toMatch(/Your Role: QA/)
    expect(prompt).toMatch(/review-only/)
  })

  it('instructs waiting for staged diff', () => {
    expect(prompt).toContain('git diff --cached')
  })

  it('instructs running build/lint/typecheck', () => {
    expect(prompt).toContain('npm run build')
    expect(prompt).toContain('npm run lint')
    expect(prompt).toContain('npm run typecheck')
  })

  it('forbids editing source, committing, or staging', () => {
    expect(prompt).toMatch(/Do NOT edit source code/)
    expect(prompt).toMatch(/Do NOT run `git add`/)
    expect(prompt).toMatch(/Do NOT commit/)
  })

  it('requires emitting PASS or FAIL', () => {
    expect(prompt).toMatch(/PASS or FAIL/)
    expect(prompt).toContain('QA-NOTES.md')
  })

  it('includes a Reproduction Protocol calling evaluateReproductionEvidence (WS B)', () => {
    expect(prompt).toMatch(/Reproduction Protocol/)
    expect(prompt).toContain('git stash')
    expect(prompt).toContain('evaluateReproductionEvidence')
    expect(prompt).toMatch(/unstaged|pre-edit|baseline/i)
    expect(prompt).toMatch(/staged/)
  })
})
