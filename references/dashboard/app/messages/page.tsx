"use client";

import { useEffect, useState } from "react";
import { Heading, Text, Card, Flex, Button } from "@radix-ui/themes";
import { MessageTimeline } from "@/components/message-timeline";
import { listMessages, Message } from "@/lib/api";

export default function MessagesPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchMessages() {
    try {
      setError(null);
      const data = await listMessages(100);
      setMessages(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch messages");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchMessages();
    const interval = setInterval(fetchMessages, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <Flex justify="between" align="center" className="mb-6">
        <Heading size="7">Messages</Heading>
        <Button variant="soft" onClick={fetchMessages} disabled={loading}>
          Refresh
        </Button>
      </Flex>

      {error && (
        <Card className="mb-4">
          <Text color="red">Error: {error}</Text>
        </Card>
      )}

      {loading && messages.length === 0 ? (
        <Text color="gray">Loading messages...</Text>
      ) : (
        <Card>
          <MessageTimeline messages={messages} />
        </Card>
      )}
    </div>
  );
}
