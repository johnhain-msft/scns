"use client";

import { useEffect, useState, useCallback } from "react";
import { Heading, Text, Card, Flex, Button, Badge } from "@radix-ui/themes";
import { SessionTable } from "@/components/session-table";
import { listSessions, Session } from "@/lib/api";
import { useSSE } from "@/lib/sse-client";

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      setError(null);
      const data = await listSessions();
      setSessions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  // SSE for real-time updates
  useSSE({
    onConnect: () => setConnected(true),
    onError: () => setConnected(false),
    onEvent: (event) => {
      // Refresh on session-related events
      if (
        event.type === "session_registered" ||
        event.type === "session_deregistered" ||
        event.type === "heartbeat_received" ||
        event.type === "zombie_cleaned"
      ) {
        fetchSessions();
      }
    },
  });

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  return (
    <div>
      <Flex justify="between" align="center" className="mb-6">
        <Flex align="center" gap="3">
          <Heading size="7">Sessions</Heading>
          <Badge color={connected ? "green" : "gray"} size="1">
            {connected ? "● live" : "○ polling"}
          </Badge>
        </Flex>
        <Button variant="soft" onClick={fetchSessions} disabled={loading}>
          Refresh
        </Button>
      </Flex>

      {error && (
        <Card className="mb-4 border-red-500">
          <Text color="red">Error: {error}</Text>
          <Text size="2" color="gray" className="block mt-1">
            Make sure the session broker is running on localhost:3456
          </Text>
        </Card>
      )}

      {loading && sessions.length === 0 ? (
        <Text color="gray">Loading sessions...</Text>
      ) : (
        <Card>
          <SessionTable sessions={sessions} />
        </Card>
      )}
    </div>
  );
}
