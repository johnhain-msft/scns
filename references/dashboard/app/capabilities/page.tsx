"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Heading, Text, Card, Flex, Badge, Button, Table,
} from "@radix-ui/themes";
import { listSessions, getSessionCapabilities, type Session } from "@/lib/api";
import { useSSE } from "@/lib/sse-client";

interface SessionWithCaps {
  readonly session: Session;
  readonly capabilities: readonly string[];
}

export default function CapabilitiesPage() {
  const [sessionsWithCaps, setSessionsWithCaps] = useState<readonly SessionWithCaps[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const sessions = await listSessions();
      const active = sessions.filter((s) => s.status === "active");

      const results = await Promise.allSettled(
        active.map(async (session) => {
          const caps = await getSessionCapabilities(session.id);
          return { session, capabilities: caps } as SessionWithCaps;
        })
      );

      const successful = results
        .filter((r): r is PromiseFulfilledResult<SessionWithCaps> => r.status === "fulfilled")
        .map((r) => r.value);

      setSessionsWithCaps(successful);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch data");
    } finally {
      setLoading(false);
    }
  }, []);

  useSSE({
    onConnect: () => setConnected(true),
    onError: () => setConnected(false),
    onEvent: (event) => {
      if (event.type === "capabilities_declared") fetchData();
    },
  });

  useEffect(() => { fetchData(); }, [fetchData]);

  const allCaps = [...new Set(sessionsWithCaps.flatMap((s) => s.capabilities))].sort();

  return (
    <div>
      <Flex justify="between" align="center" className="mb-6">
        <Flex align="center" gap="3">
          <Heading size="7">Capabilities</Heading>
          <Badge color={connected ? "green" : "gray"} size="1">
            {connected ? "live" : "polling"}
          </Badge>
        </Flex>
        <Button variant="soft" onClick={fetchData} disabled={loading}>Refresh</Button>
      </Flex>

      {error && (
        <Card className="mb-4 border-red-500">
          <Text color="red">Error: {error}</Text>
        </Card>
      )}

      {loading ? (
        <Text color="gray">Loading capabilities...</Text>
      ) : sessionsWithCaps.length === 0 ? (
        <Card><Text color="gray" className="p-4">No active sessions with declared capabilities.</Text></Card>
      ) : (
        <Card>
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Session</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Capabilities</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {sessionsWithCaps.map(({ session, capabilities }) => (
                <Table.Row key={session.id}>
                  <Table.Cell>
                    <Flex direction="column" gap="1">
                      <Text size="2" weight="medium">{session.id.slice(0, 16)}...</Text>
                      <Text size="1" color="gray">{session.purpose}</Text>
                    </Flex>
                  </Table.Cell>
                  <Table.Cell>
                    <Flex gap="1" wrap="wrap">
                      {capabilities.map((cap) => (
                        <Badge key={cap} color="blue" variant="soft" size="1">{cap}</Badge>
                      ))}
                      {capabilities.length === 0 && <Text size="2" color="gray">none</Text>}
                    </Flex>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>

          {allCaps.length > 0 && (
            <Flex gap="2" wrap="wrap" className="mt-4 pt-4 border-t border-gray-800">
              <Text size="2" color="gray">All capabilities:</Text>
              {allCaps.map((cap) => (
                <Badge key={cap} color="purple" variant="soft" size="1">{cap}</Badge>
              ))}
            </Flex>
          )}
        </Card>
      )}
    </div>
  );
}
