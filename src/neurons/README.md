# Neurons — concurrent project fan-out

A **neuron** is an SCNS team pinned to its own git working tree. Multiple
neurons run in parallel without stepping on each other's staged diffs or
quality-gate verdicts.

## Why

Before task 34, every agent the broker spawned ran in the broker's
`cwd`. Two concurrent self-improve loops on the same broker would have
written into the same checkout, tangling commits and producing one
`quality_gate_verdict` that mixes work from both loops. The
concurrent-agent cap (4) also blocked the second neuron's manager from
ever spawning, since one neuron already consumed 3 slots.

## What changed (task 34)

1. `teams.working_dir` — nullable column. NULL preserves legacy
   behaviour (broker cwd). Non-null forces every agent spawned for the
   team into that directory. `agent-spawner.doSpawn` consults the
   column on every spawn; **team working_dir always wins** over the
   caller-supplied one, so the autospawner, manual `/spawn`, and the
   manager auto-dispatch all converge on the same tree per neuron.
2. `DEFAULT_MAX_CONCURRENT_AGENTS` bumped from 4 → 8. Enough for two
   3-agent neurons + 2 slots of transient headroom. Override with
   `SCNS_MAX_CONCURRENT_AGENTS` when running more neurons.

## Operator workflow — add a new neuron

```bash
# 1. Clone the target repo to a dedicated checkout.
git clone git@github.com:your-org/target-repo.git \
  /Users/you/Coding_Projects/target-repo-neuron-a

# 2. Create a team in the broker with that path as working_dir.
#    Use whatever CLI/API surface you already use; the SQL is:
sqlite3 ~/.session-broker/data.db <<'SQL'
INSERT INTO teams (id, name, description, working_dir)
VALUES (
  'neuron-a-uuid',
  'neuron-target-repo-a',
  'Self-improve loop for target-repo',
  '/Users/you/Coding_Projects/target-repo-neuron-a'
);
SQL

# 3. Seed a pending task on the team. team-task-autospawner picks it
#    up on its next tick, spawns the scns-manager into the team's
#    working_dir, and the manager's broker auto-dispatch hands the
#    same working_dir to dev + qa.
sqlite3 ~/.session-broker/data.db <<'SQL'
INSERT INTO tasks (team_id, seq, subject, description, status)
VALUES ('neuron-a-uuid', 1, 'kick off neuron-a', '...your prompt...', 'pending');
SQL
```

That's it. The autospawner, manager, dev, and qa for `neuron-a` will all
run inside `target-repo-neuron-a`. Repeat with a different path to
fan out a second neuron concurrently — they share the broker, message
bus, and quality-gate arbiter, but never share a working tree.

## What's still single-instance

This commit isolates the **working tree** but not memory/dream/observer
scoping. Lessons learned by the brain on neuron A may still surface to
neuron B. That's tracked as the optional follow-up in task 34's brief
and is fine for the dual-neuron MVP — most cross-pollination is
beneficial. Revisit if it ever produces a false-positive verdict.

## Hard constraints

- `agent-spawner` resolves `team.working_dir` on **every** spawn — there
  is no opt-out, no flag, no env override that lets a caller bypass it.
  This is intentional: a per-call escape hatch is exactly how tangled
  diffs would creep back in.
- Path traversal in `working_dir` (any `..` segment after `path.resolve`)
  is rejected with `ValidationError`, same as the legacy caller-supplied
  path validation.
