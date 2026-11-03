import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import { findSessionById } from '../storage/repositories/session-repository.js'
import {
  declareCapabilities,
  listCapabilities,
  findCapableAgents,
  findAgentsWithAllCapabilities,
} from '../storage/repositories/capability-repository.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface DeclareCapabilitiesInput {
  readonly session_id: string
  readonly capabilities: ReadonlyArray<string>
}

export function handleDeclareCapabilities(
  db: Database.Database,
  eventLog: EventLog,
  input: DeclareCapabilitiesInput,
): ToolResult {
  const session = findSessionById(db, input.session_id)
  if (!session) {
    return errorResult(`Session '${input.session_id}' not found`)
  }

  if (input.capabilities.length === 0) {
    return errorResult('capabilities array must not be empty')
  }

  const capabilities = declareCapabilities(db, input.session_id, input.capabilities)
  eventLog.capabilitiesDeclared(input.session_id, {
    capabilities: input.capabilities,
    total: capabilities.length,
  })

  return textResult({
    session_id: input.session_id,
    capabilities: capabilities.map((c) => c.capability),
  })
}

interface ListCapabilitiesInput {
  readonly session_id: string
}

export function handleListCapabilities(
  db: Database.Database,
  input: ListCapabilitiesInput,
): ToolResult {
  const capabilities = listCapabilities(db, input.session_id)
  return textResult(capabilities.map((c) => c.capability))
}

interface FindCapableAgentsInput {
  readonly capability?: string
  readonly capabilities?: ReadonlyArray<string>
}

export function handleFindCapableAgents(
  db: Database.Database,
  input: FindCapableAgentsInput,
): ToolResult {
  if (input.capabilities && input.capabilities.length > 0) {
    const agents = findAgentsWithAllCapabilities(db, input.capabilities)
    return textResult({
      required: input.capabilities,
      agents,
    })
  }

  if (input.capability) {
    const agents = findCapableAgents(db, input.capability)
    return textResult({
      capability: input.capability,
      agents,
    })
  }

  return errorResult('Provide either capability or capabilities parameter')
}
