#!/usr/bin/env node
/**
 * WS L (Phase 13.13.x) — agentic-loop live verification harness.
 *
 * Polling variant: avoids long-lived SSE because the broker's main thread
 * is periodically blocked by OTel embedding inference (pre-existing hang
 * memory note 2026-05-04 dogfood), which kills SSE under load. Instead we
 * poll /api/events?after_id=N every few seconds to observe WS K + WS L
 * events for our scns-dev session.
 *
 * Diagnostic infra only — NOT production code.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const BROKER = 'http://127.0.0.1:3456'
const WALL_MS = Number(process.env.WSL_WALL_MS ?? 360_000) // 6 min default
const POLL_MS = 8_000
const REQ_TIMEOUT_MS = 60_000
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const LOG = `/tmp/wsk-acp-trace-${ts}.log`
const out = fs.createWriteStream(LOG, { flags: 'a' })
const log = (line) => {
  const stamped = `[${new Date().toISOString()}] ${line}`
  out.write(stamped + '\n')
  console.log(stamped)
}

async function httpJson(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null
    const req = http.request(
      `${BROKER}${p}`,
      {
        method,
        timeout: REQ_TIMEOUT_MS,
        headers: {
          'content-type': 'application/json',
          ...(data ? { 'content-length': data.length } : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            parsed = text
          }
          resolve({ status: res.statusCode, body: parsed })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error(`request timeout ${REQ_TIMEOUT_MS}ms ${method} ${p}`))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function checkStaged(cwd) {
  try {
    execSync('git diff --cached --quiet', { cwd, stdio: 'ignore' })
    return false
  } catch (err) {
    if (err.status === 1) return true
    return false
  }
}

async function main() {
  log(`WS L agentic-loop verification harness (polling); log=${LOG}`)
  log(`broker=${BROKER} wall_ms=${WALL_MS} poll_ms=${POLL_MS}`)

  const health = await httpJson('GET', '/health')
  log(`health: status=${health.status} uptime=${health.body?.uptime_seconds}s mem=${health.body?.memory_mb}MB`)
  if (health.status !== 200) process.exit(2)

  const teamRes = await httpJson('POST', '/api/teams', { name: `wsl-trace-${ts}`.slice(0, 60) })
  const teamId = teamRes.body?.id
  log(`team_create: status=${teamRes.status} id=${teamId}`)
  if (!teamId) process.exit(2)

  const scratch = fs.mkdtempSync(path.join('/tmp', 'wsl-scratch-'))
  fs.writeFileSync(path.join(scratch, 'README.md'), '# WS L scratch\n')
  fs.writeFileSync(path.join(scratch, 'hello.txt'), 'hello world\n')
  execSync(
    'git init -q && git config user.email a@b && git config user.name t && git add -A && git commit -q -m init',
    { cwd: scratch },
  )
  log(`scratch_dir=${scratch} (git initialized)`)

  const taskRes = await httpJson('POST', '/api/tasks', {
    team_id: teamId,
    subject: 'WS L trace: append a goodbye line',
    description:
      'Append a single line "goodbye world" to ./hello.txt in this working directory. Then run `git add -A`. That is the entire task. Do NOT run tests or commit.',
  })
  const taskId = taskRes.body?.id ?? taskRes.body?.task?.id
  log(`task_create: status=${taskRes.status} id=${taskId}`)
  if (!taskId) process.exit(2)

  // Capture baseline event id so we only see new events for this trace.
  const baselineEvents = await httpJson('GET', '/api/events?limit=1')
  const baselineId =
    Array.isArray(baselineEvents.body?.events) && baselineEvents.body.events.length > 0
      ? baselineEvents.body.events[0].id
      : 0
  log(`baseline_event_id=${baselineId}`)

  const spawnRes = await httpJson('POST', `/api/tasks/${taskId}/spawn`, {
    role: 'scns-dev',
    launch_method: 'acp',
    working_dir: scratch,
  })
  const ourSession = spawnRes.body?.session_id
  log(`spawn: status=${spawnRes.status} session=${ourSession} body=${JSON.stringify(spawnRes.body)}`)
  if (!ourSession) {
    log('ABORT: no session_id')
    out.end(() => process.exit(2))
    return
  }

  const startedAt = Date.now()
  let lastEventId = baselineId
  let staged = false
  let nudges = 0
  let firstOutputLatencyMs = null
  let launchFailed = false

  while (Date.now() - startedAt < WALL_MS) {
    await delay(POLL_MS)
    // Pull new events.
    try {
      const evRes = await httpJson('GET', `/api/events?after_id=${lastEventId}&limit=200`)
      const events = Array.isArray(evRes.body?.events) ? evRes.body.events : []
      for (const evt of events) {
        if (evt.id > lastEventId) lastEventId = evt.id
        if (evt.session_id !== ourSession) continue
        log(
          `event id=${evt.id} type=${evt.event_type ?? evt.type} payload=${JSON.stringify(evt.payload)}`,
        )
        const tp = evt.event_type ?? evt.type
        if (tp === 'agent_first_output_received' && firstOutputLatencyMs === null) {
          firstOutputLatencyMs = Date.now() - startedAt
        }
        if (tp === 'agent_nudge_sent') nudges += 1
        if (tp === 'agent_launch_failed') launchFailed = true
      }
    } catch (err) {
      log(`event_poll_error: ${err.message}`)
    }
    staged = checkStaged(scratch)
    log(
      `poll: elapsed=${Math.round((Date.now() - startedAt) / 1000)}s staged=${staged} nudges=${nudges} launch_failed=${launchFailed} first_output_ms=${firstOutputLatencyMs}`,
    )
    if (staged || launchFailed) break
  }

  let finalDiffStat = null
  try {
    finalDiffStat = execSync('git diff --cached --stat', { cwd: scratch, encoding: 'utf8' })
  } catch (err) {
    finalDiffStat = `error: ${err.message}`
  }
  log(`final_diff_stat:\n${finalDiffStat || '(empty)'}`)
  log(
    `FINAL_SUMMARY: staged=${staged} nudges_observed=${nudges} launch_failed=${launchFailed} first_output_latency_ms=${firstOutputLatencyMs} session=${ourSession} scratch=${scratch}`,
  )

  out.end(() => {
    console.log(`\nLOG: ${LOG}`)
    process.exit(staged ? 0 : nudges > 0 ? 0 : 1)
  })
}

main().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`)
  out.end(() => process.exit(3))
})
