"use client";

import { useEffect, useRef, useCallback } from "react";

const BROKER_URL = process.env.NEXT_PUBLIC_BROKER_URL || "http://localhost:3456";

export interface BrokerEvent {
  id: number;
  type: string;
  session_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

interface UseSSEOptions {
  onEvent?: (event: BrokerEvent) => void;
  onConnect?: () => void;
  onError?: (error: Event) => void;
}

export function useSSE(options: UseSSEOptions = {}) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource(`${BROKER_URL}/events`);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      options.onConnect?.();
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as BrokerEvent | { type: "connected" };
        if (data.type !== "connected" && options.onEvent) {
          options.onEvent(data as BrokerEvent);
        }
      } catch {
        // Ignore parse errors
      }
    };

    eventSource.onerror = (error) => {
      options.onError?.(error);
      eventSource.close();

      // Reconnect after 5 seconds
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 5000);
    };
  }, [options]);

  useEffect(() => {
    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect]);

  return {
    close: () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    },
  };
}
