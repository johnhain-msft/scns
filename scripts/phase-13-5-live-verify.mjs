// Phase 13.5 live verification — drives the real arbiter against the real repo.
// Runs both PASS and FAIL paths. Emits evidence to stdout.
//
// Paths derive from this script's own location (scripts/ -> repo root), so the
// harness runs from any clone. Override the repo under test with SCNS_PROJECT_ROOT.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distUrl = (rel) => pathToFileURL(join(repoRoot, 'dist', rel)).href

const { createEventDispatcher } = await import(distUrl('broker/event-dispatcher.js'))
const { createEventLog } = await import(distUrl('broker/services/event-log.js'))
const { createQualityGateArbiter } = await import(
  distUrl('broker/services/quality-gate-arbiter.js')
)

const projectRoot = process.env.SCNS_PROJECT_ROOT ?? repoRoot
const dbPath = '/tmp/scns-qg-verify/broker.db' // fresh broker DB
const db = new Database(dbPath)

// Apply full broker schema so createQualityCheck works.
const schema = readFileSync(join(repoRoot, 'dist', 'broker', 'storage', 'schema.sql'), 'utf8')
db.exec(schema)

const dispatcher = createEventDispatcher()
const eventLog = createEventLog(db, dispatcher)

// Fake suggestion + neg-memory adapters (real executor not needed — arbiter only
// calls it when suggestion lookup returns a row, and we pass no suggestionId).
const suggestionUpdates = []
const suggestionStore = {
  get: () => null,
  updateStatus: (id, status, reason) => {
    suggestionUpdates.push({ id, status, reason })
    return null
  },
}
const negMems = []
const negativeMemoryStore = {
  storeFromHeuristic: (x) => {
    negMems.push(x)
    return { id: 'neg-' + negMems.length, ...x }
  },
  // other methods unused here
}

const arbiter = createQualityGateArbiter({
  db,
  eventLog,
  dispatcher,
  projectRoot,
  suggestionStore,
  negativeMemoryStore,
  maxOutputBytes: 8192,
  // Skip the expensive real npm test/lint — we're testing the ARBITER flow end-to-end
  // (worktree create, diff apply, commit, branch persist, FAIL cleanup, negative memory).
  // A separate unit test ("real git round-trip") exercises skipCommands=true; the unit
  // tests with mocked runCommand cover the test-fail / lint-fail / rubric-fail branches.
  // Here we run with a fake runCommand that lets us flip PASS and FAIL deterministically.
  runCommand: (cmd, cwd, opts) => {
    // For git/etc pass through to REAL execSync. Only stub npm test/lint.
    if (!cmd.startsWith('npm test') && !cmd.startsWith('npm run lint')) {
      try {
        const out = execSync(cmd, {
          cwd,
          encoding: 'utf8',
          timeout: opts?.timeoutMs ?? 180_000,
          maxBuffer: 8 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, CI: '1' },
        })
        return { ok: true, stdout: String(out ?? ''), stderr: '' }
      } catch (err) {
        return {
          ok: false,
          stdout: err.stdout ? String(err.stdout) : '',
          stderr: err.stderr ? String(err.stderr) : '',
          code: typeof err.status === 'number' ? err.status : 1,
        }
      }
    }
    const isPass = process.env.QG_VERIFY_MODE === 'pass'
    if (isPass) return { ok: true, stdout: 'all good\n', stderr: '' }
    if (cmd.includes('npm test')) {
      return {
        ok: false,
        code: 1,
        stdout: '',
        stderr: 'Error: 2 tests failed\nassertion failed\n',
      }
    }
    return { ok: true, stdout: '', stderr: '' }
  },
})

// Build a tiny realistic diff: touch a new file that doesn't exist yet, so
// `git apply --index` works cleanly in the worktree.
const passDiff = `diff --git a/docs/phase-13-5-live-verify.md b/docs/phase-13-5-live-verify.md
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/docs/phase-13-5-live-verify.md
@@ -0,0 +1,3 @@
+# Phase 13.5 live verify marker
+
+Inserted by live-verify.mjs PASS path.
`

const failDiff = `diff --git a/docs/phase-13-5-fail.md b/docs/phase-13-5-fail.md
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/docs/phase-13-5-fail.md
@@ -0,0 +1 @@
+FAIL marker
`

function mk(teamId, stagedDiff) {
  return {
    teamId,
    memberSessionIds: ['dev-1'],
    stagedDiff,
    artifacts: [{ path: 'docs/phase-13-5.md', size: stagedDiff.length }],
    logs: [{ sessionId: 'dev-1', last: 'done' }],
    aggregateOutcome: 'success',
  }
}

// Delete any leftover branches from previous runs
try {
  execSync('git branch | grep scns/auto/ | xargs -I{} git branch -D {}', {
    cwd: projectRoot,
    stdio: 'pipe',
    shell: '/bin/bash',
  })
} catch {}

async function main() {
  console.log('\n═══ PASS PATH ═══')
  process.env.QG_VERIFY_MODE = 'pass'
  const passVerdict = await arbiter.handleTeamCompletion(mk('team-task-sugg-livepass001', passDiff))
  console.log('verdict:', JSON.stringify(passVerdict, null, 2))

  console.log('\n── git branches after PASS ──')
  const branches = execSync('git branch --list "scns/auto/*"', {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  console.log(branches || '(none)')

  console.log('\n── commit on PASS branch ──')
  const passBranch = branches.trim().replace(/^\*?\s*/, '')
  if (passBranch) {
    console.log(
      execSync(`git log --oneline -1 ${passBranch}`, { cwd: projectRoot, encoding: 'utf8' }),
    )
    console.log(
      execSync(`git log -1 --format='%B' ${passBranch}`, {
        cwd: projectRoot,
        encoding: 'utf8',
      }),
    )
  }

  console.log('\n── quality_checks rows ──')
  const rows = db.prepare('SELECT id, task_type, passed, score FROM quality_checks').all()
  console.log(rows)

  console.log('\n── events emitted ──')
  const evs = db
    .prepare("SELECT event_type, session_id FROM events WHERE event_type LIKE 'quality_gate%'")
    .all()
  console.log(evs)

  console.log('\n── suggestion updates (PASS) ──')
  console.log(suggestionUpdates)

  console.log('\n═══ FAIL PATH ═══')
  process.env.QG_VERIFY_MODE = 'fail'
  suggestionUpdates.length = 0
  const failVerdict = await arbiter.handleTeamCompletion(mk('team-task-sugg-livefail001', failDiff))
  console.log('verdict:', JSON.stringify(failVerdict, null, 2))

  console.log('\n── git branches after FAIL (should NOT include the fail branch) ──')
  console.log(
    execSync('git branch --list "scns/auto/*"', { cwd: projectRoot, encoding: 'utf8' }) || '(none)',
  )

  console.log('\n── working tree clean? ──')
  console.log(execSync('git status --short', { cwd: projectRoot, encoding: 'utf8' }) || '(clean)')

  console.log('\n── negative memories recorded ──')
  console.log(JSON.stringify(negMems, null, 2))

  console.log('\n── suggestion updates (FAIL) ──')
  console.log(suggestionUpdates)

  console.log('\n── all quality_checks rows ──')
  console.log(db.prepare('SELECT id, task_type, passed, score FROM quality_checks').all())

  console.log('\n── all quality_gate events ──')
  console.log(
    db
      .prepare(
        "SELECT event_type, session_id, substr(payload,1,240) as payload FROM events WHERE event_type LIKE 'quality_gate%' ORDER BY id",
      )
      .all(),
  )

  console.log('\nDONE')
  process.exit(0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
