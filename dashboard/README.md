# SCNS Dashboard

Web dashboard for the Second Central Nervous System. Built with Next.js 16, React 19, Radix UI Themes, TanStack Query, and Tailwind CSS v4.

## Prerequisites

- Node.js 22+
- SCNS broker running at `http://localhost:3456` (or set `NEXT_PUBLIC_BROKER_URL`)

## Setup

```bash
npm install
cp .env.local.example .env.local  # if you need custom config
```

## Development

```bash
npm run dev        # Start dev server (http://localhost:3000)
npm run build      # Production build
npm run start      # Start production server
```

## Testing

```bash
npm test                         # Unit + component tests (Vitest)
npx vitest run test/stress/      # Stress / large-data tests
npx playwright test              # E2E + accessibility tests (Playwright)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_BROKER_URL` | `http://localhost:3456` | SCNS broker URL |
| `NEXT_PUBLIC_BROKER_TOKEN` | *(empty)* | Bearer token for broker auth |

## Pages

| Route | Description |
|-------|-------------|
| `/` | Overview — health, sessions, teams, autonomy, dream, cost |
| `/sessions` | Active sessions with heartbeat status + SSE updates |
| `/scheduler` | Cron + on-demand task management |
| `/suggestions` | AI-generated suggestions (approve/reject) |
| `/traces` | OpenTelemetry trace viewer with span tree |
| `/metrics` | Token usage, tool calls, model distribution |
| `/settings/otel` | OTel ingestion configuration |
| `/teams` | Team management |
| `/tasks` | Task kanban board |
| `/memory` | Memory vault search |
| `/dream` | AutoDream consolidation status |
| `/observers` | Observation pipeline controls |
| `/autonomy` | Progressive autonomy level control |
| `/cost` | Token usage and cost tracking |

## Architecture

- **App Router** — file-based routing under `src/app/`
- **API Client** — typed fetch wrapper in `src/lib/api.ts` (27 functions)
- **SSE** — real-time updates via `src/hooks/use-sse.ts`
- **TanStack Query** — data fetching with caching + invalidation
- **MSW** — mock server for testing (no real broker needed)
- **axe-core** — automated 508 accessibility testing
