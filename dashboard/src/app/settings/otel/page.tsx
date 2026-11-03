'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getOtelConfig, updateOtelConfig } from '@/lib/api'
import type { OtelIngestionConfig } from '@/lib/api'

export default function OtelSettingsPage() {
  const queryClient = useQueryClient()

  const configQuery = useQuery({
    queryKey: ['otel-config'],
    queryFn: () => getOtelConfig(),
  })

  const [filePath, setFilePath] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [retentionDays, setRetentionDays] = useState(7)
  const [contentCapture, setContentCapture] = useState(false)
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (configQuery.data) {
      const d = configQuery.data as OtelIngestionConfig & { contentCapture?: boolean }
      setFilePath(d.filePath ?? '')
      setEnabled(d.enabled ?? false)
      setRetentionDays(d.retentionDays ?? 7)
      setContentCapture(d.contentCapture ?? false)
    }
  }, [configQuery.data])

  const mutation = useMutation({
    mutationFn: (updates: Record<string, unknown>) => updateOtelConfig(updates),
    onSuccess: () => {
      setSaveMessage({ type: 'success', text: 'Settings saved successfully.' })
      queryClient.invalidateQueries({ queryKey: ['otel-config'] })
    },
    onError: () => {
      setSaveMessage({ type: 'error', text: 'Failed to save settings. Please try again.' })
    },
  })

  const handleSave = () => {
    setSaveMessage(null)
    mutation.mutate({
      filePath,
      enabled,
      retentionDays,
      contentCapture,
    })
  }

  return (
    <div style={{ maxWidth: '640px' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '1.5rem' }}>
        OpenTelemetry Settings
      </h1>

      {/* Status Card */}
      {configQuery.data && (
        <div
          style={{
            padding: '1rem',
            borderRadius: '0.5rem',
            border: '1px solid var(--gray-a5)',
            backgroundColor: 'var(--gray-a2)',
            marginBottom: '1.5rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span
              style={{
                display: 'inline-block',
                width: '0.5rem',
                height: '0.5rem',
                borderRadius: '50%',
                backgroundColor: enabled ? 'var(--green-9)' : 'var(--gray-9)',
              }}
              aria-hidden="true"
            />
            <span style={{ fontWeight: 600 }}>
              Ingestion {enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
        </div>
      )}

      {configQuery.isLoading && <p>Loading configuration…</p>}

      {configQuery.data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Enabled Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <label htmlFor="otel-enabled" style={{ fontSize: '0.875rem', fontWeight: 500 }}>
              Ingestion Enabled
            </label>
            <button
              id="otel-enabled"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled(!enabled)}
              style={{
                width: '2.5rem',
                height: '1.25rem',
                borderRadius: '0.625rem',
                border: 'none',
                backgroundColor: enabled ? 'var(--accent-9)' : 'var(--gray-6)',
                position: 'relative',
                cursor: 'pointer',
                transition: 'background-color 0.2s',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: '0.125rem',
                  left: enabled ? '1.375rem' : '0.125rem',
                  width: '1rem',
                  height: '1rem',
                  borderRadius: '50%',
                  backgroundColor: 'white',
                  transition: 'left 0.2s',
                }}
              />
            </button>
          </div>

          {/* File Path */}
          <div>
            <label
              htmlFor="otel-file-path"
              style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.375rem' }}
            >
              JSONL File Path
            </label>
            <input
              id="otel-file-path"
              type="text"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder="/var/log/otel/traces.jsonl"
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                borderRadius: '0.375rem',
                border: '1px solid var(--gray-a5)',
                backgroundColor: 'var(--gray-a2)',
                color: 'inherit',
                fontSize: '0.875rem',
              }}
            />
          </div>

          {/* Retention Days */}
          <div>
            <label
              htmlFor="otel-retention"
              style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.375rem' }}
            >
              Retention Days
            </label>
            <input
              id="otel-retention"
              type="number"
              min={1}
              max={365}
              value={retentionDays}
              onChange={(e) => setRetentionDays(Number(e.target.value))}
              style={{
                width: '120px',
                padding: '0.5rem 0.75rem',
                borderRadius: '0.375rem',
                border: '1px solid var(--gray-a5)',
                backgroundColor: 'var(--gray-a2)',
                color: 'inherit',
                fontSize: '0.875rem',
              }}
            />
          </div>

          {/* Content Capture Toggle */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <label htmlFor="otel-content-capture" style={{ fontSize: '0.875rem', fontWeight: 500 }}>
                Content Capture
              </label>
              <button
                id="otel-content-capture"
                role="switch"
                aria-checked={contentCapture}
                onClick={() => setContentCapture(!contentCapture)}
                style={{
                  width: '2.5rem',
                  height: '1.25rem',
                  borderRadius: '0.625rem',
                  border: 'none',
                  backgroundColor: contentCapture ? 'var(--accent-9)' : 'var(--gray-6)',
                  position: 'relative',
                  cursor: 'pointer',
                  transition: 'background-color 0.2s',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: '0.125rem',
                    left: contentCapture ? '1.375rem' : '0.125rem',
                    width: '1rem',
                    height: '1rem',
                    borderRadius: '50%',
                    backgroundColor: 'white',
                    transition: 'left 0.2s',
                  }}
                />
              </button>
            </div>
            {contentCapture && (
              <div
                role="alert"
                style={{
                  marginTop: '0.5rem',
                  padding: '0.75rem',
                  borderRadius: '0.375rem',
                  backgroundColor: 'var(--orange-a3)',
                  color: 'var(--orange-11)',
                  fontSize: '0.875rem',
                  border: '1px solid var(--orange-a5)',
                }}
              >
                ⚠️ Privacy Warning: Content capture records full request/response bodies.
                This may include sensitive data. Use with caution.
              </div>
            )}
          </div>

          {/* Info Callout */}
          <div
            style={{
              padding: '0.75rem',
              borderRadius: '0.375rem',
              backgroundColor: 'var(--blue-a3)',
              color: 'var(--blue-11)',
              fontSize: '0.875rem',
              border: '1px solid var(--blue-a5)',
            }}
          >
            ℹ️ Changes require restart to take effect.
          </div>

          {/* Save Button */}
          <div>
            <button
              onClick={handleSave}
              disabled={mutation.isPending}
              style={{
                padding: '0.5rem 1.5rem',
                borderRadius: '0.375rem',
                border: 'none',
                backgroundColor: 'var(--accent-solid, #0072c3)',
                color: 'white',
                cursor: mutation.isPending ? 'not-allowed' : 'pointer',
                fontSize: '0.875rem',
                fontWeight: 600,
                opacity: mutation.isPending ? 0.7 : 1,
              }}
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>

          {/* Status Message */}
          {saveMessage && (
            <div
              role="status"
              style={{
                padding: '0.75rem',
                borderRadius: '0.375rem',
                backgroundColor:
                  saveMessage.type === 'success' ? 'var(--green-a3)' : 'var(--red-a3)',
                color:
                  saveMessage.type === 'success' ? 'var(--green-11)' : 'var(--red-11)',
                fontSize: '0.875rem',
                border: `1px solid ${
                  saveMessage.type === 'success' ? 'var(--green-a5)' : 'var(--red-a5)'
                }`,
              }}
            >
              {saveMessage.text}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
