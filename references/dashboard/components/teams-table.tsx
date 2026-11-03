"use client";

import { Table, Badge, Text, Flex } from "@radix-ui/themes";
import { Team, TeamStatus } from "@/lib/api";

interface TeamsTableProps {
  teams: Team[];
  statusMap: Record<string, TeamStatus>;
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

function TaskCounts({ counts }: { counts: TeamStatus["task_counts"] }) {
  return (
    <Flex gap="2">
      {counts.pending > 0 && (
        <Badge color="yellow" variant="soft">
          {counts.pending} pending
        </Badge>
      )}
      {counts.in_progress > 0 && (
        <Badge color="blue" variant="soft">
          {counts.in_progress} active
        </Badge>
      )}
      {counts.completed > 0 && (
        <Badge color="green" variant="soft">
          {counts.completed} done
        </Badge>
      )}
      {counts.pending === 0 && counts.in_progress === 0 && counts.completed === 0 && (
        <Text size="2" color="gray">—</Text>
      )}
    </Flex>
  );
}

export function TeamsTable({ teams, statusMap }: TeamsTableProps) {
  if (teams.length === 0) {
    return (
      <Text color="gray" className="p-4">
        No teams found. Create a team via the session broker to see it here.
      </Text>
    );
  }

  return (
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeaderCell>Team Name</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Members</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Tasks</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Created</Table.ColumnHeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {teams.map((team) => {
          const status = statusMap[team.id];

          return (
            <Table.Row key={team.id}>
              <Table.Cell>
                <Text size="2" weight="medium">
                  {team.name}
                </Text>
              </Table.Cell>
              <Table.Cell>
                <Badge
                  color={team.status === "active" ? "green" : "gray"}
                  variant="soft"
                >
                  {team.status}
                </Badge>
              </Table.Cell>
              <Table.Cell>
                <Text size="2">
                  {status ? status.member_count : "—"}
                </Text>
              </Table.Cell>
              <Table.Cell>
                {status ? (
                  <TaskCounts counts={status.task_counts} />
                ) : (
                  <Text size="2" color="gray">—</Text>
                )}
              </Table.Cell>
              <Table.Cell>
                <Text size="2" color="gray">
                  {formatTimeAgo(team.created_at)}
                </Text>
              </Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </Table.Root>
  );
}
