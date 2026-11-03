import { describe, it, expect } from 'vitest'
import { parseManagerReadback } from '../../../../src/broker/services/manager-dispatch-readback.js'

describe('parseManagerReadback', () => {
  it('extracts devSessionId, qaSessionId, and notes from a structured block', () => {
    const body = [
      'Manager dispatch summary follows.',
      '',
      'Dispatch Readback:',
      '  dev_session_id: dev-sess-abc123',
      '  qa_session_id: qa-sess-def456',
      '  notes: Dev tackling team-reaper CTE; QA review-only.',
      '',
      'End of broadcast.',
    ].join('\n')

    const result = parseManagerReadback(body)
    expect(result.devSessionId).toBe('dev-sess-abc123')
    expect(result.qaSessionId).toBe('qa-sess-def456')
    expect(result.notes).toBe('Dev tackling team-reaper CTE; QA review-only.')
  })

  it('tolerates whitespace and case variation in the block keys', () => {
    const body = [
      'Dispatch Readback:',
      'dev_session_id:   sess-1',
      'qa_session_id:sess-2',
      'notes: ok',
    ].join('\n')
    const result = parseManagerReadback(body)
    expect(result.devSessionId).toBe('sess-1')
    expect(result.qaSessionId).toBe('sess-2')
    expect(result.notes).toBe('ok')
  })

  it('records a 409 current_owner sentinel as the session id (does not throw)', () => {
    const body = [
      'Dispatch Readback:',
      '  dev_session_id: 409:owner-existing-123',
      '  qa_session_id: qa-sess-xyz',
      '  notes: dev spawn returned 409, yielded to existing owner.',
    ].join('\n')
    const result = parseManagerReadback(body)
    expect(result.devSessionId).toBe('409:owner-existing-123')
    expect(result.qaSessionId).toBe('qa-sess-xyz')
  })

  it('throws when the Dispatch Readback block is missing', () => {
    const body = 'Just a chatty manager broadcast with no structured block.'
    expect(() => parseManagerReadback(body)).toThrow(/dispatch readback/i)
  })

  it('throws when dev_session_id is missing', () => {
    const body = [
      'Dispatch Readback:',
      '  qa_session_id: qa-sess-1',
      '  notes: dev spawn skipped',
    ].join('\n')
    expect(() => parseManagerReadback(body)).toThrow(/dev_session_id/i)
  })

  it('throws when qa_session_id is missing', () => {
    const body = [
      'Dispatch Readback:',
      '  dev_session_id: dev-sess-1',
      '  notes: qa never spawned',
    ].join('\n')
    expect(() => parseManagerReadback(body)).toThrow(/qa_session_id/i)
  })

  it('throws when dev_session_id value is empty', () => {
    const body = [
      'Dispatch Readback:',
      '  dev_session_id:   ',
      '  qa_session_id: qa-1',
    ].join('\n')
    expect(() => parseManagerReadback(body)).toThrow(/dev_session_id/i)
  })
})
