/**
 * One-shot repair of the GATE ACCEPT labels that were manufactured before the transcript oracle existed.
 *
 * Three of the four live GATE rows were settled ACCEPT by the old rule ("any next >=12-char prompt in the
 * session"). On a corpus that is 58.1% machine-authored that rule was answered by a machine more often
 * than by John, so two of the three "answers" are a sub-agent brief and an "agent has finished" notice.
 *
 * This re-derives each label from the Copilot CLI transcript, which records only what the human typed:
 *
 *   originating turn K  = the turn whose text matches the GATE row's own query_text
 *   delivery turn    D  = the first human turn after K   <-- INFERRED; legacy rows predate
 *                                                            gate_delivered_ref, so we assume the
 *                                                            question was surfaced on the next human
 *                                                            briefing. Live rows record this exactly.
 *   answer              = the first human turn after D, or NOTHING
 *
 * Rows that no longer have a defensible answer are RESET to unsettled (human_outcome NULL) rather than
 * relabelled — an honest "we don't know" is the correct state for a label we cannot substantiate.
 *
 * Usage:  npx tsc && node --experimental-strip-types scripts/backfill-gate-answers.ts [--apply]
 *         (imports the BUILT modules so the backfill runs the exact same resolution logic as the broker)
 * Default is a DRY RUN. Always writes a timestamped backup of experience.db before applying.
 */

import { copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createSessionTranscript } from '../dist/memory/session-transcript.js'
import { normalizePrompt } from '../dist/memory/reask-detector.js'
import { openExperienceStore } from '../dist/memory/experience-store.js'

const APPLY = process.argv.includes('--apply')
const MIN_CHARS = 12
const expPath = process.env.SCNS_EXPERIENCE_DB ?? join(homedir(), '.scns', 'memory', 'experience.db')

const transcript = createSessionTranscript({ env: process.env })
if (transcript.mode !== 'oracle') {
  console.error(`REFUSING: transcript oracle unavailable — ${transcript.reason}`)
  process.exit(1)
}

if (APPLY) {
  const backup = `${expPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(expPath, backup)
  console.log(`backup: ${backup}\n`)
}

// Open through the real store so the additive label-validity columns (answer_source,
// gate_delivered_ref, gate_delivered_at) are migrated in exactly as the broker migrates them.
const store = openExperienceStore(expPath)
const db = store.db
const rows = db
  .prepare(
    `SELECT id, conversation_id, query_text, gate_delivered, human_outcome, elicited_intent
       FROM retrieval_experience WHERE gate_question IS NOT NULL ORDER BY id`,
  )
  .all() as Array<{
  id: number
  conversation_id: string | null
  query_text: string
  gate_delivered: number
  human_outcome: number | null
  elicited_intent: string | null
}>

const short = (s: string | null): string =>
  s == null ? '(null)' : JSON.stringify(s.replace(/\s+/g, ' ').slice(0, 62))

let changed = 0
for (const r of rows) {
  console.log(`\n── row ${r.id} ──────────────────────────────────────────────`)
  console.log(`  question prompt : ${short(r.query_text)}`)
  console.log(`  recorded outcome: ${r.human_outcome ?? '(null)'}  intent: ${short(r.elicited_intent)}`)

  if (!r.gate_delivered) {
    console.log('  → never delivered; nothing to re-derive. UNCHANGED.')
    continue
  }
  const turns = r.conversation_id ? transcript.humanTurns(r.conversation_id) : []
  if (turns.length === 0) {
    console.log('  → no transcript for this session. Cannot substantiate ⇒ RESET to unsettled.')
  }

  const originNorm = normalizePrompt(r.query_text)
  const k = turns.findIndex((t) => normalizePrompt(t.text) === originNorm)
  let answer: { turnIndex: number; text: string } | null = null
  let why = 'no matching originating turn in the transcript'

  if (k !== -1) {
    const delivery = turns[k + 1]
    if (!delivery) why = `originating turn ${turns[k]!.turnIndex}; nothing followed it`
    else {
      const cand = turns[k + 2]
      if (!cand) why = `delivered on turn ${delivery.turnIndex}; no human turn followed`
      else if (normalizePrompt(cand.text).length < MIN_CHARS)
        why = `turn ${cand.turnIndex} after delivery is too short (${short(cand.text)})`
      else if (normalizePrompt(cand.text) === originNorm)
        why = `turn ${cand.turnIndex} is a verbatim re-ask ⇒ waste, not an answer`
      else {
        answer = { turnIndex: cand.turnIndex, text: cand.text }
        why = `origin turn ${turns[k]!.turnIndex} → delivered turn ${delivery.turnIndex} → answer turn ${cand.turnIndex}`
      }
    }
  }
  console.log(`  derivation      : ${why}`)

  if (answer) {
    const same = normalizePrompt(answer.text) === normalizePrompt(r.elicited_intent ?? '')
    console.log(`  → ACCEPT stands. intent := ${short(answer.text)}${same ? '  (already correct)' : '  (REPLACED)'}`)
    if (APPLY) {
      db.prepare(
        `UPDATE retrieval_experience
            SET human_outcome = 1.0, elicited_intent = ?, answer_source = ?
          WHERE id = ?`,
      ).run(answer.text, `transcript-oracle:turn-${answer.turnIndex}:backfill`, r.id)
    }
    if (!same) changed++
  } else {
    console.log('  → NO substantiated answer. human_outcome := NULL, elicited_intent := NULL')
    if (APPLY) {
      db.prepare(
        `UPDATE retrieval_experience
            SET human_outcome = NULL, elicited_intent = NULL, answer_source = ?
          WHERE id = ?`,
      ).run('unsubstantiated:cleared-by-backfill', r.id)
    }
    if (r.human_outcome != null || r.elicited_intent != null) changed++
  }
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} — ${changed} of ${rows.length} GATE rows would change.`)
if (!APPLY) console.log('Re-run with --apply to write.')
store.close()
transcript.close()
