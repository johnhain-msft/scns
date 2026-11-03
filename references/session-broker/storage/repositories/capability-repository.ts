import type Database from 'better-sqlite3'
import type { AgentCapability } from '../../types.js'

export function declareCapabilities(
  db: Database.Database,
  sessionId: string,
  capabilities: ReadonlyArray<string>,
): ReadonlyArray<AgentCapability> {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO agent_capabilities (session_id, capability)
     VALUES (?, ?)`
  )

  for (const capability of capabilities) {
    stmt.run(sessionId, capability)
  }

  return listCapabilities(db, sessionId)
}

export function listCapabilities(
  db: Database.Database,
  sessionId: string,
): ReadonlyArray<AgentCapability> {
  const rows = db.prepare(
    'SELECT * FROM agent_capabilities WHERE session_id = ? ORDER BY capability'
  ).all(sessionId) as AgentCapability[]
  return rows.map((row) => ({ ...row }))
}

interface CapableAgent {
  readonly session_id: string
  readonly capability: string
  readonly status: string
}

export function findCapableAgents(
  db: Database.Database,
  capability: string,
): ReadonlyArray<CapableAgent> {
  const rows = db.prepare(
    `SELECT ac.session_id, ac.capability, s.status
     FROM agent_capabilities ac
     JOIN sessions s ON ac.session_id = s.id
     WHERE ac.capability = ? AND s.status = 'active'
     ORDER BY ac.session_id`
  ).all(capability) as CapableAgent[]
  return rows.map((row) => ({ ...row }))
}

interface AgentWithCapabilities {
  readonly session_id: string
  readonly capabilities: ReadonlyArray<string>
}

export function findAgentsWithAllCapabilities(
  db: Database.Database,
  capabilities: ReadonlyArray<string>,
): ReadonlyArray<AgentWithCapabilities> {
  if (capabilities.length === 0) return []

  const placeholders = capabilities.map(() => '?').join(', ')
  const rows = db.prepare(
    `SELECT ac.session_id, GROUP_CONCAT(ac.capability) as caps
     FROM agent_capabilities ac
     JOIN sessions s ON ac.session_id = s.id
     WHERE ac.capability IN (${placeholders}) AND s.status = 'active'
     GROUP BY ac.session_id
     HAVING COUNT(DISTINCT ac.capability) = ?
     ORDER BY ac.session_id`
  ).all(...capabilities, capabilities.length) as Array<{ session_id: string; caps: string }>

  return rows.map((row) => ({
    session_id: row.session_id,
    capabilities: row.caps.split(',').sort(),
  }))
}

export function removeCapabilities(
  db: Database.Database,
  sessionId: string,
): number {
  const result = db.prepare(
    'DELETE FROM agent_capabilities WHERE session_id = ?'
  ).run(sessionId)
  return result.changes
}

export function removeCapability(
  db: Database.Database,
  sessionId: string,
  capability: string,
): boolean {
  const result = db.prepare(
    'DELETE FROM agent_capabilities WHERE session_id = ? AND capability = ?'
  ).run(sessionId, capability)
  return result.changes > 0
}

export function countCapabilities(
  db: Database.Database,
  sessionId: string,
): number {
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM agent_capabilities WHERE session_id = ?'
  ).get(sessionId) as { count: number }
  return row.count
}
