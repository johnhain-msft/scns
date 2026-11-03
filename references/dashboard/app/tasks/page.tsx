"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Heading, Text, Card, Flex, Badge, Button, Select, Box,
} from "@radix-ui/themes";
import { listTeams, listTasks, type Team, type Task } from "@/lib/api";
import { useSSE } from "@/lib/sse-client";

const STATUS_COLUMNS = ["pending", "in_progress", "completed"] as const;
type TaskStatus = (typeof STATUS_COLUMNS)[number];

const STATUS_CONFIG: Record<TaskStatus, { label: string; color: "yellow" | "blue" | "green" }> = {
  pending: { label: "Pending", color: "yellow" },
  in_progress: { label: "In Progress", color: "blue" },
  completed: { label: "Completed", color: "green" },
};

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function TaskCard({ task }: { task: Task }) {
  return (
    <Card className="mb-2">
      <Flex direction="column" gap="1">
        <Text size="2" weight="medium">{task.subject}</Text>
        {task.owner && (
          <Badge color="purple" variant="soft" size="1">
            {task.owner}
          </Badge>
        )}
        {task.active_form && task.status === "in_progress" && (
          <Text size="1" color="gray">{task.active_form}</Text>
        )}
        <Text size="1" color="gray">{formatTimeAgo(task.updated_at)}</Text>
      </Flex>
    </Card>
  );
}

function KanbanColumn({ status, tasks }: { status: TaskStatus; tasks: Task[] }) {
  const config = STATUS_CONFIG[status];
  return (
    <Box className="flex-1 min-w-[250px]">
      <Flex align="center" gap="2" className="mb-3">
        <Badge color={config.color} variant="soft" size="2">
          {config.label}
        </Badge>
        <Text size="2" color="gray">({tasks.length})</Text>
      </Flex>
      <Box className="space-y-2">
        {tasks.length === 0 ? (
          <Text size="2" color="gray" className="block p-2">No tasks</Text>
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </Box>
    </Box>
  );
}

export default function TaskBoardPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<string>("");
  const [tasks, setTasks] = useState<Task[]>([]);
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

  const fetchTasks = useCallback(async (teamId: string) => {
    if (!teamId) return;
    try {
      setError(null);
      const data = await listTasks(teamId);
      setTasks(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  useSSE({
    onConnect: () => setConnected(true),
    onError: () => setConnected(false),
    onEvent: (event) => {
      if (
        selectedTeam &&
        (event.type === "task_created" ||
          event.type === "task_updated" ||
          event.type === "task_completed")
      ) {
        fetchTasks(selectedTeam);
      }
    },
  });

  useEffect(() => {
    fetchTeams();
  }, [fetchTeams]);

  useEffect(() => {
    if (teams.length > 0 && !selectedTeam) {
      setSelectedTeam(teams[0].id);
    }
  }, [teams, selectedTeam]);

  useEffect(() => {
    if (selectedTeam) {
      setLoading(true);
      fetchTasks(selectedTeam);
    }
  }, [selectedTeam, fetchTasks]);

  const tasksByStatus = STATUS_COLUMNS.reduce<Record<TaskStatus, Task[]>>(
    (acc, status) => ({
      ...acc,
      [status]: tasks.filter((t) => t.status === status),
    }),
    { pending: [], in_progress: [], completed: [] }
  );

  return (
    <div>
      <Flex justify="between" align="center" className="mb-6">
        <Flex align="center" gap="3">
          <Heading size="7">Task Board</Heading>
          <Badge color={connected ? "green" : "gray"} size="1">
            {connected ? "live" : "polling"}
          </Badge>
        </Flex>
        <Flex align="center" gap="3">
          {teams.length > 0 && (
            <Select.Root value={selectedTeam} onValueChange={setSelectedTeam}>
              <Select.Trigger placeholder="Select team..." />
              <Select.Content>
                {teams.map((team) => (
                  <Select.Item key={team.id} value={team.id}>
                    {team.name}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          )}
          <Button
            variant="soft"
            onClick={() => selectedTeam && fetchTasks(selectedTeam)}
            disabled={loading || !selectedTeam}
          >
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
        <Card>
          <Text color="gray" className="p-4">
            No active teams. Create a team via the session broker to see tasks here.
          </Text>
        </Card>
      ) : loading ? (
        <Text color="gray">Loading tasks...</Text>
      ) : (
        <Flex gap="4" className="min-h-[400px]">
          {STATUS_COLUMNS.map((status) => (
            <KanbanColumn
              key={status}
              status={status}
              tasks={tasksByStatus[status]}
            />
          ))}
        </Flex>
      )}
    </div>
  );
}
