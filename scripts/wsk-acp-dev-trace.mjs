#!/usr/bin/env node
/**
 * WS K (Phase 13.13.x) — ACP dev-spawn diagnostic harness.
 *
 * Spawns a single scns-dev agent against a tiny synthetic task via the
 * production /api/tasks/:id/spawn path (the same path manager auto-dispatch
 * uses), subscribes to the broker SSE event stream, and writes every event
 * + spawn metadata to /tmp/wsk-acp-trace-<timestamp>.log so we can finally
 * SEE which stage of dev-spawn is silently failing.
 *
 * Exits when ANY of:
 *   - agent_first_output_received fires for our session  (success)
 *   - agent_launch_failed fires for our session          (failure)
 *   - 90s wall clock elapses                             (timeout)
 *
 * Diagnostic infra only — NOT production code.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const BROKER = 'http://127.0.0.1:3456'
const TIMEOUT_MS = 90_000
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
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function main() {
  log(`WS K dev-trace harness starting; log=${LOG}`)
  log(`broker=${BROKER} timeout_ms=${TIMEOUT_MS}`)

  // 1. Probe broker health.
  const health = await httpJson('GET', '/health')
  log(`health: status=${health.status} body=${JSON.stringify(health.body)}`)
  if (health.status !== 200) {
    log('ABORT: broker not healthy')
    process.exit(2)
  }

  // 2. Create a throwaway team.
  const teamRes = await httpJson('POST', '/api/teams', {
    name: `wsk-trace-${ts}`.slice(0, 60),
  })
  log(`team_create: status=${teamRes.status} body=${JSON.stringify(teamRes.body)}`)
  if (teamRes.status >= 300) {
    log('ABORT: team create failed')
    process.exit(2)
  }
  const teamId = teamRes.body?.id
  if (!teamId) {
    log('ABORT: no team id returned')
    process.exit(2)
  }

  // 3. Create a tiny synthetic task (the dev should not ACTUALLY do work;
  // we want the spawn pipeline to start). Working dir is a tmp scratch
  // repo so the dev session has somewhere safe to land.
  const scratch = fs.mkdtempSync(path.join('/tmp', 'wsk-scratch-'))
  fs.writeFileSync(path.join(scratch, 'README.md'), '# WS K trace scratch\n')
  log(`scratch_dir=${scratch}`)

  const taskRes = await httpJson('POST', '/api/tasks', {
    team_id: teamId,
    subject: 'WS K trace: print hello',
    description:
      'WS K diagnostic harness task. Just print "hello from dev" and exit. Do NOT modify any files.',
  })
  log(`task_create: status=${taskRes.status} body=${JSON.stringify(taskRes.body)}`)
  if (taskRes.status >= 300) {
    log('ABORT: task create failed')
    process.exit(2)
  }
  const taskId = taskRes.body?.id ?? taskRes.body?.task?.id
  if (!taskId) {
    log(`ABORT: could not extract task id from ${JSON.stringify(taskRes.body)}`)
    process.exit(2)
  }

  // 4. Open SSE BEFORE spawning so we don't miss agent_launch_started.
  let ourSession = null
  let exitReason = null
  const eventReq = http.request(`${BROKER}/api/events/live`, { method: 'GET' })
  let buf = ''
  let resolveSse
  const ssePromise = new Promise((res) => {
    resolveSse = res
  })
  eventReq.on('response', (r) => {
    log(`sse_connected: status=${r.statusCode}`)
    r.setEncoding('utf8')
    r.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue
          const json = line.slice(6)
          let evt
          try {
            evt = JSON.parse(json)
          } catch {
            continue
          }
          handleEvent(evt)
        }
      }
    })
    r.on('end', () => {
      log('sse_stream_end')
      resolveSse('sse_end')
    })
    r.on('error', (err) => {
      log(`sse_error: ${err.message}`)
      resolveSse('sse_error')
    })
  })
  eventReq.on('error', (err) => {
    log(`sse_request_error: ${err.message}`)
    resolveSse('sse_request_error')
  })
  eventReq.end()
  await delay(250) // give SSE a moment to attach

  // 5. Spawn scns-dev against the task via the production path.
  const spawnRes = await httpJson('POST', `/api/tasks/${taskId}/spawn`, {
    role: 'scns-dev',
    launch_method: 'acp',
    working_dir: scratch,
  })
  log(`spawn: status=${spawnRes.status} body=${JSON.stringify(spawnRes.body)}`)
  if (spawnRes.status >= 300) {
    log('ABORT: spawn failed')
    eventReq.destroy()
    out.end()
    process.exit(2)
  }
  ourSession = spawnRes.body?.session_id
  log(`tracking session_id=${ourSession}`)

  function handleEvent(evt) {
    // Log every event but with extra emphasis on WS K events for our
    // session. Everything else helps reconstruct ordering / context.
    const ours = evt.session_id && evt.session_id === ourSession
    const tag = ours ? '*OURS*' : 'other'
    log(
      `event ${tag} id=${evt.id} type=${evt.type} sid=${evt.session_id ?? 'n/a'} payload=${JSON.stringify(evt.payload)}`,
    )
    if (!ours) return
    if (evt.type === 'agent_first_output_received') {
      exitReason = 'first_output'
      resolveSse('first_output')
    } else if (evt.type === 'agent_launch_failed') {
      exitReason = 'launch_failed'
      resolveSse('launch_failed')
    }
  }

  // 6. Race the SSE-based exit reason against the wall-clock timeout.
  const timeoutPromise = delay(TIMEOUT_MS).then(() => 'timeout')
  const reason = await Promise.race([ssePromise, timeoutPromise])
  if (!exitReason) exitReason = reason
  log(`EXIT reason=${exitReason}`)

  // 7. Snapshot session state before exiting so the diagnosis can reason
  // about whether the session even registered.
  try {
    const sessions = await httpJson('GET', '/api/list_sessions')
    log(`final_sessions: ${JSON.stringify(sessions.body?.sessions ?? sessions.body)}`)
  } catch (err) {
    log(`final_sessions_error: ${err.message}`)
  }

  eventReq.destroy()
  out.end(() => {
    console.log(`\nLOG: ${LOG}`)
    process.exit(exitReason === 'first_output' ? 0 : 1)
  })
}

main().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`)
  out.end(() => process.exit(3))
})
