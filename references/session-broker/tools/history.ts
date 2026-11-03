import type Database from 'better-sqlite3'
import {
  queryTeamHistory,
  querySessionHistory,
  queryTaskHistory,
  queryMessageHistory,
  countHistoryRecords,
} from '../storage/repositories/history-repository.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface QueryHistoryInput {
  readonly type: 'teams' | 'sessions' | 'tasks' | 'messages'
  readonly limit?: number
  readonly since?: string
  readonly name?: string
  readonly team_id?: string
  readonly session_id?: string
}

export function handleQueryHistory(
  db: Database.Database,
  input: QueryHistoryInput,
): ToolResult {
  switch (input.type) {
    case 'teams': {
      const records = queryTeamHistory(db, {
        limit: input.limit,
        since: input.since,
        name: input.name,
      })
      // Parse JSON summaries for readable output
      const enriched = records.map((r) => ({
        ...r,
        member_summary: r.member_summary ? JSON.parse(r.member_summary) : null,
        task_summary: r.task_summary ? JSON.parse(r.task_summary) : null,
      }))
      return textResult({ type: 'teams', count: enriched.length, records: enriched })
    }
    case 'sessions': {
      const records = querySessionHistory(db, {
        limit: input.limit,
        since: input.since,
      })
      return textResult({ type: 'sessions', count: records.length, records })
    }
    case 'tasks': {
      const records = queryTaskHistory(db, input.team_id, input.limit)
      return textResult({ type: 'tasks', count: records.length, records })
    }
    case 'messages': {
      const records = queryMessageHistory(db, input.session_id, input.limit)
      return textResult({ type: 'messages', count: records.length, records })
    }
    default:
      return errorResult(`Unknown history type: ${input.type}. Valid types: teams, sessions, tasks, messages`)
  }
}

export function handleHistoryStats(
  db: Database.Database,
): ToolResult {
  const counts = countHistoryRecords(db)
  return textResult(counts)
}
