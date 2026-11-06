# Public upstream, private self-improving installs

**Status:** design (the spike deliverable for #57). Nothing below is implemented unless a
section says so; the implementation is broken down into the child issues linked from #57.

## The problem

Until 2026-11 this repository was private and doubled as the author's live instance: the
self-improvement surface — the gate-pass publisher, self-issue intake, north-star nudge,
drift watchdog, team-task autospawner — read from and wrote to this one repo. The repo is
now public, and that identity breaks three ways:

1. **A user's install must never point its daemons at the upstream repo.** Some defaults
   did (#58, fixed: no unattended writer has a default target; an enabled writer with no
   explicit target refuses to run; `scns doctor` fails when a target is unset or not
   owned by the authenticated account).
2. **No serious install — the author's included — can publish its self-improvement
   artifacts upstream.** Auto branches, self-filed issues, and evidence files carry
   machine-local and private-project context. Confidentiality of per-repo memory is this
   project's core pitch; its own improvement loop has to meet the same bar.
3. **The loop still needs a remote to act on** — somewhere to push `scns/auto/*`
   branches, file self-issues, and keep evidence — or the self-improving half of SCNS
   goes dark on every install.

Resolution: **the public upstream is distribution only; every install that opts in to
self-improvement gets a private home repository; updates merge down; contributions go up
through a deliberate, human, sanitized PR.**

## A correction to the original sketch: the private home cannot be a GitHub fork

Issue #57 sketched `gh repo fork --clone=false`. That cannot work: GitHub enforces
visibility across a fork network — a fork of a public repository is always public, and
flipping it is refused with "for security reasons, you cannot change the visibility of a
fork". A fork would put every `scns/auto/*` branch and self-filed issue right back on the
public internet.

The private home is therefore a **detached private mirror**: an ordinary private
repository seeded with the upstream history, with upstream kept as a plain git remote
(`gh repo create <name> --private` plus a push — or `--source=.` — produces exactly
this). Nothing of value is lost by not being a fork: a fork only adds the shared
pull-request graph, which is the one thing the private home must *not* share.

## Remote topology: one clone, two remotes, safe names

| Remote     | Points at                  | Used for                                           |
| ---------- | -------------------------- | -------------------------------------------------- |
| `origin`   | the install's private home | everything that writes: auto branches, PRs, issues |
| `upstream` | the public repo            | fetch-only; updates merge down from here           |

`origin` is deliberately the private home. Every GitHub writer in the codebase already
acts on `origin` of the broker's project root, in exactly three ways:

- the gate-pass publisher reads `git remote get-url origin` and runs
  `git push origin <branch>` + `gh pr create` (`src/broker/services/gate-pass-publisher.ts`);
- the north-star nudge and drift watchdog run `gh issue …` with the clone as cwd, letting
  `gh` resolve the repo from the remotes (`src/broker/services/tracked-issue.ts`);
- self-issue ingestion uses an explicit `SCNS_SELF_ISSUE_REPO`, or (for a meta-child) the
  project's own origin (`src/brain/self-issue-source.ts`).

Because `origin` is the *only* remote name any writer ever touches, re-pointing `origin`
at the private home redirects the entire write surface in one move, with no changes to
the writers themselves. `gh repo set-default` pins `gh`'s repo resolution to the home for
the ambiguous cases, and the existing pre-push hook (`scripts/git-hooks/pre-push`)
continues to reject any push to `main` wherever `origin` points.

A plain clone that never opts in keeps `origin` = upstream, and that is safe *because
nothing writes in that state*: the unattended family is off by default, and since #58
every writer without an explicit target refuses rather than guessing.

## Question 1 — install story: when is the private home created?

**At opt-in time, not install time.** Installing SCNS (clone, `npm ci`, `npm run build`,
`node dist/cli.js install`, register projects) performs no GitHub writes, so it needs no
home. The home is created by the same deliberate act that turns the loop on, as one new
command (child issue):

    node dist/cli.js home setup [--repo <owner/name>]

which, idempotently:

1. verifies `gh` is authenticated;
2. creates the private repo (`gh repo create <login>/<name> --private`, default name
   derived from the clone's directory name), or adopts an existing repo named by
   `--repo` after verifying it is private and owned by the authenticated account;
3. re-points remotes — the current `origin` (the public repo) is renamed `upstream`, the
   home becomes `origin`, `main` is pushed, `gh repo set-default` is set to the home;
4. records the target graph in the meta registry (question 2);
5. finishes by running the target-repo doctor checks and printing the result.

Every step checks before it acts, so the command is safe to re-run on a half-converted
clone.

**If the user declines** — simply never runs it — outward self-improvement stays off,
which is the shipped default. Declining costs nothing except the self-improving half of
the product, and `doctor` keeps saying precisely which half that is.

## Question 2 — config model: where the target graph lives

**In the meta registry, with env as the per-process override.** The registry
(`~/.scns/meta-broker.db`, `projects` table, `src/meta-broker/registry.ts`) already
stores a per-child `self_issue_repo`, threaded to each child as `SCNS_SELF_ISSUE_REPO` by
the meta-supervisor. The target graph generalizes this (child issue):

- **Two columns per broker**:
  - `upstream_repo` — where updates come from. Fetch-only, never a write target. Null
    for an ordinary registered project (a project is its own upstream).
  - `write_target_repo` — the one repo this broker's writers may act on: push branches,
    open PRs, file and ingest issues. Supersedes `self_issue_repo`, which remains as a
    read-side alias until a later migration retires it. Both land in the existing
    additive-migration block (`applyMetaSchema`) and the register upsert's `COALESCE`
    clauses, so old registries upgrade in place.
- **The global broker gets a reserved row** (project id `global`). Today the singleton's
  target lives only in env; the registry row makes the whole graph inspectable in one
  place. Precedence for any broker: explicit env (`SCNS_SELF_ISSUE_REPO`) > registry row
  > unconfigured — and unconfigured refuses (#58 behavior, already shipped).
- **Children**: `write_target_repo` = the registered project's own repo (today's
  `self_issue_repo` semantics, including the register-time auto-derivation from the
  project's origin remote). `upstream_repo` stays null.
- **Global broker**: `write_target_repo` = the private home; `upstream_repo` = the
  public repo.

Surfacing:

- `scns meta-broker list` prints each broker's `upstream → write target` alongside the
  JSON it already emits.
- `scns doctor` extends the `unattended-target-repo` check (#58, shipped) with graph
  rules:
  - FAIL when an enabled writer's target is unset or not owned by the authenticated
    account *(shipped)*;
  - **FAIL when `write_target_repo` equals `upstream_repo`.** This is the rule that
    protects the maintainer's own install: the maintainer owns the public repo, so the
    ownership check alone would bless daemons writing to upstream. Identity with
    upstream is a misdirection regardless of who owns it;
  - WARN when the clone's `origin` slug disagrees with the registry's
    `write_target_repo` — drift between the git topology and the declared graph.

Two small hygiene items ride along: `.env.example` gains a documented, empty
`SCNS_SELF_ISSUE_REPO` entry (today the one variable an installer most needs is absent
from it), and the stale "dev-default-ON" comments in
`src/broker/services/gate-pass-publisher.ts` are corrected to describe the opt-in gate.

## Question 3 — merge-down: taking an upstream update

There is no updater today — nothing in `src/` or `scripts/` runs `git pull`, checks a
version, or rebuilds on new code; the README's install is a plain clone. "Update" becomes
one wrapped command on the home topology (child issue):

    node dist/cli.js update
      # git fetch upstream
      # git merge upstream/main          (on the home's main)
      # npm ci && npm run build
      # restart via the installed supervision root

refusing on a dirty tree and stopping with guidance on conflict rather than resolving
silently.

Merge-down stays clean only if fork-local commits stay rare. The audit for this spike
found the real sources of fork-local tree state, and they drive the design:

- **Soak evidence**: the weekly launchd soak (`scripts/auto-restart-soak.mjs`, installed
  as `com.scns.soak-weekly`) writes `docs/evidence/auto-restart-soak-<timestamp>.json`
  into the work tree, and `docs/evidence/` is not gitignored.
- **Agent sweep**: the quality gate stages agent output with `git add -A`, and twice in
  the pre-public history that swept evidence artifacts (`docs/evidence/acp-probes/…`,
  `.scns/probes/…`) into `scns/auto/*` commits. The `.gitignore` already carries a
  targeted backstop for test artifacts for exactly this reason; evidence paths have no
  such backstop.
- **Instance-mutated tracked file**: the negative-memory applicator and memory-deletion
  rewrite `.github/copilot-instructions.md` in place (the auto-merger already whitelists
  it as expected-dirty). This is the one tracked file both upstream and the instance
  legitimately edit — the textbook merge-down conflict.
- Weekly reviews, triage, snapshots, vault, telemetry already live under `~/.scns` and
  never touch the merge.

Design rule: **instance-generated artifacts live under `~/.scns`, not the work tree**
(child issue): the soak script and e2e smoke write their evidence to
`~/.scns/evidence/`; `.gitignore` gains an evidence/probes backstop so an agent sweep
can never commit them; and the instance-owned block of `.github/copilot-instructions.md`
moves to an untracked include so the tracked file stays upstream's. After that,
merge-down is a fast-forward in the common case, and a genuine conflict means the
install and upstream really did change the same code — exactly what a human should see.

Auto branches compose with this the ordinary git way: `scns/auto/*` lives on the home,
merges into the home's `main` via the install's own PRs, and upstream merges arrive
underneath them.

## Question 4 — contribute-up: the sanitize-and-propose path

A change born on a private home reaches upstream only through a human
(child issue, `scns contribute <branch|pr>`):

1. **Select** — the human picks a home branch or PR worth upstreaming.
2. **Rebase** it onto `upstream/main` in a scratch worktree.
3. **Sanitize** — two passes over the full diff and the proposed PR text:
   - the existing secret sanitizer (`src/observe/secret-sanitizer.ts`): keys, tokens,
     JWTs, SSH keys, connection strings;
   - a new **names-and-paths pass** (child issue): absolute user paths
     (`/Users/<name>/…`, `C:\Users\<name>\…`), hostnames, email addresses, the
     account's other repository names (from `gh api`), and registered project names
     pulled from the local meta registry — the categories the secret sanitizer was
     never meant to catch.
   Every hit blocks. Each must be edited away or explicitly waived by the human, per
   hit — no bulk override.
4. **Structural exclusions** — refused by path, regardless of content: evidence
   artifacts, probe output, anything that belongs under `~/.scns`. Enforcement is a
   path *allowlist* (`src/`, `test/`, `docs/` minus evidence paths, `scripts/`,
   `.github/`), not a denylist — the pre-public history shows `git add -A` sweeping
   artifacts nobody chose into auto branches, and an allowlist is the shape of filter
   that survives the next surprise.
5. **Propose** — push a human-named branch to the human's public fork of upstream (an
   ordinary public fork is correct *here*: this content is public by construction) and
   open an ordinary upstream PR under the human's account.

No daemon ever performs step 5. That is structural, not policy: the writers' one target
is the home (`origin`, question 2), nothing in the codebase pushes any `main` or merges
a PR on GitHub (the auto-merger is a local, opt-in, safety-gated merge; there is no
`gh pr merge` anywhere), and `doctor` fails any configuration whose write target is the
upstream repo.

## Question 5 — migration for existing plain clones

Deliberately **no forced migration**:

- **A plain clone that never opted in** is already in the end state for its choice:
  distribution consumer, `origin` = upstream, writers off, self-issue refusing (#58).
  `git pull` keeps working as its update path.
- **An install opting in** runs `home setup`, which performs the whole conversion —
  create or adopt the home, re-point remotes, seed the registry graph — and is
  re-runnable on a half-converted clone.
- **Installs that previously pointed daemons at upstream** (pre-#58 defaults): after
  updating, those writers refuse until given a target, and `doctor` names exactly what
  to set. Setting `SCNS_SELF_ISSUE_REPO` (or the registry row) by hand, or running
  `home setup`, both resolve it.
- **The maintainer's installs follow the same path as any user's**: a private home, the
  daemons writing there, contributions carried up by hand. The maintainer gets no
  special topology — that is what the `write target ≠ upstream` doctor rule enforces.

## The broker graph, summarized

| Broker                | Reads (issue intake)   | Writes (branches, PRs, issues) | Upstream (merge-down)            |
| --------------------- | ---------------------- | ------------------------------ | -------------------------------- |
| global (`global` row) | its private home       | its private home               | the public repo                  |
| child (per project)   | the project's own repo | the project's own repo         | — (project is its own upstream)  |

## Out of scope

Implementing any of the above. The implementation is tracked by the child issues listed
on #57: the `home setup` command, the registry target graph, the `update` command, the
artifact relocation, the `contribute` path, the names-and-paths sanitizer pass, and the
install/update documentation.
