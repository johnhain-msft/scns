/**
 * Tool filtering — enables/disables MCP tools based on session profile.
 *
 * Uses the MCP SDK's RegisteredTool.enable()/disable() mechanism.
 * The SDK already filters tools/list by enabled state and rejects
 * calls to disabled tools, so toggling enabled is all we need.
 */

import type { ToolProfile } from './tool-profiles.js'
import { getToolsForProfile } from './tool-profiles.js'

/** Minimal interface matching MCP SDK's RegisteredTool for enable/disable control. */
export interface ToolRegistration {
  enabled: boolean
  enable(): void
  disable(): void
}

/** Map of tool name → RegisteredTool control handle. */
export type ToolRegistrationMap = Map<string, ToolRegistration>

/**
 * Applies a tool profile to a set of registered tools.
 * Tools matching the profile are enabled; all others are disabled.
 */
export function applyProfile(tools: ToolRegistrationMap, profile: ToolProfile): void {
  const allowed = getToolsForProfile(profile)
  for (const [name, tool] of tools) {
    if (allowed.has(name)) {
      tool.enable()
    } else {
      tool.disable()
    }
  }
}

/** Returns the count of currently enabled tools in a registration map. */
export function countEnabledTools(tools: ToolRegistrationMap): number {
  let count = 0
  for (const tool of tools.values()) {
    if (tool.enabled) {
      count++
    }
  }
  return count
}
