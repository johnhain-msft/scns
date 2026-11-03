'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listTeams, listTasks, type TeamTask } from '@/lib/api'

interface DisplayTask extends TeamTask {
  teamName: string
  teamId: string
}

export default function TasksPage() {
  const [teamFilter, setTeamFilter] = useState<string>('all')

  const teamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: () => listTeams(),
  })

  const tasksQuery = useQuery({
    queryKey: ['all-tasks', teamsQuery.data?.map((t) => t.id)],
    queryFn: async () => {
      const teams = teamsQuery.data!
      const results = await Promise.all(
        teams.map((team) =>
          listTasks(team.id).then((tasks) => ({ team, tasks })),
        ),
      )
      return results
    },
    enabled: !!teamsQuery.data,
  })

  const isLoading = teamsQuery.isPending || (teamsQuery.isSuccess && tasksQuery.isPending)

  const allTasks: DisplayTask[] =
    tasksQuery.data?.flatMap(({ team, tasks }) =>
      tasks
        .filter((t) => t.status !== 'deleted' && t.status !== 'failed')
        .map((task) => ({ ...task, teamName: team.name, teamId: team.id })),
    ) ?? []

  const visibleTasks =
    teamFilter === 'all'
      ? allTasks
      : allTasks.filter((t) => t.teamId === teamFilter)

  const pending = visibleTasks.filter((t) => t.status === 'pending')
  const inProgress = visibleTasks.filter((t) => t.status === 'in_progress')
  const completed = visibleTasks.filter((t) => t.status === 'completed')

  const teams = teamsQuery.data ?? []

  return (
    <div>
      <h1>Tasks</h1>

      {teams.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            margin: '0.75rem 0 1rem',
            flexWrap: 'wrap',
          }}
        >
          <label
            htmlFor="task-team-filter"
            style={{ fontSize: '0.85rem', opacity: 0.8 }}
          >
            Filter by team
          </label>
          <select
            id="task-team-filter"
            aria-label="Filter tasks by team"
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            style={{
              padding: '0.375rem 0.5rem',
              borderRadius: '0.375rem',
              border: '1px solid var(--gray-a5)',
              backgroundColor: 'var(--gray-a2)',
              color: 'inherit',
              fontSize: '0.85rem',
            }}
          >
            <option value="all">All teams ({allTasks.length})</option>
            {teams.map((team) => {
              const count = allTasks.filter((t) => t.teamId === team.id).length
              return (
                <option key={team.id} value={team.id}>
                  {team.name} ({count})
                </option>
              )
            })}
          </select>
        </div>
      )}

      {isLoading && <p>Loading tasks…</p>}

      {!isLoading && allTasks.length === 0 && <p>No tasks found</p>}

      {!isLoading && allTasks.length > 0 && visibleTasks.length === 0 && (
        <p>No tasks match the selected team filter.</p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1.5rem', marginTop: '1rem' }}>
        <div>
          <h2>Pending</h2>
          {pending.map((task) => (
            <article
              key={task.id}
              style={{
                padding: '0.75rem',
                marginBottom: '0.5rem',
                borderRadius: '0.5rem',
                backgroundColor: 'var(--gray-a3, rgba(128,128,128,0.1))',
                border: '1px solid var(--gray-a5, rgba(128,128,128,0.2))',
              }}
            >
              <p style={{ fontWeight: 600, margin: 0 }}>{task.subject}</p>
              <p style={{ fontSize: '0.8rem', margin: '0.25rem 0 0', opacity: 0.7 }}>
                Owner: {task.owner ?? 'Unassigned'} · Team: {task.teamName}
              </p>
            </article>
          ))}
        </div>

        <div>
          <h2>In Progress</h2>
          {inProgress.map((task) => (
            <article
              key={task.id}
              style={{
                padding: '0.75rem',
                marginBottom: '0.5rem',
                borderRadius: '0.5rem',
                backgroundColor: 'var(--blue-a3, rgba(0,100,255,0.1))',
                border: '1px solid var(--blue-a5, rgba(0,100,255,0.2))',
              }}
            >
              <p style={{ fontWeight: 600, margin: 0 }}>{task.subject}</p>
              <p style={{ fontSize: '0.8rem', margin: '0.25rem 0 0', opacity: 0.7 }}>
                Owner: {task.owner ?? 'Unassigned'} · Team: {task.teamName}
              </p>
            </article>
          ))}
        </div>

        <div>
          <h2>Completed</h2>
          {completed.map((task) => (
            <article
              key={task.id}
              style={{
                padding: '0.75rem',
                marginBottom: '0.5rem',
                borderRadius: '0.5rem',
                backgroundColor: 'var(--green-a3, rgba(0,180,0,0.1))',
                border: '1px solid var(--green-a5, rgba(0,180,0,0.2))',
              }}
            >
              <p style={{ fontWeight: 600, margin: 0 }}>{task.subject}</p>
              <p style={{ fontSize: '0.8rem', margin: '0.25rem 0 0', opacity: 0.7 }}>
                Owner: {task.owner ?? 'Unassigned'} · Team: {task.teamName}
              </p>
            </article>
          ))}
        </div>
      </div>
    </div>
  )
}
