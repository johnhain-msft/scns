/**
 * Config change observer — watches config directories for changes and emits
 * observations when MCPs, skills, or instructions are added, removed, or modified.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import type { Observer } from '../observer.js'
import { ObservationType } from '../types.js'
import type { Observation, ObserverConfig } from '../types.js'
import type { createDailyLogWriter } from '../daily-log-writer.js'
import type { FileWatcher } from '../observers/file-changes.js'
import { createNativeFileWatcher } from '../observers/file-changes.js'
import {
  createConfigScanner,
  type DiscoveredConfig,
  type DiscoveredMcp,
  type DiscoveredSkill,
  type DiscoveredInstruction,
} from './config-scanner.js'
import { logger } from '../../shared/logger.js'

export interface ConfigChangeObserverOptions {
  readonly logWriter: ReturnType<typeof createDailyLogWriter>
  readonly config: ObserverConfig
  readonly watcher?: FileWatcher
  readonly homeDir?: string
  readonly cwd?: string
  readonly debounceMs?: number
}

type ChangeType = 'added' | 'removed' | 'updated'
type SubjectType = 'mcp' | 'skill' | 'instruction'

interface ConfigChange {
  readonly subjectType: SubjectType
  readonly changeType: ChangeType
  readonly name: string
}

/** Serialize an MCP entry to a stable fingerprint for comparison */
function mcpFingerprint(mcp: DiscoveredMcp): string {
  return `${mcp.command}|${mcp.args.join(',')}|${mcp.source}`
}

/** Serialize a skill entry to a stable fingerprint for comparison */
function skillFingerprint(skill: DiscoveredSkill): string {
  return `${skill.description}|${skill.argumentHint ?? ''}|${skill.source}`
}

/** Serialize an instruction entry to a stable fingerprint for comparison */
function instructionFingerprint(inst: DiscoveredInstruction): string {
  return `${inst.source}|${inst.fullLength}|${inst.contentPreview}`
}

function diffConfigs(prev: DiscoveredConfig, next: DiscoveredConfig): readonly ConfigChange[] {
  const changes: ConfigChange[] = []

  // Diff MCPs
  const prevMcps = new Map(prev.mcpServers.map((m) => [m.name, m]))
  const nextMcps = new Map(next.mcpServers.map((m) => [m.name, m]))

  for (const [name, mcp] of nextMcps) {
    const prevMcp = prevMcps.get(name)
    if (!prevMcp) {
      changes.push({ subjectType: 'mcp', changeType: 'added', name })
    } else if (mcpFingerprint(prevMcp) !== mcpFingerprint(mcp)) {
      changes.push({ subjectType: 'mcp', changeType: 'updated', name })
    }
  }
  for (const name of prevMcps.keys()) {
    if (!nextMcps.has(name)) {
      changes.push({ subjectType: 'mcp', changeType: 'removed', name })
    }
  }

  // Diff skills
  const prevSkills = new Map(prev.skills.map((s) => [s.name, s]))
  const nextSkills = new Map(next.skills.map((s) => [s.name, s]))

  for (const [name, skill] of nextSkills) {
    const prevSkill = prevSkills.get(name)
    if (!prevSkill) {
      changes.push({ subjectType: 'skill', changeType: 'added', name })
    } else if (skillFingerprint(prevSkill) !== skillFingerprint(skill)) {
      changes.push({ subjectType: 'skill', changeType: 'updated', name })
    }
  }
  for (const name of prevSkills.keys()) {
    if (!nextSkills.has(name)) {
      changes.push({ subjectType: 'skill', changeType: 'removed', name })
    }
  }

  // Diff instructions
  const prevInsts = new Map(prev.instructions.map((i) => [i.source, i]))
  const nextInsts = new Map(next.instructions.map((i) => [i.source, i]))

  for (const [source, inst] of nextInsts) {
    const prevInst = prevInsts.get(source)
    // basename, not split('/'): sources are `\`-joined on win32.
    const name = basename(source)
    if (!prevInst) {
      changes.push({ subjectType: 'instruction', changeType: 'added', name })
    } else if (instructionFingerprint(prevInst) !== instructionFingerprint(inst)) {
      changes.push({ subjectType: 'instruction', changeType: 'updated', name })
    }
  }
  for (const source of prevInsts.keys()) {
    if (!nextInsts.has(source)) {
      changes.push({ subjectType: 'instruction', changeType: 'removed', name: basename(source) })
    }
  }

  return changes
}

function formatChangeContent(change: ConfigChange): string {
  const labels: Record<SubjectType, string> = {
    mcp: 'MCP server',
    skill: 'Skill',
    instruction: 'Instruction file',
  }
  const verbs: Record<ChangeType, string> = {
    added: change.subjectType === 'instruction' ? 'New' : 'added',
    removed: 'removed',
    updated: 'updated',
  }

  const label = labels[change.subjectType]
  const verb = verbs[change.changeType]

  if (change.changeType === 'added' && change.subjectType === 'instruction') {
    return `New instruction file: ${change.name}`
  }
  return `${label} ${verb}: ${change.name}`
}

export function createConfigChangeObserver(options: ConfigChangeObserverOptions): Observer {
  const {
    logWriter,
    config,
    watcher = createNativeFileWatcher(),
    homeDir: home = homedir(),
    cwd = process.cwd(),
    debounceMs = 500,
  } = options

  const log = logger.child({ observer: 'config-change' })
  const scanner = createConfigScanner({ homeDir: home, cwd })

  let running = false
  let previousConfig: DiscoveredConfig | null = null
  const handles: Array<{ close(): void }> = []
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  // Directories to watch
  const claudeDir = join(home, '.claude')
  const projectClaudeDir = join(cwd, '.claude')
  const extensionsDir = join(cwd, '.github', 'extensions')

  function createObservation(change: ConfigChange): Observation {
    return {
      id: randomUUID(),
      type: ObservationType.ConfigChange,
      timestamp: new Date().toISOString(),
      source: 'config-change-observer',
      content: formatChangeContent(change),
      tags: ['config', change.subjectType, change.changeType],
      metadata: {
        category: 'config',
        subjectType: change.subjectType,
        changeType: change.changeType,
        name: change.name,
      },
    }
  }

  function rescanAndDiff(): void {
    if (!running) return

    let nextConfig: DiscoveredConfig
    try {
      nextConfig = scanner.scan()
    } catch (err) {
      log.error({ err }, 'Config rescan failed, keeping previous state')
      return
    }

    if (previousConfig === null) {
      previousConfig = nextConfig
      return
    }

    const changes = diffConfigs(previousConfig, nextConfig)
    previousConfig = nextConfig

    for (const change of changes) {
      const observation = createObservation(change)
      logWriter.write(observation)
    }
  }

  function handleEvent(): void {
    if (!running) return

    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null
      rescanAndDiff()
    }, debounceMs)
  }

  function watchDir(dir: string): void {
    if (!existsSync(dir)) return

    try {
      const handle = watcher.watch(dir, { recursive: true }, () => {
        handleEvent()
      })
      handles.push(handle)
    } catch (err) {
      log.error({ err, dir }, 'Failed to watch config directory')
    }
  }

  return {
    type: ObservationType.ConfigChange,
    name: 'config-change-observer',

    start(): void {
      if (running || !config.enabled) return

      // Initial scan to populate baseline state (no observations emitted)
      try {
        previousConfig = scanner.scan()
      } catch (err) {
        log.error({ err }, 'Initial config scan failed')
        previousConfig = {
          mcpServers: [],
          skills: [],
          instructions: [],
          scannedPaths: [],
          scannedAt: new Date().toISOString(),
        }
      }

      running = true

      // Watch each config directory
      watchDir(claudeDir)
      watchDir(projectClaudeDir)
      watchDir(extensionsDir)
    },

    stop(): void {
      running = false

      // Cancel pending debounced scan
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }

      for (const handle of handles) {
        handle.close()
      }
      handles.length = 0

      previousConfig = null
    },

    isRunning(): boolean {
      return running
    },
  }
}
