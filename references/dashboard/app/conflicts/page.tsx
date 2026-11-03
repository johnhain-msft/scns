"use client";

import { useEffect, useState, useCallback } from "react";
import { Heading, Text, Card, Flex, Button, Badge } from "@radix-ui/themes";
import { ConflictCard } from "@/components/conflict-card";
import { getBranchConflicts, type BranchConflict } from "@/lib/api";
import { useSSE } from "@/lib/sse-client";

const BROKER_URL = process.env.NEXT_PUBLIC_BROKER_URL || "http://localhost:3456";

interface FileConflict {
  filePath: string;
  sessions: { session_id: string; purpose: string }[];
}

interface ConflictIntent {
  file_path: string;
  session_id: string;
  intent: string;
}

async function fetchFileConflicts(): Promise<FileConflict[]> {
  const res = await fetch(`${BROKER_URL}/api/check_conflicts`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  const intents: ConflictIntent[] = data.conflicts || [];

  const fileToSessions = new Map<string, { session_id: string; purpose: string }[]>();
  for (const intent of intents) {
    const existing = fileToSessions.get(intent.file_path) || [];
    fileToSessions.set(intent.file_path, [...existing, { session_id: intent.session_id, purpose: intent.intent }]);
  }

  const conflicts: FileConflict[] = [];
  for (const [filePath, sessionList] of fileToSessions) {
    if (sessionList.length > 1) {
      conflicts.push({ filePath, sessions: sessionList });
    }
  }

  return conflicts.sort((a, b) => b.sessions.length - a.sessions.length);
}

function BranchConflictCard({ conflict }: { conflict: BranchConflict }) {
  const branches = conflict.branches;
  return (
    <Card className="border-l-4 border-l-orange-500">
      <Flex direction="column" gap="2">
        <Flex justify="between" align="center">
          <Text size="3" weight="bold" className="font-mono">
            {conflict.file_path}
          </Text>
          <Badge color="orange" variant="soft">
            {branches.length} branches
          </Badge>
        </Flex>

        <Text size="2" color="gray">
          This file is being modified on different branches:
        </Text>

        <Flex direction="column" gap="1">
          {branches.map((b) => (
            <Flex key={`${b.branch}-${b.session_id}`} gap="2" align="center">
              <Badge color="purple" variant="soft" size="1">
                {b.branch}
              </Badge>
              <Text size="2" className="font-mono text-blue-400">
                {b.session_id.slice(0, 8)}
              </Text>
              {b.commit_sha && (
                <Text size="1" color="gray">@ {b.commit_sha.slice(0, 7)}</Text>
              )}
            </Flex>
          ))}
        </Flex>
      </Flex>
    </Card>
  );
}

export default function ConflictsPage() {
  const [fileConflicts, setFileConflicts] = useState<FileConflict[]>([]);
  const [branchConflicts, setBranchConflicts] = useState<BranchConflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      setError(null);
      const [file, branch] = await Promise.all([
        fetchFileConflicts(),
        getBranchConflicts().then((r) => r.conflicts).catch(() => []),
      ]);
      setFileConflicts(file);
      setBranchConflicts(branch);
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
      if (
        event.type === "conflict_detected" ||
        event.type === "branch_conflict_detected" ||
        event.type === "intent_declared" ||
        event.type === "branch_intent_declared"
      ) {
        fetchAll();
      }
    },
  });

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 10000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const totalConflicts = fileConflicts.length + branchConflicts.length;

  return (
    <div>
      <Flex justify="between" align="center" className="mb-6">
        <Flex align="center" gap="3">
          <Heading size="7">Conflicts</Heading>
          <Badge color={connected ? "green" : "gray"} size="1">
            {connected ? "live" : "polling"}
          </Badge>
          {totalConflicts > 0 && (
            <Badge color="yellow" size="2">
              {totalConflicts} active
            </Badge>
          )}
        </Flex>
        <Button variant="soft" onClick={fetchAll} disabled={loading}>
          Refresh
        </Button>
      </Flex>

      {error && (
        <Card className="mb-4">
          <Text color="red">Error: {error}</Text>
        </Card>
      )}

      {loading && totalConflicts === 0 ? (
        <Text color="gray">Checking for conflicts...</Text>
      ) : totalConflicts === 0 ? (
        <Card>
          <Flex direction="column" align="center" gap="2" className="py-8">
            <Text size="5">No conflicts</Text>
            <Text color="gray">No file or branch conflicts detected</Text>
            <Text size="2" color="gray">
              Conflicts appear when multiple sessions declare intent on the same file,
              or when the same file is modified on different branches.
            </Text>
          </Flex>
        </Card>
      ) : (
        <Flex direction="column" gap="4">
          {branchConflicts.length > 0 && (
            <div>
              <Flex align="center" gap="2" className="mb-3">
                <Badge color="orange" variant="soft" size="2">Branch Conflicts</Badge>
                <Text size="2" color="gray">
                  Same file modified on different branches — potential merge conflicts
                </Text>
              </Flex>
              <Flex direction="column" gap="3">
                {branchConflicts.map((c) => (
                  <BranchConflictCard key={c.file_path} conflict={c} />
                ))}
              </Flex>
            </div>
          )}

          {fileConflicts.length > 0 && (
            <div>
              <Flex align="center" gap="2" className="mb-3">
                <Badge color="yellow" variant="soft" size="2">File Conflicts</Badge>
                <Text size="2" color="gray">
                  Multiple sessions working on the same file
                </Text>
              </Flex>
              <Flex direction="column" gap="3">
                {fileConflicts.map((conflict) => (
                  <ConflictCard
                    key={conflict.filePath}
                    filePath={conflict.filePath}
                    sessions={conflict.sessions}
                  />
                ))}
              </Flex>
            </div>
          )}
        </Flex>
      )}
    </div>
  );
}
