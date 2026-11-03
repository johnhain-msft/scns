'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Badge, Text, Flex, Grid, Heading, Button } from '@radix-ui/themes'
import {
  getHealth,
  getBrainStatus,
  listSessions,
  listTeams,
  getSchedulerTasks,
  getDreamStatus,
  getAutonomy,
  getCostSummary,
  promoteAutonomy,
  demoteAutonomy,
} from '@/lib/api'
import { StatCard } from '@/components/stat-card'
import { formatUptime, formatRelativeTime, formatUsd } from '@/lib/format'

const AUTONOMY_LABELS: Record<number, string> = {
  0: 'Observer',
  1: 'Advisor',
  2: 'Assistant',
  3: 'Autonomous',
}

export default function OverviewPage() {
  const queryClient = useQueryClient()

  const health = useQuery({ queryKey: ['health'], queryFn: getHealth })
  const brain = useQuery({
    queryKey: ['brain-status'],
    queryFn: getBrainStatus,
    refetchInterval: 10_000,
  })
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: listSessions })
  const teams = useQuery({ queryKey: ['teams'], queryFn: listTeams })
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: getSchedulerTasks })
  const dream = useQuery({ queryKey: ['dream'], queryFn: getDreamStatus })
  const autonomy = useQuery({ queryKey: ['autonomy'], queryFn: getAutonomy })
  const cost = useQuery({ queryKey: ['cost'], queryFn: getCostSummary })

  const promote = useMutation({
    mutationFn: promoteAutonomy,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['autonomy'] }),
  })
  const demote = useMutation({
    mutationFn: demoteAutonomy,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['autonomy'] }),
  })

  const hasError =
    health.isError ||
    sessions.isError ||
    teams.isError ||
    tasks.isError ||
    dream.isError ||
    autonomy.isError ||
    cost.isError

  const healthData = health.data as
    | { status: string; uptime_seconds: number; version?: string }
    | undefined

  const sessionCounts = (sessions.data ?? []).reduce<Record<string, number>>(
    (acc, s) => {
      acc[s.status] = (acc[s.status] || 0) + 1
      return acc
    },
    {},
  )
  const totalSessions = sessions.data?.length ?? 0

  const allTasks = tasks.data ?? []
  const activeTasks = allTasks.filter((t) => t.enabled).length
  const pendingTasks = allTasks.filter((t) => !t.enabled).length

  const autonomyLevel = autonomy.data?.level ?? 0
  const autonomyLabel = AUTONOMY_LABELS[autonomyLevel] ?? 'Unknown'
  const canPromote = autonomyLevel < 3
  const canDemote = autonomyLevel > 0

  const dreamData = dream.data as Record<string, unknown> | undefined

  return (
    <>
      <Heading as="h1" size="6" mb="4">
        Overview
      </Heading>

      {hasError && (
        <div role="alert" aria-live="assertive">
          <Text color="red">
            Failed to load dashboard data. Please try again.
          </Text>
        </div>
      )}

      <Grid columns={{ initial: '1', sm: '2', md: '3' }} gap="4">
        <StatCard title="System Health">
          {health.isLoading ? (
            <Text>Loading…</Text>
          ) : health.isError ? (
            <Text color="red">Error loading health</Text>
          ) : (
            <Flex direction="column" gap="2">
              <Flex align="center" gap="2">
                <Text weight="medium">Status</Text>
                <Badge
                  color={healthData?.status === 'ok' ? 'green' : 'yellow'}
                >
                  {healthData?.status === 'ok' ? 'Healthy' : 'Degraded'}
                </Badge>
              </Flex>
              <Flex gap="2">
                <Text weight="medium">Uptime</Text>
                <Text>{formatUptime(healthData?.uptime_seconds ?? 0)}</Text>
              </Flex>
              <Flex gap="2">
                <Text weight="medium">Version</Text>
                <Text>{healthData?.version ?? '—'}</Text>
              </Flex>
            </Flex>
          )}
        </StatCard>

        <StatCard title="Brain">
          {brain.isLoading ? (
            <Text>Loading…</Text>
          ) : brain.isError || !brain.data ? (
            <Flex direction="column" gap="2">
              <Flex align="center" gap="2">
                <Text weight="medium">Status</Text>
                <Badge color="red" data-testid="brain-status-badge">
                  Unavailable
                </Badge>
              </Flex>
            </Flex>
          ) : (
            (() => {
              const b = brain.data
              const lastTickMs = b.lastTickAt ? Date.parse(b.lastTickAt) : NaN
              const ageMs = Number.isFinite(lastTickMs)
                ? Date.now() - lastTickMs
                : Infinity
              const FRESH_MS = 5 * 60 * 1000
              const isReady = b.state !== 'starting'
              let color: 'green' | 'yellow' | 'red'
              let label: string
              if (!isReady) {
                color = 'red'
                label = 'Starting'
              } else if (ageMs <= FRESH_MS) {
                color = 'green'
                label = 'Ready'
              } else {
                color = 'yellow'
                label = 'Stale'
              }
              return (
                <Flex direction="column" gap="2">
                  <Flex align="center" gap="2">
                    <Text weight="medium">Status</Text>
                    <Badge color={color} data-testid="brain-status-badge">
                      {label}
                    </Badge>
                    <Badge color="gray" variant="soft">
                      {b.state}
                    </Badge>
                  </Flex>
                  <Flex justify="between">
                    <Text>Last tick</Text>
                    <Text>
                      {b.lastTickAt
                        ? formatRelativeTime(b.lastTickAt)
                        : 'never'}
                    </Text>
                  </Flex>
                  <Flex justify="between">
                    <Text>Ticks today</Text>
                    <Text weight="bold">{b.ticksToday}</Text>
                  </Flex>
                  <Flex justify="between">
                    <Text>Pending suggestions</Text>
                    <Text weight="bold">{b.queueDepth}</Text>
                  </Flex>
                </Flex>
              )
            })()
          )}
        </StatCard>

        <StatCard title="Sessions">
          {sessions.isLoading ? (
            <Text>Loading…</Text>
          ) : (
            <Flex direction="column" gap="1">
              {Object.entries(sessionCounts).map(([status, count]) => (
                <Flex key={status} justify="between">
                  <Text style={{ textTransform: 'capitalize' }}>{status}</Text>
                  <Text weight="bold">{count}</Text>
                </Flex>
              ))}
              <Flex
                justify="between"
                mt="2"
                pt="2"
                style={{ borderTop: '1px solid var(--gray-a5)' }}
              >
                <Text weight="medium">Total</Text>
                <Text weight="bold">{totalSessions}</Text>
              </Flex>
            </Flex>
          )}
        </StatCard>

        <StatCard title="Teams & Tasks">
          {teams.isLoading || tasks.isLoading ? (
            <Text>Loading…</Text>
          ) : (
            <Flex direction="column" gap="1">
              <Flex justify="between">
                <Text>Teams</Text>
                <Text weight="bold">{teams.data?.length ?? 0}</Text>
              </Flex>
              <Flex justify="between">
                <Text>Active Tasks</Text>
                <Text weight="bold">{activeTasks}</Text>
              </Flex>
              <Flex justify="between">
                <Text>Pending Tasks</Text>
                <Text weight="bold">{pendingTasks}</Text>
              </Flex>
            </Flex>
          )}
        </StatCard>

        <StatCard title="Autonomy">
          {autonomy.isLoading ? (
            <Text>Loading…</Text>
          ) : (
            <Flex direction="column" gap="3">
              <Badge size="2" color="blue">
                L{autonomyLevel} {autonomyLabel}
              </Badge>
              <Flex gap="2">
                {canPromote && (
                  <Button
                    size="1"
                    variant="soft"
                    onClick={() => promote.mutate()}
                  >
                    Promote
                  </Button>
                )}
                {canDemote && (
                  <Button
                    size="1"
                    variant="soft"
                    color="red"
                    onClick={() => demote.mutate()}
                  >
                    Demote
                  </Button>
                )}
              </Flex>
            </Flex>
          )}
        </StatCard>

        <StatCard title="Dream">
          {dream.isLoading ? (
            <Text>Loading…</Text>
          ) : (
            <Flex direction="column" gap="1">
              <Flex justify="between">
                <Text>Status</Text>
                <Badge color={(dreamData?.gateCheck as Record<string, unknown>)?.allPassed ? 'green' : 'gray'}>
                  {(dreamData?.gateCheck as Record<string, unknown>)?.allPassed ? 'Ready' : 'Idle'}
                </Badge>
              </Flex>
              <Flex justify="between">
                <Text>Last Run</Text>
                <Text>
                  {typeof dreamData?.lastRunAt === 'string'
                    ? formatRelativeTime(dreamData.lastRunAt as string)
                    : '—'}
                </Text>
              </Flex>
              <Flex justify="between">
                <Text>Total Runs</Text>
                <Text weight="bold">
                  {(dreamData?.totalRuns as number) ?? 0}
                </Text>
              </Flex>
            </Flex>
          )}
        </StatCard>

        <StatCard title="Cost">
          {cost.isLoading ? (
            <Text>Loading…</Text>
          ) : (
            <Flex direction="column" gap="1">
              <Text size="5" weight="bold">
                {formatUsd(cost.data?.estimatedTotalCostUSD ?? 0)}
              </Text>
              <Flex justify="between">
                <Text>Tokens</Text>
                <Text weight="bold">
                  {(cost.data?.totalTokens ?? 0).toLocaleString()}
                </Text>
              </Flex>
              <Flex justify="between">
                <Text>Sessions</Text>
                <Text weight="bold">{cost.data?.sessionCount ?? 0}</Text>
              </Flex>
            </Flex>
          )}
        </StatCard>
      </Grid>
    </>
  )
}
