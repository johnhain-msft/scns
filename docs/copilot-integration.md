# Copilot CLI Integration

SCNS integrates with GitHub Copilot CLI through three complementary layers, each providing
progressively richer interaction. All layers are **opt-in** and degrade gracefully when the
broker is unavailable.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Copilot CLI                           │
│  ┌──────────────┐  ┌──────────┐  ┌────────────────────┐ │
│  │ Extension     │  │ Hooks    │  │ Session Store DB   │ │
│  │ (extension.mjs)│ │ (hooks.json)│ │(~/.copilot/        │ │
│  │ Layer 1       │  │ Layer 1b │  │ session-store.db)  │ │
│  └──────┬───────┘  └────┬─────┘  └────────┬───────────┘ │
└─────────┼───────────────┼─────────────────┼──────────────┘
          │ HTTP          │ curl            │ SQLite (read-only)
          ▼               ▼                 ▼
┌──────────────────────────────────────────────────────────┐
│                     SCNS Broker                          │
│  /api/events   /api/extension/config   /api/memory/*     │
│  /api/extension/context   /api/sessions                  │
└──────────────────────────────────────────────────────────┘
```

## Layer 1: Extension (Richest)

A standalone `.mjs` file installed into `~/.copilot/extensions/scns/extension.mjs`.
Uses the Copilot SDK to register hooks and tools.

### Features

- **Event forwarding**: All 6 SDK hooks (session start/end, user prompt, pre/post tool use,
  error) are forwarded to the broker as session events. The HTTP timeout is 5000 ms by
  default (`install-extension --timeout <ms>`; `TIMEOUT_MS` in the generated file).
- **Context injection**: When enabled, `onUserPromptSubmitted` queries the broker for
  relevant memories and suggestions, injecting them as hidden context the agent sees.
- **SCNS tools**: **21** tools exposed to the Copilot agent. The list below is generated
  from `src/copilot-extension/tool-definitions.ts` — that file is the source of truth.

  *Memory and status*
  - `scns_memory_search` — search the SCNS memory vault for context, facts, observations
  - `scns_memory_store` — store a fact or observation for future reference
  - `scns_memory_delete` — retract a memory: source file, index rows and managed instruction
    bullet together. Previews unless `apply=true`; refused on a global route, like a store
  - `scns_suggestions` — list pending SCNS suggestions
  - `scns_status` — system health, observer status, autonomy level, pattern counts
  - `scns_report_negative_feedback` — record a correction / "don't do X" signal

  *Agent-to-agent messaging*
  - `scns_send_message` — send a message to another agent
  - `scns_read_messages` — read messages for an agent (optionally unread-only)
  - `scns_ack_message` — record an explicit accepted/rejected/deferred disposition for a received message (issue #70: a send response is never an acknowledgement)
  - `scns_report_progress` — team-scoped progress update
  - `scns_heartbeat` — tell the broker this session is alive

  *Teams and coordination*
  - `scns_team_status` — team status including members and their states
  - `scns_list_teams` — list teams
  - `scns_declare_intent` — claim a file, preventing conflicts with other agents
  - `scns_release_intent` — release a previously declared file intent
  - `scns_list_intents` — list active file intents

  *Shared state*
  - `scns_set_state` / `scns_get_state` — shared key-value state in the broker

  *Tasks*
  - `scns_create_task` — create a task assigned to a team
  - `scns_list_tasks` — list a team's tasks, optionally filtered by status
  - `scns_update_task` — update a task's status or description

### Installation

```bash
# Install the extension (generates extension.mjs)
scns install-extension

# With a custom broker URL (default: http://localhost:3456)
scns install-extension --broker-url http://localhost:3456

# Remove the extension
scns uninstall-extension
```

### Context Injection

Context injection is **disabled by default in two independent places**. Either one alone
is enough to keep it off, so both matter:

1. **The generated extension.** Without `--context-injection`, the generated
   `extension.mjs` asks the broker on each prompt whether injection is on (see 2). With
   the flag, injection is hard-wired ON in the file and the broker config is not consulted.

   ```bash
   scns install-extension --context-injection
   ```

2. **The broker's `extension.config` state.** Used only when the extension was generated
   *without* `--context-injection`:

   ```bash
   curl -X POST http://localhost:3456/api/state \
     -H 'Content-Type: application/json' \
     -d '{"key": "extension.config", "value": "{\"contextInjectionEnabled\": true}"}'
   ```

   State is per-broker. In a meta-broker setup the extension talks to the **child** broker
   for a registered repo, so setting this on the global broker at `:3456` alone will not
   enable injection inside that repo — set it on the child's port as well.

When enabled, each user prompt triggers a query to `/api/extension/context` which returns
relevant memories and pending suggestions. The config response is cached for 60 seconds.

## Layer 1b: Shell Hooks (Lightweight Alternative)

For environments where extensions aren't available (e.g., CI/CD, cloud agents), shell hooks
provide event forwarding via `curl` commands in `hooks.json`.

### Setup

```bash
# Generate hooks.json
scns setup-hooks

# With custom broker URL and output path
scns setup-hooks --broker-url http://localhost:3456 --output ./hooks.json
```

### Generated Events

The hooks.json maps Copilot CLI events to broker session events:

| CLI Event | Broker Event Type |
|-----------|-------------------|
| `copilot_prompt` | `user-prompt` |
| `copilot_tool_start` | `pre-tool-use` |
| `copilot_tool_end` | `post-tool-use` |
| `copilot_error` | `error` |
| `copilot_session_start` | `session-start` |
| `copilot_session_end` | `session-end` |

> **Note**: Use either the extension OR hooks, not both — they would produce duplicate events.

## Layer 2: Session-Store Poller (Passive)

An observation plugin that reads from Copilot CLI's `~/.copilot/session-store.db` to
discover sessions and turns. This works even without the extension installed.

### Configuration

```bash
# Enable via environment variables
export OBSERVE_SESSION_STORE_ENABLED=true
export OBSERVE_SESSION_STORE_PATH=~/.copilot/session-store.db  # default
export OBSERVE_SESSION_STORE_INTERVAL_MS=60000                  # default: 60s
export OBSERVE_SESSION_STORE_MAX_SESSIONS=50                    # default
```

### Emitted Observations

- `session-discovered` — new Copilot CLI session detected
- `turn-observed` — new conversation turn in an existing session

## API Endpoints

### GET /api/extension/config

Returns extension configuration (context injection settings).

```json
{
  "contextInjectionEnabled": false,
  "maxMemories": 5,
  "maxSuggestions": 3
}
```

### POST /api/extension/context

Returns contextual information for a given prompt.

**Request:**
```json
{
  "prompt": "How do I deploy to production?",
  "sessionId": "optional-session-id"
}
```

**Response:**
```json
{
  "additionalContext": "Relevant SCNS memories:\n...\n\nPending SCNS suggestions:\n...",
  "memoriesUsed": 2,
  "suggestionsUsed": 1
}
```

### POST /api/memory/store

Stores a key-value pair in SCNS memory.

**Request:**
```json
{
  "key": "deployment-process",
  "value": "Always run tests before deploying. Use blue-green deployment."
}
```

### GET /api/sessions

Lists all broker sessions (alias for session listing).

**Query params:** `status`, `include_archived`

## Graceful Degradation

All broker communication uses 500ms timeouts with fire-and-forget semantics:

- **Broker down**: Extension silently skips event forwarding and context injection
- **Memory unavailable**: Context endpoint returns `{additionalContext: null}`
- **Session-store missing**: Poller logs a warning and retries next interval
- **Invalid config**: Falls back to defaults (injection OFF)
