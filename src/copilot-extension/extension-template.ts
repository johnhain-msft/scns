/**
 * Extension Template Generator — produces a standalone extension.mjs
 * for the Copilot CLI that integrates with the SCNS broker.
 *
 * The generated file is self-contained (no external imports beyond @github/copilot-sdk)
 * and communicates with the SCNS broker over HTTP.
 *
 * Tool definitions come from `tool-definitions.ts` (the single source of
 * truth); this module only supplies each tool's generated handler body.
 * Generation THROWS when a definition has no handler (or a handler has no
 * definition) so the two can never drift apart again.
 */

import { ValidationError } from '../shared/errors.js'
import {
  DEFAULT_RECONCILE_LOCK_TTL_MS,
  DEFAULT_RECONCILE_POLL_MS,
  DEFAULT_RECONCILE_PROBE_TIMEOUT_MS,
  DEFAULT_RECONCILE_READY_TIMEOUT_MS,
  reconcileRuntimeJs,
} from './broker-reconcile.js'
import { TOOL_DEFINITIONS } from './tool-definitions.js'
import { routeIdentityRuntimeJs } from './route-identity.js'
import { startupNoticeRuntimeJs } from './startup-notice.js'

/**
 * How long a session waits at startup for an IDLE-REAPED project broker to
 * come back, before giving up and falling back to the global broker.
 *
 * Derived from measurement, not taste. Over 5 real spawns on this machine at
 * the production 5s supervisor tick, wake -> registry `running` took
 * 10.07s, 10.07s, 10.18s, 15.19s, 10.26s (mean 11.16s, max 15.19s). The
 * latency is quantised to the tick — one tick to spawn, another to promote
 * `starting` -> `running` — so the distribution is a staircase at 10s/15s/20s
 * rather than a bell around the mean, and the load condition documented for
 * this box (concurrent test runs starving health probes) adds steps.
 *
 * 45s is ~3x the measured mean and clears a 4-tick worst case with room. It
 * applies ONLY while `/api/meta/resolve` is answering `child-idle`: a project
 * that is dead for any other reason still falls back on the ordinary
 * {@link DEFAULT_RECONCILE_READY_TIMEOUT_MS}, so this cannot hang a session
 * behind a genuinely broken broker.
 */
export const CHILD_WAKE_TIMEOUT_MS = 45_000

/**
 * Issue #61, option A — session-start reconciliation.
 *
 * When present, the generated extension health-checks the global broker at
 * session start and starts the supervision root when it is dead. Opt-in by
 * construction: with no config the emitted source is byte-identical to before,
 * so no install gains the ability to spawn processes by accident.
 */
export interface ExtensionReconcileConfig {
  readonly enabled: boolean
  /** Command to start the stack, or null to emit the probe without a spawn. */
  readonly startCommand: { readonly command: string; readonly args: readonly string[] } | null
  /** Cross-session lock so N simultaneous sessions start the stack once. */
  readonly lockPath: string
  readonly lockTtlMs?: number
  readonly readyTimeoutMs?: number
  readonly pollMs?: number
  readonly probeTimeoutMs?: number
}

export interface ExtensionTemplateConfig {
  readonly brokerUrl: string
  readonly timeoutMs?: number
  readonly contextInjection?: boolean
  readonly configCacheTtlMs?: number
  /**
   * WI-2b — broker auth token baked into the generated source. When set, every
   * broker request carries `Authorization: Bearer <token>` (required once the
   * broker runs with BROKER_TOKEN, as on the Windows work machine). When null
   * the generated requests are byte-identical to the pre-token extension, so
   * tokenless setups (the live Mac install) are unaffected.
   */
  readonly brokerToken?: string | null
  /**
   * #61 — session-start reconciliation. Omit (or pass null) to generate the
   * pre-#61 source exactly: no health probe, no child_process import, no spawn.
   */
  readonly reconcile?: ExtensionReconcileConfig | null
}

/** Validate that a broker URL is well-formed (http/https, no code injection) */
export function validateBrokerUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ValidationError(`Invalid broker URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`Broker URL must use http or https protocol, got: ${parsed.protocol}`)
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '')
}

/** Generate a complete, standalone extension.mjs source file */
export function generateExtensionSource(config: ExtensionTemplateConfig): string {
  const brokerUrl = validateBrokerUrl(config.brokerUrl)
  const timeoutMs = config.timeoutMs ?? 5000
  const contextInjection = config.contextInjection ?? false
  const configCacheTtlMs = config.configCacheTtlMs ?? 60_000
  const brokerToken = config.brokerToken ?? null
  const reconcile = config.reconcile ?? null

  return `// SCNS Copilot CLI Extension — Auto-generated
// Broker: ${brokerUrl}
// Context injection default: ${contextInjection ? 'ON' : 'OFF'}
// Generated: ${new Date().toISOString()}
//
// This extension integrates SCNS with Copilot CLI sessions.
// It forwards lifecycle events, registers SCNS tools, and optionally injects context.

import { joinSession } from "@github/copilot-sdk/extension";
${reconcile ? 'import { spawn } from "node:child_process";\nimport { mkdirSync, openSync, closeSync, rmSync, statSync } from "node:fs";\nimport { dirname } from "node:path";\n' : ''}
const BROKER_URL = "${brokerUrl}";
const BROKER_TOKEN = ${JSON.stringify(brokerToken)};
const TIMEOUT_MS = ${timeoutMs};
const CONFIG_CACHE_TTL_MS = ${configCacheTtlMs};

// ── Team-mode identity ───────────────────────────────────────
${generateTeamMode()}

// ── Broker resolution (W5: per-project routing) ──────────────
${generateBrokerResolution()}

// ── Startup notice de-duplication ─────────────────────────────
${generateStartupNotice()}

// ── HTTP helpers ──────────────────────────────────────────────
${generateHttpHelpers()}

// ── Config cache ──────────────────────────────────────────────
${generateConfigCache()}

// ── Event forwarding ──────────────────────────────────────────
${generateForwardFunction()}
${reconcile ? `\n// ── Session-start reconciliation (#61 option A) ───────────────\n${generateBrokerReconcile(reconcile)}\n` : ''}
// ── Extension entry point ─────────────────────────────────────
// Join before broker I/O: route recovery must not hold up extension readiness.
const session = await joinSession({
  hooks: {
${generateHooks(contextInjection)}
  },
  tools: [
${generateTools()}
  ],
});

// ── Team-mode heartbeat ──────────────────────────────────────
${generateTeamHeartbeat()}

// ── Event listeners ───────────────────────────────────────────
${generateEventListeners()}

brokerResolutionSession = session;

// ── Resolve the broker OFF the load path ─────────────────────
// Deliberately not awaited here. Every broker read and write funnels through
// fetchBroker → recoverProjectRoute → awaitStartupResolution, so nothing can
// touch an unresolved route; only the LOAD is unblocked.
startupResolution = (async () => {${
    reconcile
      ? `
  // Reconcile BEFORE resolving: resolving against a dead broker is the silent
  // \`global:fallback\` failure this exists to stop.
  await ensureBrokerAlive();`
      : ''
  }
  await resolveBrokerUrl("startup");
})();
// One notice per activation, not one per fork. The CLI replaces this process
// several times while a single session starts, and each replacement re-runs
// everything above — see announceOnce.
startupResolution
  .then(() => announceRouteStatus())
  .catch((err) =>
    announceOnce("SCNS extension loaded (broker unresolved: " + ((err && err.message) || err) + ")", "error"),
  )
  .catch((err) => console.error("[SCNS] Startup notification failed: " + String(err)));
`
}

/** Use the CLI lifecycle and session workspace, not a time-based activation guess. */
function generateStartupNotice(): string {
  return `${startupNoticeRuntimeJs()}

const NOTICE_SESSION_ID = process.env.SESSION_ID || "";
let noticeQueue = Promise.resolve();
let noticeActivationPromise = null;
let noticeMemoryState = null;

async function noticeActivation() {
  if (noticeActivationPromise) return noticeActivationPromise;
  noticeActivationPromise = (async () => {
    try {
      const events = await brokerResolutionSession.getEvents();
      const event = events.findLast((e) => e.type === "session.start" || e.type === "session.resume");
      if (!event || typeof event.id !== "string" || !event.id) throw new Error("no start/resume event");
      // Host replacement keeps the CLI parent and lifecycle event. A new
      // launch or actual resume changes at least one of them.
      return String(process.ppid) + ":" + event.id;
    } catch (err) {
      console.error("[SCNS] Cannot identify notice activation; deduplication disabled: " + String(err));
      return "";
    }
  })();
  return noticeActivationPromise;
}

async function acquireNoticeLock(fs, file) {
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const lock = file + ".lock";
  const ownerName = "owner-" + randomUUID() + ".json";
  const candidate = fs.mkdtempSync(file + ".claim-");
  const deadline = Date.now() + 5000;
  const isContention = (err) =>
    ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "EBUSY"].includes(err.code);
  const isRetired = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return false; }
    catch (err) { if (err.code === "ESRCH") return true; throw err; }
  };
  let published = false;
  try {
    // Publish a nonempty directory atomically. A reaper may remove only the
    // retired generation's unique owner file, followed by an EMPTY directory.
    // Neither operation can remove a new, nonempty replacement generation.
    fs.writeFileSync(join(candidate, ownerName), JSON.stringify({ pid: process.pid }), { flag: "wx" });
    for (;;) {
      if (Date.now() >= deadline) throw new Error("notice state is locked by another host");
      try {
        fs.renameSync(candidate, lock);
        published = true;
        return { directory: lock, ownerFile: join(lock, ownerName) };
      } catch (err) {
        if (!isContention(err)) throw err;
      }
      try {
        if (fs.lstatSync(lock).isFile()) {
          // Migrate a retired lock from the earlier file-based protocol.
          // unlink cannot delete a directory published by this version.
          if (isRetired(Number(fs.readFileSync(lock, "utf8")))) fs.unlinkSync(lock);
        } else {
          const owners = fs.readdirSync(lock);
          if (owners.length === 0) {
            fs.rmdirSync(lock);
          } else if (owners.length === 1 && /^owner-[a-f0-9-]+\\.json$/.test(owners[0])) {
            const ownerFile = join(lock, owners[0]);
            const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
            if (isRetired(owner.pid)) {
              fs.unlinkSync(ownerFile);
              fs.rmdirSync(lock);
            }
          } else {
            throw new Error("unrecognized notice-lock directory");
          }
        }
      } catch (err) {
        if (!["ENOENT", "ENOTDIR", "EISDIR"].includes(err.code) && !isContention(err)) throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    if (!published) {
      try {
        fs.unlinkSync(join(candidate, ownerName));
      } catch (err) {
        if (err.code !== "ENOENT") console.error("[SCNS] Could not clean private notice claim: " + String(err));
      }
      try { fs.rmdirSync(candidate); }
      catch (err) {
        if (err.code !== "ENOENT") console.error("[SCNS] Could not clean private notice directory: " + String(err));
      }
    }
  }
}

async function deliverNotice(message, level) {
  if (!brokerResolutionSession) return false;
  const sessionId = brokerResolutionSession.sessionId || NOTICE_SESSION_ID;
  const activationId = sessionId ? await noticeActivation() : "";
  let fs = null;
  let file = null;
  let lock = null;
  let previous = noticeMemoryState;
  try {
    if (activationId) {
      try {
        fs = await import("node:fs");
        const path = await import("node:path");
        const workspace = brokerResolutionSession.workspacePath;
        if (!workspace || !path.isAbsolute(workspace)) throw new Error("no local session workspace");
        fs.mkdirSync(workspace, { recursive: true });
        file = path.join(workspace, "scns-extension-notice.json");
        lock = await acquireNoticeLock(fs, file);
        try { previous = JSON.parse(fs.readFileSync(file, "utf8")); }
        catch (err) {
          if (err.code !== "ENOENT") console.error("[SCNS] Cannot read notice state: " + String(err));
          previous = null;
        }
      } catch (err) {
        console.error("[SCNS] Notice state unavailable; showing notice without persistent deduplication: " + String(err));
        file = null;
      }
    }
    const decision = decideStartupNotice(previous, sessionId, activationId, message, level);
    if (!decision.announce) {
      console.error("[SCNS] Unchanged startup notice suppressed for activation " + activationId);
      return false;
    }
    // A failed RPC must not leave a receipt that suppresses the next host.
    await brokerResolutionSession.log(message, { level });
    noticeMemoryState = decision.next;
    if (file) {
      const temp = file + "." + process.pid + ".tmp";
      try {
        fs.writeFileSync(temp, JSON.stringify(decision.next), "utf8");
        fs.renameSync(temp, file);
      } catch (err) {
        console.error("[SCNS] Could not persist delivered notice: " + String(err));
      } finally {
        try { fs.rmSync(temp, { force: true }); }
        catch (err) { console.error("[SCNS] Could not clean notice temporary file: " + String(err)); }
      }
    }
    return true;
  } catch (err) {
    console.error("[SCNS] could not post startup notice: " + String(err));
    return false;
  } finally {
    if (lock) {
      try {
        fs.unlinkSync(lock.ownerFile);
        fs.rmdirSync(lock.directory);
      } catch (err) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code)) {
          console.error("[SCNS] Could not release notice lock: " + String(err));
        }
      }
    }
  }
}

async function announceOnce(message, level = "info") {
  const pending = noticeQueue.then(() => deliverNotice(message, level));
  noticeQueue = pending.catch((err) => console.error("[SCNS] Notice queue failed: " + String(err)));
  return pending;
}`
}

function generateTeamMode(): string {
  return `const SCNS_SESSION_ID = process.env.SCNS_SESSION_ID;
const SCNS_TEAM_ID = process.env.SCNS_TEAM_ID;
const SCNS_ROLE = process.env.SCNS_ROLE || 'dev';
const SCNS_BROKER_URL = process.env.SCNS_BROKER_URL;
const IS_TEAM_MODE = !!(SCNS_SESSION_ID && SCNS_TEAM_ID && SCNS_BROKER_URL);`
}

function generateBrokerResolution(): string {
  return `// Resolve the cwd's owner at startup; retry while its child is recovering.
//   1. SCNS_BROKER_URL env (team mode / manual override — always wins)
//   2. the GLOBAL broker's meta registry maps cwd → the project's child broker
//   3. the global broker itself
// Once an owner is known, an outage must not erase it and permit global writes.
let effectiveBrokerUrl = SCNS_BROKER_URL || BROKER_URL;
let brokerRouteLabel = SCNS_BROKER_URL ? "env:SCNS_BROKER_URL" : "global:default";
const brokerResolutionLog = [];
let brokerResolutionSession = null;
let brokerResolvePromise = null;
let startupResolution = null;
let projectRecoveryPending = false;
let brokerResolutionFailure = null;
const CHILD_READY_TIMEOUT_MS = ${DEFAULT_RECONCILE_READY_TIMEOUT_MS};
const CHILD_WAKE_TIMEOUT_MS = ${CHILD_WAKE_TIMEOUT_MS};
const CHILD_READY_POLL_MS = ${DEFAULT_RECONCILE_POLL_MS};
let reResolveUsed = false;
// Project that owns this cwd, including while its child is unavailable.
// null means no owner was established (or an explicit env override).
let resolvedProjectId = null;
let routeIdentityWarned = false;

function recordBrokerResolution(message, visible) {
  brokerResolutionLog.push(message);
  // Ordinary resolution detail is DIAGNOSTICS, not a timeline notification.
  // Posting it to the session repeated it once per extension fork, and the CLI
  // forks this process several times per activation.
  console.error("[SCNS] broker-resolve: " + message);
  // Abnormal routes stay user-visible — deduped, never silenced.
  if (visible) {
    announceOnce("SCNS broker-resolve: " + message, "warning").catch((err) => {
      console.error("[SCNS] Could not log broker recovery: " + String(err));
    });
  }

}

function announceRouteStatus() {
  if (brokerResolutionFailure) {
    return announceOnce(
      "SCNS broker unresolved: " + brokerResolutionFailure + " (broker: " +
      effectiveBrokerUrl + " [" + brokerRouteLabel + "])",
      "warning",
    );
  }
  return announceOnce("SCNS extension loaded (broker: " + effectiveBrokerUrl + " [" + brokerRouteLabel + "])", "info");
}

// WI-4 strict routing — SCNS_REQUIRE_PROJECT_BROKER=1 (default OFF) refuses
// memory WRITES while the session is on the global broker (unregistered repo
// or failed resolve): storing there is exactly the cross-repo pollution the
// per-project child brokers exist to prevent. Reads stay allowed.
const STRICT_PROJECT_BROKER = process.env.SCNS_REQUIRE_PROJECT_BROKER === "1";
let strictRoutingWarned = false;
function strictStoreRefusal() {
  if (!STRICT_PROJECT_BROKER) return null;
  if (!brokerRouteLabel.startsWith("global:")) return null;
  if (!strictRoutingWarned) {
    strictRoutingWarned = true;
    console.error(
      "[SCNS] STRICT ROUTING: this session resolved to " + brokerRouteLabel +
      " (not a per-project child broker) — scns_memory_store is REFUSED so the" +
      " shared brain stays clean. " + (resolvedProjectId
        ? "The project is recovering; retry the write after its broker is ready."
        : "Fix: scns meta-broker register <this repo's root>, ensure the supervisor is running, then start a new session.")
    );
  }
  return {
    stored: false,
    refused: true,
    reason: "strict-project-broker: session is on " + brokerRouteLabel +
      (resolvedProjectId
        ? " — waiting for project " + resolvedProjectId + "; retry after recovery"
        : " — register this repo (scns meta-broker register) and restart the session"),
  };
}

async function resolveBrokerUrl(trigger) {
  if (brokerResolvePromise) return brokerResolvePromise;
  brokerResolvePromise = resolveBrokerRoute(trigger);
  try {
    await brokerResolvePromise;
  } finally {
    brokerResolvePromise = null;
  }
}

async function resolveBrokerRoute(trigger) {
  if (SCNS_BROKER_URL) {
    effectiveBrokerUrl = SCNS_BROKER_URL;
    brokerRouteLabel = "env:SCNS_BROKER_URL";
    resolvedProjectId = null;
    brokerResolutionFailure = null;
    recordBrokerResolution("[" + trigger + "] broker=env:SCNS_BROKER_URL " + SCNS_BROKER_URL);
    if (trigger !== "startup") void announceRouteStatus();
    return;
  }
  // Only startup waits. Subsequent requests get one resolve attempt, so a
  // prolonged outage cannot stall every hook for another readiness budget.
  const waitMs = trigger === "startup" ? CHILD_READY_TIMEOUT_MS : 0;
  // An idle-reaped broker is a COLD START, and a cold start is measurably
  // slower than the generic readiness budget assumes. Measured on this
  // machine, wake -> registry says running, over 5 real spawns at the
  // production 5s tick: 10.07s, 10.07s, 10.18s, 15.19s, 10.26s (mean 11.16s).
  // The latency is QUANTISED to the supervisor tick — one tick to spawn,
  // another to promote starting -> running — so the tail sits at 15s and 20s,
  // not at the mean, and the documented load condition on this box
  // (concurrent test runs starving probes) adds steps. The generic 20s budget
  // therefore had ~4.8s of margin against the worst observed case and none at
  // all against a 4-tick one. The longer deadline below is used ONLY while the
  // reason is child-idle, so a genuinely dead project still falls back on the
  // ordinary budget rather than hanging a session for 45s.
  const startedAt = Date.now();
  let deadline = startedAt + waitMs;
  let reason = "unresolved";
  let waitingLogged = false;
  do {
    let retryable = false;
    try {
      const timeoutMs = waitMs
        ? Math.max(1, Math.min(TIMEOUT_MS, deadline - Date.now()))
        : TIMEOUT_MS;
      const res = await fetch(
        BROKER_URL + "/api/meta/resolve?path=" + encodeURIComponent(process.cwd()),
        { headers: authHeaders(), signal: AbortSignal.timeout(timeoutMs) },
      );
      if (res.ok) {
        const data = await res.json();
        const projectId = data && typeof data.projectId === "string" && data.projectId
          ? data.projectId : null;
        if (projectId && resolvedProjectId && projectId !== resolvedProjectId) {
          reason = "project changed from " + resolvedProjectId + " to " + projectId;
          break;
        }
        if (projectId) resolvedProjectId = projectId;
        if (data && data.resolved && data.brokerUrl && projectId) {
          effectiveBrokerUrl = data.brokerUrl;
          brokerRouteLabel = "project:" + projectId;
          projectRecoveryPending = false;
          brokerResolutionFailure = null;
          recordBrokerResolution("[" + trigger + "] broker=child " + projectId + " @ " + data.brokerUrl);
          if (trigger !== "startup") void announceRouteStatus();
          return;
        }
        reason = (data && data.reason) || "unresolved";
        // 'child-idle' is a COLD START, not a refusal: the broker was reaped
        // for idleness and the resolve above has already flipped its registry
        // row so the supervisor respawns it. Waiting here is what keeps idle
        // reaping safe — a non-retryable reason would latch this session on
        // global:fallback, which refuses every memory write for its whole life.
        // 'child-stopped' stays OUT: that one is an operator stop, and waiting
        // for a human decision is not something a session should do.
        retryable = projectId !== null &&
          ["child-registered", "child-starting", "child-failing", "child-idle"].includes(reason);
        // Anchored to the loop's START, never to now(). That makes re-applying
        // it on every pass IDEMPOTENT, which is the property that actually
        // matters. Sampling Date.now() here instead produced a later candidate
        // on every pass, so the deadline advanced 45s PER PASS forever: while
        // the resolve kept answering child-idle the startup resolution never
        // returned, and because every broker read and write funnels through
        // fetchBroker -> recoverProjectRoute -> awaitStartupResolution, every
        // SCNS tool call in the session blocked behind it indefinitely.
        if (waitMs && reason === "child-idle") {
          const wakeDeadline = startedAt + CHILD_WAKE_TIMEOUT_MS;
          if (wakeDeadline > deadline) deadline = wakeDeadline;
        }
      } else {
        reason = "HTTP " + res.status;
        retryable = resolvedProjectId !== null && res.status >= 500;
      }
    } catch (err) {
      reason = "failed (" + ((err && err.message) || err) + ")";
      retryable = resolvedProjectId !== null;
    }
    const remaining = deadline - Date.now();
    if (!retryable || remaining <= 0) break;
    if (!waitingLogged) {
      waitingLogged = true;
      recordBrokerResolution("[" + trigger + "] meta-resolve: " + reason + " — waiting for project recovery", true);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(CHILD_READY_POLL_MS, remaining)));
  } while (Date.now() < deadline);

  projectRecoveryPending = resolvedProjectId !== null;
  brokerResolutionFailure = reason +
    (projectRecoveryPending ? " - project " + resolvedProjectId + " unavailable; writes refused until recovery" : "");
  if (!brokerRouteLabel.startsWith("project:")) {
    effectiveBrokerUrl = BROKER_URL;
    brokerRouteLabel = "global:fallback";
  }
  recordBrokerResolution("[" + trigger + "] meta-resolve: " + reason +
    (projectRecoveryPending
      ? " — project " + resolvedProjectId + " unavailable; writes refused until recovery, retry on next request"
      : " — using global " + BROKER_URL));
  if (trigger !== "startup") void announceRouteStatus();
}

// Gate every broker call on the startup resolve without blocking the LOAD.
// Resolved once, then cleared so later calls cost nothing. A failed startup
// resolve must not wedge requests — it already falls back to global:fallback.
async function awaitStartupResolution() {
  if (!startupResolution) return;
  const pending = startupResolution;
  try {
    await pending;
  } catch {
    /* resolution records its own failure and falls back */
  } finally {
    if (startupResolution === pending) startupResolution = null;
  }
}

async function recoverProjectRoute() {
  await awaitStartupResolution();
  if (projectRecoveryPending && !IS_TEAM_MODE) {
    await resolveBrokerUrl("retry-project-route");
  }
}`
}

/**
 * Emit the session-start reconciliation runtime.
 *
 * Everything here is deliberately defensive: this code runs before the session
 * is even joined, so a failure must degrade to "carry on with whatever broker
 * we can reach", never to a broken Copilot session. Every step is wrapped, and
 * the whole thing is a no-op when the broker answers.
 *
 * The decision itself is NOT written here — it is emitted from
 * `broker-reconcile.ts`, whose unit test cross-checks the emitted function
 * against the TypeScript core over the whole input space.
 */
function generateBrokerReconcile(cfg: ExtensionReconcileConfig): string {
  const startCommand = cfg.startCommand
  const lockTtlMs = cfg.lockTtlMs ?? DEFAULT_RECONCILE_LOCK_TTL_MS
  const readyTimeoutMs = cfg.readyTimeoutMs ?? DEFAULT_RECONCILE_READY_TIMEOUT_MS
  const pollMs = cfg.pollMs ?? DEFAULT_RECONCILE_POLL_MS
  const probeTimeoutMs = cfg.probeTimeoutMs ?? DEFAULT_RECONCILE_PROBE_TIMEOUT_MS

  return `const RECONCILE_ENABLED = ${cfg.enabled ? 'true' : 'false'};
const RECONCILE_COMMAND = ${JSON.stringify(startCommand ? startCommand.command : null)};
const RECONCILE_ARGS = ${JSON.stringify(startCommand ? startCommand.args : [])};
const RECONCILE_LOCK_PATH = ${JSON.stringify(cfg.lockPath)};
const RECONCILE_LOCK_TTL_MS = ${lockTtlMs};
const RECONCILE_READY_TIMEOUT_MS = ${readyTimeoutMs};
const RECONCILE_POLL_MS = ${pollMs};
const RECONCILE_PROBE_TIMEOUT_MS = ${probeTimeoutMs};

${reconcileRuntimeJs()}

// A health probe, not a route resolve. ANY HTTP status means the broker's
// event loop answered; only a transport failure counts as down. Never posts:
// /api/extension/context looks like a read but appends a retrieval_experience
// row, which would put probe traffic into the learning corpus.
async function probeBrokerHealth() {
  try {
    const res = await fetch(BROKER_URL + "/api/health", {
      headers: authHeaders(),
      signal: AbortSignal.timeout(RECONCILE_PROBE_TIMEOUT_MS),
    });
    return typeof res.status === "number";
  } catch {
    return false;
  }
}

function reconcileLockAgeMs() {
  try {
    return Date.now() - statSync(RECONCILE_LOCK_PATH).mtimeMs;
  } catch {
    return null;
  }
}

// Exclusive create ("wx") is the race arbiter: N sessions starting together all
// see no lock, all try to create it, exactly one wins. The losers fall through
// to waiting, so the stack is started once.
function acquireReconcileLock(lockAgeMs) {
  try {
    if (lockAgeMs !== null && lockAgeMs >= RECONCILE_LOCK_TTL_MS) {
      rmSync(RECONCILE_LOCK_PATH, { force: true });
    }
    mkdirSync(dirname(RECONCILE_LOCK_PATH), { recursive: true });
    closeSync(openSync(RECONCILE_LOCK_PATH, "wx"));
    return true;
  } catch {
    return false;
  }
}

function releaseReconcileLock() {
  try {
    rmSync(RECONCILE_LOCK_PATH, { force: true });
  } catch {
    /* a stale lock expires via RECONCILE_LOCK_TTL_MS */
  }
}

async function waitForBrokerReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeBrokerHealth()) return true;
    await new Promise((r) => setTimeout(r, RECONCILE_POLL_MS));
  }
  return false;
}

async function ensureBrokerAlive() {
  try {
    const enabled = RECONCILE_ENABLED && process.env.SCNS_SESSION_RECONCILE !== "0";
    const healthy = enabled ? await probeBrokerHealth() : true;
    const decision = decideReconcile({
      healthy,
      enabled,
      teamMode: IS_TEAM_MODE,
      startCommandConfigured: RECONCILE_COMMAND !== null,
      lockAgeMs: reconcileLockAgeMs(),
    }, RECONCILE_LOCK_TTL_MS);

    if (decision.action === "none") {
      if (decision.reason !== "healthy") {
        recordBrokerResolution("[reconcile] skipped: " + decision.reason);
      }
      return;
    }

    if (decision.action === "wait") {
      const ready = await waitForBrokerReady(RECONCILE_READY_TIMEOUT_MS);
      recordBrokerResolution("[reconcile] peer was starting the stack; ready=" + ready, !ready);
      return;
    }

    if (!acquireReconcileLock(reconcileLockAgeMs())) {
      const ready = await waitForBrokerReady(RECONCILE_READY_TIMEOUT_MS);
      recordBrokerResolution("[reconcile] lost the start race; ready=" + ready, !ready);
      return;
    }

    try {
      // Detached + unref'd: the supervision root must outlive the Copilot
      // session that noticed it was missing.
      const child = spawn(RECONCILE_COMMAND, RECONCILE_ARGS, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      const ready = await waitForBrokerReady(RECONCILE_READY_TIMEOUT_MS);
      recordBrokerResolution(
        "[reconcile] broker was down — started supervision root (pid " +
          (child.pid || "?") + "); ready=" + ready, !ready,
      );
    } finally {
      releaseReconcileLock();
    }
  } catch (err) {
    // Reconciliation is a bonus, never a precondition. A session with a dead
    // broker must still start (degraded) rather than fail to load.
    recordBrokerResolution("[reconcile] failed: " + ((err && err.message) || err), true);
  }
}`
}

function generateTeamHeartbeat(): string {
  // Issue #70: the session lease must be maintained for ordinary, resumed,
  // and team sessions alike — independent of model turns, blocking tools,
  // and approval waits. Team mode uses its env-pinned id; interactive mode
  // uses the id captured from any hook invocation.
  //
  // Auto-re-register is INTERACTIVE-ONLY and 404-ONLY (decision 2026-09-17):
  // a 404 means the broker is up and genuinely forgot this session (restart,
  // TTL settlement) — re-registering with the real cwd restores identity.
  // Transport errors and 500s never trigger it. Team agents never
  // self-re-register: their rows are broker-managed, and a purge there is
  // the reaper's deliberate decision — a killed-but-surviving process must
  // fail loudly (UNKNOWN_PARTICIPANT), not silently re-enroll itself.
  return `let heartbeatInterval = null;
async function heartbeatTick() {
  const sid = effectiveSessionId();
  if (!sid) return;
  const res = await postBrokerVerbose('/api/heartbeat', { session_id: sid });
  if (!res.ok && res.status === 404 && !IS_TEAM_MODE) {
    await postBroker('/api/register', {
      id: sid,
      purpose: 'copilot-hook',
      ...(extensionCwd ? { working_dir: extensionCwd } : {}),
    });
  }
}
heartbeatInterval = setInterval(() => { heartbeatTick().catch(() => {}); }, 15000);`
}

function generateHttpHelpers(): string {
  return `function authHeaders() {
  return BROKER_TOKEN ? { Authorization: "Bearer " + BROKER_TOKEN } : {};
}

${routeIdentityRuntimeJs()}

// Read the project_id the broker at \`url\` echoes from BROKER_PROJECT_ID.
// null means "could not establish identity" — unreachable, non-OK, or a
// broker with no project (the global one).
async function brokerProjectId(url) {
  try {
    const res = await fetch(url + "/api/health", {
      headers: authHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.project_id) || null;
  } catch {
    return null;
  }
}

// Gate every WRITE on the broker still being the project that owns this cwd.
// Return the checked URL along with any refusal. A concurrent resolve must
// not change a write's destination after its identity probe.
//
// Fail CLOSED: a refused write is recoverable by retrying, whereas a write
// filed into another project's database is silent corruption that strict
// routing cannot see (the route label is captured at resolve time and would
// still name the right project). Reads are deliberately never gated.
async function assertRouteIdentity() {
  const staleBroker = effectiveBrokerUrl;
  const staleProject = resolvedProjectId;
  let broker = effectiveBrokerUrl;
  let verdict = "unverified";
  for (let attempt = 0; attempt < 2; attempt++) {
    broker = effectiveBrokerUrl;
    const expectedProject = resolvedProjectId;
    if (IS_TEAM_MODE || expectedProject === null) return { broker, refusal: null };
    if (projectRecoveryPending && brokerRouteLabel.startsWith("global:")) break;
    verdict = routeIdentityVerdict(expectedProject, await brokerProjectId(broker));
    if (verdict === "ok" && expectedProject === resolvedProjectId) return { broker, refusal: null };
    if (attempt === 0) await resolveBrokerUrl("identity-mismatch");
  }

  if (!routeIdentityWarned) {
    routeIdentityWarned = true;
    console.error(
      "[SCNS] ROUTE IDENTITY: broker " + staleBroker + " no longer serves project " +
      staleProject + " — writes are REFUSED so this session cannot file data into" +
      " another project. The extension will retry project resolution on subsequent requests."
    );
  }
  return {
    broker,
    refusal: {
      stored: false,
      refused: true,
      reason: "route-identity: broker " + broker + " does not serve project " +
        (resolvedProjectId || "(unresolved)") + " (" + verdict + ") — write refused to" +
        " avoid cross-project contamination; retry after the project recovers",
    },
  };
}

async function fetchBrokerOnce(path, options = {}, broker = effectiveBrokerUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(broker + path, {
      ...options,
      headers: { ...authHeaders(), ...(options.headers || {}) },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBroker(path, options = {}) {
  await recoverProjectRoute();
  const isWrite = !["GET", "HEAD"].includes((options.method || "GET").toUpperCase());
  const send = async () => {
    const route = isWrite
      ? await assertRouteIdentity()
      : { broker: effectiveBrokerUrl, refusal: null };
    if (route.refusal) return route.refusal;
    return fetchBrokerOnce(path, options, route.broker);
  };
  let result = await send();
  // One re-resolve per session: a resolved child may have moved ports or died
  // since startup. Team mode keeps its env-pinned broker.
  if (result === null && !IS_TEAM_MODE && !reResolveUsed) {
    reResolveUsed = true;
    await resolveBrokerUrl("re-resolve-after-failure");
    result = await send();
  }
  return result;
}

async function postBroker(path, body) {
  return fetchBroker(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Verbose request core for calls that must FAIL LOUDLY instead of degrading
// to null: reports which broker was addressed, the HTTP status, the parsed
// error body, and why it failed — so distinct failures (unknown participant,
// conflict, auth, transport) stay distinguishable (issue #70).
async function requestBrokerVerboseOnce(path, options = {}, broker = effectiveBrokerUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(broker + path, {
      ...options,
      headers: { ...authHeaders(), ...(options.headers || {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!response.ok) {
      return { ok: false, broker, status: response.status, body: parsed, error: "HTTP " + response.status + (text ? ": " + text.slice(0, 200) : "") };
    }
    return { ok: true, broker, status: response.status, body: parsed };
  } catch (err) {
    // Transport-level failure (down/moved/timeout) — the one case where a
    // re-resolve can help. HTTP errors mean the broker is up; don't re-route.
    return { ok: false, retriable: true, broker, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function postBrokerVerboseOnce(path, body, broker = effectiveBrokerUrl) {
  return requestBrokerVerboseOnce(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, broker);
}

// Verbose GET — reads are never identity-gated (matching fetchBroker) but
// still fail loudly with status + broker instead of collapsing to null.
async function fetchBrokerVerbose(path) {
  await recoverProjectRoute();
  let result = await requestBrokerVerboseOnce(path, {}, effectiveBrokerUrl);
  if (!result.ok && result.retriable && !IS_TEAM_MODE && !reResolveUsed) {
    reResolveUsed = true;
    await resolveBrokerUrl("re-resolve-after-failure");
    result = await requestBrokerVerboseOnce(path, {}, effectiveBrokerUrl);
  }
  return result;
}

async function postBrokerVerbose(path, body) {
  await recoverProjectRoute();
  const send = async () => {
    const { broker, refusal } = await assertRouteIdentity();
    if (refusal) return { ok: false, refused: true, broker, error: refusal.reason };
    return postBrokerVerboseOnce(path, body, broker);
  };
  let result = await send();
  // Same one-per-session re-resolve as fetchBroker: the child resolved at
  // startup may have moved ports or died. Still fails loudly if the retry fails.
  if (!result.ok && result.retriable && !IS_TEAM_MODE && !reResolveUsed) {
    reResolveUsed = true;
    await resolveBrokerUrl("re-resolve-after-failure");
    result = await send();
  }
  return result;
}

async function fireAndForget(path, body) {
  postBroker(path, body).catch(() => {});
}`
}

function generateConfigCache(): string {
  return `let cachedConfig = null;
let cachedConfigAt = 0;
let cachedConfigBroker = null;

async function getInjectionConfig() {
  await recoverProjectRoute();
  const now = Date.now();
  if (cachedConfig && cachedConfigBroker === effectiveBrokerUrl && now - cachedConfigAt < CONFIG_CACHE_TTL_MS) {
    return cachedConfig;
  }
  const requestedBroker = effectiveBrokerUrl;
  const result = await fetchBroker("/api/extension/config");
  if (result && requestedBroker === effectiveBrokerUrl) {
    cachedConfig = result;
    cachedConfigAt = now;
    cachedConfigBroker = requestedBroker;
  }
  return result || (cachedConfigBroker === effectiveBrokerUrl ? cachedConfig : null) ||
    { contextInjectionEnabled: false };
}`
}

function generateForwardFunction(): string {
  return `function forwardHook(hookName, input, sessionId) {
  // Issue #70: capture identity from ANY hook invocation, not just
  // onSessionStart — a session whose start callback never fired must still
  // bind its id before event listeners emit (else they report sessionId:null
  // and the broker rejects the hook with a 400). The cwd is captured too so
  // a heartbeat-path re-register carries the session's REAL working_dir
  // instead of letting the broker guess one.
  if (!extensionSessionId && sessionId) extensionSessionId = sessionId;
  if (!extensionCwd && input && input.cwd) extensionCwd = input.cwd;
  const eventMap = {
    onSessionStart: "session-start",
    onSessionEnd: "session-end",
    onPreToolUse: "pre-tool-use",
    onPostToolUse: "post-tool-use",
    onUserPromptSubmitted: "user-prompt",
    onErrorOccurred: "error",
  };
  const event = eventMap[hookName] || "tool-use";
  const timestamp = input.timestamp
    ? new Date(input.timestamp).toISOString()
    : new Date().toISOString();

  fireAndForget("/api/hooks/" + event, {
    event,
    sessionId,
    timestamp,
    tool: input.toolName,
    toolArgs: input.toolArgs ? JSON.stringify(input.toolArgs) : undefined,
    toolResult: input.toolResult?.textResultForLlm,
    errorMessage: input.error,
    metadata: {
      hookName,
      cwd: input.cwd,
      prompt: input.prompt ? input.prompt.slice(0, 500) : undefined,
      source: input.source,
      reason: input.reason,
    },
  });
}

let extensionSessionId = null;
let extensionCwd = null;

// The id the broker knows this session by: env-pinned in team mode,
// hook-captured otherwise (null until any hook has fired).
function effectiveSessionId() {
  return IS_TEAM_MODE ? SCNS_SESSION_ID : extensionSessionId;
}`
}

function generateHooks(contextInjection: boolean): string {
  const contextHook = contextInjection
    ? `
      // Context injection always enabled
      {
        const ctx = await postBroker("/api/extension/context", {
          prompt: input.prompt,
          cwd: input.cwd,
          sessionId: invocation.sessionId,
          clientTimeoutMs: TIMEOUT_MS,
        });
        if (ctx?.additionalContext) {
          contextParts.push(ctx.additionalContext);
        }
      }`
    : `
      // Context injection (opt-in via broker config)
      const config = await getInjectionConfig();
      if (config.contextInjectionEnabled) {
        const ctx = await postBroker("/api/extension/context", {
          prompt: input.prompt,
          cwd: input.cwd,
          sessionId: invocation.sessionId,
          clientTimeoutMs: TIMEOUT_MS,
        });
        if (ctx?.additionalContext) {
          contextParts.push(ctx.additionalContext);
        }
      }`

  return `    onSessionStart: async (input, invocation) => {
      extensionSessionId = invocation.sessionId;
      forwardHook("onSessionStart", input, invocation.sessionId);
      if (IS_TEAM_MODE) {
        await postBroker('/api/register', { id: SCNS_SESSION_ID, purpose: 'team-agent' });
        await postBroker('/api/teams/' + SCNS_TEAM_ID + '/members', {
          session_id: SCNS_SESSION_ID,
          name: SCNS_SESSION_ID,
          role: SCNS_ROLE,
        });
      }
    },
    onSessionEnd: async (input, invocation) => {
      forwardHook("onSessionEnd", input, invocation.sessionId);
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (IS_TEAM_MODE) {
        await postBroker('/api/deregister/' + SCNS_SESSION_ID, {});
      }
    },
    onUserPromptSubmitted: async (input, invocation) => {
      forwardHook("onUserPromptSubmitted", input, invocation.sessionId);
      // Issue #70: contexts ACCUMULATE — mailbox delivery must never be
      // overwritten by (or overwrite) memory-context injection.
      const contextParts = [];
      const sid = effectiveSessionId();
      if (sid) {
        // The mailbox route returns { messages: [...] } — consume the
        // envelope, not a bare array (issue #70: the old messages?.length
        // check silently discarded every real response).
        const mailbox = await fetchBroker('/api/messages/' + encodeURIComponent(sid) + '?unread_only=true');
        const mail = mailbox && Array.isArray(mailbox.messages) ? mailbox.messages : [];
        if (mail.length) {
          contextParts.push('Unread SCNS messages for this session: ' + JSON.stringify(mail));
          // Delivery receipt for DIRECTED mail only — broadcasts keep
          // per-recipient semantics and are never collapsed to one flag.
          const directedIds = mail.filter((m) => m.receiver_id === sid).map((m) => m.id);
          if (directedIds.length) {
            fireAndForget('/api/messages/mark-delivered', { message_ids: directedIds, receiver_id: sid });
          }
        }
      }
      if (IS_TEAM_MODE) {
        const teamStatus = await fetchBroker('/api/teams/' + encodeURIComponent(SCNS_TEAM_ID));
        if (teamStatus?.members) {
          contextParts.push('Team members: ' + JSON.stringify(teamStatus.members));
        }
      }
${contextHook}
      if (contextParts.length) {
        return { additionalContext: contextParts.join('\\n') };
      }
    },
    onPreToolUse: async (input, invocation) => {
      forwardHook("onPreToolUse", input, invocation.sessionId);
    },
    onPostToolUse: async (input, invocation) => {
      forwardHook("onPostToolUse", input, invocation.sessionId);
    },
    onErrorOccurred: async (input, invocation) => {
      forwardHook("onErrorOccurred", input, invocation.sessionId);
    },`
}

/**
 * Generated handler body per tool name. Definitions (name/description/
 * parameters) come from TOOL_DEFINITIONS; only the extension-side handler
 * source lives here. A definition without a handler — or a handler without a
 * definition — fails generation (see {@link generateTools}).
 */
const EXTENSION_TOOL_HANDLERS: Record<string, string> = {
  scns_memory_search: `async (args) => {
        const q = encodeURIComponent(String(args.query || ""));
        const topK = Number(args.top_k) || 5;
        const result = await fetchBroker("/api/memory/search?q=" + q + "&top_k=" + topK);
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_memory_store: `async (args) => {
        if (STRICT_PROJECT_BROKER && brokerRouteLabel.startsWith("global:")) {
          await recoverProjectRoute();
        }
        const refusal = strictStoreRefusal();
        if (refusal) return JSON.stringify(refusal);
        const result = await postBroker("/api/memory/store", {
          key: String(args.key || ""),
          value: String(args.value || ""),
        });
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_memory_delete: `async (args) => {
        if (STRICT_PROJECT_BROKER && brokerRouteLabel.startsWith("global:")) {
          await recoverProjectRoute();
        }
        // A delete on the wrong route is worse than a write on the wrong route: it removes
        // someone else's memory. Reuse the same strict-routing guard and refuse identically.
        const refusal = strictStoreRefusal();
        if (refusal) {
          return JSON.stringify({ applied: false, refused: true, reason: refusal.reason });
        }
        const path = String(args.path || "");
        if (!path) {
          return JSON.stringify({ applied: false, error: "path is required" });
        }
        const result = await postBroker("/api/memory/delete", {
          path: path,
          apply: args.apply === true,
          hard: args.hard === true,
          allow_pinned: args.allow_pinned === true,
        });
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_suggestions: `async (args) => {
        const status = String(args.status || "pending");
        const result = await fetchBroker("/api/suggestions?status=" + encodeURIComponent(status));
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_status: `async () => {
        const [observers, autonomy] = await Promise.all([
          fetchBroker("/api/observers"),
          fetchBroker("/api/autonomy"),
        ]);
        return JSON.stringify({
          observers: observers || { error: "unavailable" },
          autonomy: autonomy || { error: "unavailable" },
        });
      }`,
  scns_report_negative_feedback: `async (args) => {
        const body = { feedback: String(args.feedback || "") };
        if (args.context) body.context = String(args.context);
        if (args.category) body.category = String(args.category);
        if (args.target) body.target = String(args.target);
        if (args.severity) body.severity = String(args.severity);
        if (extensionSessionId) body.sessionId = extensionSessionId;
        // Transport signal: a spawned team agent's feedback must never be
        // classified as human-authored (it would mint High brain tasks).
        body.transportOrigin = IS_TEAM_MODE ? "team-agent" : "interactive";
        const res = await postBrokerVerbose("/api/memory/negative", body);
        if (!res.ok) {
          // Human feedback must NEVER be silently dropped: name the broker
          // that failed and instruct the model to tell the user.
          return JSON.stringify({
            stored: false,
            error: "FEEDBACK NOT STORED — broker " + res.broker + " (" + brokerRouteLabel + ") did not accept it: " + res.error + ". Tell the user their feedback was NOT recorded.",
          });
        }
        return JSON.stringify({
          stored: true,
          storedAt: brokerRouteLabel + " @ " + res.broker,
          ...(res.body || {}),
        });
      }`,
  scns_send_message: `async (args) => {
        const body = { sender_id: String(args.sender_id || ""), content: String(args.content || "") };
        if (args.receiver_id) body.receiver_id = String(args.receiver_id);
        if (args.client_message_id) body.client_message_id = String(args.client_message_id);
        // Issue #70: fail loudly with the real status/error class — a 404
        // unknown participant, a 409 conflicting retry, and a dead broker are
        // different problems with different fixes.
        const res = await postBrokerVerbose("/api/messages", body);
        if (!res.ok) {
          return JSON.stringify({
            sent: false,
            broker: res.broker,
            status: res.status ?? null,
            error: res.error,
            detail: (res.body && res.body.error) || null,
          });
        }
        // Broker acceptance is NOT delivery or acknowledgement — the receiver
        // must still read it and return an explicit disposition.
        return JSON.stringify({ sent: true, accepted_not_yet_delivered: true, ...res.body });
      }`,
  scns_read_messages: `async (args) => {
        const receiverId = encodeURIComponent(String(args.receiver_id || ""));
        const qs = args.unread_only ? "?unread_only=true" : "";
        const res = await fetchBrokerVerbose("/api/messages/" + receiverId + qs);
        if (!res.ok) {
          return JSON.stringify({ broker: res.broker, status: res.status ?? null, error: res.error });
        }
        return JSON.stringify(res.body);
      }`,
  scns_ack_message: `async (args) => {
        const res = await postBrokerVerbose("/api/messages/ack", {
          message_id: String(args.message_id || ""),
          disposition: String(args.disposition || ""),
          note: args.note ? String(args.note) : null,
        });
        if (!res.ok) {
          return JSON.stringify({
            acknowledged: false,
            broker: res.broker,
            status: res.status ?? null,
            error: res.error,
          });
        }
        return JSON.stringify({ acknowledged: true, ...res.body });
      }`,
  scns_team_status: `async (args) => {
        const teamId = encodeURIComponent(String(args.team_id || ""));
        const result = await fetchBroker("/api/teams/" + teamId);
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_declare_intent: `async (args) => {
        const body = { session_id: String(args.session_id || ""), file: String(args.file || "") };
        if (args.operation) body.operation = String(args.operation);
        const result = await postBroker("/api/declare_intent", body);
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_release_intent: `async (args) => {
        const result = await postBroker("/api/release_intent", {
          session_id: String(args.session_id || ""),
          file: String(args.file || ""),
        });
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_set_state: `async (args) => {
        const body = { key: String(args.key || ""), value: String(args.value || "") };
        if (args.session_id) body.session_id = String(args.session_id);
        const result = await postBroker("/api/state", body);
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_get_state: `async (args) => {
        const key = encodeURIComponent(String(args.key || ""));
        const result = await fetchBroker("/api/state/" + key);
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_report_progress: `async (args) => {
        const senderId = String(args.sender_id || "");
        const content = "PROGRESS: " + String(args.progress || "");
        // Team-scoped: find sender's team and send direct to each teammate
        if (IS_TEAM_MODE && SCNS_TEAM_ID) {
          const teamData = await fetchBroker("/api/teams/" + encodeURIComponent(SCNS_TEAM_ID));
          if (teamData?.members) {
            for (const member of teamData.members) {
              if (member.session_id !== senderId) {
                await postBroker("/api/messages", {
                  sender_id: senderId,
                  receiver_id: member.session_id,
                  content: content,
                });
              }
            }
            return JSON.stringify({ sent: true, team_id: SCNS_TEAM_ID, recipients: teamData.members.length - 1 });
          }
        }
        // Fallback for non-team mode
        const result = await postBroker("/api/messages", { sender_id: senderId, content: content });
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_heartbeat: `async (args) => {
        const result = await postBroker("/api/heartbeat", {
          session_id: String(args.session_id || ""),
        });
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_list_teams: `async (args) => {
        const status = String(args.status || "active");
        const result = await fetchBroker("/api/teams?status=" + encodeURIComponent(status));
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_list_intents: `async (args) => {
        const params = new URLSearchParams();
        if (args.file) params.set("file", String(args.file));
        if (args.session_id) params.set("session_id", String(args.session_id));
        const qs = params.toString();
        const result = await fetchBroker("/api/intents" + (qs ? "?" + qs : ""));
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_create_task: `async (args) => {
        const body = { team_id: String(args.team_id || ""), subject: String(args.subject || "") };
        if (args.description) body.description = String(args.description);
        const result = await postBroker("/api/tasks", body);
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_list_tasks: `async (args) => {
        const teamId = encodeURIComponent(String(args.team_id || ""));
        const status = args.status ? "&status=" + encodeURIComponent(String(args.status)) : "";
        const result = await fetchBroker("/api/tasks?team_id=" + teamId + status);
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
  scns_update_task: `async (args) => {
        const taskId = Number(args.task_id);
        const body = {};
        if (args.status) body.status = String(args.status);
        if (args.description) body.description = String(args.description);
        const result = await fetchBroker("/api/tasks/" + taskId, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return result ? JSON.stringify(result) : JSON.stringify({ error: "SCNS broker unavailable", available: false });
      }`,
}

function generateTools(): string {
  const orphanHandlers = Object.keys(EXTENSION_TOOL_HANDLERS).filter(
    (name) => !TOOL_DEFINITIONS.some((def) => def.name === name),
  )
  if (orphanHandlers.length > 0) {
    throw new ValidationError(
      `Extension handlers with no TOOL_DEFINITIONS entry (dead code): ${orphanHandlers.join(', ')}`,
    )
  }
  return TOOL_DEFINITIONS.map((def) => {
    const handler = EXTENSION_TOOL_HANDLERS[def.name]
    if (!handler) {
      throw new ValidationError(
        `Tool '${def.name}' is in TOOL_DEFINITIONS but has no extension handler — add it to EXTENSION_TOOL_HANDLERS`,
      )
    }
    return `    {
      name: ${JSON.stringify(def.name)},
      description: ${JSON.stringify(def.description)},
      parameters: ${JSON.stringify(def.parameters)},
      handler: ${handler},
    },`
  }).join('\n')
}

function generateEventListeners(): string {
  return `session.on("tool.execution_start", (event) => {
  fireAndForget("/api/hooks/tool-use", {
    event: "tool-use",
    sessionId: extensionSessionId,
    timestamp: new Date().toISOString(),
    tool: event.data.toolName,
    toolArgs: event.data.arguments ? JSON.stringify(event.data.arguments) : undefined,
    metadata: {
      eventType: "tool.execution_start",
      toolCallId: event.data.toolCallId,
    },
  });
});

session.on("tool.execution_complete", (event) => {
  fireAndForget("/api/hooks/tool-use", {
    event: "tool-use",
    sessionId: extensionSessionId,
    timestamp: new Date().toISOString(),
    tool: event.data.toolName,
    toolResult: event.data.success ? String(event.data.result || "").slice(0, 500) : undefined,
    errorMessage: event.data.error ? String(event.data.error).slice(0, 500) : undefined,
    metadata: {
      eventType: "tool.execution_complete",
      toolCallId: event.data.toolCallId,
      success: event.data.success,
    },
  });
});

session.on("session.shutdown", (event) => {
  fireAndForget("/api/hooks/session-end", {
    event: "session-end",
    sessionId: extensionSessionId,
    timestamp: new Date().toISOString(),
    metadata: {
      eventType: "session.shutdown",
      shutdownType: event.data.shutdownType,
      totalPremiumRequests: event.data.totalPremiumRequests,
    },
  });
});`
}
