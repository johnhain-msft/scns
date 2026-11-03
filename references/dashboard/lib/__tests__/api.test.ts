import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listSessions,
  getHealth,
  getIndexStats,
  listMessages,
  listTeams,
  getTeamStatus,
  getTeamMembers,
  getMemberStats,
  listTasks,
  getTask,
  createTask,
  updateTask,
  getScalingPolicies,
  getUsageSummary,
  getTeamBudget,
  getBranchConflicts,
  getSessionCapabilities,
  getRespawnPolicies,
  getRespawnHistory,
  getTeamActivity,
  getBrokerInfo,
  purgeTeam,
  disbandTeam,
  getHeartbeatStatus,
  type Session,
  type HealthResponse,
  type IndexStatsResponse,
  type Message,
  type Team,
  type TeamStatus,
} from '../api'

const mockFetch = vi.fn()
global.fetch = mockFetch

beforeEach(() => {
  mockFetch.mockReset()
})

function okResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(data),
  }
}

function errorResponse(status: number, statusText: string) {
  return {
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({ error: statusText }),
  }
}

describe('listSessions', () => {
  it('fetches sessions from the correct URL', async () => {
    const sessions: Session[] = [
      {
        id: 'sess-1',
        purpose: 'testing',
        working_dir: '/tmp',
        worktree: null,
        status: 'active',
        last_heartbeat: new Date().toISOString(),
        created_at: new Date().toISOString(),
        team: null,
      },
    ]
    mockFetch.mockResolvedValueOnce(okResponse({ sessions }))

    const result = await listSessions()

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/list_sessions',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(sessions)
  })

  it('passes include_archived param when true', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ sessions: [] }))

    await listSessions(true)

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/list_sessions?include_archived=true',
      expect.objectContaining({ cache: 'no-store' })
    )
  })

  it('returns empty array when no sessions exist', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ sessions: [] }))

    const result = await listSessions()
    expect(result).toEqual([])
  })

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'))

    await expect(listSessions()).rejects.toThrow('500 Internal Server Error')
  })

  it('throws on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    await expect(listSessions()).rejects.toThrow('Network error')
  })
})

describe('getHealth', () => {
  it('fetches health from the correct URL', async () => {
    const health: HealthResponse = {
      status: 'ok',
      uptime_seconds: 120,
      sessions: { active: 2, zombie: 0, total: 2 },
      active_teams: 1,
      pending_tasks: 3,
      in_progress_tasks: 1,
    }
    mockFetch.mockResolvedValueOnce(okResponse(health))

    const result = await getHealth()

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/health',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(health)
  })

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(503, 'Service Unavailable'))

    await expect(getHealth()).rejects.toThrow('503 Service Unavailable')
  })
})

describe('getIndexStats', () => {
  it('fetches index stats from the correct URL', async () => {
    const stats: IndexStatsResponse = {
      indexed_sessions: 5,
      embedding_dimension: 384,
    }
    mockFetch.mockResolvedValueOnce(okResponse(stats))

    const result = await getIndexStats()

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/index_stats',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(stats)
  })

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'))

    await expect(getIndexStats()).rejects.toThrow('500 Internal Server Error')
  })
})

describe('listMessages', () => {
  it('fetches messages with default limit', async () => {
    const messages: Message[] = [
      {
        id: 'msg-1',
        sender_id: 'sess-1',
        receiver_id: 'sess-2',
        content: 'hello',
        story_id: null,
        read_at: null,
        created_at: new Date().toISOString(),
      },
    ]
    mockFetch.mockResolvedValueOnce(okResponse({ messages }))

    const result = await listMessages()

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/list_messages?limit=100',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(messages)
  })

  it('fetches messages with custom limit', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ messages: [] }))

    await listMessages(50)

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/list_messages?limit=50',
      expect.objectContaining({ cache: 'no-store' })
    )
  })

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'))

    await expect(listMessages()).rejects.toThrow('500 Internal Server Error')
  })
})

describe('listTeams', () => {
  it('fetches teams from the correct URL', async () => {
    const teams: Team[] = [
      {
        id: 'team-1',
        name: 'Alpha',
        description: 'Test team',
        status: 'active',
        created_at: new Date().toISOString(),
      },
    ]
    mockFetch.mockResolvedValueOnce(okResponse(teams))

    const result = await listTeams()

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(teams)
  })

  it('passes include_archived param when true', async () => {
    mockFetch.mockResolvedValueOnce(okResponse([]))

    await listTeams(true)

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams?include_archived=true',
      expect.objectContaining({ cache: 'no-store' })
    )
  })

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'))

    await expect(listTeams()).rejects.toThrow('500 Internal Server Error')
  })
})

describe('getTeamStatus', () => {
  it('fetches team status with correct team ID in URL', async () => {
    const status: TeamStatus = {
      name: 'Alpha',
      member_count: 3,
      task_counts: { pending: 2, in_progress: 1, completed: 5 },
      idle: false,
    }
    mockFetch.mockResolvedValueOnce(okResponse(status))

    const result = await getTeamStatus('team-abc')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/team-abc/status',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(status)
  })

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'))

    await expect(getTeamStatus('no-such-team')).rejects.toThrow('404 Not Found')
  })
})

describe('getTeamMembers', () => {
  it('fetches team members', async () => {
    const data = { team_id: 't-1', team_name: 'Alpha', members: [] }
    mockFetch.mockResolvedValueOnce(okResponse(data))

    const result = await getTeamMembers('t-1')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/t-1',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(data)
  })
})

describe('getMemberStats', () => {
  it('fetches member stats', async () => {
    const data = { team_id: 't-1', members: [] }
    mockFetch.mockResolvedValueOnce(okResponse(data))

    const result = await getMemberStats('t-1')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/t-1/members/stats',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(data)
  })
})

describe('listTasks', () => {
  it('fetches tasks for a team', async () => {
    const tasks = [{ id: 1, team_id: 't-1', subject: 'Do X', status: 'pending' }]
    mockFetch.mockResolvedValueOnce(okResponse(tasks))

    const result = await listTasks('t-1')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/t-1/tasks',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(tasks)
  })

  it('passes status filter', async () => {
    mockFetch.mockResolvedValueOnce(okResponse([]))

    await listTasks('t-1', 'pending')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/t-1/tasks?status=pending',
      expect.objectContaining({ cache: 'no-store' })
    )
  })
})

describe('getTask', () => {
  it('fetches a single task by ID', async () => {
    const task = { id: 42, team_id: 't-1', subject: 'Task', status: 'pending', blocks: [], blocked_by: [] }
    mockFetch.mockResolvedValueOnce(okResponse(task))

    const result = await getTask(42)

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/tasks/42',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(task)
  })
})

describe('createTask', () => {
  it('posts a new task', async () => {
    const task = { id: 1, team_id: 't-1', subject: 'New', status: 'pending' }
    mockFetch.mockResolvedValueOnce(okResponse(task))

    const result = await createTask('t-1', { subject: 'New' })

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/t-1/tasks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ subject: 'New' }),
      })
    )
    expect(result).toEqual(task)
  })
})

describe('updateTask', () => {
  it('patches a task', async () => {
    const task = { id: 1, status: 'completed' }
    mockFetch.mockResolvedValueOnce(okResponse(task))

    await updateTask(1, { status: 'completed' })

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/tasks/1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ status: 'completed' }),
      })
    )
  })
})

describe('getScalingPolicies', () => {
  it('fetches scaling policies for a team', async () => {
    const data = { team_id: 't-1', policies: [] }
    mockFetch.mockResolvedValueOnce(okResponse(data))

    const result = await getScalingPolicies('t-1')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/t-1/scaling-policy',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(data)
  })
})

describe('getUsageSummary', () => {
  it('fetches usage with no filters', async () => {
    const data = { total_tokens_in: 100, total_tokens_out: 50, total_cost_usd: 0.01, record_count: 1 }
    mockFetch.mockResolvedValueOnce(okResponse(data))

    const result = await getUsageSummary()

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/usage/summary',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(data)
  })

  it('passes team_id filter', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ total_tokens_in: 0, total_tokens_out: 0, total_cost_usd: 0, record_count: 0 }))

    await getUsageSummary({ team_id: 't-1' })

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/usage/summary?team_id=t-1',
      expect.objectContaining({ cache: 'no-store' })
    )
  })
})

describe('getTeamBudget', () => {
  it('fetches team budget', async () => {
    const data = { team_id: 't-1', total_tokens_in: 500, total_tokens_out: 200, total_cost_usd: 0.05, by_session: {} }
    mockFetch.mockResolvedValueOnce(okResponse(data))

    const result = await getTeamBudget('t-1')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/t-1/budget',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(data)
  })
})

describe('getBranchConflicts', () => {
  it('fetches branch conflicts with no filters', async () => {
    const data = { conflicts: [] }
    mockFetch.mockResolvedValueOnce(okResponse(data))

    const result = await getBranchConflicts()

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/branch-conflicts',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(data)
  })

  it('passes file_path filter', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ conflicts: [] }))

    await getBranchConflicts({ file_path: 'src/main.ts' })

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/branch-conflicts?file_path=src%2Fmain.ts',
      expect.objectContaining({ cache: 'no-store' })
    )
  })
})

describe('getSessionCapabilities', () => {
  it('fetches capabilities for a session', async () => {
    const data = ['typescript', 'testing']
    mockFetch.mockResolvedValueOnce(okResponse(data))

    const result = await getSessionCapabilities('sess-1')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/sessions/sess-1/capabilities',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(data)
  })
})

describe('getRespawnPolicies', () => {
  it('fetches respawn policies', async () => {
    const data = { team_id: 't-1', policies: [] }
    mockFetch.mockResolvedValueOnce(okResponse(data))

    const result = await getRespawnPolicies('t-1')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/t-1/respawn-policy',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(data)
  })
})

describe('getRespawnHistory', () => {
  it('fetches respawn history', async () => {
    const data = { team_id: 't-1', history: [] }
    mockFetch.mockResolvedValueOnce(okResponse(data))

    const result = await getRespawnHistory('t-1')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/t-1/respawn-history',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(data)
  })

  it('passes filters', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ team_id: 't-1', history: [] }))

    await getRespawnHistory('t-1', { limit: 10, status: 'failed' })

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/t-1/respawn-history?limit=10&status=failed',
      expect.objectContaining({ cache: 'no-store' })
    )
  })
})

describe('getTeamActivity', () => {
  it('fetches team activity feed', async () => {
    const data = { team_id: 't-1', events: [], total: 0 }
    mockFetch.mockResolvedValueOnce(okResponse(data))

    const result = await getTeamActivity('t-1')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/t-1/activity',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(data)
  })

  it('passes filters', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ team_id: 't-1', events: [], total: 0 }))

    await getTeamActivity('t-1', { limit: 20, event_types: ['task_updated', 'message_sent'] })

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/t-1/activity?limit=20&event_types=task_updated%2Cmessage_sent',
      expect.objectContaining({ cache: 'no-store' })
    )
  })
})

describe('getBrokerInfo', () => {
  it('fetches broker info', async () => {
    const data = {
      version: '0.1.0',
      uptime_seconds: 60,
      sessions: { active: 1, zombie: 0, total: 1 },
      teams: { active: 1, disbanded: 0 },
      tasks: { pending: 2, in_progress: 1, completed: 0 },
    }
    mockFetch.mockResolvedValueOnce(okResponse(data))

    const result = await getBrokerInfo()

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/broker/info',
      expect.objectContaining({ cache: 'no-store' })
    )
    expect(result).toEqual(data)
  })
})

describe('purgeTeam', () => {
  it('posts to purge endpoint', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ purged: true }))

    await purgeTeam('t-1')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/t-1/purge',
      expect.objectContaining({ method: 'POST' })
    )
  })
})

describe('disbandTeam', () => {
  it('sends DELETE to team endpoint', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ disbanded: true }))

    await disbandTeam('t-1')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/teams/t-1',
      expect.objectContaining({ method: 'DELETE' })
    )
  })
})

describe('getHeartbeatStatus', () => {
  it('returns "healthy" for heartbeat less than 30s ago', () => {
    const recent = new Date(Date.now() - 5_000).toISOString()
    expect(getHeartbeatStatus(recent)).toBe('healthy')
  })

  it('returns "warning" for heartbeat between 30s and 60s ago', () => {
    const medium = new Date(Date.now() - 45_000).toISOString()
    expect(getHeartbeatStatus(medium)).toBe('warning')
  })

  it('returns "stale" for heartbeat more than 60s ago', () => {
    const old = new Date(Date.now() - 120_000).toISOString()
    expect(getHeartbeatStatus(old)).toBe('stale')
  })
})
