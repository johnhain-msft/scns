import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import { parseManifest } from '../manifest/parser.js'
import { reconcileManifest } from '../manifest/reconcile.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface ApplyManifestInput {
  readonly manifest_yaml: string
}

export async function handleApplyManifest(
  db: Database.Database,
  eventLog: EventLog,
  input: ApplyManifestInput,
): Promise<ToolResult> {
  const parsed = parseManifest(input.manifest_yaml)

  if (!parsed.ok) {
    return errorResult(`Manifest validation failed:\n${parsed.errors.join('\n')}`)
  }

  try {
    const result = await reconcileManifest(db, eventLog, parsed.manifest)

    eventLog.manifestApplied(null, {
      team_id: result.team_id,
      team_name: result.team_name,
      created: result.created,
      roles_reconciled: result.roles.length,
      tasks_created: result.tasks.created,
    })

    return textResult(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return errorResult(`Failed to apply manifest: ${message}`)
  }
}
