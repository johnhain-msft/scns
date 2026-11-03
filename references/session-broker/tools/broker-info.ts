import type Database from 'better-sqlite3'
import { textResult, type ToolResult } from './helpers.js'
import { countSessionsByStatus } from '../storage/repositories/session-repository.js'
import { countTeamsByStatus } from '../storage/repositories/team-repository.js'
import { countTasksByStatus } from '../storage/repositories/task-repository.js'

const BROKER_VERSION = '0.1.0'
export const startedAt = Date.now()

export function handleBrokerInfo(db: Database.Database): ToolResult {
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000)

  return textResult({
    version: BROKER_VERSION,
    uptime_seconds: uptimeSeconds,
    started_at: new Date(startedAt).toISOString(),
    active_sessions: countSessionsByStatus(db, 'active'),
    active_teams: countTeamsByStatus(db, 'active'),
    active_tasks: {
      pending: countTasksByStatus(db, 'pending'),
      in_progress: countTasksByStatus(db, 'in_progress'),
      completed: countTasksByStatus(db, 'completed'),
    },
  })
}
