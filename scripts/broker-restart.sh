#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Blue/Green Broker Restart — Daily maintenance script
#
# Usage:
#   broker-restart.sh              # Full restart flow (default)
#   broker-restart.sh rollback     # Re-bootstrap the blue plist (recovery)
#
# Sequence (full restart):
#   Phase 1: Pre-restart  — dream consolidation + housekeeping (no VACUUM)
#   Phase 2: Canary       — start isolated canary on temp port, health check
#   Phase 3: Drain        — tell blue broker to reject new work
#   Phase 4: Stop blue    — launchctl bootout (SIGTERM → graceful shutdown)
#   Phase 5: Restart      — launchctl kickstart -k (socket-preserving in-place
#                           restart; with a Sockets-key plist launchd keeps the
#                           socket bound → kernel queues connections, 0 dropped)
#   Phase 6: Verify       — health check fresh broker; rollback on failure
#
# The canary step validates the binary starts cleanly before
# killing the production broker. Uses isolated data dir/DB
# to avoid touching real state.
#
# Exit codes:
#   0 — success
#   1 — canary failed (blue still running, no restart)
#   2 — fresh broker failed health check AND rollback also failed
#   3 — fresh broker failed health check but rollback recovered blue
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# ── Configuration ────────────────────────────────────────────

MAIN_PORT="${BROKER_PORT:-3456}"
CANARY_PORT=$((MAIN_PORT + 1))
# PLIST_LABEL / PLIST_PATH are overridable so the live soak harness can
# point at an isolated `com.scns.soak` plist without touching the real
# `com.scns.broker` installation.
PLIST_LABEL="${PLIST_LABEL:-com.scns.broker}"
PLIST_PATH="${PLIST_PATH:-${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist}"
SCNS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
LOG_FILE="${BROKER_RESTART_LOG:-${HOME}/.scns/logs/restart.log}"
MAX_WAIT=30  # seconds for health checks
PREPARE_TIMEOUT=120  # seconds for dream + housekeeping
DRAIN_TIMEOUT=30  # seconds to wait for active requests to complete

# Auth header (set BROKER_TOKEN to match the broker's BROKER_TOKEN env var).
#
# IMPORTANT (bash 3.2 on macOS + `set -u`): `"${AUTH_ARGS[@]}"` on an empty
# array is treated as an unbound-variable reference and aborts the top-level
# shell. That regression caused the nightly blue/green restart to die right
# after logging "Phase 4: Draining blue broker" every night from 2026-04-18
# onward. All expansions below use the `${arr[@]+"${arr[@]}"}` idiom which
# evaluates to nothing when the array is empty and is safe under `set -u`.
AUTH_ARGS=()
if [ -n "${BROKER_TOKEN:-}" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${BROKER_TOKEN}")
fi

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# ── Helpers ──────────────────────────────────────────────────

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo "$msg" | tee -a "$LOG_FILE"
}

health_check() {
  local port=$1
  local max_wait=$2
  local endpoint="${3:-/health/ready}"
  for i in $(seq 1 "$max_wait"); do
    if curl -sf "http://localhost:${port}${endpoint}" > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Poll /api/admin/health until activeRequestCount == 0 or timeout expires.
# Returns 0 if drained cleanly, 1 on timeout.
wait_for_drain() {
  local port=$1
  local max_wait=$2
  local active=0
  for i in $(seq 1 "$max_wait"); do
    local health
    health=$(curl -sf "http://localhost:${port}/api/admin/health" ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} 2>/dev/null || echo '{}')
    active=$(echo "$health" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(int(d.get('activeRequestCount', 0)))
except Exception:
    print(0)
" 2>/dev/null || echo "0")
    if [ "$active" = "0" ]; then
      log "Drain complete after ${i}s (active=0)"
      return 0
    fi
    if [ "$((i % 5))" = "0" ]; then
      log "Drain waiting: ${active} active request(s) after ${i}s"
    fi
    sleep 1
  done
  log "WARNING: Drain timed out after ${max_wait}s with ${active} active request(s); proceeding"
  return 1
}

# Rollback: re-bootstrap the blue plist. Used on green failure or via
# `broker-restart.sh rollback` subcommand.
rollback() {
  log "════════════════════════════════════════"
  log "ROLLBACK: Re-bootstrapping blue from $PLIST_PATH"
  log "════════════════════════════════════════"

  # Ensure any current instance is booted out first (idempotent).
  launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
  sleep 2

  if ! launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null; then
    log "ROLLBACK: First bootstrap attempt failed, retrying in 2s"
    sleep 2
    if ! launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null; then
      log "ROLLBACK ERROR: Second bootstrap attempt also failed"
      return 1
    fi
  fi

  if health_check "$MAIN_PORT" "$MAX_WAIT"; then
    log "ROLLBACK: Blue broker healthy after rollback ✓"
    return 0
  fi

  log "ROLLBACK ERROR: Blue broker did not become healthy after ${MAX_WAIT}s"
  return 1
}

cleanup_canary() {
  if [ -n "${CANARY_PID:-}" ]; then
    kill "$CANARY_PID" 2>/dev/null || true
    wait "$CANARY_PID" 2>/dev/null || true
  fi
  if [ -n "${CANARY_DATA_DIR:-}" ] && [ -d "${CANARY_DATA_DIR}" ]; then
    rm -rf "$CANARY_DATA_DIR"
  fi
  if [ -n "${CANARY_DB_DIR:-}" ] && [ -d "${CANARY_DB_DIR}" ]; then
    rm -rf "$CANARY_DB_DIR"
  fi
}

trap cleanup_canary EXIT

# ── Subcommand dispatch ──────────────────────────────────────

if [ "${1:-}" = "rollback" ]; then
  if rollback; then
    exit 0
  else
    exit 2
  fi
fi

# ── Phase 1: Pre-restart (dream + housekeeping) ─────────────

log "════════════════════════════════════════"
log "Blue/Green Restart Starting"
log "════════════════════════════════════════"

log "Phase 1: Running dream + housekeeping on blue (port $MAIN_PORT)"

PREPARE_RESULT=$(curl -sf -X POST \
  "http://localhost:${MAIN_PORT}/api/admin/prepare-restart" \
  -H 'Content-Type: application/json' \
  ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} \
  --max-time "$PREPARE_TIMEOUT" 2>&1) || {
  log "WARNING: Pre-restart preparation curl failed — proceeding (non-blocking)"
  PREPARE_RESULT='{"error":"curl_failed"}'
}

# Extract success status from JSON
PREPARE_SUCCESS=$(echo "$PREPARE_RESULT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print('true' if d.get('success') else 'false')
except:
    print('false')
" 2>/dev/null || echo "false")

# Extract failure reason (if any) so the log names the failing sub-step
# rather than a generic "preparation failed". Phase 7 is the authoritative
# gate; Phase 1 failures here are warnings only and do NOT block restart.
PREPARE_REASON=$(echo "$PREPARE_RESULT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    steps = d.get('steps') or {}
    failed = [name for name, v in steps.items() if isinstance(v, dict) and v.get('success') is False]
    if failed:
        print(','.join(failed))
    elif d.get('error'):
        print(d['error'])
    else:
        print('unknown')
except Exception:
    print('parse_error')
" 2>/dev/null || echo "parse_error")

if [ "$PREPARE_SUCCESS" = "true" ]; then
  log "Phase 1 result: success=true"
else
  log "Phase 1 result: success=false (reason=${PREPARE_REASON}) — non-blocking, continuing"
fi

# ── Phase 2: Canary (isolated validation) ────────────────────

log "Phase 2: Starting canary broker on port $CANARY_PORT"

CANARY_DATA_DIR=$(mktemp -d -t scns-canary-XXXXXX)
CANARY_DB_DIR=$(mktemp -d -t scns-canary-db-XXXXXX)

SCNS_DATA_DIR="$CANARY_DATA_DIR" \
BROKER_DB_PATH="${CANARY_DB_DIR}/canary.db" \
SCNS_LOG_LEVEL="warn" \
  "$NODE_BIN" "$SCNS_DIR/dist/cli.js" start \
    --port "$CANARY_PORT" \
    --autonomy 0 \
  > "${CANARY_DATA_DIR}/canary.log" 2>&1 &
CANARY_PID=$!

log "Phase 2: Canary PID=$CANARY_PID, data=$CANARY_DATA_DIR"

# ── Phase 3: Health check canary ─────────────────────────────

log "Phase 3: Health checking canary (max ${MAX_WAIT}s)"

if ! health_check "$CANARY_PORT" "$MAX_WAIT"; then
  log "ERROR: Canary failed health check after ${MAX_WAIT}s"
  log "ERROR: Aborting restart — blue broker stays running"
  log "Canary log:"
  cat "${CANARY_DATA_DIR}/canary.log" >> "$LOG_FILE" 2>/dev/null || true
  exit 1
fi

log "Phase 3: Canary healthy ✓"

# Kill canary — it was just for validation
cleanup_canary
CANARY_PID=""
CANARY_DATA_DIR=""
CANARY_DB_DIR=""

# ── Phase 4: Drain blue ─────────────────────────────────────

log "Phase 4: Draining blue broker"

curl -sf -X POST "http://localhost:${MAIN_PORT}/api/admin/drain" \
  -H 'Content-Type: application/json' \
  ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} \
  --max-time 5 > /dev/null 2>&1 || true

# Poll for active requests to drain (up to DRAIN_TIMEOUT seconds).
DRAIN_START=$(date +%s)
if wait_for_drain "$MAIN_PORT" "$DRAIN_TIMEOUT"; then
  DRAIN_ELAPSED=$(( $(date +%s) - DRAIN_START ))
  log "Phase 4: Drain finished cleanly (waited=${DRAIN_ELAPSED}s)"
else
  DRAIN_ELAPSED=$(( $(date +%s) - DRAIN_START ))
  log "Phase 4: Drain timed out (waited=${DRAIN_ELAPSED}s) — proceeding anyway"
fi

# ── Phase 4.5: Snapshot agents for recovery ──────────────────

log "Phase 4.5: Snapshotting active agents for recovery"

SNAPSHOT_RESULT=$(curl -sf -X POST \
  "http://localhost:${MAIN_PORT}/api/admin/snapshot-agents" \
  -H 'Content-Type: application/json' \
  ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} \
  --max-time 10 2>&1) || {
  log "WARNING: Agent snapshot failed — agents will not be recovered after restart (non-blocking)"
  SNAPSHOT_RESULT='{"count":0}'
}

SNAPSHOT_COUNT=$(echo "$SNAPSHOT_RESULT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('count', 0))
except:
    print(0)
" 2>/dev/null || echo "0")

log "Phase 4.5 result: ${SNAPSHOT_COUNT} agents snapshotted"

# ── Phase 5/6: Restart via launchd socket-preserving kickstart ──────
#
# `launchctl kickstart -k` restarts the broker process IN PLACE while launchd
# keeps the (socket-activated) listening socket bound. With a broker plist that
# declares `Sockets → Listeners` (see `scns service generate-broker-plist`), the
# kernel queues incoming connections during the swap → ZERO dropped connections,
# with no port-rebind gap and no fixed sleep. If the installed plist lacks the
# Sockets key this is still a faster, atomic restart than bootout→sleep→bootstrap.

log "Phase 5: Restarting broker in place (launchctl kickstart -k ${PLIST_LABEL})"

if ! launchctl kickstart -k "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null; then
  log "WARNING: kickstart failed (job may not be bootstrapped) — falling back to bootstrap"
  # Job not loaded (e.g., fresh machine / after a manual bootout). Bootstrap it.
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || {
    log "ERROR: fallback bootstrap also failed"
    exit 2
  }
fi

# ── Phase 7: Verify fresh broker ─────────────────────────────

log "Phase 7: Health checking fresh broker (max ${MAX_WAIT}s)"

if health_check "$MAIN_PORT" "$MAX_WAIT"; then
  # Also verify admin health endpoint is responsive
  ADMIN_HEALTH=$(curl -sf "http://localhost:${MAIN_PORT}/api/admin/health" 2>/dev/null || echo '{}')
  log "Phase 7: Fresh broker healthy ✓"
  log "Admin health: $ADMIN_HEALTH"
  log "════════════════════════════════════════"
  log "Blue/Green Restart Complete"
  log "════════════════════════════════════════"
  exit 0
else
  log "ERROR: Fresh broker failed health check after ${MAX_WAIT}s"
  log "ERROR: Check broker logs at ~/.scns/logs/broker.log"
  log "Attempting automatic rollback to blue..."
  if rollback; then
    log "Rollback succeeded — blue broker restored"
    exit 3
  fi
  log "Rollback FAILED — manual intervention required"
  exit 2
fi
