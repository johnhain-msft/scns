"use client";

import { Table, Badge, Text, Flex } from "@radix-ui/themes";
import { Session, getHeartbeatStatus } from "@/lib/api";

interface SessionTableProps {
  sessions: Session[];
}

function HeartbeatBadge({ status }: { status: "healthy" | "warning" | "stale" }) {
  const colors = {
    healthy: "green" as const,
    warning: "yellow" as const,
    stale: "red" as const,
  };
  const labels = {
    healthy: "● Active",
    warning: "● Warning",
    stale: "● Stale",
  };

  return (
    <Badge color={colors[status]} variant="soft">
      {labels[status]}
    </Badge>
  );
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function SessionTable({ sessions }: SessionTableProps) {
  if (sessions.length === 0) {
    return (
      <Text color="gray" className="p-4">
        No active sessions. Start a Copilot CLI session to see it here.
      </Text>
    );
  }

  return (
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeaderCell>Session ID</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Purpose</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Heartbeat</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Last Heartbeat</Table.ColumnHeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {sessions.map((session) => {
          const heartbeatStatus = getHeartbeatStatus(session.last_heartbeat);

          return (
            <Table.Row key={session.id}>
              <Table.Cell>
                <Text size="2" className="font-mono">
                  {session.id.slice(0, 12)}...
                </Text>
              </Table.Cell>
              <Table.Cell>
                <Text size="2">{session.purpose || "—"}</Text>
              </Table.Cell>
              <Table.Cell>
                <Badge
                  color={session.status === "active" ? "green" : session.status === "zombie" ? "red" : "gray"}
                  variant="soft"
                >
                  {session.status}
                </Badge>
              </Table.Cell>
              <Table.Cell>
                <HeartbeatBadge status={heartbeatStatus} />
              </Table.Cell>
              <Table.Cell>
                <Text size="2" color="gray">
                  {formatTimeAgo(session.last_heartbeat)}
                </Text>
              </Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </Table.Root>
  );
}
