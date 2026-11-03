/**
 * Learning pipeline — orchestrates session digests → vault → AutoDream consolidation.
 *
 * Extracts session summaries from OTel spans, generates digests and patterns,
 * stores them in the vault, and tracks progress via learning state.
 */

import type Database from 'better-sqlite3'
import type { Vault } from '../memory/vault.js'
import type { ExtractedPatterns } from './pattern-extractor.js'
import { extractSessionSummaries } from './session-extractor.js'
import { generateSessionDigest, storeSessionDigest } from './session-digest.js'
import { extractPatterns, patternsToMemoryEntries } from './pattern-extractor.js'
import { ensureLearningStateTable, loadLearningState, saveLearningState } from './learning-state.js'
import { logger } from '../shared/logger.js'

// ── Types ────────────────────────────────────────────────────

export interface LearningPipelineConfig {
  readonly db: Database.Database
  readonly vault: Vault
  readonly since?: string
}

export interface LearningRunResult {
  readonly sessionsProcessed: number
  readonly digestsStored: number
  readonly patternsExtracted: ExtractedPatterns | null
  readonly memoryEntriesGenerated: number
  readonly errors: ReadonlyArray<string>
}

// ── Pipeline ─────────────────────────────────────────────────

const MAX_SESSIONS_PER_RUN = 1000

/**
 * Run the full learning pipeline:
 * 1. Extract session summaries from DB
 * 2. Generate and store digests in vault
 * 3. Extract behavioral patterns
 * 4. Convert patterns to memory entries and append to daily log
 * 5. Update learning state
 */
export function runLearningPipeline(config: LearningPipelineConfig): LearningRunResult {
  const { db, vault } = config
  const errors: string[] = []

  // 1. Ensure learning state table exists
  ensureLearningStateTable(db)
  const state = loadLearningState(db)

  // 2. Determine "since" cursor
  const since = config.since ?? state.lastProcessedAt ?? undefined

  // 3. Extract session summaries
  const summaries = extractSessionSummaries(db, {
    since,
    limit: MAX_SESSIONS_PER_RUN,
  })

  if (summaries.length === 0) {
    logger.debug('learning pipeline: no new sessions to process')
    return {
      sessionsProcessed: 0,
      digestsStored: 0,
      patternsExtracted: null,
      memoryEntriesGenerated: 0,
      errors: [],
    }
  }

  logger.info({ count: summaries.length, since }, 'learning pipeline: processing sessions')

  // 4. Generate and store digests (isolate errors per session)
  let digestsStored = 0
  let latestSessionTime: string | null = null

  for (const summary of summaries) {
    try {
      const digest = generateSessionDigest(summary)
      storeSessionDigest(vault, digest)
      digestsStored++

      // Track latest session time for cursor advancement
      const sessionTime = summary.startTime
      if (latestSessionTime === null || sessionTime > latestSessionTime) {
        latestSessionTime = sessionTime
      }
    } catch (err) {
      const msg = `Failed to process session ${summary.sessionId}: ${err instanceof Error ? err.message : String(err)}`
      logger.warn({ sessionId: summary.sessionId, err }, msg)
      errors.push(msg)
    }
  }

  // 5. Extract patterns across all summaries
  let patterns: ExtractedPatterns | null = null
  let memoryEntriesGenerated = 0

  try {
    patterns = extractPatterns(summaries)

    // 6. Convert to memory entries and append to daily log
    const memoryEntries = patternsToMemoryEntries(patterns)
    memoryEntriesGenerated = memoryEntries.length

    for (const entry of memoryEntries) {
      try {
        vault.appendDailyLog(`**[learning]** ${entry.name}\n\n${entry.content}`)
      } catch (err) {
        const msg = `Failed to write memory entry ${entry.name}: ${err instanceof Error ? err.message : String(err)}`
        logger.warn({ entryName: entry.name, err }, msg)
        errors.push(msg)
      }
    }
  } catch (err) {
    const msg = `Pattern extraction failed: ${err instanceof Error ? err.message : String(err)}`
    logger.error({ err }, msg)
    errors.push(msg)
  }

  // 7. Save learning state (only advance cursor if at least one digest succeeded)
  if (digestsStored > 0 && latestSessionTime !== null) {
    const newState = {
      lastProcessedAt: latestSessionTime,
      totalSessionsProcessed: state.totalSessionsProcessed + digestsStored,
      totalPatternsExtracted: state.totalPatternsExtracted + (patterns?.totalSessions ?? 0),
      latestPatternsJson: patterns !== null ? JSON.stringify(patterns) : state.latestPatternsJson,
    }
    saveLearningState(db, newState)
  }

  return {
    sessionsProcessed: summaries.length,
    digestsStored,
    patternsExtracted: patterns,
    memoryEntriesGenerated,
    errors,
  }
}
