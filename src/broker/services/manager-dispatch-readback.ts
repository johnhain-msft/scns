/**
 * Phase 13.13.x — Pure parser for the manager's "Dispatch Readback" block.
 *
 * The scns-manager prompt instructs managers to emit a final broadcast on
 * POST /api/messages whose body contains a structured block of the form:
 *
 *     Dispatch Readback:
 *       dev_session_id: <id-or-409:current_owner>
 *       qa_session_id: <id-or-409:current_owner>
 *       notes: <one-line summary>
 *
 * This module extracts those fields. It is intentionally pure: WS C wires
 * it into the broker's manager-exit monitor; this file has no I/O.
 */

export interface ManagerReadback {
  readonly devSessionId: string
  readonly qaSessionId: string
  readonly notes: string
}

const HEADER_RE = /Dispatch Readback:\s*\n([\s\S]*)/i
const DEV_RE = /^[ \t]*dev_session_id[ \t]*:[ \t]*(.*?)[ \t]*$/im
const QA_RE = /^[ \t]*qa_session_id[ \t]*:[ \t]*(.*?)[ \t]*$/im
const NOTES_RE = /^[ \t]*notes[ \t]*:[ \t]*(.*?)[ \t]*$/im

export function parseManagerReadback(broadcastBody: string): ManagerReadback {
  if (typeof broadcastBody !== 'string' || broadcastBody.length === 0) {
    throw new Error('parseManagerReadback: empty broadcast body — Dispatch Readback block missing')
  }
  const headerMatch = broadcastBody.match(HEADER_RE)
  if (!headerMatch) {
    throw new Error(
      'parseManagerReadback: Dispatch Readback block not found in broadcast body',
    )
  }
  const block = headerMatch[1] ?? ''

  const devRaw = block.match(DEV_RE)?.[1] ?? ''
  const qaRaw = block.match(QA_RE)?.[1] ?? ''
  const notesRaw = block.match(NOTES_RE)?.[1] ?? ''

  const devSessionId = devRaw.trim()
  const qaSessionId = qaRaw.trim()
  const notes = notesRaw.trim()

  if (devSessionId.length === 0) {
    throw new Error(
      'parseManagerReadback: dev_session_id missing or empty in Dispatch Readback block',
    )
  }
  if (qaSessionId.length === 0) {
    throw new Error(
      'parseManagerReadback: qa_session_id missing or empty in Dispatch Readback block',
    )
  }

  return { devSessionId, qaSessionId, notes }
}
