# Multi-Agent Coordination Research Summary

## Google/MIT Study: "Towards a Science of Scaling Agent Systems"

- Source: arXiv 2512.08296
- 180 configurations, 5 architectures, 3 LLM families, 4 benchmarks
- **Key finding**: Centralized coordination +80.8% on parallelizable tasks
- **Key finding**: ALL multi-agent variants degrade sequential reasoning -39% to -70%
- **Key finding**: Independent agents amplify errors 17.2x vs 4.4x for centralized
- Predictive model: R²=0.524, correctly predicts optimal architecture 87% of the time
- If single agent exceeds ~45% capability, adding more shows diminishing returns

## A2A Protocol (Google, v0.3)

- JSON-RPC 2.0 over HTTPS, SSE for streaming, push notifications for async
- Agent Cards at `/.well-known/agent.json` for capability discovery
- Task lifecycle: submitted → working → completed/failed
- Under Linux Foundation (Apache 2.0) since June 2025
- SDKs: `a2a-sdk` (Python), `@a2a/sdk` (JS)
- Complementary to MCP: MCP = tools, A2A = agent coordination

## Claude Code AutoDream / KAIROS

- Background memory consolidation daemon
- 3-gate trigger: 24hr + 5 sessions + lock file
- 4-phase cycle: Orient → Gather → Consolidate → Prune/Index
- Process-isolated (sub-agent, never in main context)
- MEMORY.md capped at 200 lines / 25KB
- AutoCompact at ~80-90% context, keeps last 10 messages

## Anthropic Production Multi-Agent System

- Lead agent spawns 3-5 subagents in parallel
- Opus orchestrator + Sonnet workers = 90.2% improvement over single Opus
- Artifact bypass: large outputs to filesystem, lightweight refs in conversation
- Multi-agent uses ~15x more tokens than single-turn chat
- Token usage explains 80% of performance variance

## Best Practices 2025-2026

- Classify before spawning (parallel vs sequential)
- Two-level heartbeats (liveness + work-progress)
- Sessions are ephemeral computation units, not persistent entities
- Semantic caching achieves ~70% cache hit rates
- Data retrieval overhead = 40-50% of execution time
- MCP as event bus is emerging 2026 pattern
