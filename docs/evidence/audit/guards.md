# Audit — guards (cross-cutting, T011b)

**Scope**: the RunGuards safety invariants every feature-002 run must uphold (data-model §6). This is the
SIXTH auditor — the six-vs-five resolution (see `audit-protocol.md`): the cross-cutting guards get their own
gradeable artifact rather than being folded silently into T017. · **State**: `measured_with_controls`

**Summary**: the CORE guards (live-vault read-only, isolated home, kill-by-PID) are real, reachable, and
**proven with explicit negative controls** (a guard that can only pass is not a guard). The broker/allowlist/
default-OFF invariants are verified structurally (config + repo-history non-touch) but were not exercised with
a live negative-control in this session — an honest limitation, not a failure.

| # | Invariant | Mechanism | Controls | Evidence (path:line) |
|---|---|---|---|---|
| 1 | Live vault read-only | `snapshotVault`/`assertVaultUnchanged` (mtime+size) | **pos+neg** (untouched passes; size/mtime/appearance throw) | `test/helpers/isolation.ts:49-76`; `test/unit/isolation-helper.test.ts:72-120` |
| 2 | Isolated home | `createIsolatedHome` sets `SCNS_HOME=mktemp`, restores prior | pos + restore | `test/helpers/isolation.ts:86-103`; `test/unit/isolation-helper.test.ts` |
| 3 | Kill-by-explicit-PID | `killByPid` refuses non-positive/group pids | **pos+neg** (live pid true; NaN/0/neg/group throw) | `test/helpers/isolation.ts:105-123`; `test/unit/isolation-helper.test.ts` |
| 4 | Broker :3456 undisturbed | shared `BROKER_PORT`, config default | structural (const alignment; not started/stopped) | `test/helpers/isolation.ts:17`; `src/broker/config.ts:67-70` |
| 5 | Kernel + allowlist human-owned/untouched | empty deny-all, non-self-editable | structural (ownership comment; no session write) | `config/safety-allowlist.json:1-5` |
| 6 | Levers default-OFF | strict `=== '1'` env gates | pos (default false when unset) | `src/memory/explore-router.ts:38-41`; `src/cli.ts:548-570` |

**Evidence rows**
- claim: live-vault guard tested with negative controls · quoted: `NEGATIVE control: a size change throws...` / `...an mtime-only change... throws` · ref: `test/unit/isolation-helper.test.ts:72-120`
- claim: kill-by-PID refuses group pids · quoted: `NEGATIVE control: refuses a negative pid that would signal a process GROUP` · ref: `test/unit/isolation-helper.test.ts`
- claim: allowlist is human-owned deny-all · quoted: `WS-0 Immutable Safety Kernel allowlist. HUMAN-OWNED. Ships EMPTY = deny-all` · ref: `config/safety-allowlist.json:1-5`
- claim: this session left the live vault byte-identical · quoted: `BEFORE mtime=1783256409 size=232488960 / AFTER mtime=1783256409 size=232488960 / UNCHANGED ✓` · ref: `docs/evidence/baseline-2026-07-06.md:8-11`

**Controls**: positive **and** negative present for guards 1–3 (separation clear). Guards 4–6 are pos/structural
only in this session.

**Gap**: add live negative-control exercises for the broker-undisturbed (start/stop refused), allowlist-write-
refused, and a lever off→on flip verification, so all six invariants have an executed negative control rather
than structural attestation.

**Blocked**: null.

**Assessment**: the guards are provably enforced where the unit tests include explicit failures (vault
mutation, invalid/group PID). The broker/kernel/lever invariants are real and reachable but currently rest on
"present + aligned + not-touched" rather than an executed negative control.
