import { describe, it, expect } from 'vitest'
import {
  SessionSchema,
  MessageSchema,
  FileIntentSchema,
  SharedStateEntrySchema,
  EventSchema,
  TeamSchema,
  TeamMemberSchema,
  TaskSchema,
  BackgroundTaskSchema,
  SessionStatus,
  IntentType,
  TeamStatus,
  TeamRole,
  MemberStatus,
  TaskStatus,
} from '../../../src/broker/types.js'

describe('Broker Zod types', () => {
  describe('SessionSchema', () => {
    it('parses valid session', () => {
      const result = SessionSchema.parse({
        id: 's1',
        purpose: 'test',
        working_dir: '/tmp',
      })
      expect(result.id).toBe('s1')
      expect(result.status).toBe('active')
      expect(result.worktree).toBeNull()
    })

    it('rejects missing id', () => {
      expect(() => SessionSchema.parse({ purpose: 'x', working_dir: '/' })).toThrow()
    })

    it('accepts all valid statuses', () => {
      for (const status of SessionStatus) {
        const result = SessionSchema.parse({
          id: 's1',
          purpose: 'test',
          working_dir: '/',
          status,
        })
        expect(result.status).toBe(status)
      }
    })

    it('rejects invalid status', () => {
      expect(() =>
        SessionSchema.parse({ id: 's1', purpose: 'x', working_dir: '/', status: 'invalid' }),
      ).toThrow()
    })
  })

  describe('MessageSchema', () => {
    it('parses valid message', () => {
      const result = MessageSchema.parse({
        id: 'm1',
        sender_id: 's1',
        content: 'hello',
      })
      expect(result.receiver_id).toBeNull()
      expect(result.story_id).toBeNull()
    })

    it('rejects missing content', () => {
      expect(() => MessageSchema.parse({ id: 'm1', sender_id: 's1' })).toThrow()
    })
  })

  describe('FileIntentSchema', () => {
    it('defaults intent to edit', () => {
      const result = FileIntentSchema.parse({
        file_path: '/foo.ts',
        session_id: 's1',
      })
      expect(result.intent).toBe('edit')
    })

    it('accepts all intent types', () => {
      for (const intent of IntentType) {
        const result = FileIntentSchema.parse({
          file_path: '/f',
          session_id: 's',
          intent,
        })
        expect(result.intent).toBe(intent)
      }
    })
  })

  describe('SharedStateEntrySchema', () => {
    it('parses valid entry', () => {
      const result = SharedStateEntrySchema.parse({
        key: 'k1',
        value: '{"x":1}',
      })
      expect(result.story_id).toBeNull()
      expect(result.session_id).toBeNull()
    })
  })

  describe('EventSchema', () => {
    it('parses valid event', () => {
      const result = EventSchema.parse({
        id: 1,
        event_type: 'session.registered',
        payload: '{}',
      })
      expect(result.session_id).toBeNull()
    })
  })

  describe('TeamSchema', () => {
    it('defaults status to active', () => {
      const result = TeamSchema.parse({ id: 't1', name: 'Team A' })
      expect(result.status).toBe('active')
      expect(result.parent_team_id).toBeNull()
    })

    it('accepts all team statuses', () => {
      for (const status of TeamStatus) {
        const result = TeamSchema.parse({ id: 't1', name: 'T', status })
        expect(result.status).toBe(status)
      }
    })
  })

  describe('TeamMemberSchema', () => {
    it('defaults role to general', () => {
      const result = TeamMemberSchema.parse({
        team_id: 't1',
        session_id: 's1',
        name: 'Agent',
      })
      expect(result.role).toBe('general')
      expect(result.status).toBe('idle')
    })

    it('accepts all roles', () => {
      for (const role of TeamRole) {
        const result = TeamMemberSchema.parse({
          team_id: 't',
          session_id: 's',
          name: 'a',
          role,
        })
        expect(result.role).toBe(role)
      }
    })

    it('accepts all member statuses', () => {
      for (const status of MemberStatus) {
        const result = TeamMemberSchema.parse({
          team_id: 't',
          session_id: 's',
          name: 'a',
          status,
        })
        expect(result.status).toBe(status)
      }
    })
  })

  describe('TaskSchema', () => {
    it('defaults status to pending', () => {
      const result = TaskSchema.parse({
        id: 1,
        team_id: 't1',
        seq: 1,
        subject: 'do thing',
      })
      expect(result.status).toBe('pending')
      expect(result.owner).toBeNull()
    })

    it('accepts all task statuses', () => {
      for (const status of TaskStatus) {
        const result = TaskSchema.parse({
          id: 1,
          team_id: 't',
          seq: 1,
          subject: 's',
          status,
        })
        expect(result.status).toBe(status)
      }
    })
  })

  describe('BackgroundTaskSchema', () => {
    it('transforms enabled from number to boolean', () => {
      const result = BackgroundTaskSchema.parse({
        task_name: 'heartbeat',
        enabled: 1,
      })
      expect(result.enabled).toBe(true)
      expect(result.run_count).toBe(0)
      expect(result.interval_ms).toBe(300000)
    })

    it('transforms enabled=0 to false', () => {
      const result = BackgroundTaskSchema.parse({
        task_name: 'x',
        enabled: 0,
      })
      expect(result.enabled).toBe(false)
    })

    it('accepts boolean enabled', () => {
      const result = BackgroundTaskSchema.parse({
        task_name: 'x',
        enabled: true,
      })
      expect(result.enabled).toBe(true)
    })
  })

  describe('constant arrays', () => {
    it('SessionStatus has correct values', () => {
      expect(SessionStatus).toContain('registered')
      expect(SessionStatus).toContain('zombie')
      expect(SessionStatus).toContain('expired')
      expect(SessionStatus).toHaveLength(9)
    })

    it('IntentType has correct values', () => {
      expect(IntentType).toContain('edit')
      expect(IntentType).toContain('delete')
      expect(IntentType).toHaveLength(4)
    })
  })
})
