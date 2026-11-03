#!/usr/bin/env node
/*
 * WI-6 — Real Copilot CLI E2E smoke: per-repo routing, memory isolation,
 * strict-mode refusal, context injection, and A2A messaging — driven through
 * REAL `copilot` sessions in tmux (send-keys / capture-pane), against a dev
 * broker stack (real HOME for Copilot auth, throwaway SCNS_HOME for data).
 *
 * Re-runnable. Never touches the live broker (:3456) or the live ~/.scns.
 * The ONLY shared mutable state is ~/.copilot/extensions/scns — backed up
 * first and restored in the finally block, even on failure or SIGINT.
 *
 * Usage:
 *   node scripts/e2e-copilot-smoke.mjs [--cli <path-to-cli.js>] [--keep]
 *
 * --cli   broker/CLI entry to test (default: <repo>/dist/cli.js). Point it at
 *         a worktree's dist to smoke a branch without touching the live dist.
 * --keep  keep the scratch dir + tmux sessions on failure (debugging).
 *
 * Exit code 0 = every step PASSed (evidence printed as it goes).
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const cliArgIdx = argv.indexOf('--cli')
const CLI = resolve(cliArgIdx >= 0 ? argv[cliArgIdx + 1] : join(REPO_ROOT, 'dist', 'cli.js'))
const KEEP = argv.includes('--keep')

const NONCE = 'kiwi' + randomBytes(4).toString('hex')
const MARKER = `aurora-borealis-${NONCE}`
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

// Scratch lives under $HOME so Copilot's trusted-folder config covers it.
const WORK = join(homedir(), `.scns-e2e-${NONCE}`)
const HOME_DEV = join(WORK, 'home')
const META_DB = join(HOME_DEV, '.scns', 'meta-broker.db')
const CHILDREN = join(WORK, 'children')
const EXT_DIR = join(homedir(), '.copilot', 'extensions', 'scns')
const EXT_BACKUP = join(WORK, 'extension-backup')

const results = []
const spawned = []
const tmuxSessions = new Set()
let evidenceLines = []

function log(line) {
  console.log(line)
  evidenceLines.push(line)
}

function pass(step, detail) {
  results.push({ step, ok: true, detail })
  log(`PASS  ${step} — ${detail}`)
}

function fail(step, detail) {
  results.push({ step, ok: false, detail })
  log(`FAIL  ${step} — ${detail}`)
}

function sh(file, args, opts = {}) {
  return execFileSync(file, args, { encoding: 'utf-8', ...opts })
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
    s.on('error', rej)
  })
}

async function httpJson(method, port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
    signal: AbortSignal.timeout(10000),
  })
  try {
    return { status: res.status, body: await res.json() }
  } catch {
    return { status: res.status, body: null }
  }
}

async function waitHealth(port, label, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const r = await httpJson('GET', port, '/health')
      if (r.status === 200) return
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error(`${label} on :${port} not healthy`)
    await sleep(1000)
  }
}

function spawnProc(label, args, env) {
  const logPath = join(WORK, `${label}.log`)
  const fd = openSync(logPath, 'a')
  const proc = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', fd, fd],
  })
  spawned.push({ label, proc })
  log(`  spawned ${label} (pid ${proc.pid}) → log ${logPath}`)
  return proc
}

// ── tmux helpers ──────────────────────────────────────────────────────────

function tmux(...args) {
  return sh('tmux', args)
}

async function startCopilotSession(name, cwd, extraEnv = {}) {
  tmuxSessions.add(name)
  const envPrefix = Object.entries(extraEnv)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  tmux('new-session', '-d', '-s', name, '-x', '220', '-y', '50', '-c', cwd)
  // Launch inside the pane so the session env is exactly the user's shell env
  // plus our overrides (strict-mode flag etc.).
  tmux('send-keys', '-t', name, `${envPrefix} copilot --allow-all-tools`.trim(), 'Enter')
  // Copilot 1.0.8x can open a session-restore picker at startup ("esc start
  // fresh") — anything typed then lands in its search box. Escape past it.
  await sleep(6000)
  for (let i = 0; i < 5; i++) {
    const text = capture(name)
    if (!/start fresh|restore|switch tabs/i.test(text)) break
    tmux('send-keys', '-t', name, 'Escape')
    await sleep(2000)
  }
}

function sendPrompt(name, prompt) {
  // send-keys -l keeps the prompt literal (no key-name interpretation).
  tmux('send-keys', '-t', name, '-l', prompt)
  tmux('send-keys', '-t', name, 'Enter')
}

function capture(name) {
  return sh('tmux', ['capture-pane', '-p', '-t', name, '-S', '-2000'])
}

async function waitForPane(name, patterns, timeoutMs = 150000, label = '') {
  const deadline = Date.now() + timeoutMs
  const list = Array.isArray(patterns) ? patterns : [patterns]
  for (;;) {
    const text = capture(name)
    for (const p of list) {
      const m = typeof p === 'string' ? (text.includes(p) ? p : null) : (text.match(p)?.[0] ?? null)
      if (m) return { matched: m, text }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timeout waiting for ${JSON.stringify(list.map(String))} in pane ${name}${label ? ` (${label})` : ''}\n--- last 40 pane lines ---\n${text.split('\n').slice(-40).join('\n')}`,
      )
    }
    await sleep(2000)
  }
}

function killSession(name) {
  try {
    tmux('kill-session', '-t', name)
  } catch {
    /* already gone */
  }
  tmuxSessions.delete(name)
}

// ── the journey ───────────────────────────────────────────────────────────

async function main() {
  log(`# WI-6 Copilot CLI E2E smoke — ${STAMP}`)
  log('')
  log(`cli under test: ${CLI}`)

  // 0. Preflight
  for (const bin of ['copilot', 'tmux', 'git']) {
    sh('sh', ['-c', `command -v ${bin}`])
  }
  if (!existsSync(CLI)) throw new Error(`CLI not found: ${CLI} — build first`)
  const copilotVersion = sh('copilot', ['--version']).trim().split('\n')[0]
  log(`copilot: ${copilotVersion}`)
  pass('preflight', `copilot + tmux + git present; CLI at ${CLI}`)

  // 1. Scratch env + repos
  mkdirSync(join(HOME_DEV, '.scns'), { recursive: true })
  mkdirSync(CHILDREN, { recursive: true })
  const repoA = join(WORK, 'repoA')
  const repoB = join(WORK, 'repoB')
  const repoC = join(WORK, 'repoC') // deliberately NOT registered (strict test)
  const repoG = join(WORK, 'repoG') // global broker's own project root
  for (const r of [repoA, repoB, repoC, repoG]) {
    mkdirSync(r, { recursive: true })
    sh('git', ['init', '-q'], { cwd: r })
  }

  // 2. Register A+B through the real CLI, pinning ports
  const [portG, portA, portB] = [await freePort(), await freePort(), await freePort()]
  sh(process.execPath, [CLI, 'meta-broker', 'register', repoA, '--port', String(portA), '--meta-db', META_DB])
  sh(process.execPath, [CLI, 'meta-broker', 'register', repoB, '--port', String(portB), '--meta-db', META_DB])
  pass('register', `repoA→:${portA}, repoB→:${portB} in dev registry`)

  // 3. Global broker + REAL supervisor (spawns the child brokers)
  spawnProc('global-broker', [CLI, 'start', '--port', String(portG), '--autonomy', '0'], {
    SCNS_HOME: HOME_DEV,
    BROKER_DB_PATH: join(HOME_DEV, 'broker.db'),
    BROKER_PROJECT_ROOT: repoG,
    BROKER_PORT: String(portG),
    OBSERVE_ACTIVE_APP_ENABLED: 'false',
    OBSERVE_SESSION_STORE_ENABLED: 'false',
  })
  spawnProc(
    'supervisor',
    [CLI, 'meta-broker', 'run', '--meta-db', META_DB, '--broker-entry', CLI, '--project-db-dir', CHILDREN],
    {
      SCNS_HOME: HOME_DEV,
      OBSERVE_ACTIVE_APP_ENABLED: 'false',
      OBSERVE_SESSION_STORE_ENABLED: 'false',
      // Children inherit this: the reindex handler's restart-protection
      // cooldown (default 20 min) would swallow the harness's explicit
      // run-now trigger in step 10.
      SCNS_MEMORY_REINDEX_COOLDOWN_SEC: '0',
    },
  )
  await waitHealth(portG, 'global broker')
  await waitHealth(portA, 'child A (supervisor-spawned)', 120000)
  await waitHealth(portB, 'child B (supervisor-spawned)', 120000)
  pass('brokers-up', `global :${portG}, child A :${portA}, child B :${portB} all healthy`)

  // 4. Routing ground truth via the global broker. A child is HTTP-healthy
  // before the supervisor's probe flips it registered→running, and
  // meta-resolve refuses to route to a not-running child — poll until the
  // supervisor bookkeeping catches up.
  let ra, rb
  {
    const deadline = Date.now() + 90000
    for (;;) {
      ra = await httpJson('GET', portG, `/api/meta/resolve?path=${encodeURIComponent(join(repoA, 'src'))}`)
      rb = await httpJson('GET', portG, `/api/meta/resolve?path=${encodeURIComponent(repoB)}`)
      if (ra.body?.resolved && rb.body?.resolved) break
      if (Date.now() > deadline) break
      await sleep(2000)
    }
  }
  const rc = await httpJson('GET', portG, `/api/meta/resolve?path=${encodeURIComponent(repoC)}`)
  if (ra.body?.resolved === true && ra.body.boundPort === portA && rb.body?.boundPort === portB && rc.body?.resolved === false) {
    pass('meta-resolve', `A/sub→:${portA}, B→:${portB}, unregistered C→resolved:false (${rc.body.reason})`)
  } else {
    fail('meta-resolve', `unexpected: ${JSON.stringify({ ra: ra.body, rb: rb.body, rc: rc.body })}`)
  }

  // 5. Swap in the dev extension (live one backed up; restored in finally)
  if (existsSync(EXT_DIR)) cpSync(EXT_DIR, EXT_BACKUP, { recursive: true })
  sh(process.execPath, [CLI, 'install-extension', '--broker-url', `http://localhost:${portG}`])
  pass('extension-installed', `dev extension → global broker :${portG} (backup at ${EXT_BACKUP})`)

  // 6. Store the marker from a REAL Copilot session in repoA
  await startCopilotSession('e2e-a', repoA)
  await waitForPane('e2e-a', [/Copilot|copilot/i], 60000, 'copilot banner')
  await sleep(8000) // let the extension finish session-start + broker resolution
  sendPrompt(
    'e2e-a',
    `Call the scns_memory_store tool with key "e2e-marker" and value "The secret launch codename is ${MARKER}." — after the tool returns, print "STORE_" followed immediately by "OK" as one word, and stop.`,
  )
  await waitForPane('e2e-a', ['STORE_OK'], 180000, 'store in repoA')
  // Server-side ground truth (short poll — the pane sentinel can render a
  // beat before the HTTP round-trip settles): the marker must be in child
  // A's vault and in NO other broker.
  let hitA = false
  for (let i = 0; i < 15 && !hitA; i++) {
    const sa = await httpJson('GET', portA, `/api/memory/search?q=${MARKER}`)
    hitA = (sa.body?.results ?? []).some((r) => (r.content ?? '').includes(MARKER))
    if (!hitA) await sleep(2000)
  }
  const sb = await httpJson('GET', portB, `/api/memory/search?q=${MARKER}`)
  const sg = await httpJson('GET', portG, `/api/memory/search?q=${MARKER}`)
  const hitB = (sb.body?.results ?? []).some((r) => (r.content ?? '').includes(MARKER))
  const hitG = (sg.body?.results ?? []).some((r) => (r.content ?? '').includes(MARKER))
  if (hitA && !hitB && !hitG) {
    pass('store-routed', `marker stored via Copilot session landed ONLY in child A's vault`)
  } else {
    fail('store-routed', `hitA=${hitA} hitB=${hitB} hitGlobal=${hitG}`)
  }

  // 7. Search isolation from a REAL session in repoB
  await startCopilotSession('e2e-b', repoB)
  await waitForPane('e2e-b', [/Copilot|copilot/i], 60000)
  await sleep(8000)
  sendPrompt(
    'e2e-b',
    `Call the scns_memory_search tool with query "${MARKER}" and top_k 5. Count the entries in the results array of the tool's JSON response, then print "BCOUNT" followed immediately by "=" and the number, as one token — nothing else.`,
  )
  const rB = await waitForPane('e2e-b', [/BCOUNT=\d+/], 180000, 'search in repoB')
  if (/BCOUNT=0/.test(rB.matched)) {
    pass('isolation-search', `repoB session sees 0 results for A's marker (${rB.matched})`)
  } else {
    fail('isolation-search', `repoB session saw ${rB.matched}`)
  }

  // 8. Same search from repoA finds it
  sendPrompt(
    'e2e-a',
    `Now call the scns_memory_search tool with query "${MARKER}" and top_k 5. Count the entries in the results array, then print "ACOUNT" followed immediately by "=" and the number, as one token — nothing else.`,
  )
  const rA = await waitForPane('e2e-a', [/ACOUNT=\d+/], 180000, 'search in repoA')
  if (!/ACOUNT=0/.test(rA.matched)) {
    pass('recall-own-repo', `repoA session finds its marker (${rA.matched})`)
  } else {
    fail('recall-own-repo', `repoA session got ${rA.matched}`)
  }

  // 9. Strict-mode refusal from an UNREGISTERED repo
  await startCopilotSession('e2e-c', repoC, { SCNS_REQUIRE_PROJECT_BROKER: '1' })
  await waitForPane('e2e-c', [/Copilot|copilot/i], 60000)
  await sleep(8000)
  sendPrompt(
    'e2e-c',
    `Call the scns_memory_store tool with key "strict-probe" and value "must-not-land-${NONCE}". Then print the tool's raw JSON response verbatim, then print "STRICT_" followed immediately by "END" as one word.`,
  )
  const rC = await waitForPane('e2e-c', ['STRICT_END'], 180000, 'strict store in repoC')
  const refusedShown = /strict-project-broker|"refused"\s*:\s*true|refused/.test(rC.text)
  const sgc = await httpJson('GET', portG, `/api/memory/search?q=must-not-land-${NONCE}`)
  const leaked = (sgc.body?.results ?? []).some((r) => (r.content ?? '').includes(`must-not-land-${NONCE}`))
  if (refusedShown && !leaked) {
    pass('strict-guard', 'unregistered repo + SCNS_REQUIRE_PROJECT_BROKER=1 → store refused, nothing landed in the global vault')
  } else {
    fail('strict-guard', `refusedShown=${refusedShown} leakedToGlobal=${leaked}`)
  }
  killSession('e2e-c')

  // 10. Context injection: ON for child A, then a fresh session must know the
  // marker WITHOUT tools; a fresh repoB session must not.
  await httpJson('POST', portA, '/api/state', {
    key: 'extension.config',
    value: JSON.stringify({ contextInjectionEnabled: true, maxMemories: 5, maxSuggestions: 3 }),
  })
  await httpJson('POST', portB, '/api/state', {
    key: 'extension.config',
    value: JSON.stringify({ contextInjectionEnabled: true, maxMemories: 5, maxSuggestions: 3 }),
  })
  killSession('e2e-a')
  killSession('e2e-b')
  // A freshly-stored fact has a keyword index entry but NO embedding until the
  // scheduled memory-reindex runs (every 30 min in production), and chat-length
  // prompts retrieve semantically (FTS ANDs every term, so natural-language
  // questions never keyword-match). Trigger the reindex now — the same task
  // production runs — so the briefing path is in its steady state.
  await httpJson('POST', portA, '/api/scheduler/tasks/memory-reindex/run')
  await httpJson('POST', portB, '/api/scheduler/tasks/memory-reindex/run')
  // Pre-warm child A's briefing path (cold embedding-worker spawn can exceed
  // the extension's 5s budget, which reads as "no context" on the very first
  // prompt) and capture the server-side ground truth that the briefing for
  // this question carries the marker.
  let briefingHasMarker = false
  for (let i = 0; i < 30 && !briefingHasMarker; i++) {
    const warm = await httpJson('POST', portA, '/api/extension/context', {
      prompt: 'does your provided context mention a secret launch codename?',
    })
    briefingHasMarker = JSON.stringify(warm.body ?? {}).includes(MARKER)
    if (!briefingHasMarker) await sleep(3000)
  }
  log(`  briefing ground truth (child A carries marker for the question): ${briefingHasMarker}`)
  await startCopilotSession('e2e-a2', repoA)
  await waitForPane('e2e-a2', [/Copilot|copilot/i], 60000)
  await sleep(8000)
  sendPrompt(
    'e2e-a2',
    'WITHOUT calling any tool: does your provided context mention a secret launch codename? Print "CODE" followed immediately by "WORD=" and then the codename (or the word NONE), as one token.',
  )
  const inj = await waitForPane('e2e-a2', [/CODEWORD=\S+/], 180000, 'injection in repoA')
  const injected = inj.text.includes(MARKER)
  await startCopilotSession('e2e-b2', repoB)
  await waitForPane('e2e-b2', [/Copilot|copilot/i], 60000)
  await sleep(8000)
  sendPrompt(
    'e2e-b2',
    'WITHOUT calling any tool: does your provided context mention a secret launch codename? Print "CODE" followed immediately by "WORD=" and then the codename (or the word NONE), as one token.',
  )
  const injB = await waitForPane('e2e-b2', [/CODEWORD=\S+/], 180000, 'injection in repoB')
  const leakedB = injB.text.includes(MARKER)
  if (briefingHasMarker && injected && !leakedB) {
    pass('context-injection', `repoA briefing carries the marker (server-verified) and the session saw it; repoB session did not (B said ${injB.matched})`)
  } else {
    fail('context-injection', `serverBriefing=${briefingHasMarker} repoA injected=${injected} (${inj.matched}); repoB leaked=${leakedB}`)
  }
  killSession('e2e-b2')

  // 11. A2A: two concurrent sessions in repoA exchange messages both ways.
  // Message participants must be REGISTERED sessions (messages.sender_id has
  // a foreign key onto sessions) — register the two smoke identities the way
  // any A2A participant would be.
  for (const id of ['e2e-one', 'e2e-two']) {
    const reg = await httpJson('POST', portA, '/api/register', {
      id,
      purpose: 'wi6-a2a-smoke participant',
      working_dir: repoA,
    })
    if (reg.status !== 200) log(`  WARN register ${id} → HTTP ${reg.status}`)
  }
  await startCopilotSession('e2e-a3', repoA)
  await waitForPane('e2e-a3', [/Copilot|copilot/i], 60000)
  await sleep(8000)
  sendPrompt(
    'e2e-a2',
    `Call scns_send_message with sender_id "e2e-one", receiver_id "e2e-two", content "ping-${NONCE}". Then print "PINGSENT" followed immediately by "YES" as one word.`,
  )
  await waitForPane('e2e-a2', ['PINGSENTYES'], 180000, 'send ping')
  sendPrompt(
    'e2e-a3',
    `Call scns_read_messages with receiver_id "e2e-two". If any message content contains "ping-${NONCE}" print "PINGREAD" followed immediately by "YES" as one word, else print "PINGREAD" followed immediately by "NO". Then call scns_send_message with sender_id "e2e-two", receiver_id "e2e-one", content "pong-${NONCE}" and print "PONGSENT" followed immediately by "YES" as one word.`,
  )
  const ping = await waitForPane('e2e-a3', ['PINGREADYES', 'PINGREADNO'], 180000, 'read ping + send pong')
  await waitForPane('e2e-a3', ['PONGSENTYES'], 180000, 'pong sent')
  sendPrompt(
    'e2e-a2',
    `Call scns_read_messages with receiver_id "e2e-one". If any message content contains "pong-${NONCE}" print "PONGREAD" followed immediately by "YES" as one word, else print "PONGREAD" followed immediately by "NO".`,
  )
  const pong = await waitForPane('e2e-a2', ['PONGREADYES', 'PONGREADNO'], 180000, 'read pong')
  if (ping.matched === 'PINGREADYES' && pong.matched === 'PONGREADYES') {
    pass('a2a-exchange', 'ping/pong delivered both ways between two concurrent sessions via child A')
  } else {
    fail('a2a-exchange', `ping=${ping.matched} pong=${pong.matched}`)
  }
}

// ── run + teardown + evidence ─────────────────────────────────────────────

let exitCode = 1
try {
  await main()
  exitCode = results.every((r) => r.ok) ? 0 : 1
} catch (err) {
  fail('harness', err instanceof Error ? err.message : String(err))
  exitCode = 1
} finally {
  for (const name of [...tmuxSessions]) killSession(name)
  for (const { label, proc } of spawned.reverse()) {
    try {
      proc.kill('SIGTERM')
      log(`  stopped ${label}`)
    } catch {
      /* already down */
    }
  }
  // Restore the REAL extension install no matter what.
  try {
    if (existsSync(EXT_BACKUP)) {
      rmSync(EXT_DIR, { recursive: true, force: true })
      cpSync(EXT_BACKUP, EXT_DIR, { recursive: true })
      log('restored the live ~/.copilot/extensions/scns from backup')
    }
  } catch (err) {
    log(`WARNING: could not restore extension backup: ${err}`)
  }

  const summary = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.step} — ${r.detail}`)
  const evidence = [
    `# v1 Copilot CLI E2E evidence — ${STAMP}`,
    '',
    `- harness: \`scripts/e2e-copilot-smoke.mjs\` (re-runnable)`,
    `- cli under test: \`${CLI}\``,
    `- marker nonce: \`${MARKER}\``,
    '',
    '## Verdicts',
    '',
    ...summary.map((s) => `- ${s}`),
    '',
    `Overall: **${exitCode === 0 ? 'GO' : 'NO-GO'}**`,
    '',
    '## Full transcript',
    '',
    '```',
    ...evidenceLines,
    '```',
    '',
  ].join('\n')
  const evidencePath = join(REPO_ROOT, 'docs', 'evidence', `v1-copilot-e2e-${STAMP.slice(0, 10)}.md`)
  try {
    writeFileSync(evidencePath, evidence)
    console.log(`\nevidence written → ${evidencePath}`)
  } catch (err) {
    console.log(`could not write evidence doc: ${err}`)
  }

  if (!KEEP || exitCode === 0) {
    await sleep(2000)
    rmSync(WORK, { recursive: true, force: true })
  } else {
    console.log(`scratch kept for debugging: ${WORK}`)
  }
  console.log(`\n${exitCode === 0 ? 'ALL STEPS PASSED (GO)' : 'FAILURES PRESENT (NO-GO)'}`)
  process.exit(exitCode)
}
