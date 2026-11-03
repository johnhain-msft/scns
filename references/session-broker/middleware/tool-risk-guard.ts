/**
 * Tool risk guard middleware.
 *
 * Wraps MCP tool invocations with risk-level logging and optional
 * role-based access control for high-risk tools.
 */

import type pino from 'pino'
import type Database from 'better-sqlite3'
import type { ToolRiskLevelType } from '../types.js'
import { getToolRisk, checkToolAccess } from '../tool-risk.js'
import { findTeamMemberInfoBySession } from '../storage/repositories/team-repository.js'

// ── Types ─────────────────────────────────────────────────────────────────

export interface ToolRiskGuardOptions {
  readonly logger: pino.Logger
  readonly db: Database.Database
}

export interface ToolRiskCheckResult {
  readonly allowed: boolean
  readonly riskLevel: ToolRiskLevelType
  readonly reason?: string
}

export interface ToolRiskGuard {
  check(toolName: string, sessionId?: string): ToolRiskCheckResult
  logToolInvocation(toolName: string, sessionId?: string): void
}

// ── Implementation ────────────────────────────────────────────────────────

/**
 * Creates a tool risk guard that checks access and logs invocations.
 *
 * - High-risk tools: logged at warn, role-checked when sessionId present.
 * - Medium-risk tools: logged at info.
 * - Low-risk tools: no logging overhead.
 * - When role cannot be determined, the operation is allowed (backward compat).
 */
export function createToolRiskGuard(options: ToolRiskGuardOptions): ToolRiskGuard {
  const { logger, db } = options

  function resolveCallerRole(sessionId?: string): string | undefined {
    if (!sessionId) return undefined
    try {
      const member = findTeamMemberInfoBySession(db, sessionId)
      return member?.role
    } catch (error) {
      logger.warn({ sessionId, error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to resolve caller role — allowing tool invocation')
      return undefined
    }
  }

  function check(toolName: string, sessionId?: string): ToolRiskCheckResult {
    const riskLevel = getToolRisk(toolName)

    if (riskLevel !== 'high') {
      return { allowed: true, riskLevel }
    }

    const callerRole = resolveCallerRole(sessionId)
    const accessResult = checkToolAccess(toolName, callerRole)

    return {
      allowed: accessResult.allowed,
      riskLevel,
      reason: accessResult.reason,
    }
  }

  function logToolInvocation(toolName: string, sessionId?: string): void {
    const riskLevel = getToolRisk(toolName)

    if (riskLevel === 'high') {
      logger.warn(
        { tool: toolName, riskLevel, sessionId },
        'High-risk tool invoked',
      )
      return
    }

    if (riskLevel === 'medium') {
      logger.info(
        { tool: toolName, riskLevel, sessionId },
        'Medium-risk tool invoked',
      )
      return
    }

    // Low-risk: no logging overhead
  }

  return { check, logToolInvocation }
}
