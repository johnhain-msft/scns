import { describe, it, expect } from 'vitest'
import {
  buildTaskSpawnPrompt,
  isTaskSpawnRoleSupported,
  SUPPORTED_TASK_SPAWN_ROLES,
} from '../../../../src/broker/services/task-spawn-prompt.js'

const TEAM = {
  id: 'team-abc',
  name: 'team-dogfood',
}

const TASK = {
  id: 12,
  subject: 'Fix team-reaper premature archive',
  description:
    'team-reaper archives teams whose member status dips out of working|idle.',
}

describe('buildTaskSpawnPrompt', () => {
  it('builds a manager prompt that frames decomposition + dispatch', () => {
    const prompt = buildTaskSpawnPrompt({
      role: 'scns-manager',
      team: TEAM,
      task: TASK,
      projectRoot: '/repo',
    })
    expect(prompt).toContain('scns-manager')
    expect(prompt).toContain('team-abc')
    expect(prompt.toLowerCase()).toContain('decompose')
    // Manager dispatches via team messaging, does not edit code itself
    expect(prompt.toLowerCase()).toMatch(/dispatch|delegate|messaging|sub.?task/)
    expect(prompt).toContain('Fix team-reaper premature archive')
    expect(prompt).toContain('team-reaper archives teams')
    // Task id surfaced so manager can update its status
    expect(prompt).toContain('12')
  })

  it('manager prompt includes the spawn-recipe URL for dev and qa', () => {
    const prompt = buildTaskSpawnPrompt({
      role: 'scns-manager',
      team: TEAM,
      task: TASK,
      projectRoot: '/repo',
    })
    // Concrete spawn machinery: POST endpoint and roles must be discoverable
    // verbatim so the manager can curl them.
    expect(prompt).toContain('/api/tasks/')
    expect(prompt).toContain('/spawn')
    expect(prompt).toMatch(/role.*scns-dev/)
    expect(prompt).toMatch(/role.*scns-qa/)
    // It must NOT instruct the manager to use scns_create_task to make new
    // task records — the existing task is what gets dispatched.
    expect(prompt.toLowerCase()).not.toContain('scns_create_task')
  })

  it('manager prompt forbids self-completion of the task', () => {
    const prompt = buildTaskSpawnPrompt({
      role: 'scns-manager',
      team: TEAM,
      task: TASK,
      projectRoot: '/repo',
    })
    expect(prompt.toLowerCase()).toMatch(/(must not|do not|never).*(mark|set|update|flip).*(complet)/)
    // QA is the only role allowed to complete; failure path is 'failed'.
    expect(prompt.toLowerCase()).toContain('failed')
  })

  it('manager prompt requires a final status message before exit', () => {
    const prompt = buildTaskSpawnPrompt({
      role: 'scns-manager',
      team: TEAM,
      task: TASK,
      projectRoot: '/repo',
    })
    expect(prompt.toLowerCase()).toMatch(/final.*(status|summary).*message/)
    // Must reference the team message bus / send_message tool.
    expect(prompt.toLowerCase()).toMatch(/send_message|message bus|team.*messag/)
  })

  it('manager prompt enumerates three explicit exit preconditions (dev spawn, qa spawn, final broadcast)', () => {
    const prompt = buildTaskSpawnPrompt({
      role: 'scns-manager',
      team: TEAM,
      task: TASK,
      projectRoot: '/repo',
    })
    // A discoverable, headed block enumerating preconditions.
    expect(prompt).toMatch(/Exit Preconditions/i)
    const lower = prompt.toLowerCase()
    // (a) spawned scns-dev capturing session_id
    expect(lower).toMatch(/spawn(ed)?\s+scns-dev[\s\S]*session_id/)
    // (b) spawned scns-qa capturing session_id
    expect(lower).toMatch(/spawn(ed)?\s+scns-qa[\s\S]*session_id/)
    // (c) sent final POST /api/messages broadcast naming both session ids
    expect(lower).toMatch(/post\s+\/api\/messages|\/api\/messages.*broadcast/)
    expect(lower).toMatch(/both[\s\S]{0,40}session id/)
    // The structured "Dispatch Readback:" block must be specified verbatim
    // in the prompt so the parser (manager-dispatch-readback.ts) can extract
    // dev/qa session ids from the broadcast body.
    expect(prompt).toContain('Dispatch Readback:')
    expect(prompt).toMatch(/dev_session_id\s*:/)
    expect(prompt).toMatch(/qa_session_id\s*:/)
  })

  it('manager prompt instructs that on 409 the existing owner is recorded in the final broadcast (no silent exit)', () => {
    const prompt = buildTaskSpawnPrompt({
      role: 'scns-manager',
      team: TEAM,
      task: TASK,
      projectRoot: '/repo',
    })
    const lower = prompt.toLowerCase()
    // 409 → record current_owner in the dispatch readback / final broadcast
    expect(lower).toMatch(/409[\s\S]{0,200}(current_owner|existing owner)/)
    expect(lower).toMatch(/(record|include|name)[\s\S]{0,80}(current_owner|existing owner)[\s\S]{0,200}(broadcast|readback|final.*message)/)
    // Forbid silent exit on 409
    expect(lower).toMatch(/(do\s*not|never|must\s*not)[\s\S]{0,60}(exit\s+silently|silent\s+exit|exit\s+without)/)
  })

  it('builds a dev/implementer prompt with TDD framing', () => {
    const prompt = buildTaskSpawnPrompt({
      role: 'scns-dev',
      team: TEAM,
      task: TASK,
      projectRoot: '/repo',
    })
    expect(prompt).toContain('scns-dev')
    expect(prompt.toLowerCase()).toMatch(/tdd|implement|stage/)
    expect(prompt).toContain('Fix team-reaper premature archive')
  })

  it('builds a qa prompt that is review-only', () => {
    const prompt = buildTaskSpawnPrompt({
      role: 'scns-qa',
      team: TEAM,
      task: TASK,
      projectRoot: '/repo',
    })
    expect(prompt).toContain('scns-qa')
    expect(prompt.toLowerCase()).toMatch(/review|qa/)
    expect(prompt.toLowerCase()).toMatch(/do not edit|review-only|not edit source/)
    expect(prompt).toContain('Fix team-reaper premature archive')
  })

  it('scns-researcher is a supported task-spawn role', () => {
    expect(isTaskSpawnRoleSupported('scns-researcher')).toBe(true)
    expect(SUPPORTED_TASK_SPAWN_ROLES).toContain('scns-researcher')
  })

  it('builds a researcher prompt that is investigate-only and evidence-first', () => {
    const prompt = buildTaskSpawnPrompt({
      role: 'scns-researcher',
      team: TEAM,
      task: TASK,
      projectRoot: '/repo',
    })
    expect(prompt).toContain('scns-researcher')
    expect(prompt).toMatch(/Your Role: RESEARCHER/)
    expect(prompt.toLowerCase()).toMatch(/investigat/)
    // Evidence discipline (ties 1C to the 1A claim-evidence rule).
    expect(prompt).toContain('live-confirmed')
    expect(prompt).toContain('code-only')
    // Task framing preserved.
    expect(prompt).toContain('Fix team-reaper premature archive')
  })

  it('manager prompt offers a discretionary researcher dispatch for investigation tasks', () => {
    const prompt = buildTaskSpawnPrompt({
      role: 'scns-manager',
      team: TEAM,
      task: TASK,
      projectRoot: '/repo',
    })
    const lower = prompt.toLowerCase()
    // Manager may dispatch a scns-researcher when the task needs investigation
    // (reproduction / prior-art / claim verification) — discretionary, not mandatory.
    expect(lower).toMatch(/scns-researcher/)
    expect(lower).toMatch(/reproduc|prior[- ]art|verify.*claim|claim.*verif|investigat/)
  })

  it('truncates oversized descriptions with a marker', () => {
    const huge = 'X'.repeat(20000)
    const prompt = buildTaskSpawnPrompt({
      role: 'scns-dev',
      team: TEAM,
      task: { id: 1, subject: 'big', description: huge },
      projectRoot: '/repo',
    })
    expect(prompt.length).toBeLessThan(20000)
    expect(prompt).toContain('truncated')
  })

  it('echoes extra_context verbatim when provided', () => {
    const prompt = buildTaskSpawnPrompt({
      role: 'scns-dev',
      team: TEAM,
      task: TASK,
      projectRoot: '/repo',
      extraContext: 'NB: prefer minimal edits to scheduler-repository.',
    })
    expect(prompt).toContain('NB: prefer minimal edits to scheduler-repository.')
  })

  it('handles missing description gracefully', () => {
    const prompt = buildTaskSpawnPrompt({
      role: 'scns-dev',
      team: TEAM,
      task: { id: 5, subject: 'noop', description: null },
      projectRoot: '/repo',
    })
    expect(prompt).toContain('noop')
  })

  it('throws on unsupported role', () => {
    expect(() =>
      buildTaskSpawnPrompt({
        role: 'evil-overlord',
        team: TEAM,
        task: TASK,
        projectRoot: '/repo',
      }),
    ).toThrow(/role/i)
  })
})
