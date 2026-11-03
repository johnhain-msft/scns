'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge, Text, Flex, Heading, Table } from '@radix-ui/themes'
import { listSessions } from '@/lib/api'
import { useSSE } from '@/hooks/use-sse'
import { formatRelativeTime, truncateId } from '@/lib/format'

const STATUS_FILTERS = ['all', 'active', 'working', 'idle', 'zombie'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

function getStatusColor(
  status: string,
): 'green' | 'blue' | 'yellow' | 'red' | 'gray' {
  switch (status) {
    case 'active':
      return 'green'
    case 'working':
      return 'blue'
    case 'idle':
      return 'yellow'
    case 'zombie':
      return 'red'
    default:
      return 'gray'
  }
}

function getHeartbeatHealth(lastHeartbeat: string): {
  label: string
  color: 'green' | 'yellow' | 'red'
} {
  const ageSeconds = (Date.now() - new Date(lastHeartbeat).getTime()) / 1000
  if (ageSeconds < 30) return { label: 'Healthy', color: 'green' }
  if (ageSeconds <= 60) return { label: 'Warning', color: 'yellow' }
  return { label: 'Stale', color: 'red' }
}

export default function SessionsPage() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const { data, isLoading } = useQuery({
    queryKey: ['sessions'],
    queryFn: listSessions,
  })

  useSSE((event) => {
    if (
      ['session_registered', 'session_deregistered', 'heartbeat_received'].includes(
        event.type,
      )
    ) {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    }
  })

  const sessions = data ?? []
  const visibleSessions =
    statusFilter === 'all'
      ? sessions
      : sessions.filter((s) => s.status === statusFilter)

  return (
    <>
      <Flex align="baseline" gap="3" mb="4">
        <Heading as="h1" size="6">
          Sessions
        </Heading>
        {data && (
          <Badge variant="soft" size="2">
            {sessions.length}
          </Badge>
        )}
      </Flex>

      <div
        role="group"
        aria-label="Filter sessions by status"
        style={{ display: 'flex', gap: '0.375rem', marginBottom: '1rem', flexWrap: 'wrap' }}
      >
        {STATUS_FILTERS.map((filter) => {
          const count =
            filter === 'all'
              ? sessions.length
              : sessions.filter((s) => s.status === filter).length
          const active = statusFilter === filter
          return (
            <button
              key={filter}
              type="button"
              onClick={() => setStatusFilter(filter)}
              aria-pressed={active}
              style={{
                padding: '0.375rem 0.75rem',
                borderRadius: '9999px',
                border: '1px solid var(--gray-a5)',
                backgroundColor: active
                  ? 'var(--accent-solid, #0072c3)'
                  : 'transparent',
                color: active ? 'white' : 'inherit',
                cursor: 'pointer',
                fontSize: '0.8rem',
                fontWeight: active ? 600 : 500,
                textTransform: 'capitalize',
              }}
            >
              {filter} {data && <span style={{ opacity: 0.7 }}>({count})</span>}
            </button>
          )
        })}
      </div>

      <div aria-live="polite">
        {isLoading && <Text>Loading…</Text>}

        {!isLoading && sessions.length === 0 && (
          <Text color="gray">No sessions found.</Text>
        )}

        {!isLoading && sessions.length > 0 && visibleSessions.length === 0 && (
          <Text color="gray">
            No sessions match the selected status filter.
          </Text>
        )}

        {!isLoading && visibleSessions.length > 0 && (
          <Table.Root>
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Purpose</th>
                <th scope="col">Status</th>
                <th scope="col">Working Dir</th>
                <th scope="col">Last Heartbeat</th>
              </tr>
            </thead>
            <Table.Body>
              {visibleSessions.map((session) => {
                const purpose = (session.intent ?? session['purpose'] ?? '—') as string
                const workingDir = (session['working_dir'] ?? '—') as string
                const lastHeartbeat = session['last_heartbeat'] as string | undefined

                return (
                  <Table.Row key={session.id}>
                    <Table.Cell>
                      <Text size="2" style={{ fontFamily: 'monospace' }}>
                        {truncateId(session.id)}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>{purpose}</Table.Cell>
                    <Table.Cell>
                      <Badge color={getStatusColor(session.status)}>
                        {session.status}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="2" style={{ fontFamily: 'monospace' }}>
                        {workingDir}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      {lastHeartbeat ? (
                        <Flex align="center" gap="2">
                          <Text size="2">
                            {formatRelativeTime(lastHeartbeat)}
                          </Text>
                          <Badge
                            color={getHeartbeatHealth(lastHeartbeat).color}
                          >
                            {getHeartbeatHealth(lastHeartbeat).label}
                          </Badge>
                        </Flex>
                      ) : (
                        <Text size="2">—</Text>
                      )}
                    </Table.Cell>
                  </Table.Row>
                )
              })}
            </Table.Body>
          </Table.Root>
        )}
      </div>
    </>
  )
}
