# Backlog — The "Big Brain": a cross-organ knowledge-graph tier (the capstone) + graph-DB spike

**Status:** DEFERRED (2026-07-09). Do **NOT** start until the **little-brain (node) tier is finished** —
specifically: **self-scaling, blue/green deploys, the learning loop (accept-vs-waste reward), and the DB
upgrade** (see §Sequencing). John: *"I need to finish this portion (the nodes) first… Once all that is done
**THEN** I can build out the Big Brain on top of it (which will be able to leverage many of those pieces) —
that's the missing link on how this all ties together neatly."*
**Effort:** heavy. A **paper-only architecture SPIKE first** (this doc IS the spike brief — §The Spike), then a
dedicated multi-phase `plan.md` build. Do the spike in its **own fresh context** with an **independent grader**
(producer ≠ grader).

---

## The vision (John's model — the "central nervous system")
A **Brain (capital B)** = **SCNS proper**, the central orchestrator that *keeps an eye on everything*. Beneath it,
**little brains (lowercase)** = per-project SCNS instances, each an "organ" with **its own DB**. The little brains
are the **nodes** of the CNS. The Big Brain is a **wrapper that orchestrates these orchestrators** — and, crucially,
it should own a **graph that rolls all the organs up into one structure *it* can traverse**, so it can reason about
**connections *across* projects** ("how does what SCNS learned in project A relate to project C?").

> This is the piece we were missing: how the little pieces tie together into one self-improving whole. The Big
> Brain is where **cross-project transfer + global orchestration** become real, which is the north star
> (self-improve / self-innovate / point-at-any-problem). See `docs/NORTH_STAR.md`.

## Where this came from (the thread that produced this doc)
Started as *"do we need to convert SCNS's graph to a real graph database (Neo4j)?"* The honest, evidence-grounded
answer split into **two tiers with two different answers**:
- **Little-brain / MAGMA tier → No graph DB needed.** (Proven — see §Capability map.)
- **Big-Brain / cross-organ tier → genuinely OPEN.** This is a *different workload* (connection discovery + global
  structure across organs), and it's the one place a graph engine may actually earn its keep. **MAGMA is not the
  algorithm for it** — we'll need to pull a different mechanism from the literature.

## ⚠️ Read this first (harness rules — do them BEFORE any build; the `__fleet__` precedent)
Per `.github/instructions/00-fix-first.instructions.md`:
1. **Codebase-prior-art-first (§4).** Map ALL existing paths that already serve "cross-project / rollup / orchestrate
   the orchestrators" and REUSE them (see §Capability map). A prior effort built a redundant `__fleet__` lane for a
   capability that already existed and had to be deleted. **The process-level Brain-of-brains already exists — wire
   the knowledge tier onto it, don't rebuild orchestration.**
2. **Build-from-paper, not apparatus (§1b).** The Big Brain is **greenfield**, so *design-before-build is correct
   (not circling)* — BUT the spike must **name the paper, extract the concrete algorithm, and end in a GO/build
   decision**, never open-ended analysis. Grade in parts; measure once after it's built.
3. **Challenge the frame (§1c) + validate this doc's premise against the code** before coding — a cited fact here
   can go stale.
4. **Evidence-gated + producer ≠ grader (§5, AGENTS.md #12).** The spike's recommendation gets an **independent
   fresh-context sign-off**. Any behavioral go-live is arbiter-gated on measured outcomes; safety guardrails stay
   human-owned (`docs/evidence/AWAITING-JOHN.md`).

## Capability map — what ALREADY EXISTS (reuse; cite verified 2026-07-09)
**Little-brain tier (per-project memory) — BUILT, and SQLite is a *faithful* fit (not a compromise):**
- Storage = **SQLite** (`better-sqlite3`) + **`sqlite-vec`**; the "graph" is **relational adjacency tables**:
  `memory_edges` (typed: entity/temporal/causal, weighted), `memory_causal`, `event_nodes` — `src/memory/db.ts:90-168`,
  indexed on `(src_chunk, edge_type)` / `dst_entity` / cause/effect keys.
- Retrieval = **MAGMA Algorithm 1 bounded beam** (`src/memory/adaptive-traversal.ts`): `beamWidth=8`, bounded
  `maxDepth`, budget-capped; each hop is a single **indexed adjacency lookup**; per-neighbor cost is **embedding
  cosine** (Eq. 5 `exp(λ1·φ+λ2·sim)`), topology is a cheap weight lookup. **No** shortest-path / PageRank / community
  / variable-length pattern-matching on the hot path.
- Learning (BEYOND the paper) = **scalar multiplicative weight update** on existing edge rows
  (`src/memory/edge-reinforcement.ts`: `w ← clamp(w·(1+η·(2·outcome−1)))`, decayed, idempotent) — a read-modify-write
  UPDATE, a **relational strength**.
- **Fidelity evidence:** MAGMA paper arXiv:2601.03236v2 + its OSS repo `github.com/FredJiang0324/MAGMA` run on
  **in-memory NetworkX + FAISS** (`requirements.txt`: `networkx>=3.0`, `faiss-cpu`; `graph_db.py` docstring: *"in-memory
  NetworkX implementation that can be swapped for Neo4j"*). Retrieval is bounded (**Table 6: MaxDepth 5, MaxNodes 200**).
  → SCNS's SQLite-adjacency + `sqlite-vec` is the **persistent twin of the authors' own architecture**. Neo4j is *not*
  warranted at this tier.

**Brain-of-brains — the PROCESS layer ALREADY exists (reuse as the CNS backbone):**
- `src/meta-broker/meta-supervisor.ts:15` — spawns/probes/restarts per-project child brokers; **"Each child gets its
  own DB at `~/.session-broker/projects/<projectId>/data.db`"** (this is literally "each organ has its own DB").
  Registry (`meta-broker/registry.ts`), port-allocator, restart-policy, supervisor-tick are all present.
- `src/brain/` — per-project cognition: `classifier`, `decision-tree`, `agent-loop`, `scaling-policy`,
  `self-critique`, `self-improvement-issue`, `suggestion-promoter`, `task-queue`.

**What does NOT exist yet (the greenfield the Big Brain adds):**
- A **cross-organ knowledge/memory graph** the Brain can traverse. The only cross-project surface today is
  **read-only admin summary**: `src/broker/project-registry.ts:10` — *"cross-project summary… the **seed of a** …"*;
  `src/broker/routes/index.ts:527` — *"Multi-project foundation (P3): supervisor view. Read-only cross-project."*
- Rollup today is **temporal only, within one memory** (`src/dream/tiered-consolidation.ts:2` — weekly/monthly
  rollups of daily logs), not cross-organ federation.

## The key insight — a **polyglot, two-tier** design (dissolves the "huge lift" fear)
You do **not** pick one engine globally. **Little brains stay SQLite/MAGMA** (proven). The **Big Brain tier adopts a
graph engine *only if* its workload warrants it** — an **additive new tier**, never a migration of everything. So the
frightening "shift *everything* to Neo4j" is off the table by construction; the real question is only *"what backs the
Brain-tier rollup graph?"*

**DB-upgrade note (this is one of the node-tier prerequisites, and it de-risks the Brain tier too):**
- Little-brain graph access is currently **raw `better-sqlite3` SQL threaded across ~21 files** with **no
  `GraphStore` port** (though the codebase already has 10+ `*Store`/`*Provider` interfaces — the idiom exists).
  **That coupling — not the choice of SQLite — is what makes any engine change painful.**
- **Do the `GraphStore`/`MemoryStore` seam** as part of the DB-upgrade node work: one interface
  (`getNeighbors`, `addEdge`, `upsertCausal`, `reinforceWeight`, traverse-primitives), SQLite as adapter #1.
- If little brains ever outgrow SQLite (concurrent multi-writer to one shared graph, or multi-machine hosting), the
  proportionate escalation is **Postgres + pgvector** (same relational-adjacency model), **NOT Neo4j**. Main cost of
  that swap: `better-sqlite3` is **synchronous** and `pg` is **async** → every call site `await`s (funnel through the
  seam so it's *one* boundary, not 21), plus dialect deltas + `sqlite-vec`→`pgvector`. Real but *continuous*.

## The Spike (run this AFTER the gate — it's written to be pasteable into a fresh session)
**The ONE question:** *What algorithm + storage engine + federation mechanism should the Big-Brain cross-organ
rollup graph use — and does **that tier** warrant a graph-native DB, even though the MAGMA/little-brain tier does not?*
**Scope:** paper-only architecture recommendation + decision matrix (no code). Time-boxed. Independent grader signs off.

**Step 1 — Prior-art literature scan (annotated bibliography: technique → the lego it gives → adopt-vs-build):**
- **Microsoft GraphRAG** — KG construction + **Leiden community detection** + hierarchical community summaries
  (≈ "roll all organs up into a traversable, summarizable graph").
- **HippoRAG / HippoRAG 2** — hippocampal-indexing; **personalized PageRank** over a KG for multi-hop association
  across a corpus (directly on-theme for the CNS/associative-recall metaphor).
- **Graphiti / Zep** — temporal knowledge graph purpose-built for agent memory (**runs on Neo4j** — a real data point
  on whether the Brain tier wants graph-native).
- **Hierarchical agent memory** — MemGPT/Letta, A-MEM, Generative-Agents memory stream (rollup/reflection patterns).
- **Blackboard / society-of-mind / hierarchical multi-agent orchestration** — the "orchestrator of orchestrators."

**Step 2 — Characterize the Brain workload (the crux that decides the engine).** Enumerate the *concrete* Brain
operations and map each to the graph-DB-favoring criteria:
- Cross-organ **connection discovery / link prediction** ("relate X in A to Y in C").
- **Multi-hop reasoning across organs** (variable-length paths — the first genuinely graph-DB-favoring op).
- **Global structure**: centrality (which patterns are load-bearing across everything?), **community/cluster**
  detection across organs, provenance/lineage DAG.
- Routing/orchestration ("which organ handles this?") — likely embedding/classification, not topology.
→ If the Brain genuinely needs **unbounded/variable-length multi-hop + PageRank/community at scale**, a graph-native
engine wins at this tier. If it stays **bounded + vector-scored** (like MAGMA), SQLite/Postgres suffices even here.

**Step 3 — Compare engines against that workload + SCNS's guard model** (embedded / isolated `SCNS_HOME` /
kill-by-PID / no server sprawl):
- **SQLite** — a *second* rollup graph, app-level or recursive-CTE traversal (cheapest, all-embedded).
- **Postgres + Apache AGE (openCypher) + pgvector** — graph queries *inside* relational; true multi-writer MVCC.
- **Neo4j + GDS** — Cypher + native PageRank/Louvain-Leiden/shortest-path (server on a port; heaviest ops footprint).
- **Embedded graph (KùzuDB / Memgraph)** — the **dark horse**: Cypher + graph algorithms **without a server**,
  preserving the embedded/single-file guard model. May give Neo4j-class queries at SQLite-class ops cost.

**Step 4 — Federation mechanism (engine-independent; sketch only).** How do organ graphs feed the Brain graph?
Reuse the existing **dream/consolidation slow-path** as the promoter + the `project-registry` cross-project "seed";
decide the namespace model (isolated shards + a rollup meta-graph vs. one graph with a `project` dimension).

**Deliverable:** a decision matrix (workload → each candidate's fit / lift / ops-cost → **recommended architecture +
named triggers + a single GO target to prototype next**), plus the chosen Brain-tier algorithm (from Step 1). Write it
here in `docs/backlog/` (or promote to a `plan.md`). **Independent fresh-context grader** validates before it's acted on.

## Sequencing — why the nodes come first, and how the Big Brain *leverages* each (the "missing link")
Finish the **little-brain (node) tier** first; each prerequisite becomes a building block the Big Brain reuses:
1. **Self-scaling** (`src/brain/scaling-policy.ts`, `meta-broker/*`) → the Brain uses this to spin organs up/down and
   to scale *itself*.
2. **Blue/green deploys** → the Brain tier gets safe, reversible rollout for free (and the Brain can orchestrate
   organ deploys).
3. **The learning loop** (accept-vs-waste reward + edge reinforcement, `edge-reinforcement.ts` + experience store) →
   the Brain learns **cross-organ** value with the *same* mechanism, one tier up.
4. **The DB upgrade** (the `GraphStore` seam; SQLite→Postgres path if needed) → produces the storage abstraction the
   Brain tier plugs its (possibly graph-native) rollup store into, and settles the little-brain engine question.
5. **THEN the Big Brain** — a cross-organ graph + traversal algorithm layered on the existing **meta-supervisor CNS**,
   the per-project **organ DBs**, the **learning loop**, and the **`GraphStore` seam**. This is what ties the whole
   system into one self-improving, self-innovating brain that can be pointed at any problem.

## Current setup (enough to finish + test the node tier now)
SCNS is pointed at **one other project + itself** (self-observation) — sufficient to complete and exercise scaling,
blue/green, learning, and the DB upgrade before the Big Brain is built.
