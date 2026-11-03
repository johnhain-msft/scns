# SCNS Testing Strategy

## 1. Testing Philosophy

- **TDD**: Write tests first, implement to pass. Tests drive design.
- **80% coverage minimum** enforced via Vitest V8 thresholds (lines, functions, branches, statements).
- **Tests are documentation** — they describe expected behavior. A reader should understand what a module does by reading its tests.
- **Every layer matters** — unit tests alone cannot catch integration gaps. The hook-endpoint gap (100% per-module scores, missing cross-module E2E) proved this.

## 2. Testing Pyramid

```
          ┌─────────┐
          │   E2E   │  Few, slow, high-confidence
          ├─────────┤
          │ Stress  │  Load/concurrency verification
          ├─────────┤
          │ Integr. │  Cross-module data flows
          ├─────────┤
          │  Unit   │  Isolated module behavior (bulk of tests)
          └─────────┘
```

The bulk of tests are unit tests (~119 files). Integration tests (~12 files) verify cross-module flows with real SQLite. E2E and stress layers are thinner but catch the gaps unit tests cannot.

## 3. Layer Definitions

### Unit Tests

| Attribute | Detail |
|-----------|--------|
| **What it tests** | Individual module logic in isolation — validators, parsers, state machines, pure functions, handlers |
| **What it does NOT test** | Cross-module interactions, real I/O, database schemas, HTTP routing |
| **Location** | `test/unit/` (mirrors `src/` structure) |
| **How to run** | `npm run test:unit` |
| **Timeout** | 10s per test (configured in `vitest.config.ts`) |
| **Mock strategy** | Mock **all** external dependencies — DB, filesystem, HTTP, child processes. Use `vi.fn()`, `vi.mock()` |

**Modules covered:** `brain/`, `broker/` (config, routes, middleware, storage, services, a2a, tools), `cli/`, `context/`, `dream/`, `memory/`, `observe/` (observers, privacy, sanitization), `otel/`, `rate-limit/`, `shared/`, `suggest/`

### Integration Tests

| Attribute | Detail |
|-----------|--------|
| **What it tests** | Cross-module data flows with real dependencies — DB round-trips, pipeline stages, multi-service interactions |
| **What it does NOT test** | HTTP endpoints, CLI invocation, external network calls |
| **Location** | `test/integration/` |
| **How to run** | `npm run test:integration` |
| **Timeout** | 10s per test |
| **Mock strategy** | **Real SQLite** (in-memory via test harness). Mock external I/O (filesystem writes, network, Claude API) |

**Flows covered:**
- `brain-pipeline` — observe → classify → decide → act
- `broker-lifecycle` — session create → heartbeat → cleanup
- `broker-services` — message bus, event dispatch, team coordination
- `cli-commands` — command parsing and dispatch
- `consolidation-pipeline` — daily log → extraction → memory storage
- `hybrid-search` — FTS5 + sqlite-vec combined retrieval
- `memory/pipeline` — ingest → chunk → embed → store → search
- `observation-pipeline` — observer → sanitize → filter → log
- `session-rotation` — context health → handoff → rotation
- `suggestion-pipeline` — evidence → generate → review → store
- `system-flow` — multi-module end-to-end data flow
- `team-orchestration` — team create → agent spawn → task dispatch

### E2E Tests

| Attribute | Detail |
|-----------|--------|
| **What it tests** | Full system behavior — real HTTP server, real filesystem, real DB. Nothing mocked across module boundaries |
| **What it does NOT test** | Internal implementation details, performance characteristics |
| **Location** | `test/e2e/` |
| **How to run** | `npm run test:e2e` |
| **Timeout** | 30s+ per test (real I/O) |
| **Mock strategy** | **Nothing mocked** across module boundaries. External services (Claude API) may use test doubles |

**Key rule:** Every user-facing CLI command and API endpoint must have at least one E2E test.

### Stress Tests

| Attribute | Detail |
|-----------|--------|
| **What it tests** | System behavior under load — concurrent connections, large datasets, resource exhaustion, rate limiting |
| **What it does NOT test** | Functional correctness (that's E2E's job) |
| **Location** | `test/stress/` |
| **How to run** | `npm run test:stress` |
| **Timeout** | 60s+ per test |
| **Mock strategy** | Same as E2E — real components, focused on volume and concurrency |

## 4. Critical Rules

These rules exist because we missed a critical integration gap (hook endpoints) despite 100% scores on per-module quality gates.

### Rule 1: Every cross-module data flow MUST have at least one E2E test

If module A generates output consumed by module B, there must be a test that runs A→B together with real infrastructure.

Examples:
- Hook script → broker endpoint → session state update
- OTel file → watcher → DB ingestion → trace assembly
- Observation → daily log → consolidation → memory storage
- CLI command → broker API → response rendering

### Rule 2: Every user-facing CLI command MUST have an E2E test

If `scns <command>` exists, there must be a test that invokes it and verifies the output. Unit tests for command handlers are necessary but not sufficient.

### Rule 3: Every API endpoint MUST be exercised in E2E, not just unit tests

Unit tests verify handler logic in isolation. E2E tests verify:
- Routing (the URL actually maps to the handler)
- Middleware chain (auth, rate limiting, error handling)
- Request/response serialization
- Error response format

### Rule 4: New features require tests at ALL relevant layers

A new API endpoint needs:
1. **Unit test** — handler logic with mocked dependencies
2. **Integration test** — handler with real DB
3. **E2E test** — full HTTP request → response cycle

A new observer needs:
1. **Unit test** — observer logic with mocked executor
2. **Integration test** — observer → sanitizer → log writer pipeline
3. **E2E test** — observer runs and data appears in queryable storage

### Rule 5: Platform-specific code MUST have tests for each supported platform

Use mocked `CommandExecutor` instances to simulate each platform's tool output (macOS `osascript`, Linux `xdotool`, etc.). See `test/unit/observe/observers/` for examples.

## 5. Dashboard Testing

The dashboard (`dashboard/`) has its own Vitest + Playwright test setup.

### Unit Tests (Vitest + React Testing Library)

| Attribute | Detail |
|-----------|--------|
| **Location** | `dashboard/test/unit/` |
| **How to run** | `cd dashboard && npm test` |
| **Setup** | `dashboard/test/setup.ts` — imports `@testing-library/jest-dom/vitest` |
| **Render helper** | `dashboard/test/helpers/render.tsx` — `renderWithProviders()` wraps components in `QueryClientProvider` |
| **Mock API** | `dashboard/test/mocks/handlers.ts` + `server.ts` — MSW handlers for API mocking |

**Coverage:** Components (`sidebar`, `confidence-bar`, `cron-preview`), hooks (`use-sse`), API client (`api.ts`), all pages (`overview`, `sessions`, `teams`, `memory`, `observers`, `dream`, `autonomy`, `cost`, `metrics`, `scheduler`, `suggestions`, `tasks`, `traces`, `otel-settings`)

### E2E Tests (Playwright)

| Attribute | Detail |
|-----------|--------|
| **Location** | `dashboard/test/e2e/` |
| **How to run** | `cd dashboard && npx playwright test` |
| **Helpers** | `dashboard/test/e2e/helpers/mock-api.ts` — API mocking for E2E |

**Coverage:** Page loads, navigation, flow tests (autonomy, dream, memory-observers, scheduler, suggestions, traces, otel-settings)

### Accessibility Tests (axe-core + Playwright)

| Attribute | Detail |
|-----------|--------|
| **Location** | `dashboard/test/e2e/acceptance/a11y.spec.ts` |
| **How to run** | `cd dashboard && npm run test:a11y` |
| **Standard** | WCAG 2.1 AA / Section 508 |
| **Helper** | `dashboard/test/helpers/a11y.ts` — `checkA11y()` runs axe-core with jsdom-safe rule config |

### Dashboard Rule

Every new dashboard page requires:
1. **Unit test** — component renders with mock data
2. **E2E test** — page loads and interactive elements work
3. **Accessibility test** — no axe-core violations

## 6. Test Utilities & Helpers

### Core Test Helpers (`test/helpers/`)

| File | Purpose | Exports |
|------|---------|---------|
| `db-harness.ts` | Creates temporary SQLite databases, tears down after test | `createTestDb()`, `createTestDbWithSchema(sql)`, `TestDb` |
| `broker-db-harness.ts` | Creates temp DB with broker schema pre-applied | `createBrokerTestDb()` |
| `otel-db-harness.ts` | Creates temp DB with OTel schema pre-applied | `createOtelTestDb()` |
| `factories.ts` | Builds test objects with sensible defaults + overrides | `buildSession()`, `buildMemoryEntry()`, `buildAutonomyState()`, `resetFactoryCounter()` |
| `fixtures.ts` | Static reusable test data | `fixtures.autonomyState`, `fixtures.session`, `fixtures.memoryEntry` |
| `index.ts` | Barrel export for all helpers | — |

### Mock Patterns

- **CommandExecutor**: Mock the `execute()` method to simulate platform tool output. See `test/unit/observe/observers/` for per-platform mocking.
- **Database**: Use `createTestDb()` / `createBrokerTestDb()` / `createOtelTestDb()` for real SQLite with schema. Never mock the DB driver in integration tests.
- **Factories over fixtures**: Use `buildSession({ state: SessionState.Idle })` for test-specific data. Use `fixtures` for canonical reference data.

### Vitest Configuration

`vitest.config.ts` key settings:
- **Path alias**: `@scns` → `src/`
- **Includes**: `test/**/*.test.ts`
- **Excludes**: `test/e2e/**`, `test/stress/**` (run separately)
- **Coverage provider**: V8 with 80% thresholds on lines, functions, branches, statements
- **Coverage excludes**: `src/**/index.ts`, `src/**/*.d.ts`, `src/cli.ts`
- **Timeouts**: 10s for tests and hooks
- **restoreMocks**: `true` (auto-restore after each test)

## 7. PR Review Checklist

```markdown
## Test Review Checklist

- [ ] Does this change introduce a new cross-module data flow? → Where's the E2E test?
- [ ] Does this add a new CLI command? → Where's the E2E test?
- [ ] Does this add a new API endpoint? → Where's the E2E test?
- [ ] Does this add platform-specific code? → Tests for each platform?
- [ ] Does this change a public interface? → Are existing tests updated?
- [ ] Could this break under load? → Should there be a stress test?
- [ ] Does the dashboard change affect accessibility? → a11y test updated?
```

## 8. Running Tests

### Core (Node.js)

```bash
npm test                    # All unit + integration tests
npm run test:unit           # Unit tests only
npm run test:integration    # Integration tests only
npm run test:e2e            # End-to-end tests
npm run test:stress         # Stress/load tests
npm run test:watch          # Watch mode (re-run on change)
npm run test:coverage       # Tests with V8 coverage report
```

### Dashboard (Next.js)

```bash
cd dashboard
npm test                    # Unit tests (Vitest)
npm run test:watch          # Watch mode
npx playwright test         # E2E tests (Playwright)
npm run test:a11y           # Accessibility tests (axe-core + Playwright)
```

### CI Notes

- `npm test` runs unit + integration (E2E and stress are excluded in `vitest.config.ts`)
- E2E (`npm run test:e2e`) and stress (`npm run test:stress`) run via dedicated scripts that override the exclude pattern
- Coverage thresholds are enforced — builds fail if any metric drops below 80%

### Learning-memory-loop suites (specs/001-learning-memory-loop)

- `test/helpers/isolation.ts` — throwaway DI roots + the read-only live-vault guard
  (`snapshotVault`/`assertVaultUnchanged`); use it in any test that could touch vault paths.
- `test/integration/experience-live.test.ts` — boots the REAL `dist/cli.js` on an ephemeral port
  with HOME sandboxed (`npm run build` first): seven-field experience rows, per-attempt verdict
  binding, fail-safe negatives, live shadowed exploration. Never touches `~/.scns` or :3456;
  children are killed by exact PID.
- `test/integration/outward-safety.test.ts` — the SC-010 outward-safety behavioral table against
  the REAL shipped allowlist. Run both via `npm run test:integration -- outward safety-kernel`.
- Structural locks: `test/unit/scripts/locomo-judge-harness.test.ts` (right-axis + arbiter),
  `test/unit/scripts/prior-art.test.ts` (docs/PRIOR_ART.md must exist and be cited),
  edge-reinforcement FR-017 locks, and the src/reward Everitt-isolation suite. If one fires,
  fix the DESIGN, not the test.
- Judged gates spawn ONLY behind `SCNS_LLM_JUDGE=1` / `SCNS_QA_GENERATOR=1`; pin the judge model
  (`SCNS_JUDGE_MODEL`) and re-establish σ (variance mode) whenever it changes. Under tsx, set
  `SCNS_EMBED_WORKER_PATH=$PWD/dist/memory/embedding-worker.js` for vault-building modes.
