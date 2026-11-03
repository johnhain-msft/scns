/**
 * Phase 13.6: Team-scoped message bus — monotonic ordering, cursor resume,
 * and addressability invariants enforced by the repository layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createSession } from '../../../../src/broker/storage/repositories/session-repository.js'
import { createTeam, addTeamMember } from '../../../../src/broker/storage/repositories/team-repository.js'
import {
  createMessage,
  findTeamMessagesSince,
  getMaxTeamSeq,
} from '../../../../src/broker/storage/repositories/message-repository.js'

describe('team message bus — monotonic seq + cursor resume', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDatabase(':memory:')
    createSession(db, { id: 'alice', purpose: 'p', working_dir: '/tmp', worktree: null })
    createSession(db, { id: 'bob', purpose: 'p', working_dir: '/tmp', worktree: null })
    createSession(db, { id: 'carol', purpose: 'p', working_dir: '/tmp', worktree: null })
    createTeam(db, { id: 'team-a', name: 'Team A' })
    createTeam(db, { id: 'team-b', name: 'Team B' })
    addTeamMember(db, { team_id: 'team-a', session_id: 'alice', name: 'Alice', role: 'lead' })
    addTeamMember(db, { team_id: 'team-a', session_id: 'bob', name: 'Bob', role: 'dev' })
    addTeamMember(db, { team_id: 'team-b', session_id: 'carol', name: 'Carol', role: 'lead' })
  })

  afterEach(() => closeDatabase(db))

  it('assigns a monotonic seq starting at 1 per team', () => {
    const m1 = createMessage(db, {
      id: 'm1',
      sender_id: 'alice',
      receiver_id: 'bob',
      content: 'hi',
      story_id: null,
      team_id: 'team-a',
    })
    const m2 = createMessage(db, {
      id: 'm2',
      sender_id: 'bob',
      receiver_id: 'alice',
      content: 'hey',
      story_id: null,
      team_id: 'team-a',
    })
    expect(m1.seq).toBe(1)
    expect(m2.seq).toBe(2)
  })

  it('seq is independent per team', () => {
    const a1 = createMessage(db, {
      id: 'a1',
      sender_id: 'alice',
      receiver_id: null,
      content: 'team a broadcast',
      story_id: null,
      team_id: 'team-a',
    })
    const b1 = createMessage(db, {
      id: 'b1',
      sender_id: 'carol',
      receiver_id: null,
      content: 'team b broadcast',
      story_id: null,
      team_id: 'team-b',
    })
    expect(a1.seq).toBe(1)
    expect(b1.seq).toBe(1)
  })

  it('findTeamMessagesSince returns strictly-ascending seq > cursor', () => {
    for (let i = 0; i < 20; i++) {
      createMessage(db, {
        id: `msg-${i}`,
        sender_id: i % 2 === 0 ? 'alice' : 'bob',
        receiver_id: null,
        content: `m${i}`,
        story_id: null,
        team_id: 'team-a',
      })
    }

    const page1 = findTeamMessagesSince(db, 'team-a', 0, { limit: 5 })
    expect(page1.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])

    const page2 = findTeamMessagesSince(db, 'team-a', 5, { limit: 5 })
    expect(page2.map((m) => m.seq)).toEqual([6, 7, 8, 9, 10])

    const tail = findTeamMessagesSince(db, 'team-a', 18)
    expect(tail.map((m) => m.seq)).toEqual([19, 20])
  })

  it('stores role and cross-team addressing metadata', () => {
    const m = createMessage(db, {
      id: 'x1',
      sender_id: 'alice',
      receiver_id: null,
      content: 'hey team B lead',
      story_id: null,
      team_id: 'team-b',
      to_role: 'lead',
      to_team: 'team-b',
    })
    expect(m.team_id).toBe('team-b')
    expect(m.to_role).toBe('lead')
    expect(m.to_team).toBe('team-b')
    expect(m.seq).toBe(1)
  })

  it('getMaxTeamSeq reports the current head', () => {
    expect(getMaxTeamSeq(db, 'team-a')).toBe(0)
    createMessage(db, {
      id: 'h1',
      sender_id: 'alice',
      receiver_id: null,
      content: 'first',
      story_id: null,
      team_id: 'team-a',
    })
    createMessage(db, {
      id: 'h2',
      sender_id: 'bob',
      receiver_id: null,
      content: 'second',
      story_id: null,
      team_id: 'team-a',
    })
    expect(getMaxTeamSeq(db, 'team-a')).toBe(2)
  })

  it('no gaps under rapid bursts from multiple senders', () => {
    const ids: string[] = []
    for (let i = 0; i < 100; i++) {
      const m = createMessage(db, {
        id: `burst-${i}`,
        sender_id: i % 3 === 0 ? 'alice' : 'bob',
        receiver_id: null,
        content: `b${i}`,
        story_id: null,
        team_id: 'team-a',
      })
      ids.push(String(m.seq))
    }
    const all = findTeamMessagesSince(db, 'team-a', 0, { limit: 1000 })
    expect(all).toHaveLength(100)
    for (let i = 0; i < 100; i++) {
      expect(all[i]!.seq).toBe(i + 1)
    }
  })
})
