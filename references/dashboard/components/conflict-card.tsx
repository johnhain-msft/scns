"use client";

import { Card, Flex, Text, Badge } from "@radix-ui/themes";

interface ConflictCardProps {
  filePath: string;
  sessions: { session_id: string; purpose: string }[];
}

export function ConflictCard({ filePath, sessions }: ConflictCardProps) {
  return (
    <Card className="border-l-4 border-l-yellow-500">
      <Flex direction="column" gap="2">
        <Flex justify="between" align="center">
          <Text size="3" weight="bold" className="font-mono">
            {filePath}
          </Text>
          <Badge color="yellow" variant="soft">
            {sessions.length} sessions
          </Badge>
        </Flex>

        <Text size="2" color="gray">
          The following sessions have declared intent on this file:
        </Text>

        <Flex direction="column" gap="1">
          {sessions.map((session) => (
            <Flex key={session.session_id} gap="2" align="center">
              <Text size="2" className="font-mono text-blue-400">
                {session.session_id.slice(0, 8)}
              </Text>
              <Text size="2" color="gray">
                — {session.purpose || "No purpose specified"}
              </Text>
            </Flex>
          ))}
        </Flex>
      </Flex>
    </Card>
  );
}
