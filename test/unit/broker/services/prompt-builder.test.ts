import { describe, it, expect } from 'vitest'
import { buildAgentPrompt } from '../../../../src/broker/services/prompt-builder.js'
import type { PromptConfig } from '../../../../src/broker/services/prompt-builder.js'

describe('Prompt Builder', () => {
  const baseConfig: PromptConfig = {
    sessionId: 'sess-abc-123',
    teamId: 'team-xyz',
    name: 'coder-1',
    role: 'dev',
    brokerUrl: 'http://localhost:3456',
  }

  it('builds prompt with all required fields', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).toContain('coder-1')
    expect(prompt).toContain('dev')
    expect(prompt).toContain('team-xyz')
    expect(prompt).toContain('sess-abc-123')
  })

  it('includes broker URL', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).toContain('http://localhost:3456')
  })

  it('includes session ID in multiple places', () => {
    const prompt = buildAgentPrompt(baseConfig)
    const matches = prompt.match(/sess-abc-123/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThan(1)
  })

  it('includes team ID', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).toContain('team-xyz')
  })

  it('includes custom prompt when provided', () => {
    const prompt = buildAgentPrompt({
      ...baseConfig,
      customPrompt: 'Fix the login bug in auth.ts',
    })
    expect(prompt).toContain('Fix the login bug in auth.ts')
  })

  it('uses default task text when customPrompt not provided', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).toContain('scns_read_messages')
    expect(prompt).not.toContain('Fix the login bug')
  })

  it('includes working directory when provided', () => {
    const prompt = buildAgentPrompt({
      ...baseConfig,
      workingDir: '/home/user/project',
    })
    expect(prompt).toContain('Working Directory: /home/user/project')
  })

  it('omits working directory line when not provided', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).not.toContain('Working Directory')
  })

  // --- GAP-NEW-006: scns_* tool references ---

  it('references scns_send_message tool', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).toContain('scns_send_message')
  })

  it('references scns_declare_intent tool', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).toContain('scns_declare_intent')
  })

  it('references scns_release_intent tool', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).toContain('scns_release_intent')
  })

  it('references scns_read_messages tool', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).toContain('scns_read_messages')
  })

  it('references scns_report_progress tool', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).toContain('scns_report_progress')
  })

  it('references scns_heartbeat tool', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).toContain('scns_heartbeat')
  })

  it('references scns_set_state and scns_get_state tools', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).toContain('scns_set_state')
    expect(prompt).toContain('scns_get_state')
  })

  it('does NOT contain old function-call syntax', () => {
    const prompt = buildAgentPrompt(baseConfig)
    // Old-style: function_name(arg="value") patterns
    expect(prompt).not.toContain('join_team(team_id=')
    expect(prompt).not.toContain('send_message(sender_id=')
    expect(prompt).not.toContain('heartbeat(session_id=')
    expect(prompt).not.toContain('declare_intent(session_id=')
    expect(prompt).not.toContain('release_intent(session_id=')
    expect(prompt).not.toContain('update_task(task_id=')
    expect(prompt).not.toContain('deregister_session(id=')
    expect(prompt).not.toContain('list_tasks(team_id=')
  })

  it('mentions automatic team join and heartbeat', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).toMatch(/automatic/i)
  })

  it('instructs to check messages on startup', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).toMatch(/scns_read_messages/i)
  })

  it('lists available SCNS tools section', () => {
    const prompt = buildAgentPrompt(baseConfig)
    expect(prompt).toContain('AVAILABLE SCNS TOOLS')
  })

  // Phase 13.12.18 — skills advertisement.
  describe('availableSkills (Phase 13.12.18)', () => {
    it('omits the skills block when no skills are supplied', () => {
      const prompt = buildAgentPrompt(baseConfig)
      expect(prompt).not.toContain('## Available skills')
    })

    it('omits the skills block when the list is empty', () => {
      const prompt = buildAgentPrompt({ ...baseConfig, availableSkills: [] })
      expect(prompt).not.toContain('## Available skills')
    })

    it('emits a bullet per skill with name and description', () => {
      const prompt = buildAgentPrompt({
        ...baseConfig,
        availableSkills: [
          { name: 'browser-automation', description: 'Drive a real browser.' },
          { name: 'commit', description: 'Make structured git commits.' },
        ],
      })
      expect(prompt).toContain('## Available skills')
      expect(prompt).toContain('- **browser-automation** — Drive a real browser.')
      expect(prompt).toContain('- **commit** — Make structured git commits.')
    })

    it('does not leak values into the skills block accidentally', () => {
      const prompt = buildAgentPrompt({
        ...baseConfig,
        availableSecretKeys: ['instagram.password'],
        availableSkills: [{ name: 'browser-automation', description: 'Use it wisely.' }],
      })
      expect(prompt).toContain('## Available secrets')
      expect(prompt).toContain('## Available skills')
      // The skill block must come after the secrets block (order stable).
      expect(prompt.indexOf('## Available skills')).toBeGreaterThan(
        prompt.indexOf('## Available secrets'),
      )
    })
  })
})
