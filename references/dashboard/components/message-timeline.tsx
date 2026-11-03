"use client";

import { Card, Flex, Text, Badge } from "@radix-ui/themes";
import { Message } from "@/lib/api";

interface MessageTimelineProps {
  messages: Message[];
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString();
}

export function MessageTimeline({ messages }: MessageTimelineProps) {
  if (messages.length === 0) {
    return (
      <Text color="gray" className="p-4">
        No messages yet. Messages between sessions will appear here.
      </Text>
    );
  }

  // Group messages by date
  const grouped: Map<string, Message[]> = new Map();
  for (const msg of messages) {
    const date = formatDate(msg.created_at);
    const existing = grouped.get(date) || [];
    existing.push(msg);
    grouped.set(date, existing);
  }

  return (
    <Flex direction="column" gap="4">
      {Array.from(grouped.entries()).map(([date, msgs]) => (
        <div key={date}>
          <Text size="2" color="gray" className="mb-2 block">
            {date}
          </Text>
          <Flex direction="column" gap="2">
            {msgs.map((msg) => (
              <Card key={msg.id} className="p-3">
                <Flex justify="between" align="start">
                  <Flex direction="column" gap="1">
                    <Flex gap="2" align="center">
                      <Text size="2" className="font-mono text-blue-400">
                        {msg.sender_id.slice(0, 8)}
                      </Text>
                      <Text size="2" color="gray">→</Text>
                      {msg.receiver_id ? (
                        <Text size="2" className="font-mono text-green-400">
                          {msg.receiver_id.slice(0, 8)}
                        </Text>
                      ) : (
                        <Badge color="purple" size="1">broadcast</Badge>
                      )}
                    </Flex>
                    <Text size="2" className="mt-1">
                      {msg.content}
                    </Text>
                  </Flex>
                  <Flex direction="column" align="end" gap="1">
                    <Text size="1" color="gray">
                      {formatTime(msg.created_at)}
                    </Text>
                    {msg.read_at && (
                      <Badge color="green" size="1">read</Badge>
                    )}
                  </Flex>
                </Flex>
              </Card>
            ))}
          </Flex>
        </div>
      ))}
    </Flex>
  );
}
