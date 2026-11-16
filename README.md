# SCNS — Second Central Nervous System

**SCNS gives your coding agent a memory that survives the session.**

Every time you close a Copilot CLI session, everything it learned about your project
dies with it. The next session starts from zero. You re-explain the architecture, you
re-state the decision you made last week, you watch it re-make a mistake you already
corrected. SCNS is a local background service that fixes that. It watches your sessions,
keeps what mattered, holds the memory *separate per repository*, and hands the relevant
parts back to the agent at the start of your next prompt.

Everything runs on your own machine. The memory is a SQLite file in your home directory.
Nothing is uploaded anywhere.

**Prefer a visual tour?** The **[slide deck](https://johnhain-msft.github.io/scns/)**
walks through the architecture, the retrieval math, and the learning loop in 16 slides
([source](docs/slides/index.html) — self-contained HTML, works offline).

> **Status: alpha.** This is being handed to a small group of testers. Parts of it are
> solid and have been running daily for months; parts are young. The
> [What's solid, what isn't](#whats-solid-what-isnt) section is honest about which is
> which. Read it before you rely on this for anything. If the install fails, that is a
> bug in these instructions, and we want the report:
> [open an issue](https://github.com/johnhain-msft/scns/issues).

---

## Contents

- [What SCNS is](#what-scns-is)
- [How it works](#how-it-works)
- [Why you'd want it](#why-youd-want-it)
- [Safety: what SCNS will not do unless you ask](#safety-what-scns-will-not-do-unless-you-ask)
- [Install (Windows)](#install-windows)
- [Install with an agent](#install-with-an-agent) — paste-into-a-reasoning-model prompt
- [Install (macOS / Linux)](#install-macos--linux)
- [Verify it actually works](#verify-it-actually-works)
- [When something is wrong](#when-something-is-wrong)
- [What's solid, what isn't](#whats-solid-what-isnt)
- [Roadmap](#roadmap)
- [Credits and prior art](#credits-and-prior-art)
- [Repository map](#repository-map)

---

## What SCNS is

Three parts. The first two work today; the third is young, and that's where the caveats
are.

**1. A memory that outlives the session.** SCNS stores facts, decisions and observations
in a local vault, and retrieves them with a multi-graph traversal rather than a top-k
similarity dump. That retrieval layer is what makes the injected context worth reading,
and it is described in [How retrieval actually works](#how-retrieval-actually-works--magma).
When you start a new session, the things you settled last time are still there.

**2. Memory that is scoped to the repository you're in.** A decision you made about your
work project should not leak into a session about your side project. SCNS runs a separate
memory per registered repository, routed automatically by your working directory. That
separation is the reason for the child-broker architecture below.

**3. A background service that reacts to what happens.** It watches session events — what
tools ran, what failed, what you corrected — and turns that into suggestions, negative
memories ("don't do X, you were told this"), and cross-agent coordination when several
agents work the same repo at once.

## How it works

```
                       your terminal
                             │
                  ┌──────────┴───────────┐
                  │   Copilot CLI        │
                  │  ┌────────────────┐  │
                  │  │ SCNS extension │  │  21 tools + context injection
                  │  └───────┬────────┘  │  ~/.copilot/extensions/scns/extension.mjs
                  └──────────┼───────────┘
                             │  HTTP, localhost only
                             ▼
              ┌──────────────────────────────┐
              │  global broker  :3456        │  session registry, scheduler,
              │  ┌────────────────────────┐  │  event log, meta-registry
              │  │ meta-broker supervisor │  │
              │  └───────────┬────────────┘  │
              └──────────────┼───────────────┘
                             │  spawns + supervises one child per repo
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌───────────┐  ┌───────────┐  ┌───────────┐
        │ child     │  │ child     │  │ child     │   ports :3500+
        │ repo-a    │  │ repo-b    │  │ repo-c    │
        └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
              ▼              ▼              ▼
          its own memory, per repository
                             │
                             ▼
              ~/.scns/  — vault.db, experience.db, logs, state
```

### The broker

A local HTTP service on `127.0.0.1:3456`. It tracks live sessions, runs scheduled jobs
(re-indexing, consolidation, housekeeping), keeps an event log of what happened, and
serves the memory API. It binds loopback by default, which is also why it doesn't trigger
a Windows Defender Firewall prompt.

### Per-repository child brokers

Registering a repository (`meta-broker register <path>`) tells the meta-broker
supervisor — a loop inside the global broker — to start a dedicated child broker for it
on a port from the `3500`–`3599` pool, with its own database. When a Copilot session
starts, the extension asks the global broker "which broker owns this directory?" and talks
to the child from then on. That is the isolation boundary. Two repos cannot see each
other's memory, because they are different databases behind different ports.

**The route is resolved once, at session start.** The extension caches it for the life of
the session (it will re-resolve once if a request later fails, in case a child moved
ports). Registering a repo or setting a variable mid-session therefore changes nothing
until you start a new one — see
[strict routing](#trap-4-strict-routing-needs-a-new-session) below.

### The memory vault

SQLite, at `~/.scns/memory/vault.db`, using two extensions:

- **FTS5** for keyword search — synchronous, a fact is findable the moment it's stored.
- **sqlite-vec** for 384-dimensional embeddings — semantic search, so "how do we handle
  auth failures" finds a note that never used those words.

Content is chunked into a `chunks` table, mirrored into an FTS index and a vector index,
and the two result sets are fused at query time. There is also a graph layer
(`memory_entities`, `memory_edges`, `memory_causal`) used for multi-hop retrieval,
following a chain of related facts rather than returning the top-k nearest chunks. The
graph layer is the newest and least proven part.

Embeddings are computed locally by a bundled model (~128 MB, cached in `local_cache/`).
No text leaves your machine.

### Removing memories that no longer apply

Project context accumulates. Some of it is durable ("never claim tests pass without
quoting the row"); some of it was only ever true for one afternoon ("wait for the handoff
session before implementing"). Left alone, the temporary material keeps arriving in every
future prompt.

Three manual, directory-scoped commands handle that. Each resolves the **owning project**
through the meta registry — the deepest registered root containing the directory — so it
operates on that project's vault, never your home vault, and never a parent's. A directory
that is not inside a registered project is refused rather than silently redirected.

```powershell
# What would change? (read-only; the default)
scns memory prune --directory "C:\work\project"

# Save a reviewable plan, read it, then execute exactly that plan
scns memory prune --directory "C:\work\project" --out prune-plan.json
scns memory prune --directory "C:\work\project" --apply prune-plan.json

# Explicit, single-memory removal
scns memory delete "negative/<id>.md" --directory "C:\work\project"          # preview
scns memory delete "negative/<id>.md" --directory "C:\work\project" --apply

# Undo a retirement
scns memory restore "negative/<id>.md" --directory "C:\work\project"
```

**Deletion means all four representations.** Removing the Markdown file is not removal:
the memory also exists as `vault_files` / `chunks` / `chunks_fts` rows, as vectors in
`chunk_embeddings` (a `vec0` table with no foreign key, so nothing cascades to it), as
graph edges, and as a bullet inside the managed block of
`.github/copilot-instructions.md`. All of them are reconciled together, and a retirement
is recorded so a later re-index cannot resurrect the removed revision.

**Retire versus hard delete.** The default is `retire`: the exact bytes are copied into the
vault's `archive/` tier, which is excluded from listing and indexing — a recovery record,
not an active memory — and `scns memory restore` brings it back. `--hard` deletes with no
recovery record, and says so in its result rather than implying it can be undone. Restoring
revives the *record*; its instruction bullet is re-projected by the next application pass.

**What `prune` will not do.** It proposes; it does not decide alone. Pinned memories are
kept outright. Every removal proposal must cite evidence that exists in the work snapshot —
a closed task, a live session, an unread message, a real human turn — and a proposal citing
nothing, or citing something the snapshot does not contain, is downgraded to `uncertain`.
If the broker could not be read, *everything* is `uncertain`: an empty session list is not
proof that a memory expired. `uncertain` is deliberately not `keep` — "we could not tell"
and "this still applies" are different answers, and the preview reports them differently.

The same rule covers coordination the broker can no longer *place*. A session can vanish
while its unread messages and file intents remain, so a row that resolves to no session at
all is reported as an explicit gap and blocks removal — rather than being quietly dropped,
which would let a truncated inventory read as an empty one. Coordination belonging to an
archived session or another project is different: it is attributable, so it is excluded by
scope and reported as a count, not as missing evidence. Each evidence query is also capped
at 500 rows; reaching that cap is reported as a gap and blocks removal too, because the
objection may be in the tail that was never read.

The preview also reconciles the three stores a memory lives in — canonical vault files,
indexed paths, and the managed Markdown block — and names every disagreement: `file-only`
(on disk, not yet indexed), `index-only` (indexed, source gone), `projection-only` (an
injected bullet nothing backs) and `fully-matched`. Synthetic `event-nodes/*` rows have no
on-disk file by design and are never counted as orphans. An absent
`.github/copilot-instructions.md` is reported, never created.

Assessment itself needs an evaluator. Without `--evaluator-cwd` (an isolated directory for
a deny-all, think-only ACP session) nothing is assessed and every unpinned memory is
reported as `uncertain` — never as "kept", which would be a false report.

Writes are serialized. If the project's own broker is running, that process owns the vault
and the CLI refuses to open a second writer; across processes an exclusive lease on the
vault directory keeps a deletion from interleaving with a re-index.

### How retrieval actually works — MAGMA

The vault above is storage. What decides which memories reach the agent is a separate
layer, and that layer is the reason the injected context is worth reading.

Most memory add-ons retrieve by similarity over one store. That tangles four things into a
single number: meaning, time, cause, and subject. Ask "why did we drop the retry wrapper?"
and you get back the chunks that sound like the question. The chunks that answer it form a
causal chain. A distance metric cannot tell the two apart.

SCNS follows MAGMA (Jiang et al., 2026 — see
[Credits and prior art](#credits-and-prior-art)). MAGMA holds memory in separate semantic,
temporal, causal and entity graphs. It treats retrieval as a guided walk over them rather
than a nearest-neighbor lookup. On the briefing path:

1. Anchor — a hybrid FTS5 and vector search picks the entry points.
2. Traverse — `src/memory/adaptive-traversal.ts` walks out from those anchors along typed
   edges. It scores each hop by a question-conditioned salience on the edge type, not by
   raw cosine, so a `caused-by` edge can outrank a chunk that merely sounds similar.
   Anchors are protected. Nodes reached later never evict them.
3. Synthesize — everything visited gets ordered and written into one block, capped in
   tokens rather than chunks (`SCNS_MAGMA_MAX_TOKENS`, 3,400 estimated tokens by default).
   The low-salience tail is elided instead of the context being cut mid-thought.

This is the default as of the current build. The `Relevant SCNS memories:` block you never
see is what comes out of it. Set `SCNS_LIVE_MEMORY_BRIEFING=hybrid` to fall back to the
hybrid join. One environment variable, no rebuild. Both defaults are read from the code
and from recorded runs, and have not been re-confirmed against a fresh install.

**What we took, and what we left off.** SCNS implements MAGMA's Algorithm-1 return
contract and its Stage-4 salience budget over SCNS's own graph tables. MAGMA's
intent-routing lever is built but off on the live path (`intentRouting: false`). A second
arm, `multihop-iter`, handles queries that need iterative chaining. The two are
purpose-routed rather than rivals. Which one is right depends on the shape of the query,
and the design calls for a classifier that decides. No such classifier exists so far. In
practice the arms are sampled instead, to collect balanced evidence for building one.

**On the numbers.** We score 0.768 overall on LoCoMo at the ~3.4k-token budget, against a
0.700 target. A strict reproduction of the paper is still recorded as NOT_REPRODUCED, for
two reasons. Temporal questions land below the paper's per-category result. And a
scrambled-graph control suggested the topology is not carrying the result on static QA, so
on the evidence so far the Stage-4 ordering and budgeting may be doing the work on its
own. Static QA is probably the wrong yardstick for a self-learning substrate in any case.
Raw runs are in [`docs/evidence/`](docs/evidence/), and the current state is in
[`docs/NORTH_STAR.md`](docs/NORTH_STAR.md).

### The learning loop

Retrieval that never finds out whether it helped cannot get better. Every briefing writes
a `retrieval_experience` row to `~/.scns/memory/experience.db` with the query, the arm
that served it, and the selection propensity. A later signal settles an outcome onto that
exact row:

- Re-ask the same question, and the earlier briefing is labeled waste.
- Answer a clarifying question SCNS asked, and it is labeled accept. Your answer is kept
  as a better statement of what you wanted than the original prompt was.

Accept-vs-waste is the project's north-star metric. It is binary and per-attempt on
purpose, because that is the signal shape preference-optimization methods like KTO consume.

**This is the least finished part of SCNS.** The machinery runs. Label quality is the open
problem. Early accepts were contaminated by traffic no human sent. A sub-agent's own
prompt and an automated idle notice both settled as though a person had answered. No
learned weight feeds back into live retrieval so far. Treat it as instrumentation being
made trustworthy, not as a system that is learning from you today.

### The Copilot CLI extension

A single generated `extension.mjs` in `~/.copilot/extensions/scns/`. It does two things:

- **Exposes 21 tools** to the agent — memory store/search/delete, suggestions, status, negative
  feedback, agent-to-agent messaging, file-intent claims, shared state, and team tasks.
  The definitive list is in
  [`src/copilot-extension/tool-definitions.ts`](src/copilot-extension/tool-definitions.ts)
  and is documented in [`docs/copilot-integration.md`](docs/copilot-integration.md).
- **Injects context** — when enabled, each prompt you submit is first used to search
  memory, and the results are prepended as hidden context the agent sees but you don't.
  Without it, searching memory is something you have to remember to do yourself. It is
  **off by default** and takes two switches to turn on (see
  [Trap 3](#trap-3-context-injection-has-two-switches)).

It also forwards all six session hooks (start, end, prompt, pre/post tool use, error) to
the broker, which is where the observation signal comes from.

### The observation layer

Optional background observers (file changes, git activity, terminal history, session
hooks) that feed the same event log. **All observers default to off.** Anything captured
runs through a secret sanitizer before it's stored.

## Why you'd want it

- **You stop re-explaining your project.** This is the whole thing. If you work in the
  same repo for weeks, the compounding is real.
- **Corrections stick.** "Don't use that pattern here" recorded as a negative memory
  comes back the next time the agent drifts toward it, instead of being a correction you
  make weekly forever.
- **Per-repo isolation actually holds.** Because it's enforced by separate databases
  rather than by a prompt asking the model to be careful, work context does not bleed into
  personal context.
- **It's local and inspectable.** The vault is a SQLite file. You can open it, query it,
  delete it. There is no service to trust and no data to exfiltrate.
- **Multi-agent coordination exists** — file-intent claims stop two agents editing the
  same file, and agents can message each other through the broker.

And what it is not:

- Not a replacement for good instructions files. `AGENTS.md` and `copilot-instructions.md`
  are still how you set the rules; SCNS is how the agent remembers what happened.
- Not a hosted product. It's a service you run, and it will occasionally need a restart.
- Not magic retrieval. If you never store anything and never enable context injection,
  SCNS does approximately nothing.

## Safety: what SCNS will not do unless you ask

SCNS contains daemons that can act outside your machine: push git branches, open pull
requests, file issues, and spawn agent sessions that spend your Copilot credits. On the
author's development machine several of these ran by default. **They are off by default
here, and it takes a deliberate opt-in to turn any of them on.**

| Feature | What it does if enabled | Enable with |
|---|---|---|
| `gate-pass-publisher` | pushes `scns/auto/*` branches to `origin` and opens PRs via `gh` | `BROKER_PUBLISH_GATE_PASS=1` |
| `north-star-nudge` | files a GitHub issue when project intent goes stale | `BROKER_NORTH_STAR_NUDGE=1` |
| `drift-watchdog` | files/refreshes a GitHub staleness issue | `SCNS_DRIFT_WATCHDOG=1` |
| `team-task-autospawner` | spawns agent sessions — **consumes credits** | `BROKER_AUTOSPAWN_ENABLED=1` |
| `self-improve-followups` | queues follow-up tasks the autospawner then spawns | `BROKER_SELF_IMPROVE_FOLLOWUPS=1` |

`SCNS_UNATTENDED=1` turns on the whole family at once. An explicit per-feature `=0`
always wins over it, and any value the gate doesn't recognize is treated as *off*. A
variable whose job is to authorize writes to your GitHub account should not be satisfied
by a typo.

You do not have to take this on faith. `doctor` reports the posture directly:

```
[info] unattended-actions — all OFF (opt-in) — nothing will push branches, open PRs,
       file issues, or spend credits on your behalf
```

If you enable any of them, that line turns into a `[WARN]` naming exactly which ones.

If you do opt in, the design for keeping a self-improving install's artifacts off the
public upstream — a private home repository per install, updates merging down, deliberate
human contributions going up — is in
[docs/plans/public-private-split.md](docs/plans/public-private-split.md).

Two more things:

- **Observers are off by default.** Nothing watches your terminal or files until you turn
  it on with `node dist/cli.js observe`.
- **`BROKER_TOKEN` is optional but recommended.** Setting it requires a bearer token on
  every broker route except `/health*` and `/api/hooks/*`. On a shared or managed machine,
  set it.

---

## Install (Windows)

Windows 10/11, no WSL required. PowerShell throughout.

### Prerequisites

**1. A supported Node.** This is the single biggest install trap:

- SCNS depends on `better-sqlite3@~12.9`, a native module. It loads a prebuilt binary
  matched to Node's ABI version. That line's published `win32-x64` prebuilds cover ABI
  115, 127, 131, 137 and 141 — **Node 20, 22, 23, 24 and 25**. Node 21 (ABI 120) has no
  prebuild and is not supported, and neither is anything newer than 25.
- On an unsupported major, `npm ci` falls through to compiling from source, which on a
  typical Windows machine without Visual Studio build tools fails. The failure then
  surfaces much later as `native-modules` failing in `node dist\cli.js doctor`.
- `package.json#engines` and `node dist\cli.js doctor` state exactly this range, and
  doctor fails fast rather than green-lighting a Node it cannot actually run on.

```powershell
node --version          # must be 20.x, 22.x, 23.x, 24.x or 25.x
```

If yours is already in range, use it — you do not need a second Node.

**The prebuild is chosen by whichever `node` runs `npm ci`.** If you keep several Node
versions on the machine, make sure the one on `PATH` during install is the one you will
run SCNS with; otherwise you install a binary for the wrong ABI and land in Trap 1.

**Do not change your system-wide Node to suit SCNS** if other tools depend on it. Install
a supported version alongside whatever you already have (nvm-windows, Nodist, fnm) and
invoke it by absolute path:

```powershell
# example; yours will differ
$SCNS_NODE = "C:\Program Files\nodejs22\node.exe"
& $SCNS_NODE --version     # must print a supported major
```

**2. Git, and optionally the GitHub CLI (`gh`)** — `gh` is only needed for the
GitHub-writing features, which are off by default.

### Steps

```powershell
git clone https://github.com/johnhain-msft/scns.git
cd scns

# only needed if your default node is NOT in the supported range
$SCNS_NODE = "C:\Program Files\nodejs22\node.exe"
$env:PATH = (Split-Path $SCNS_NODE) + ";$env:PATH"

npm ci
npm run build
```

`npm ci` fetches native prebuilds for `better-sqlite3`, `sqlite-vec` and
`onnxruntime-node` (via `fastembed`). **Behind a corporate proxy, set `HTTPS_PROXY`
first**. A silently failed prebuild fetch is the other common cause of
`native-modules` failing later.

**Optional but recommended — a broker token:**

```powershell
setx BROKER_TOKEN "<a long random string>"
```

`setx` writes to your user environment but does **not** affect the current terminal. Open
a new one afterwards.

**Optional — the embedding model cache.** The first embedding downloads ~128 MB into
`local_cache/`. If you have that folder from another install, copy it into the repo root
to skip the download, or point `SCNS_EMBED_CACHE_DIR` at it.

### Start the broker

```powershell
node dist\cli.js start
```

> **`scns` is not on your PATH.** The repo does not run `npm link`, so the `scns` command
> shown in some older docs does not exist. Every command in this README uses
> `node dist\cli.js <subcommand>` for that reason. If you'd rather have the short form,
> `npm link` in the repo root will give it to you. Just make sure it links against a
> supported Node.

### Register your repositories

Each repo you want isolated memory for:

```powershell
node dist\cli.js meta-broker register C:\path\to\your\repo
```

Then run the supervisor that keeps the child brokers alive. It runs in the foreground:

```powershell
node dist\cli.js meta-broker run
```

> **Registration only takes effect for sessions started afterwards.** Registering a repo
> while a Copilot session is already open in it does nothing for that session. The broker
> route was decided when the session started.

### Install the Copilot extension

```powershell
node dist\cli.js install-extension --context-injection
```

`--context-injection` matters. See [Trap 3](#trap-3-context-injection-has-two-switches).
If `BROKER_TOKEN` is set in this terminal, the token is embedded in the generated
extension automatically.

### Start it automatically at logon

```powershell
node dist\cli.js install
```

On Windows this writes a **supervision root** to
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\scns-watchdog.cmd`
(open the folder with `explorer shell:startup`). Run the file once to start it now
without logging out; `node dist\cli.js uninstall` removes it.

The shim starts `scns watchdog run` — **not** the broker directly. That distinction is the
whole point. The watchdog polls `/api/health`, restarts a dead or hung broker, and spawns
it with `SCNS_SUPERVISED=1`, which is what permits the broker to arm its own self-heal.
A broker started directly from the Startup folder has nothing above it: its self-heal
drains and exits expecting a relaunch that never comes, so a "heal" becomes a permanent
death. That failure mode was observed live as an 11h47m outage before the watchdog
existed. `scns doctor` now fails on `supervision-root` when nothing is watching.

Task Scheduler is not used: `schtasks /Create /SC ONLOGON` and `Register-ScheduledTask`
both return `Access is denied` on policy-managed corporate machines, elevated or not, as
does `sc create`. The Startup folder is the only unprivileged trigger left.

The same watchdog process also supervises the **meta-broker** (per-project child brokers),
so one Startup entry covers the whole stack. The meta-broker has no HTTP listener of its
own, so its liveness comes from `~/.scns/run/meta-broker.pid` rather than a health probe,
and it is supervised only when the registry actually has projects in it — supervising it
otherwise would start a feature you never opted into. Force it either way with
`--supervise-meta on|off|auto`.

Watchdog HTTP logs include the probe URL, elapsed time, status, timeout flag, and
transport error code. **Any HTTP status, including 401, counts as responsive**;
only a missing response contributes to the restart threshold. Decision logs identify
the HTTP broker or the pidfile-only meta-broker separately. On the relaunch path,
the watchdog stops a recorded live PID and waits for exit. If the port remains
occupied, it refuses to spawn a second broker rather than guessing which process to
kill. `stoppedPid: null` alone is not evidence that an old process survived.

That matters because a dead meta-broker fails quietly and completely: every per-project
child dies with it, and every session in every registered repo silently resolves to
`global:fallback` and writes to the shared brain instead of its own project — while the
global broker stays perfectly healthy and every other check passes. `scns doctor` reports
this as `meta-broker-supervision`.

> **Every Windows autostart trigger available to a non-admin account is logon-scoped**, and
> this machine routinely goes days without a logon — which is exactly how the outage above
> went unnoticed. The long tail is covered from the other end: `scns install-extension`
> bakes session-start reconciliation into the Copilot extension, so any new Copilot session
> health-checks the broker and starts the supervision root if it is dead. Set
> `SCNS_SESSION_RECONCILE=0` to switch that off.

> **Not verified on a clean machine.** These recipes are known to work on the author's
> managed Windows machine. They have not been tested across corporate policy
> configurations, and the `schtasks` failure may not reproduce identically on yours. If
> either behaves differently for you, please report it. That's exactly the kind of thing
> this alpha is for.

---

## The four traps

Each of these produces a *plausible-looking* broken state instead of a clear error. That
is what makes them expensive to work out from scratch.

### Trap 1: the wrong Node

`native-modules` fails in `doctor`, or the broker dies on start with an ABI mismatch about
`NODE_MODULE_VERSION`. The installed binary was built for a different Node major than the
one you are running — usually because `npm ci` ran under a different `node` than the one
you start SCNS with.

Reinstall with the Node you actually use on `PATH`:

```powershell
$env:PATH = "C:\Program Files\nodejs22;$env:PATH"
node --version      # a supported major
npm ci
npm run build
```

If `npm ci` cannot fetch a prebuild, fetch the one for the running Node directly — this is
what `doctor` prints as its hint:

```powershell
cd node_modules\better-sqlite3
node ..\prebuild-install\bin.js --runtime node --target (node -p "process.versions.node")
```

**Never run `npm rebuild better-sqlite3` to fix this.** The package's install script is
`prebuild-install || node-gyp rebuild`, but `npm rebuild` skips the prebuild step and goes
straight to node-gyp, whose `rebuild` is `clean → configure → build`. `clean` deletes the
working binary first, then `configure` fails if there is no MSVC C++ toolchain — leaving
you with no binary at all.

### Trap 2: `scns` not found

There is no `scns` on your PATH. Use `node dist\cli.js …` from the repo root.

### Trap 3: context injection has two switches

Injection is off by default in two independent places, and either one alone keeps it
off:

1. **The generated extension.** Without `--context-injection`, the extension asks the
   broker on every prompt whether injection is enabled. With the flag, it's hard-wired on
   in the file and the broker is never consulted. Passing the flag is the simple path.
2. **The broker's `extension.config` state** — only consulted if you generated the
   extension *without* the flag:

   ```powershell
   curl -X POST http://127.0.0.1:3456/api/state `
     -H "Content-Type: application/json" `
     -d '{"key":"extension.config","value":"{\"contextInjectionEnabled\":true}"}'
   ```

   **This state is per-broker.** In a registered repo, your session talks to that repo's
   *child* broker, not the global one on `:3456`, so setting it only on the global broker
   does nothing inside your repo. You'd have to set it on the child's port too. Use
   `--context-injection` and skip the whole problem.

### Trap 4: strict routing needs a new session

`SCNS_REQUIRE_PROJECT_BROKER=1` makes SCNS refuse to write memory when a session
didn't resolve to a per-project child broker, the guard against polluting the shared
global brain with repo-specific facts. It's worth turning on.

But the extension reads that variable **when the Copilot CLI process starts**. Setting it
in a running session does nothing, and neither does registering the repo. Both require a
new session:

```powershell
setx SCNS_REQUIRE_PROJECT_BROKER 1
# then open a NEW terminal and start a NEW Copilot session
```

When a session is correctly routed, the extension logs
`SCNS extension loaded (broker: http://127.0.0.1:35NN [project:<id>])`. If it says
`global:default` or `global:fallback`, the repo isn't registered, the supervisor isn't
running, or the session predates one of those.

The healthy notice appears once per foreground start or resume, not once per extension
host replacement. Its delivery receipt lives in the CLI session workspace; it does not
write to the learning corpus. Unresolved routes, route changes, and recovery remain
visible. Routine resolution details go to the extension's diagnostic stderr log.

---

## Install with an agent

If you'd rather not do the above by hand, paste the following into a capable reasoning
agent (Copilot CLI itself works well) **from the directory where you want SCNS cloned**.
It is written to be self-contained and to stop and ask rather than guess.

````markdown
You are installing SCNS (Second Central Nervous System) from
https://github.com/johnhain-msft/scns on this machine. Work carefully and verify each
step with real command output — do not assume a step worked because a command exited 0.

## Success criteria — you are done only when ALL of these are true

1. `node dist/cli.js doctor` runs and no line is tagged `[FAIL]`.
   IMPORTANT: `[info]` and `[WARN]` lines are NORMAL and are not failures.
   `strict-mode` and `unattended-actions` always emit `[info]` by design.
2. The `unattended-actions` doctor line reports **all OFF**.
3. A live memory round-trip works: from inside a registered repo, a fact stored with the
   `scns_memory_store` tool is found again by `scns_memory_search`.
4. A Copilot session inside a registered repo logs a broker route of `project:<id>`,
   not `global:default` or `global:fallback`.

Report the actual output for each. If you cannot demonstrate one, say so plainly rather
than claiming success.

## Critical constraint: Node version

SCNS depends on better-sqlite3 `~12.9`, whose published win32-x64 prebuilds cover Node ABI
115/127/131/137/141 — **Node 20, 22, 23, 24 and 25**. Node 21 (ABI 120) has no prebuild,
and neither does anything newer than 25. On an unsupported major the install tries to
compile from source and typically fails, surfacing later as `native-modules` failing in
doctor.

- SCNS runs on **Node 20, 22, 23, 24 or 25**. `package.json#engines` and
  `node dist/cli.js doctor` both state exactly that range.
- The prebuild that gets installed is chosen by whichever `node` runs `npm ci` — install
  with the same Node you will run SCNS with.
- **Do NOT change the system-wide/default Node version** if other tools depend on it.
  Install a supported version alongside it and invoke it by ABSOLUTE PATH for every SCNS
  command (npm ci, npm run build, and every `node dist/cli.js ...`).

First: run `node --version`. If it is already in the supported range, use it. Otherwise
check nvm / nvm-windows / Nodist / fnm / volta directories and any standalone installs. If
you cannot find a supported Node, **stop and ask the user** how they would like it
installed — do not silently install a Node version manager or change their default Node.

## Steps

1. Clone the repo and `cd` into it (skip if already cloned).
2. Using a supported Node binary, run `npm ci` then `npm run build`.
   - If `npm ci` fails fetching native prebuilds and the machine is behind a proxy, set
     `HTTPS_PROXY` and retry. If it still fails, stop and report the exact error.
3. Ask the user whether to set a `BROKER_TOKEN` (recommended on a work or shared machine;
   it requires a bearer token on all broker routes except health and hooks). If yes, have
   them choose one, set it in the user environment, and note that a NEW terminal is needed
   before it takes effect.
4. Start the broker in the background: `node dist/cli.js start`.
   Verify it is actually listening — do not assume. Confirm the process is alive AND that
   `http://127.0.0.1:3456/health` answers.
5. Ask the user which repository paths they want SCNS memory for. For each:
   `node dist/cli.js meta-broker register <absolute path>`
   Then start the supervisor in the background: `node dist/cli.js meta-broker run`.
   Verify with `node dist/cli.js meta-broker list` that each repo shows as running with a
   bound port in the 3500+ range.
6. Install the Copilot extension WITH context injection:
   `node dist/cli.js install-extension --context-injection`
   (Without that flag, injection also depends on broker-side state that must be set on the
   per-repo CHILD broker, not just the global one — the flag avoids that entirely.)
7. Recommend setting `SCNS_REQUIRE_PROJECT_BROKER=1` in the user environment. Explain that
   it refuses memory writes when a session isn't routed to a per-project broker, and that
   it only takes effect in a NEWLY STARTED session — the broker route is fixed when a
   session begins.
8. Autostart at logon: `node dist/cli.js install`. It generates a launchd plist (macOS), a
   systemd user unit (Linux), or a Startup-folder shim (Windows) that runs
   `scns watchdog run` as the supervision root. Do NOT put `dist/cli.js start` in the
   Startup folder directly: a broker with nothing supervising it turns its own self-heal
   into a permanent death. Task Scheduler is not an option on policy-managed
   machines — `schtasks` and `Register-ScheduledTask` both return `Access is denied` even
   elevated. Confirm with `node dist/cli.js doctor` that `supervision-root` is `[OK]`.

## Environment branches you must handle rather than assume

- **OS**: Windows (PowerShell), macOS, or Linux. Path separators, the autostart mechanism,
  and the home directory all differ. Detect, don't guess.
- **Node**: 20 may be absent, present via a version manager, or present standalone. See
  above.
- **Proxy**: corporate proxies break native prebuild downloads.
- **Ports**: the global broker defaults to 3456 and children take 3500+. If 3456 is
  already in use, find out by what before changing anything — it may be an SCNS broker
  already running, in which case do NOT start a second one.
- **Existing install**: if `~/.scns` already exists, or an extension is already at
  `~/.copilot/extensions/scns/extension.mjs`, STOP and ask. Do not overwrite an existing
  memory vault or extension without explicit permission.

## Rules

- **Stop and ask** whenever the environment does not match what these instructions
  assume. A wrong guess here can destroy an existing memory vault.
- **Do not** enable any unattended feature (`BROKER_PUBLISH_GATE_PASS`,
  `BROKER_NORTH_STAR_NUDGE`, `SCNS_DRIFT_WATCHDOG`, `BROKER_AUTOSPAWN_ENABLED`,
  `BROKER_SELF_IMPROVE_FOLLOWUPS`, `SCNS_UNATTENDED`). They push branches, open PRs, file
  issues and spend credits. They are off by default and must stay off unless the user
  explicitly asks.
- **Verify, don't assume.** Exit code 0 is not evidence. Show the real output.
- Finish by pasting the full `doctor` output and the result of the memory round-trip.
````

---

## Install (macOS / Linux)

The same shape, with two differences:

- `node dist/cli.js install` generates a **launchd plist** (macOS) or **systemd unit**
  (Linux) for you. It does not support Windows — that's why Windows uses the Startup
  folder.
- File-permission hardening is real: `~/.scns/.internal-token` and the secret vault are
  enforced at `0600`. On Windows those modes are meaningless on NTFS and SCNS relies on
  `%USERPROFILE%` being owner-scoped by default ACLs instead.

Templates in `scripts/com.scns.*.plist` contain `__HOME__`, `__SCNS_REPO__` and
`__NODE_BIN_DIR__` placeholders you must substitute, because launchd does not expand `~` or
environment variables inside them.

## Verify it actually works

```powershell
node dist\cli.js doctor
```

Sixteen checks run in failure-localization order: `node-version`, `dist-build`,
`native-modules`, `embedding-cache`, `scns-home-writable`, `broker-reachable`,
`broker-auth`, `meta-registry`, `meta-resolve-cwd`, `extension-installed`, `strict-mode`,
`unattended-actions`, `unattended-target-repo`, `supervision-root`,
`meta-broker-supervision`, `self-heal-arming`.

`unattended-target-repo` guards *where* the unattended writers would act: when any
GitHub-writing unattended feature is enabled (or `SCNS_SELF_ISSUE_REPO` is set), the
target repository must be one the authenticated `gh` account owns. A missing,
foreign, or unverifiable target is a `[FAIL]` — a misdirected writer would push
branches or file issues on somebody else's repository, most likely the public
upstream this install was cloned from. With everything off it stays `[info]`.

The last three are *durability* checks, and they ask a different question from the rest.
Everything above them asks "is it up now?"; they ask "will anything bring it back?" —
the question that used to go unasked, so `doctor` could report "all checks passed"
minutes before the stack died and stayed dead for 11h47m.

- `supervision-root` — is a supervisor installed, and (on Windows) actually running?
  A reachable broker with nothing watching it is a **`[FAIL]`**, not a pass.
- `meta-broker-supervision` — if this machine has registered projects, is a meta-broker
  actually running for them? Its failure is quiet and total: every per-project child dies
  with it, and every session in every registered repo silently falls back to the global
  broker and writes to the shared brain. The global broker stays healthy throughout, so
  nothing else in this list notices. Stays `[info]` when the meta-broker is not in use.
- `self-heal-arming` — the broker's self-heal drains and exits, expecting a supervisor to
  relaunch it. Where none exists that is a permanent death, so self-heal refuses to arm
  and this line says so.

**Reading the output correctly:**

| Tag | Meaning |
|---|---|
| `[OK]` | passed |
| `[FAIL]` | genuinely broken — the line names the layer and carries a `hint:` |
| `[WARN]` | works, but degraded — e.g. no embedding cache means a 128 MB download on first use |
| `[info]` | **not a problem.** Status reporting, not a check |

`strict-mode` and `unattended-actions` are always `[info]`. Only `[FAIL]` lines mean
something is wrong; `doctor` exits successfully when there are none.

### Restarting the broker without dropping the stack

```powershell
node dist\cli.js broker restart
```

A blue/green restart, on every platform. It validates the binary on a throwaway canary
port first (isolated `SCNS_HOME` **and** `BROKER_DB_PATH`, so it never touches your real
vault), drains the running broker, snapshots its active agents for recovery, swaps, and
verifies. If the canary will not come up the restart aborts and your broker is untouched.
If the new broker fails verification it rolls back automatically. Exit codes: `0` served,
`1` canary failed (nothing happened), `3` rolled back, `2` nobody is serving.

The swap itself is platform-native — `launchctl kickstart -k` on macOS, `systemctl --user
restart` on Linux, and stop-then-respawn elsewhere. Only macOS's socket-preserving
kickstart gives a true zero-connection-drop swap; everywhere else the port is briefly
unbound, and the report prints the measured width of that window rather than claiming
there isn't one. `--rollback` runs the recovery half on its own, and it is what
`POST /api/admin/rollback` now calls (it used to shell out to `bash`, which meant the
rollback endpoint did nothing at all on Windows).

Automatic child recovery keeps the existing port. The supervisor stops its own tracked
child, waits for exit and a free port, then starts a fresh instance at the same address.
This deliberately accepts a restart gap: CLI sessions pin their broker URL, so moving
green to another port would strand those clients. Occupied anchors are reported rather
than silently reassigned, and other projects' anchors remain reserved while offline.
The explicit blue/green swap API remains available, but callers choosing a port change
must also arrange for pinned clients to re-resolve.

Then the real test: a live memory round-trip from a Copilot session inside a registered
repo:

1. Store a fact with the `scns_memory_store` tool. A successful store returns
   `{"stored": true, ...}`.
2. Find it with `scns_memory_search`.
3. Start a session in a *different* registered repo and confirm it does not find it.

Step 3 is the one worth doing. It's what separates "there's a memory" from "the isolation
is real".

## When something is wrong

Work down the ladder and stop at the first broken layer:

1. **`node dist\cli.js doctor`** — every `[FAIL]` names its layer and its fix.
2. **`node dist\cli.js status`** — is the broker answering on `:3456` with your token?
3. **`node dist\cli.js meta-broker list`** — is every registered repo `running` with a
   bound port?
4. **Resolve directly:**
   `http://127.0.0.1:3456/api/meta/resolve?path=<repo-root>` (with the `Authorization:
   Bearer <token>` header if you set one) — must return `resolved: true` and that repo's
   child port.
5. **Check the session log** for `brokerRouteLabel`. `project:<id>` is correct.
   `global:default` or `global:fallback` means the session is on the shared brain: the
   repo isn't registered, the supervisor isn't running, or the session started before one
   of those was true. With strict mode on, that session refuses memory writes loudly,
   which is the guard doing its job.

**Auditing misrouted session data.** Use the same Node runtime as the installed
`better-sqlite3` native module:

```powershell
node scripts\audit-cross-project-pollution.mjs --json
```

The audit reads the project registry, child session/event databases, and Copilot's
native session store. Native session ownership takes precedence over broker metadata:
an older hook could record the SCNS package cwd for a session that actually belonged
to its child project. A metadata mismatch is **not** permission to delete that
session's events. Unknown reaped IDs and conflicting evidence are reported separately.
Exit `1` means an identified issue; exit `2` means the audit is incomplete. Exit `0`
does not prove that unclassified events are native.

`scripts\repair-cross-project-pollution.mjs` accepts an explicitly reviewed JSON plan
(`version: 1`, `projects`, `deleteEvents`, and `repairWorkingDirs`); its regression
test contains a small example. Preview it with `--plan <file>`. Writes additionally
require `--apply --backup-dir <new-absolute-directory>`. The tool rechecks native
ownership and exact counts, completes SQLite backups including WAL content before
writing, then verifies retained event/session content inside each transaction.
`deleteDiscoveryCopies` additionally permits an explicitly approved foreign session
copy only when it is completed, has purpose `discovered`, contains only the expected
discovery-registration events, and has no dependent records. Native sessions and
unknown IDs are not deletion candidates. Keep the
backup directory and its `repair-plan.json`; do not restore an entire old database
over newer human activity when a selective row restore is sufficient.

**Session discovery is supplemental.** Process discovery recognizes only
`--resume <uuid>`, not ordinary new CLI sessions. Project children use it only to
keep already-registered, in-project sessions alive; globally visible process IDs
are not enough to create sessions in every child. Hooks/register provide ownership,
and cwd-less hooks use the child root rather than the SCNS package cwd. Restart
existing brokers and CLI sessions to load updated guards.

**Progressive startup health.** A broker can answer HTTP while reporting
`brain: starting`. Overall readiness depends on the first successful brain wake;
idle embeddings alone do not mean failure. Inspect the response body rather than
equating HTTP 200 with readiness.

**"My memory store worked but the agent doesn't seem to know it."** Keyword search is
synchronous, so `scns_memory_search` finds it immediately. Injected context is retrieved
semantically, which needs an embedding. Embeddings are now written on store, but the
first embedding on a fresh install may be waiting on the ~128 MB model download. Either
wait it out, or pre-seed `local_cache/`.

**Known benign on Windows:** the `lsof`/`ps`-based stale-broker auto-kill is a no-op (the
`EADDRINUSE` retry still works; close a stuck process manually); tmux-based team spawning
is macOS-only; a couple of `/tmp` strings in dashboard routes are cosmetic labels.

## What's solid, what isn't

**Solid — running daily, well covered by tests:**
- The broker, the session/event model, and the scheduler
- Per-repo child brokers and the routing that decides which one a session uses
- The memory vault: chunking, FTS5 keyword search, vector search, hybrid fusion
- The MAGMA briefing path: anchor, then traverse, then Stage-4 ordering and token
  budgeting. This is the default, and so far it is where the measured gain comes from
  (see [How retrieval actually works](#how-retrieval-actually-works--magma))
- The Copilot extension: 21 tools, hook forwarding, context injection
- Strict routing as a guard against cross-repo memory pollution

**Young — works, but expect rough edges:**
- The graph/causal layer and multi-hop retrieval. The traversal runs. A scrambled control
  suggests the topology is not carrying its weight on static QA, though that test may not
  be the right one to judge it by
- The learning loop. Labels are being collected; their quality is unproven
- Query routing between the `magma` and `multihop-iter` arms. A classifier should make
  this a decision rather than a sample, and none exists so far
- Suggestions and the autonomy ladder
- The self-improvement loop (and now off by default, see
  [Safety](#safety-what-scns-will-not-do-unless-you-ask))
- The dashboard

**Recently fixed, in case you read otherwise in an older doc:**
- A single transient probe failure could latch an entire session to the global brain,
  silently. Fixed; the supervisor no longer unroutes a healthy child on one failed probe.
- A newly stored memory was invisible to the injected briefing until the next re-index
  (~20 min). Fixed; a stored memory is briefable immediately.

**Unverified on anything but the author's machines.** Native Windows support is new. The
install has not been run end-to-end on a clean machine. Doing so on the author's machine
would overwrite a live vault, replace the installed extension, and collide with brokers
already on `:3456`/`:3500+`. **Your install is the test.** If you get stuck, record exactly
where and open an issue; the first few install reports are treated as bugs against the
documentation, not user error.

## Roadmap

**Being built now**
- Measuring whether memory retrieval actually improves answers. This is the project's
  north star, and the least finished part of it
- Hardening the native-Windows path from real alpha install reports
- Multi-hop / causal retrieval, past the experimental stage

**Next**
- A real first-run experience: guided setup, fewer manual steps, no two-switch traps
- `npm link` / a proper `scns` binary so the CLI stops being `node dist/cli.js`
- Better visibility into what SCNS decided to inject, and why it picked that

**Speculative — ideas, not commitments**
- Dream/consolidation passes that compress old memory into durable lessons
- Higher autonomy levels where SCNS proposes and executes its own improvements
- Team orchestration beyond the current single-machine model

See [`docs/NORTH_STAR.md`](docs/NORTH_STAR.md) for the current metric and ranked next
moves. Open issues are the real backlog:
[github.com/johnhain-msft/scns/issues](https://github.com/johnhain-msft/scns/issues).

## Credits and prior art

The memory architecture is not original to SCNS. The multi-graph retrieval design at the
center of it comes from a paper by other people, and the author did not arrive at the
pattern independently. What SCNS adds is an implementation of that idea inside a local
agent runtime, plus a learning loop on top.

> **MAGMA: A Multi-Graph based Agentic Memory Architecture for AI Agents**
> Dongming Jiang, Yi Li, Guanpeng Li, Bingzhe Li
> arXiv:[2601.03236](https://arxiv.org/abs/2601.03236) [cs.AI], January 2026

From the paper: splitting memory into separate semantic, temporal, causal and entity
graphs; retrieval as a guided traversal over those graphs; the Algorithm-1 return
contract, where the whole visited set goes to narrative synthesis instead of being capped
earlier; and the Stage-4 question-conditioned salience budget.

Written here: everything binding those ideas to a SQLite vault, per-repo child brokers, a
Copilot CLI extension, and the accept-vs-waste learning loop. None of that is the paper's
concern.

The code was written against the paper rather than forked from it. The authors' reference
implementation ([FredJiang0324/MAGMA](https://github.com/FredJiang0324/MAGMA), MIT) was
consulted as an oracle for the algorithms. Where we adopted a mechanism and where we
deliberately went our own way is recorded per-mechanism in
[`docs/PRIOR_ART.md`](docs/PRIOR_ART.md) §M. The paper is free to read on arXiv, though
arXiv's non-exclusive distribution license is not an open-content license, so the work is
cited here and not reproduced. Any bug or shortfall in this implementation is ours, not
theirs.

The rest of the design leans on other people's work too. Self-RAG and Adaptive-RAG on when
and how much to retrieve, RouterRetriever on routing among retrievers, KTO on learning
from a binary accept/waste signal, contextual bandits and doubly-robust estimation for
off-policy evaluation. Each one is cited with its adopt-or-build call in
[`docs/PRIOR_ART.md`](docs/PRIOR_ART.md).

## Repository map

| Path | What's in it |
|---|---|
| `src/broker/` | the global broker: routes, services, storage, scheduler |
| `src/meta-broker/` | per-project child broker supervisor + port allocation |
| `src/memory/` | the vault: chunking, FTS + vector search, graph, retrieval |
| `src/copilot-extension/` | extension generator, tool definitions, context injection |
| `src/observe/` | observation layer + secret sanitizer |
| `src/cli/` | CLI subcommands, including `doctor` |
| `src/shared/` | cross-cutting helpers, incl. the unattended-action opt-in gate |
| `dashboard/` | web dashboard |
| `docs/` | architecture (`modules.md`), integration (`copilot-integration.md`), direction (`NORTH_STAR.md`) |
| `references/` | the author's own earlier prototypes, kept for reference (git-ignored for new files) |
| `test/` | unit, integration, e2e and stress suites |
| `.github/workflows/` | CI: the blocking `ci.yml` gate (lint · formatting · types · build · unit + integration on every Node major in `engines`) plus the advisory `windows-smoke.yml` |

**Further reading:** [`docs/modules.md`](docs/modules.md) (architecture and module map) ·
[`docs/copilot-integration.md`](docs/copilot-integration.md) (the three integration layers
and the full tool list) · [`docs/NORTH_STAR.md`](docs/NORTH_STAR.md) (direction).

## License

[Apache-2.0](LICENSE). Copyright © 2026 John Hain.
