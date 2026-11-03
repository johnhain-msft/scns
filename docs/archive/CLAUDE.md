# SCNS — Second Central Nervous System

## What This Is

An autonomous AI agent system: second brain (persistent memory, hybrid search, AutoDream consolidation) + nervous system (session broker, multi-agent teams, observation layer, progressive autonomy).

## Architecture

- `src/shared/` — Types, errors, logger (Pino), config (Zod), sanitization
- `src/memory/` — File vault + SQLite hybrid search (sqlite-vec + FTS5)
- `src/broker/` — Session broker (Express 5 + MCP), heartbeats, teams, message bus
- `src/dream/` — AutoDream consolidation daemon
- `src/observe/` — Observation layer (Claude hooks + computer activity + plugin system + cross-source correlation)
- `src/brain/` — Brain agent (wake → observe → decide → act)
- `src/rate-limit/` — Rate limit detection + exponential backoff
- `src/context/` — Context health monitoring + rotation
- `src/autonomy/` — Progressive autonomy (L0-L3) + guardrails
- `src/suggest/` — Suggestion pipeline (extractors → confidence scoring → review → artifact generation)
- `src/otel/` — OTel telemetry ingestion, session digests, pattern extraction
- `src/copilot-extension/` — Copilot CLI integration (event forwarding, context injection, SCNS tools, extension template)
- `src/cli.ts` — Commander.js CLI entry point
- `src/cli/` — CLI subcommand helpers (service generators, extension installer, hooks setup)

## Commands

```bash
npm run build        # TypeScript compilation
npm test             # Unit + integration tests (vitest)
npm run test:unit    # Unit tests only
npm run test:integration  # Integration tests only
npm run test:e2e     # End-to-end tests
npm run test:coverage # Tests with coverage report
npm run lint         # ESLint check
npm run lint:fix     # ESLint auto-fix
npm run format       # Prettier format
npm run typecheck    # Type check without emitting
```

## Tech Stack

TypeScript 5.8 (ESM strict), Node.js 22, Express 5, MCP SDK, better-sqlite3 + sqlite-vec, FastEmbed, Zod, Pino, Vitest, Commander.js

## Conventions

- ESM modules (`.js` extensions in imports)
- Immutable data patterns (spread, never mutate)
- Zod for all external input validation
- Pino for logging (never console.log)
- Vitest for testing, 80% coverage minimum
- TDD: write tests first, implement to pass
- Conventional commits: feat/fix/refactor/test/chore/docs

### API Response Conventions

All broker REST endpoints follow these patterns:

- **GET collection** → `{ <name>: [...] }` (e.g., `{ sessions: [...] }`, `{ tasks: [...] }`)
- **GET single resource** → bare object (e.g., the session/task/team object directly)
- **POST create** → `201` + `{ success: true, id: "..." }` or created object
- **POST action** → `{ success: true }` with optional metadata
- **Errors** → proper HTTP status code + `{ error: "message" }` (never 200 with error payload)
- **Unavailable service** → `503` + `{ error: "...", available: false }` or graceful fallback

## Testing

- `test/unit/` — Isolated unit tests
- `test/integration/` — Cross-module tests with real SQLite
- `test/e2e/` — Full system tests (real HTTP, real DB, real components)
- `test/stress/` — Load and concurrency tests
- `test/helpers/` — Test DB harness, fixtures, factories

### Testing Requirements

**All tests must verify real behavior, not mock plumbing:**

1. **No mocking the thing you're testing.** If a test is verifying that hook events persist to the database, it must use a real `EventLog` and query real SQLite — never `vi.fn()` on the handler being tested.

2. **E2E tests must start real components.** E2E tests create a real broker server (in-memory SQLite + Express), a real `ObservationManager`, and send real HTTP requests. They verify data persists by querying the DB directly.

3. **Verify side effects, not just responses.** A 200 OK from an endpoint is necessary but not sufficient. Tests must verify:
   - Data actually persists to the correct SQLite table
   - Sessions auto-register when expected
   - Events appear in `/api/events/since`
   - Dashboard endpoints return real data (not degraded "not available" responses)

4. **Test the wiring, not just the units.** Integration tests must verify that components are actually connected at startup — that deps flow from `cli.ts` → `startBroker()` → `createBrokerServer()` → route handlers. A unit test passing with injected mocks does not prove the system works.

5. **Live verification before claiming "it works".** After any change to broker routes, startup wiring, or event handling:
   ```bash
   npm run build
   node dist/cli.js start --autonomy 0 &
   # Wait for "Broker listening on port 3456"
   
   # Verify hooks persist:
   curl -s -X POST http://localhost:3456/api/hooks/session-start \
     -H 'Content-Type: application/json' \
     -d '{"event":"session-start","sessionId":"test-1","timestamp":"2025-01-01T00:00:00Z"}'
   
   # Verify session auto-registered:
   curl -s http://localhost:3456/api/list_sessions | grep test-1
   
   # Verify event persisted:
   curl -s http://localhost:3456/api/events/since/0 | grep hook_received
   
   # Verify dashboard not degraded:
   curl -s http://localhost:3456/api/observers  # Should return observer list, not error
   curl -s http://localhost:3456/api/suggestions?status=pending  # Should return array, not error
   ```

6. **Avoid weak assertions.** Prefer `toBe()`, `toEqual()`, `toContain()` over `toBeTruthy()`. The assertion should fail if the behavior is wrong, not just if the value is falsy.

7. **Regression testing is mandatory.** After any set of changes — before committing:
   - Run the **full test suite**: `npm test` (unit + integration)
   - Run **e2e tests**: `npm run test:e2e`
   - Run **dashboard tests**: `cd dashboard && npm test`
   - **Start the live broker** and verify the dashboard renders live sessions, not blank/error states
   - If changes touch broker routes, schemas, or startup wiring, verify the dashboard at `http://localhost:3001` shows sessions, observers, and suggestions (broker API at localhost:3456)
   - Never rely solely on unit tests passing — they test isolated units, not the assembled system

8. **Never write to real user config in tests.** Tests that generate or execute plans (e.g., executor tests) must use temp directories for all file I/O. Use options like `configBaseDir`, `skillsDir`, `automationsDir` pointed at `mkdtempSync()` paths. Writing to `~/.copilot/`, `~/.scns/`, or any real config path from a test is a critical bug.

### Mandatory Manual Verification

**Automated tests are necessary but NOT sufficient.** Every change must be manually verified before claiming it works. You have powerful tools — use them.

- **Backend changes:** Start the broker, `curl` every affected endpoint, verify response bodies have correct data (not just 200 OK)
- **Frontend/Dashboard changes:** Start the dashboard, open it in a browser, take screenshots (`screencapture` on macOS), actually LOOK at them for layout issues, empty states, error messages
- **CLI changes:** Run the command with real inputs, verify output
- **Never fabricate verification evidence.** If you claim you took a screenshot, the file must exist. If you claim you tested an endpoint, show the command and response.
- **Never say "it should work" — prove it works.**

### Completion Workflow

Think of every task as a story in a sprint. Before declaring any work "done":

1. **Plan** — finalize acceptance criteria and approach
2. **Implement** — write the code (TDD: tests first)
3. **Automated tests** — `npm test` + `npm run test:e2e` must all pass
4. **Manual regression** — start the live system, test every affected feature manually
5. **Quality gate** — run `/quality-gate` on completed phases
6. **Declare done** — only after steps 1-5 pass. This is "pushed to prod"

You would never release software without running all tests AND manually verifying — so don't tell the user you're done until you've completed the full workflow.

## Documentation

- `docs/modules.md` — All module documentation: architecture, key files, exports, dependencies
- `docs/observer-plugins.md` — Observer plugin system: interface, lifecycle, configuration, testing, examples
- `docs/copilot-integration.md` — Copilot CLI integration: extension, hooks, context injection

## Environment Variables

All configuration uses Zod schemas with sensible defaults. The system works out-of-the-box with no env vars set.

| Variable | Default | Description |
|----------|---------|-------------|
| `BROKER_PORT` | `3456` | Session broker HTTP port |
| `BROKER_TOKEN` | _(none)_ | Bearer token for API auth (disabled if empty) |
| `BROKER_DB_PATH` | `~/.session-broker/data.db` | SQLite database path |
| `BROKER_HEARTBEAT_INTERVAL_MS` | `10000` | Heartbeat poll interval |
| `BROKER_HEARTBEAT_TIMEOUT_MS` | `20000` | Heartbeat timeout before warning |
| `BROKER_ZOMBIE_GRACE_MS` | `300000` | Grace period before zombie cleanup (5min) |
| `BROKER_AUTO_RESPAWN` | `true` | Auto-respawn failed agents |
| `BROKER_AUTO_SCALE` | `false` | Auto-scale teams based on load |
| `BROKER_MAX_RESPAWN_RETRIES` | `3` | Max respawn attempts per agent |
| `BROKER_RESPAWN_BACKOFF_BASE_MS` | `1000` | Base delay for respawn backoff |
| `SCNS_PORT` | `3456` | SCNS service port (alias for BROKER_PORT) |
| `SCNS_LOG_LEVEL` | `info` | Pino log level (trace/debug/info/warn/error) |
| `SCNS_DATA_DIR` | `~/.scns` | Data directory for state, autonomy, memory |
| `SCNS_MAX_CONCURRENT_SESSIONS` | `10` | Max concurrent managed sessions |
| `SCNS_YIELD_TO_USER` | `true` | Pause SCNS work when user is active |
| `OBSERVE_CHRONICLE_ENABLED` | `false` | Enable Chronicle file reader plugin |
| `OBSERVE_POLL_INTERVAL_MS` | `5000` | Observer polling interval |
| `OTEL_SCNS_ENABLED` | `false` | Enable OTel telemetry ingestion |
| `OTEL_SCNS_FILE_PATH` | _(none)_ | OTel JSONL file path (auto-enables ingestion) |
| `COPILOT_OTEL_FILE_EXPORTER_PATH` | _(none)_ | Copilot CLI telemetry export path (also auto-enables SCNS ingestion) |
| `NEXT_PUBLIC_BROKER_URL` | `http://localhost:3456` | Dashboard → Broker URL |
| `HISTORY_RETENTION_DAYS` | `30` | Days to retain event/team history |

## Data Directories

```
~/.session-broker/data.db     # Broker SQLite database
~/.scns/                      # SCNS data root
  state/autonomy.json         # Autonomy level persistence
  memory/                     # Memory vault files
~/.copilot/extensions/scns/   # Copilot CLI extension
~/.copilot/chronicle/         # Chronicle event files (if enabled)
```

## Key Design Decisions

- Runs on Claude Code Max plan (rate-limited, not per-token)
- SCNS yields to user's interactive sessions
- Progressive autonomy: L0 Observer → L1 Advisor → L2 Assistant → L3 Autonomous
- A2A integrated into broker as wire format (Phase 7)
- Dashboard deferred to Phase 9 (CLI-only through core phases)
- `references/` is read-only source material, not imported into build
