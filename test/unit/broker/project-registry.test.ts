import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../../src/broker/storage/db.js'
import { createTeam } from '../../../src/broker/storage/repositories/team-repository.js'
import { createSession } from '../../../src/broker/storage/repositories/session-repository.js'
import {
  registerProject,
  backfillProjectId,
  listProjects,
} from '../../../src/broker/project-registry.js'

describe('project-registry (P3)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => closeDatabase(db))

  describe('registerProject', () => {
    it('upserts a project row (idempotent) and bumps last_seen_at', () => {
      registerProject(db, 'proj-a', '/repo/a')
      registerProject(db, 'proj-a', '/repo/a')
      const rows = db.prepare('SELECT project_id, project_root FROM projects').all() as Array<{
        project_id: string
        project_root: string
      }>
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ project_id: 'proj-a', project_root: '/repo/a' })
    })
  })

  describe('backfillProjectId', () => {
    it('adopts legacy NULL rows whose working_dir is under the project root', () => {
      createTeam(db, { id: 't-null', name: 'legacy' }) // working_dir NULL
      createSession(db, { id: 's-in', purpose: 'x', working_dir: '/repo/a/sub', worktree: null })
      createSession(db, { id: 's-root', purpose: 'x', working_dir: '/repo/a', worktree: null })
      createSession(db, { id: 's-out', purpose: 'x', working_dir: '/other/b', worktree: null })

      const result = backfillProjectId(db, { projectId: 'proj-a', projectRoot: '/repo/a' })

      // sessions under /repo/a adopted; /other/b left NULL
      const inRow = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('s-in') as {
        project_id: string | null
      }
      const outRow = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('s-out') as {
        project_id: string | null
      }
      expect(inRow.project_id).toBe('proj-a')
      expect(db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('s-root')).toMatchObject(
        { project_id: 'proj-a' },
      )
      expect(outRow.project_id).toBeNull()
      expect(result.sessions).toBe(2)
    })

    it('does NOT overwrite rows already stamped with another project', () => {
      createSession(db, {
        id: 's-other',
        purpose: 'x',
        working_dir: '/repo/a/sub',
        worktree: null,
        project_id: 'proj-b',
      })
      backfillProjectId(db, { projectId: 'proj-a', projectRoot: '/repo/a' })
      const row = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('s-other') as {
        project_id: string
      }
      expect(row.project_id).toBe('proj-b')
    })

    it('avoids false-prefix matches (/repo/ab is not under /repo/a)', () => {
      createSession(db, { id: 's-ab', purpose: 'x', working_dir: '/repo/ab/x', worktree: null })
      const result = backfillProjectId(db, { projectId: 'proj-a', projectRoot: '/repo/a' })
      const row = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('s-ab') as {
        project_id: string | null
      }
      expect(row.project_id).toBeNull()
      expect(result.sessions).toBe(0)
    })
  })

  describe('listProjects (supervisor view)', () => {
    it('aggregates team/session counts per project including legacy NULL', () => {
      registerProject(db, 'proj-a', '/repo/a')
      createTeam(db, { id: 'a1', name: 'a1', project_id: 'proj-a' })
      createTeam(db, { id: 'a2', name: 'a2', project_id: 'proj-a' })
      createTeam(db, { id: 'leg', name: 'leg' }) // NULL
      createSession(db, { id: 'sa', purpose: 'x', working_dir: '/a', worktree: null, project_id: 'proj-a' })

      const projects = listProjects(db)
      const a = projects.find((p) => p.projectId === 'proj-a')
      const legacy = projects.find((p) => p.projectId === null)
      expect(a).toMatchObject({ projectId: 'proj-a', teams: 2, sessions: 1, projectRoot: '/repo/a' })
      expect(legacy).toMatchObject({ projectId: null, teams: 1 })
    })
  })
})
