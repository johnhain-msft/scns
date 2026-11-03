"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Box, Text, Flex } from "@radix-ui/themes";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: "◉" },
  { href: "/sessions", label: "Sessions", icon: "◎" },
  { href: "/teams", label: "Teams", icon: "⚑" },
  { href: "/tasks", label: "Task Board", icon: "☰" },
  { href: "/conflicts", label: "Conflicts", icon: "⚠" },
  { href: "/scaling", label: "Scaling", icon: "⇅" },
  { href: "/cost", label: "Cost", icon: "$" },
  { href: "/capabilities", label: "Capabilities", icon: "★" },
  { href: "/respawn", label: "Respawn", icon: "↻" },
  { href: "/messages", label: "Messages", icon: "✉" },
  { href: "/health", label: "Health", icon: "♥" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <Box
      className="w-56 border-r border-gray-800 bg-gray-950 p-4"
      style={{ minHeight: "100vh" }}
    >
      <Text size="5" weight="bold" className="mb-6 block text-blue-400">
        🔗 Session Broker
      </Text>

      <Flex direction="column" gap="1">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-blue-600 text-white"
                  : "text-gray-400 hover:bg-gray-800 hover:text-white"
              }`}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </Flex>
    </Box>
  );
}
