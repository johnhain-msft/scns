'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getSchedulerTasks,
  updateSchedulerTask,
  triggerSchedulerTask,
  getSchedulerHistory,
} from '@/lib/api'
import type { ScheduledTask, TaskRunRecord } from '@/lib/api'
import { CronPreview } from '@/components/cron-preview'

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    success: { bg: 'var(--green-a3, #1a3a2a)', fg: 'var(--green-11, #4cc38a)' },
    completed: { bg: 'var(--green-a3, #1a3a2a)', fg: 'var(--green-11, #4cc38a)' },
    failure: { bg: 'var(--red-a3, #3a1a1a)', fg: 'var(--red-11, #f27474)' },
    failed: { bg: 'var(--red-a3, #3a1a1a)', fg: 'var(--red-11, #f27474)' },
    running: { bg: 'var(--blue-a3, #1a2a3a)', fg: 'var(--blue-11, #5eb0ef)' },
    skipped: { bg: 'var(--yellow-a3, #3a3a1a)', fg: 'var(--yellow-11, #f5d90a)' },
  }
  const style = colors[status] || { bg: 'var(--gray-a3, #2a2a2a)', fg: 'var(--gray-11, #aaa)' }

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.125rem 0.5rem',
        borderRadius: '9999px',
        fontSize: '0.75rem',
        fontWeight: 500,
        backgroundColor: style.bg,
        color: style.fg,
      }}
    >
      {status}
    </span>
  )
}

function CategoryBadge({ category }: { category: string }) {
  const isCron = category === 'cron'
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.125rem 0.5rem',
        borderRadius: '9999px',
        fontSize: '0.75rem',
        fontWeight: 500,
        backgroundColor: isCron ? 'var(--blue-a3, #1a2a3a)' : 'var(--purple-a3, #2a1a3a)',
        color: isCron ? 'var(--blue-11, #5eb0ef)' : 'var(--purple-11, #b38aef)',
      }}
    >
      {category}
    </span>
  )
}

function TaskHistory({ taskId }: { taskId: string }) {
  const { data: history, isLoading } = useQuery({
    queryKey: ['scheduler-history', taskId],
    queryFn: () => getSchedulerHistory(taskId, 10),
  })

  if (isLoading) return <tr><td colSpan={6} style={{ padding: '1rem', textAlign: 'center' }}>Loading history...</td></tr>

  if (!history || history.length === 0) {
    return <tr><td colSpan={6} style={{ padding: '1rem', textAlign: 'center', opacity: 0.6 }}>No history available</td></tr>
  }

  return (
    <tr>
      <td colSpan={6} style={{ padding: '0.75rem 1rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: 'left', padding: '0.25rem 0.5rem', fontSize: '0.75rem', opacity: 0.7 }}>Run ID</th>
              <th scope="col" style={{ textAlign: 'left', padding: '0.25rem 0.5rem', fontSize: '0.75rem', opacity: 0.7 }}>Status</th>
              <th scope="col" style={{ textAlign: 'left', padding: '0.25rem 0.5rem', fontSize: '0.75rem', opacity: 0.7 }}>Started At</th>
              <th scope="col" style={{ textAlign: 'left', padding: '0.25rem 0.5rem', fontSize: '0.75rem', opacity: 0.7 }}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {history.map((entry: TaskRunRecord) => (
              <tr key={entry.id}>
                <td style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}>{entry.id}</td>
                <td style={{ padding: '0.25rem 0.5rem' }}><StatusBadge status={entry.status} /></td>
                <td style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}>
                  {new Date(entry.started_at).toLocaleString()}
                </td>
                <td style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}>
                  {entry.duration_ms != null ? `${entry.duration_ms}ms` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </td>
    </tr>
  )
}

export default function SchedulerPage() {
  const queryClient = useQueryClient()
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set())

  const { data: tasks, isLoading } = useQuery({
    queryKey: ['scheduler-tasks'],
    queryFn: getSchedulerTasks,
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateSchedulerTask(id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduler-tasks'] })
    },
  })

  const triggerMutation = useMutation({
    mutationFn: (id: string) => triggerSchedulerTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduler-tasks'] })
    },
  })

  function handleToggleExpand(taskId: string) {
    setExpandedTasks((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) {
        next.delete(taskId)
      } else {
        next.add(taskId)
      }
      return next
    })
  }

  if (isLoading) {
    return (
      <div>
        <h1>Scheduler</h1>
        <p>Loading...</p>
      </div>
    )
  }

  return (
    <div>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '1.5rem' }}>Scheduler</h1>

      <div aria-live="polite" className="sr-only" />

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th scope="col" style={{ textAlign: 'left', padding: '0.75rem 1rem', borderBottom: '1px solid var(--gray-a5, #333)', fontSize: '0.8rem', fontWeight: 600 }}>Name</th>
            <th scope="col" style={{ textAlign: 'left', padding: '0.75rem 1rem', borderBottom: '1px solid var(--gray-a5, #333)', fontSize: '0.8rem', fontWeight: 600 }}>Category</th>
            <th scope="col" style={{ textAlign: 'left', padding: '0.75rem 1rem', borderBottom: '1px solid var(--gray-a5, #333)', fontSize: '0.8rem', fontWeight: 600 }}>Schedule</th>
            <th scope="col" style={{ textAlign: 'left', padding: '0.75rem 1rem', borderBottom: '1px solid var(--gray-a5, #333)', fontSize: '0.8rem', fontWeight: 600 }}>Status</th>
            <th scope="col" style={{ textAlign: 'left', padding: '0.75rem 1rem', borderBottom: '1px solid var(--gray-a5, #333)', fontSize: '0.8rem', fontWeight: 600 }}>Last Run</th>
            <th scope="col" style={{ textAlign: 'left', padding: '0.75rem 1rem', borderBottom: '1px solid var(--gray-a5, #333)', fontSize: '0.8rem', fontWeight: 600 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {tasks?.map((task: ScheduledTask) => {
            const isExpanded = expandedTasks.has(task.id)
            const historyPanelId = `history-${task.id}`

            return (
              <TaskRow
                key={task.id}
                task={task}
                isExpanded={isExpanded}
                historyPanelId={historyPanelId}
                onToggleEnabled={() =>
                  toggleMutation.mutate({ id: task.id, enabled: !task.enabled })
                }
                onTrigger={() => triggerMutation.mutate(task.id)}
                onToggleExpand={() => handleToggleExpand(task.id)}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TaskRow({
  task,
  isExpanded,
  historyPanelId,
  onToggleEnabled,
  onTrigger,
  onToggleExpand,
}: {
  task: ScheduledTask
  isExpanded: boolean
  historyPanelId: string
  onToggleEnabled: () => void
  onTrigger: () => void
  onToggleExpand: () => void
}) {
  const rowStyle = {
    opacity: task.enabled ? 1 : 0.5,
  }

  return (
    <>
      <tr data-disabled={!task.enabled ? 'true' : undefined} style={rowStyle}>
        <td style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--gray-a3, #222)' }}>
          {task.name}
        </td>
        <td style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--gray-a3, #222)' }}>
          <CategoryBadge category={task.category} />
        </td>
        <td style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--gray-a3, #222)' }}>
          <CronPreview expression={task.cron_expression || '—'} />
        </td>
        <td style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--gray-a3, #222)' }}>
          <button
            role="switch"
            aria-checked={task.enabled}
            aria-label={`Toggle ${task.name}`}
            onClick={onToggleEnabled}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              width: '36px',
              height: '20px',
              borderRadius: '10px',
              border: 'none',
              cursor: 'pointer',
              padding: '2px',
              backgroundColor: task.enabled
                ? 'var(--green-9, #30a46c)'
                : 'var(--gray-6, #555)',
              transition: 'background-color 0.2s',
            }}
          >
            <span
              style={{
                display: 'block',
                width: '16px',
                height: '16px',
                borderRadius: '50%',
                backgroundColor: 'white',
                transform: task.enabled ? 'translateX(16px)' : 'translateX(0)',
                transition: 'transform 0.2s',
              }}
            />
          </button>
        </td>
        <td style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--gray-a3, #222)' }}>
          {task.last_run_at ? (
            <span style={{ fontSize: '0.8rem' }}>
              {new Date(task.last_run_at).toLocaleString()}
              {task.last_status && (
                <>
                  {' '}
                  <StatusBadge status={task.last_status} />
                </>
              )}
            </span>
          ) : (
            <span style={{ fontSize: '0.8rem', opacity: 0.5 }}>Never</span>
          )}
        </td>
        <td style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--gray-a3, #222)' }}>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={onTrigger}
              aria-label={`Run Now ${task.name}`}
              style={{
                padding: '0.25rem 0.75rem',
                borderRadius: '0.375rem',
                border: '1px solid var(--gray-a5, #444)',
                backgroundColor: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: '0.8rem',
              }}
            >
              Run Now
            </button>
            <button
              onClick={onToggleExpand}
              aria-expanded={isExpanded}
              aria-controls={historyPanelId}
              aria-label={`Show history for ${task.name}`}
              style={{
                padding: '0.25rem 0.75rem',
                borderRadius: '0.375rem',
                border: '1px solid var(--gray-a5, #444)',
                backgroundColor: isExpanded ? 'var(--gray-a3, #222)' : 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: '0.8rem',
              }}
            >
              {isExpanded ? 'Hide History' : 'Show History'}
            </button>
          </div>
        </td>
      </tr>
      {isExpanded && <TaskHistory taskId={task.id} />}
    </>
  )
}
