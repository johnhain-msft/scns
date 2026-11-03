/**
 * Autonomy level management — read, write, promote, demote.
 * State is persisted to ~/.scns/state/autonomy.json.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { logger } from './logger.js'

export interface AutonomyState {
  readonly level: 0 | 1 | 2 | 3
  readonly changedAt: string
  readonly changedBy: string // 'user' | 'brain'
}

const AutonomyStateSchema = z.object({
  level: z.number().int().min(0).max(3),
  changedAt: z.string(),
  changedBy: z.string(),
})

const AUTONOMY_FILE = 'autonomy.json'
const MIN_LEVEL = 0
const MAX_LEVEL = 3

function createDefaultState(): AutonomyState {
  return {
    level: 0,
    changedAt: new Date().toISOString(),
    changedBy: 'user',
  }
}

const DESCRIPTIONS: Record<number, string> = {
  0: 'Observer — only suggests, never acts',
  1: 'Assistant — can execute pre-approved actions',
  2: 'Collaborator — can act independently on low-risk tasks',
  3: 'Autonomous — full autonomy within guardrails',
}

export function loadAutonomy(stateDir: string): AutonomyState {
  const filePath = join(stateDir, AUTONOMY_FILE)
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const result = AutonomyStateSchema.safeParse(JSON.parse(raw))
    if (!result.success) {
      logger.warn(
        { error: result.error.message, filePath },
        'Invalid autonomy state file, using defaults',
      )
      return createDefaultState()
    }
    return {
      level: Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, result.data.level)) as AutonomyState['level'],
      changedAt: result.data.changedAt,
      changedBy: result.data.changedBy,
    }
  } catch {
    return createDefaultState()
  }
}

export function saveAutonomy(stateDir: string, state: AutonomyState): void {
  mkdirSync(stateDir, { recursive: true })
  const filePath = join(stateDir, AUTONOMY_FILE)
  writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

/**
 * Seed the autonomy store from an initial level (e.g. the `--autonomy` startup
 * flag) ONLY when no state file exists yet. Idempotent: an existing store (set by
 * a prior promote/demote or an operator) is never overwritten. Without this, a
 * FRESH broker's `loadAutonomy()` defaults to level 0 and silently ignores
 * `--autonomy` — which is why a meta-broker child spawned with `--autonomy 2` (its
 * own isolated, empty state dir) would otherwise run in Observer mode and never
 * execute tasks. Returns the effective state.
 */
export function seedAutonomyIfAbsent(
  stateDir: string,
  level: number,
  changedBy = 'startup-flag',
): AutonomyState {
  if (existsSync(join(stateDir, AUTONOMY_FILE))) return loadAutonomy(stateDir)
  const clamped = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, level)) as AutonomyState['level']
  const state: AutonomyState = { level: clamped, changedAt: new Date().toISOString(), changedBy }
  saveAutonomy(stateDir, state)
  return state
}

export function promote(stateDir: string): AutonomyState {
  const current = loadAutonomy(stateDir)
  const newLevel = Math.min(MAX_LEVEL, current.level + 1) as AutonomyState['level']
  const newState: AutonomyState = {
    level: newLevel,
    changedAt: new Date().toISOString(),
    changedBy: 'user',
  }
  saveAutonomy(stateDir, newState)
  return newState
}

export function demote(stateDir: string): AutonomyState {
  const current = loadAutonomy(stateDir)
  const newLevel = Math.max(MIN_LEVEL, current.level - 1) as AutonomyState['level']
  const newState: AutonomyState = {
    level: newLevel,
    changedAt: new Date().toISOString(),
    changedBy: 'user',
  }
  saveAutonomy(stateDir, newState)
  return newState
}

export function getAutonomyDescription(level: number): string {
  return DESCRIPTIONS[level] ?? `Unknown level ${level}`
}
