'use client'

import { useEffect, useRef, useCallback, useState } from 'react'

const BROKER_URL = process.env.NEXT_PUBLIC_BROKER_URL || 'http://localhost:3456'
const AUTH_TOKEN = process.env.NEXT_PUBLIC_BROKER_TOKEN || ''

export interface SSEEvent {
  id: number
  type: string
  session_id: string | null
  payload: unknown
  team_id: string | null
  created_at: string
}

export function useSSE(onEvent: (event: SSEEvent) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false)
  const onEventRef = useRef(onEvent)
  const esRef = useRef<EventSource | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  onEventRef.current = onEvent

  const connect = useCallback(() => {
    const url = new URL(`${BROKER_URL}/api/events/stream`)
    if (AUTH_TOKEN) {
      url.searchParams.set('token', AUTH_TOKEN)
    }

    const es = new EventSource(url.toString())
    esRef.current = es

    es.onopen = () => {
      setConnected(true)
    }

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as SSEEvent
        onEventRef.current(data)
      } catch {
        // Ignore malformed events
      }
    }

    es.onerror = () => {
      setConnected(false)
      es.close()
      reconnectTimer.current = setTimeout(() => {
        connect()
      }, 5000)
    }
  }, [])

  useEffect(() => {
    connect()

    return () => {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
      }
      esRef.current?.close()
    }
  }, [connect])

  return { connected }
}
