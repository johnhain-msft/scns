"use client";

import { useEffect, useState, useCallback } from "react";
import { Heading, Text, Card, Flex, Button, Badge } from "@radix-ui/themes";
import { TeamsTable } from "@/components/teams-table";
import { listTeams, getTeamStatus, Team, TeamStatus } from "@/lib/api";
import { useSSE } from "@/lib/sse-client";

export default function TeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [statusMap, setStatusMap] = useState<Record<string, TeamStatus>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const fetchTeams = useCallback(async () => {
    try {
      setError(null);
      const data = await listTeams();
      setTeams(data);

      const statuses: Record<string, TeamStatus> = {};
      const activeTeams = data.filter((t) => t.status === "active");
      const results = await Promise.allSettled(
        activeTeams.map((t) => getTeamStatus(t.id))
      );
      activeTeams.forEach((team, i) => {
        const result = results[i];
        if (result.status === "fulfilled") {
          statuses[team.id] = result.value;
        }
      });
      setStatusMap(statuses);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch teams");
    } finally {
      setLoading(false);
    }
  }, []);

  useSSE({
    onConnect: () => setConnected(true),
    onError: () => setConnected(false),
    onEvent: (event) => {
      if (
        event.type === "team_created" ||
        event.type === "team_disbanded" ||
        event.type === "member_joined" ||
        event.type === "member_left" ||
        event.type === "task_created" ||
        event.type === "task_updated"
      ) {
        fetchTeams();
      }
    },
  });

  useEffect(() => {
    fetchTeams();
  }, [fetchTeams]);

  return (
    <div>
      <Flex justify="between" align="center" className="mb-6">
        <Flex align="center" gap="3">
          <Heading size="7">Teams</Heading>
          <Badge color={connected ? "green" : "gray"} size="1">
            {connected ? "● live" : "○ polling"}
          </Badge>
        </Flex>
        <Button variant="soft" onClick={fetchTeams} disabled={loading}>
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

      {loading && teams.length === 0 ? (
        <Text color="gray">Loading teams...</Text>
      ) : (
        <Card>
          <TeamsTable teams={teams} statusMap={statusMap} />
        </Card>
      )}
    </div>
  );
}
