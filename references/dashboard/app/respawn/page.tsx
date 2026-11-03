"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Heading, Text, Card, Flex, Badge, Button, Table, Select,
} from "@radix-ui/themes";
import {
  listTeams, getRespawnPolicies, getRespawnHistory,
  type Team, type RespawnPolicy, type RespawnEvent,
} from "@/lib/api";
import { useSSE } from "@/lib/sse-client";

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

const STATUS_COLORS: Record<string, "green" | "yellow" | "red" | "gray"> = {
  spawned: "green",
  pending: "yellow",
  failed: "red",
  abandoned: "gray",
};

export default function RespawnPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<string>("");
  const [policies, setPolicies] = useState<RespawnPolicy[]>([]);
  const [history, setHistory] = useState<RespawnEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const fetchTeams = useCallback(async () => {
    try {
      const data = await listTeams();
      setTeams(data.filter((t) => t.status === "active"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch teams");
    }
  }, []);

  const fetchData = useCallback(async (teamId: string) => {
    if (!teamId) return;
    try {
      setError(null);
      const [policiesData, historyData] = await Promise.all([
        getRespawnPolicies(teamId),
        getRespawnHistory(teamId, { limit: 50 }),
      ]);
      setPolicies(policiesData.policies);
      setHistory(historyData.history);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch respawn data");
    } finally {
      setLoading(false);
    }
  }, []);

  useSSE({
    onConnect: () => setConnected(true),
    onError: () => setConnected(false),
    onEvent: (event) => {
      if (selectedTeam && (event.type === "agent_respawned" || event.type === "agent_abandoned")) {
        fetchData(selectedTeam);
      }
    },
  });

  useEffect(() => { fetchTeams(); }, [fetchTeams]);

  useEffect(() => {
    if (teams.length > 0 && !selectedTeam) setSelectedTeam(teams[0].id);
  }, [teams, selectedTeam]);

  useEffect(() => {
    if (selectedTeam) { setLoading(true); fetchData(selectedTeam); }
  }, [selectedTeam, fetchData]);

  return (
    <div>
      <Flex justify="between" align="center" className="mb-6">
        <Flex align="center" gap="3">
          <Heading size="7">Respawn</Heading>
          <Badge color={connected ? "green" : "gray"} size="1">
            {connected ? "live" : "polling"}
          </Badge>
        </Flex>
        <Flex align="center" gap="3">
          {teams.length > 0 && (
            <Select.Root value={selectedTeam} onValueChange={setSelectedTeam}>
              <Select.Trigger placeholder="Select team..." />
              <Select.Content>
                {teams.map((t) => <Select.Item key={t.id} value={t.id}>{t.name}</Select.Item>)}
              </Select.Content>
            </Select.Root>
          )}
          <Button variant="soft" onClick={() => selectedTeam && fetchData(selectedTeam)} disabled={loading || !selectedTeam}>
            Refresh
          </Button>
        </Flex>
      </Flex>

      {error && (
        <Card className="mb-4 border-red-500"><Text color="red">Error: {error}</Text></Card>
      )}

      {teams.length === 0 ? (
        <Card><Text color="gray" className="p-4">No active teams. Create a team to configure respawn policies.</Text></Card>
      ) : loading ? (
        <Text color="gray">Loading respawn data...</Text>
      ) : (
        <>
          {policies.length > 0 && (
            <Card className="mb-4">
              <Text size="3" weight="medium" className="mb-3 block">Policies</Text>
              <Table.Root>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>Role</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Min Count</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Max Retries</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Backoff</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Enabled</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {policies.map((p) => (
                    <Table.Row key={p.role}>
                      <Table.Cell><Badge color="blue" variant="soft">{p.role}</Badge></Table.Cell>
                      <Table.Cell><Text size="2">{p.min_count}</Text></Table.Cell>
                      <Table.Cell><Text size="2">{p.max_retries}</Text></Table.Cell>
                      <Table.Cell><Text size="2">{p.backoff_base_ms}ms</Text></Table.Cell>
                      <Table.Cell>
                        <Badge color={p.enabled ? "green" : "gray"} variant="soft">
                          {p.enabled ? "on" : "off"}
                        </Badge>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Card>
          )}

          <Card>
            <Text size="3" weight="medium" className="mb-3 block">History</Text>
            {history.length === 0 ? (
              <Text color="gray" className="p-2">No respawn history for this team.</Text>
            ) : (
              <Table.Root>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>Role</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Attempt</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Session</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Time</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Error</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {history.map((h) => (
                    <Table.Row key={h.id}>
                      <Table.Cell><Badge color="blue" variant="soft">{h.role}</Badge></Table.Cell>
                      <Table.Cell>
                        <Badge color={STATUS_COLORS[h.status] ?? "gray"} variant="soft">
                          {h.status}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell><Text size="2">#{h.attempt}</Text></Table.Cell>
                      <Table.Cell><Text size="2">{h.session_id?.slice(0, 12) ?? "—"}...</Text></Table.Cell>
                      <Table.Cell><Text size="2">{formatTimeAgo(h.created_at)}</Text></Table.Cell>
                      <Table.Cell><Text size="2" color="red">{h.error ?? "—"}</Text></Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
