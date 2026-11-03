"use client";

import { useEffect, useState } from "react";
import { Heading, Text, Card, Flex, Grid, Button, Badge } from "@radix-ui/themes";
import { getHealth, getIndexStats, HealthResponse, IndexStatsResponse } from "@/lib/api";

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export default function HealthPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [indexStats, setIndexStats] = useState<IndexStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchData() {
    try {
      setError(null);
      const [healthData, statsData] = await Promise.all([
        getHealth(),
        getIndexStats(),
      ]);
      setHealth(healthData);
      setIndexStats(statsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch health");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <Flex justify="between" align="center" className="mb-6">
        <Heading size="7">Health</Heading>
        <Button variant="soft" onClick={fetchData} disabled={loading}>
          Refresh
        </Button>
      </Flex>

      {error && (
        <Card className="mb-4">
          <Text color="red">Error: {error}</Text>
          <Text size="2" color="gray" className="block mt-1">
            Make sure the session broker is running on localhost:3456
          </Text>
        </Card>
      )}

      {loading && !health ? (
        <Text color="gray">Loading health data...</Text>
      ) : health ? (
        <Grid columns="3" gap="4">
          <Card>
            <Flex direction="column" gap="2">
              <Text size="2" color="gray">Status</Text>
              <Flex align="center" gap="2">
                <Badge
                  color={health.status === "ok" ? "green" : "red"}
                  size="2"
                >
                  {health.status === "ok" ? "● Healthy" : "● Unhealthy"}
                </Badge>
              </Flex>
            </Flex>
          </Card>

          <Card>
            <Flex direction="column" gap="2">
              <Text size="2" color="gray">Uptime</Text>
              <Text size="5" weight="bold">
                {formatUptime(health.uptime_seconds)}
              </Text>
            </Flex>
          </Card>

          <Card>
            <Flex direction="column" gap="2">
              <Text size="2" color="gray">Active Sessions</Text>
              <Text size="5" weight="bold">
                {health.sessions.active}
              </Text>
            </Flex>
          </Card>

          <Card>
            <Flex direction="column" gap="2">
              <Text size="2" color="gray">Zombie Sessions</Text>
              <Flex align="center" gap="2">
                <Text size="5" weight="bold">
                  {health.sessions.zombie}
                </Text>
                {health.sessions.zombie > 0 && (
                  <Badge color="yellow" size="1">needs cleanup</Badge>
                )}
              </Flex>
            </Flex>
          </Card>

          <Card>
            <Flex direction="column" gap="2">
              <Text size="2" color="gray">Active Teams</Text>
              <Text size="5" weight="bold">
                {health.active_teams}
              </Text>
            </Flex>
          </Card>

          <Card>
            <Flex direction="column" gap="2">
              <Text size="2" color="gray">Pending Tasks</Text>
              <Text size="5" weight="bold">
                {health.pending_tasks}
              </Text>
            </Flex>
          </Card>

          <Card>
            <Flex direction="column" gap="2">
              <Text size="2" color="gray">In-Progress Tasks</Text>
              <Text size="5" weight="bold">
                {health.in_progress_tasks}
              </Text>
            </Flex>
          </Card>

          {indexStats && (
            <>
              <Card>
                <Flex direction="column" gap="2">
                  <Text size="2" color="gray">Indexed Sessions</Text>
                  <Text size="5" weight="bold">
                    {indexStats.indexed_sessions}
                  </Text>
                </Flex>
              </Card>

              <Card>
                <Flex direction="column" gap="2">
                  <Text size="2" color="gray">Embedding Dimension</Text>
                  <Text size="5" weight="bold">
                    {indexStats.embedding_dimension}
                  </Text>
                </Flex>
              </Card>
            </>
          )}
        </Grid>
      ) : null}
    </div>
  );
}
