"use client";

import { useEffect, useState } from "react";
import { Heading, Text, Card, Flex, Grid, Badge } from "@radix-ui/themes";
import { getHealth, HealthResponse } from "@/lib/api";

export default function OverviewPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const healthData = await getHealth();
        setHealth(healthData);
      } catch {
        // Silently handle - cards will show fallback
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <Heading size="7" className="mb-6">
        Dashboard Overview
      </Heading>

      <Grid columns="3" gap="4" className="mb-8">
        <Card>
          <Flex direction="column" gap="1">
            <Text size="2" color="gray">Active Sessions</Text>
            <Text size="6" weight="bold">
              {loading || !health ? "--" : health.sessions.active}
            </Text>
          </Flex>
        </Card>
        <Card>
          <Flex direction="column" gap="1">
            <Text size="2" color="gray">Zombie Sessions</Text>
            <Text size="6" weight="bold">
              {loading || !health ? "--" : health.sessions.zombie}
            </Text>
          </Flex>
        </Card>
        <Card>
          <Flex direction="column" gap="1">
            <Text size="2" color="gray">Broker Status</Text>
            {loading || !health ? (
              <Text size="6" weight="bold" color="gray">●</Text>
            ) : (
              <Badge
                color={health.status === "ok" ? "green" : "red"}
                size="2"
              >
                {health.status === "ok" ? "● Online" : "● Offline"}
              </Badge>
            )}
          </Flex>
        </Card>
      </Grid>

      <Grid columns="3" gap="4" className="mb-8">
        <Card>
          <Flex direction="column" gap="1">
            <Text size="2" color="gray">Active Teams</Text>
            <Text size="6" weight="bold">
              {loading || !health ? "--" : health.active_teams}
            </Text>
          </Flex>
        </Card>
        <Card>
          <Flex direction="column" gap="1">
            <Text size="2" color="gray">Pending Tasks</Text>
            <Text size="6" weight="bold">
              {loading || !health ? "--" : health.pending_tasks}
            </Text>
          </Flex>
        </Card>
        <Card>
          <Flex direction="column" gap="1">
            <Text size="2" color="gray">In-Progress Tasks</Text>
            <Text size="6" weight="bold">
              {loading || !health ? "--" : health.in_progress_tasks}
            </Text>
          </Flex>
        </Card>
      </Grid>

      <Text color="gray">
        Select a view from the sidebar for details.
      </Text>
    </div>
  );
}
