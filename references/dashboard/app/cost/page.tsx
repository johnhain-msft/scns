"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Heading, Text, Card, Flex, Grid, Badge, Button, Select, Table,
} from "@radix-ui/themes";
import { listTeams, getTeamBudget, type Team, type TeamBudget } from "@/lib/api";
import { useSSE } from "@/lib/sse-client";

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function formatUSD(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default function CostPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<string>("");
  const [budget, setBudget] = useState<TeamBudget | null>(null);
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

  const fetchBudget = useCallback(async (teamId: string) => {
    if (!teamId) return;
    try {
      setError(null);
      const data = await getTeamBudget(teamId);
      setBudget(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch budget");
    } finally {
      setLoading(false);
    }
  }, []);

  useSSE({
    onConnect: () => setConnected(true),
    onError: () => setConnected(false),
    onEvent: (event) => {
      if (selectedTeam && event.type === "usage_recorded") {
        fetchBudget(selectedTeam);
      }
    },
  });

  useEffect(() => { fetchTeams(); }, [fetchTeams]);

  useEffect(() => {
    if (teams.length > 0 && !selectedTeam) setSelectedTeam(teams[0].id);
  }, [teams, selectedTeam]);

  useEffect(() => {
    if (selectedTeam) { setLoading(true); fetchBudget(selectedTeam); }
  }, [selectedTeam, fetchBudget]);

  const sessionEntries = budget ? Object.entries(budget.by_session) : [];

  return (
    <div>
      <Flex justify="between" align="center" className="mb-6">
        <Flex align="center" gap="3">
          <Heading size="7">Cost Tracking</Heading>
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
          <Button variant="soft" onClick={() => selectedTeam && fetchBudget(selectedTeam)} disabled={loading || !selectedTeam}>
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
        <Card><Text color="gray" className="p-4">No active teams. Create a team and record usage to see cost tracking.</Text></Card>
      ) : loading ? (
        <Text color="gray">Loading cost data...</Text>
      ) : budget ? (
        <>
          <Grid columns="3" gap="4" className="mb-6">
            <Card>
              <Flex direction="column" gap="1">
                <Text size="2" color="gray">Total Cost</Text>
                <Text size="6" weight="bold">{formatUSD(budget.total_cost_usd)}</Text>
              </Flex>
            </Card>
            <Card>
              <Flex direction="column" gap="1">
                <Text size="2" color="gray">Tokens In</Text>
                <Text size="6" weight="bold">{formatTokens(budget.total_tokens_in)}</Text>
              </Flex>
            </Card>
            <Card>
              <Flex direction="column" gap="1">
                <Text size="2" color="gray">Tokens Out</Text>
                <Text size="6" weight="bold">{formatTokens(budget.total_tokens_out)}</Text>
              </Flex>
            </Card>
          </Grid>

          {sessionEntries.length > 0 && (
            <Card>
              <Text size="3" weight="medium" className="mb-3 block">Per-Session Breakdown</Text>
              <Table.Root>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>Session</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Tokens In</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Tokens Out</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Cost</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {sessionEntries.map(([sessionId, usage]) => (
                    <Table.Row key={sessionId}>
                      <Table.Cell><Text size="2">{sessionId.slice(0, 16)}...</Text></Table.Cell>
                      <Table.Cell><Text size="2">{formatTokens(usage.tokens_in)}</Text></Table.Cell>
                      <Table.Cell><Text size="2">{formatTokens(usage.tokens_out)}</Text></Table.Cell>
                      <Table.Cell><Text size="2">{formatUSD(usage.cost_usd)}</Text></Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}
