'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { archiveTeam, listTeams, type Team } from '@/lib/api'

export default function TeamsPage() {
  const [showArchived, setShowArchived] = useState(false)
  const queryClient = useQueryClient()

  const { data: teams, isLoading } = useQuery({
    queryKey: ['teams', { includeArchived: showArchived }],
    queryFn: () => listTeams({ includeArchived: showArchived }),
  })

  const archiveMutation = useMutation({
    mutationFn: (id: string) => archiveTeam(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['teams'] })
    },
  })

  const handleArchive = (team: Team) => {
    const ok = typeof window === 'undefined' ? true : window.confirm(`Archive team "${team.name}"?`)
    if (!ok) return
    archiveMutation.mutate(team.id)
  }

  return (
    <div>
      <h1>Teams</h1>

      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', margin: '0.5rem 0' }}>
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
          aria-label="Show archived teams"
        />
        Show archived
      </label>

      {isLoading && <p>Loading teams…</p>}

      {!isLoading && (!teams || teams.length === 0) && <p>No teams found</p>}

      {teams && teams.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Status</th>
              <th scope="col">Members</th>
              <th scope="col">Tasks</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((team: Team) => {
              const members = team['members'] as unknown[] | undefined
              const tasks = team['tasks'] as unknown[] | undefined
              const isArchived = Boolean((team as unknown as { archived_at?: string | null }).archived_at)
              const displayStatus = isArchived ? 'archived' : (team.status ?? 'active')
              return (
                <tr key={team.id}>
                  <td>{team.name}</td>
                  <td>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.375rem',
                        padding: '0.125rem 0.5rem',
                        borderRadius: '9999px',
                        fontSize: '0.75rem',
                        fontWeight: 500,
                        backgroundColor:
                          displayStatus === 'active'
                            ? 'var(--green-a3, rgba(0,180,0,0.15))'
                            : 'var(--gray-a3, rgba(128,128,128,0.15))',
                        color:
                          displayStatus === 'active'
                            ? 'var(--green-11, #4ade80)'
                            : 'var(--gray-11, #a1a1aa)',
                      }}
                    >
                      {displayStatus}
                    </span>
                  </td>
                  <td>{Array.isArray(members) ? members.length : 0}</td>
                  <td>{Array.isArray(tasks) ? tasks.length : 0}</td>
                  <td>
                    {!isArchived && (
                      <button
                        type="button"
                        aria-label={`Archive team ${team.name}`}
                        onClick={() => handleArchive(team)}
                        disabled={archiveMutation.isPending}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: '1rem',
                          padding: '0.25rem 0.5rem',
                        }}
                      >
                        🗑
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
