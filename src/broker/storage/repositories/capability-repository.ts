import type Database from 'better-sqlite3'

export interface AgentCapability {
  readonly session_id: string
  readonly capability: string
  readonly created_at: string
}

export interface CapabilitySummary {
  readonly capability: string
  readonly session_count: number
}

export function registerCapability(
  db: Database.Database,
  sessionId: string,
  capability: string,
): void {
  db.prepare('INSERT OR IGNORE INTO agent_capabilities (session_id, capability) VALUES (?, ?)').run(
    sessionId,
    capability,
  )
}

export function registerCapabilities(
  db: Database.Database,
  sessionId: string,
  capabilities: ReadonlyArray<string>,
): void {
  if (capabilities.length === 0) return

  const insert = db.prepare(
    'INSERT OR IGNORE INTO agent_capabilities (session_id, capability) VALUES (?, ?)',
  )

  const runAll = db.transaction(() => {
    for (const capability of capabilities) {
      insert.run(sessionId, capability)
    }
  })

  runAll()
}

export function unregisterCapability(
  db: Database.Database,
  sessionId: string,
  capability: string,
): boolean {
  const result = db
    .prepare('DELETE FROM agent_capabilities WHERE session_id = ? AND capability = ?')
    .run(sessionId, capability)
  return result.changes > 0
}

export function clearSessionCapabilities(db: Database.Database, sessionId: string): number {
  const result = db.prepare('DELETE FROM agent_capabilities WHERE session_id = ?').run(sessionId)
  return result.changes
}

export function findSessionsByCapability(
  db: Database.Database,
  capability: string,
): ReadonlyArray<AgentCapability> {
  const rows = db
    .prepare('SELECT * FROM agent_capabilities WHERE capability = ? ORDER BY created_at')
    .all(capability) as AgentCapability[]

  return rows.map((row) => ({ ...row }))
}

export function findCapabilitiesBySession(
  db: Database.Database,
  sessionId: string,
): ReadonlyArray<string> {
  const rows = db
    .prepare('SELECT capability FROM agent_capabilities WHERE session_id = ? ORDER BY capability')
    .all(sessionId) as Array<{ capability: string }>

  return rows.map((row) => row.capability)
}

export function findAllCapabilities(db: Database.Database): ReadonlyArray<CapabilitySummary> {
  const rows = db
    .prepare(
      `SELECT capability, COUNT(DISTINCT session_id) AS session_count
       FROM agent_capabilities
       GROUP BY capability
       ORDER BY capability`,
    )
    .all() as Array<{ capability: string; session_count: number }>

  return rows.map((row) => ({ ...row }))
}
