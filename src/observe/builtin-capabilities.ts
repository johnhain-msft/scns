/**
 * Capability and description mappings for built-in observers.
 * Keyed by observer name (not type) since config-change-observer shares
 * the 'file-change' type with the file-change observer.
 */

import type { ObserverCapability } from './plugin.js'

export const OBSERVER_CAPABILITIES: Readonly<Record<string, readonly ObserverCapability[]>> = {
  'active-app': ['system'],
  'browser-tab': ['network'],
  'file-change': ['files'],
  'file-change-observer': ['files'],
  'git-activity': ['files'],
  'git-activity-observer': ['files'],
  'terminal-history': ['system'],
  'session-hook': ['sessions'],
  'config-change-observer': ['files'],
}

export const OBSERVER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'active-app': 'Monitors the currently active application window',
  'browser-tab': 'Tracks browser tab changes and URLs',
  'file-change': 'Detects file system modifications in watched directories',
  'file-change-observer': 'Detects file system modifications in watched directories',
  'git-activity': 'Monitors git commits, branches, and repository changes',
  'git-activity-observer': 'Monitors git commits, branches, and repository changes',
  'terminal-history': 'Watches terminal command history',
  'session-hook': 'Captures Copilot CLI session lifecycle events',
  'config-change-observer': 'Detects changes to MCP, skill, and instruction config files',
}
