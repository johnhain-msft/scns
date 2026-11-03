#!/usr/bin/env node
/**
 * Phase 13.8 — Live L2 broker forcing script (ESM, imports from built dist/).
 *
 * Drives a PASS loop and a FAIL loop through the Phase 13.5 Quality Gate
 * Arbiter against an isolated tmp git repo, persisting quality_checks rows +
 * events into the same SQLite DB file the live broker uses. A subsequent
 * broker restart serves these artifacts via /api/events/since/0 and
 * /api/orchestrator/overview.
 *
 * Requires env: BROKER_DB_PATH, SCNS_DATA_DIR.
 */

import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distRoot = join(__dirname, '..', 'dist')

const { openDatabase, closeDatabase } = await import(
  `file://${join(distRoot, 'broker/storage/db.js')}`
)
const { createEventLog } = await import(
  `file://${join(distRoot, 'broker/services/event-log.js')}`
)
const { createEventDispatcher } = await import(
  `file://${join(distRoot, 'broker/event-dispatcher.js')}`
)
const { createQualityGateArbiter } = await import(
  `file://${join(distRoot, 'broker/services/quality-gate-arbiter.js')}`
)
const { createSuggestionStore } = await import(
  `file://${join(distRoot, 'suggest/suggestion-store.js')}`
)
const { createVault } = await import(`file://${join(distRoot, 'memory/vault.js')}`)
const { createNegativeMemoryStore } = await import(
  `file://${join(distRoot, 'memory/negative-memory-store.js')}`
)

const DB_PATH = process.env.BROKER_DB_PATH
const SCNS_DIR = process.env.SCNS_DATA_DIR
if (!DB_PATH || !SCNS_DIR) {
  console.error('BROKER_DB_PATH and SCNS_DATA_DIR must be set')
  process.exit(1)
}

const suggestionsDir = join(SCNS_DIR, 'suggestions')
const vaultDir = join(SCNS_DIR, 'memory')

function mkSuggestion(title) {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    type: 'skill',
    title,
    description: `Live-verify suggestion: ${title}`,
    status: 'pending',
    confidence: 0.92,
    evidence: [{ source: 'live-verify', detail: title, observedAt: now, weight: 0.5 }],
    tags: ['phase-13-8', 'live-verify'],
    createdAt: now,
    updatedAt: now,
    actionable: true,
    estimatedComplexity: 'solo',
  }
}

function makeNewFileDiff(filename, body) {
  const lines = body.split('\n')
  return [
    `diff --git a/${filename} b/${filename}`,
    `new file mode 100644`,
    `index 0000000..1111111`,
    `--- /dev/null`,
    `+++ b/${filename}`,
    `@@ -0,0 +1,${lines.length} @@`,
    lines.map((l) => '+' + l).join('\n'),
    '',
  ].join('\n')
}

function initProjectRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'scns-live-verify-'))
  execSync('git init --quiet -b main', { cwd: dir })
  execSync('git config user.email "scns-live@localhost"', { cwd: dir })
  execSync('git config user.name "scns-live"', { cwd: dir })
  execSync('git commit --quiet --allow-empty -m "initial"', { cwd: dir })
  return dir
}

const projectRoot = initProjectRoot()
const db = openDatabase(DB_PATH)
const dispatcher = createEventDispatcher()
const eventLog = createEventLog(db, dispatcher)
const suggestionStore = createSuggestionStore({ rootDir: suggestionsDir })
const vault = createVault({ rootDir: vaultDir })
const negMem = createNegativeMemoryStore(vault)

const arbiter = createQualityGateArbiter({
  db,
  eventLog,
  dispatcher,
  projectRoot,
  suggestionStore: {
    get: (id) => suggestionStore.get(id),
    updateStatus: (id, status, reason) => suggestionStore.updateStatus(id, status, reason),
  },
  negativeMemoryStore: negMem,
  skipCommands: true,
  worktreeBase: tmpdir(),
})

function waitForVerdict(teamId) {
  return new Promise((resolve) => {
    const unsub = dispatcher.subscribe({ event_types: ['quality_gate_verdict'] }, (evt) => {
      try {
        const p = JSON.parse(evt.payload)
        if (p.team_id === teamId) {
          unsub()
          resolve(p)
        }
      } catch {
        /* ignore */
      }
    })
  })
}

// ── PASS ────────────────────────────────────────────────────────────
const sugPass = mkSuggestion('live-verify-pass')
suggestionStore.save(sugPass)
const teamPass = `team-task-sugg-${sugPass.id}`
const passPromise = waitForVerdict(teamPass)
eventLog.teamCompleted(null, {
  teamId: teamPass,
  memberSessionIds: [`pass-a-${sugPass.id}`, `pass-b-${sugPass.id}`],
  stagedDiff: makeNewFileDiff(
    `phase-13-8-pass-${sugPass.id.slice(0, 8)}.txt`,
    `Phase 13.8 live PASS artifact for ${sugPass.id}.`,
  ),
  artifacts: [],
  logs: [],
  aggregateOutcome: 'success',
  completedAt: new Date().toISOString(),
})
const passVerdict = await passPromise

// ── FAIL ────────────────────────────────────────────────────────────
const sugFail = mkSuggestion('live-verify-fail')
suggestionStore.save(sugFail)
const teamFail = `team-task-sugg-${sugFail.id}`
const failPromise = waitForVerdict(teamFail)
eventLog.teamCompleted(null, {
  teamId: teamFail,
  memberSessionIds: [`fail-a-${sugFail.id}`],
  stagedDiff: '',
  artifacts: [],
  logs: [],
  aggregateOutcome: 'failed',
  completedAt: new Date().toISOString(),
})
const failVerdict = await failPromise

// ── Summary ─────────────────────────────────────────────────────────
const passRow = db
  .prepare('SELECT id, passed, task_type FROM quality_checks WHERE id = ?')
  .get(passVerdict.qualityCheckId)
const failRow = db
  .prepare('SELECT id, passed, task_type FROM quality_checks WHERE id = ?')
  .get(failVerdict.qualityCheckId)
const branches = execSync('git branch --list "scns/auto/*"', {
  cwd: projectRoot,
  encoding: 'utf8',
})
const afterPass = suggestionStore.get(sugPass.id)
const afterFail = suggestionStore.get(sugFail.id)
const negFiles = existsSync(join(vaultDir, 'negative'))
  ? readdirSync(join(vaultDir, 'negative')).filter((f) => f.endsWith('.md'))
  : []

console.log(
  JSON.stringify(
    {
      projectRoot,
      passTeamId: teamPass,
      passVerdict,
      passQualityCheck: passRow,
      passSuggestion: afterPass && {
        id: afterPass.id,
        status: afterPass.status,
        reviewReason: afterPass.reviewReason,
      },
      failTeamId: teamFail,
      failVerdict,
      failQualityCheck: failRow,
      failSuggestion: afterFail && {
        id: afterFail.id,
        status: afterFail.status,
        reviewReason: afterFail.reviewReason,
      },
      autoBranches: branches
        .split('\n')
        .map((l) => l.replace(/^\*?\s*/, '').trim())
        .filter(Boolean),
      negativeMemoryFiles: negFiles.length,
    },
    null,
    2,
  ),
)

arbiter.stop()
closeDatabase(db)
rmSync(projectRoot, { recursive: true, force: true })
