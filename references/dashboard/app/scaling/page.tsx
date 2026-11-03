"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Heading, Text, Card, Flex, Badge, Button, Table, Select, Box,
} from "@radix-ui/themes";
import { listTeams, getScalingPolicies, type Team, type ScalingPolicy } from "@/lib/api";
import { useSSE } from "@/lib/sse-client";

export default function ScalingPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<string>("");
  const [policies, setPolicies] = useState<ScalingPolicy[]>([]);
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

  const fetchPolicies = useCallback(async (teamId: string) => {
    if (!teamId) return;
    try {
      setError(null);
      const data = await getScalingPolicies(teamId);
      setPolicies(data.policies);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch scaling policies");
    } finally {
      setLoading(false);
    }
  }, []);

  useSSE({
    onConnect: () => setConnected(true),
    onError: () => setConnected(false),
    onEvent: (event) => {
      if (selectedTeam && (event.type === "agent_scaled_up" || event.type === "agent_scaled_down")) {
        fetchPolicies(selectedTeam);
      }
    },
  });

  useEffect(() => { fetchTeams(); }, [fetchTeams]);

  useEffect(() => {
    if (teams.length > 0 && !selectedTeam) setSelectedTeam(teams[0].id);
  }, [teams, selectedTeam]);

  useEffect(() => {
    if (selectedTeam) { setLoading(true); fetchPolicies(selectedTeam); }
  }, [selectedTeam, fetchPolicies]);

  return (
    <div>
      <Flex justify="between" align="center" className="mb-6">
        <Flex align="center" gap="3">
          <Heading size="7">Scaling</Heading>
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
          <Button variant="soft" onClick={() => selectedTeam && fetchPolicies(selectedTeam)} disabled={loading || !selectedTeam}>
            Refresh
          </Button>
        </Flex>
      </Flex>

      {error && (
        <Card className="mb-4 border-red-500">
          <Text color="red">Error: {error}</Text>
        </Card>
      )}

      {teams.length === 0 ? (
        <Card><Text color="gray" className="p-4">No active teams. Create a team to configure scaling policies.</Text></Card>
      ) : loading ? (
        <Text color="gray">Loading scaling policies...</Text>
      ) : policies.length === 0 ? (
        <Card><Text color="gray" className="p-4">No scaling policies configured for this team.</Text></Card>
      ) : (
        <Card>
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Role</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Min</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Max</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Scale Up At</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Scale Down At</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Cooldown</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Enabled</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {policies.map((p) => (
                <Table.Row key={p.role}>
                  <Table.Cell><Badge color="blue" variant="soft">{p.role}</Badge></Table.Cell>
                  <Table.Cell><Text size="2">{p.min_count}</Text></Table.Cell>
                  <Table.Cell><Text size="2">{p.max_count}</Text></Table.Cell>
                  <Table.Cell><Text size="2">{p.scale_up_threshold} pending tasks</Text></Table.Cell>
                  <Table.Cell><Text size="2">{p.scale_down_threshold} pending tasks</Text></Table.Cell>
                  <Table.Cell><Text size="2">{Math.round(p.cooldown_ms / 1000)}s</Text></Table.Cell>
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
    </div>
  );
}
