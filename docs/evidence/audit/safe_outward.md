# Audit — safe_outward (T016)

**Capability**: safe outward operation / guardrails (deny-all egress, fail-closed, empty human-owned
allowlist, kernel untouched) · **State**: `measured_with_controls` (closest to usable; NOT `usable`)

**Justification**: the guardrail is deny-all / fail-closed and **wired live** into the running broker
(`startBroker` → `createSafetyKernel({ allowlist: loadAllowlist(SAFETY_ALLOWLIST_PATH) })`,
`src/broker/startup.ts:313-315`), and it has a passing **positive AND negative control** via the outward
unit tests. It is graded `measured_with_controls` rather than `usable` because **no archived LIVE end-to-end
evidence row** exists in-repo (a live broker deny-all probe is deliberately deferred — running it would
touch the broker :3456, which the safety guards forbid in this read-only audit). This is an honest downgrade
from the pre-registered "usable" expectation (see the note in the readiness map + T017), not a refutation of
the guardrail.

**Backing subsystems**: `src/broker/services/safety-kernel/{kernel-allowlist,kernel-policy,safety-kernel}.ts`,
`src/broker/services/outward/{ask-human,consult-source}.ts`, `src/broker/startup.ts`,
`config/safety-allowlist.json`.

**Reachability (independently re-verified)**: `src/broker/startup.ts:313-315` constructs the safety kernel
from the loaded allowlist at broker startup; outward handlers call the chokepoint directly
(`consult-source.ts:56-74`, `ask-human.ts:49-60`). The guard is on the live outward path, not a dormant lib.

**Evidence rows**
- claim: deny-all / fail-closed allowlist ships empty · quoted: `WS-0 Immutable Safety Kernel allowlist. HUMAN-OWNED. Ships EMPTY = deny-all egress + deny-all spend` · ref: `config/safety-allowlist.json:3-5`
- claim: loader fails closed on any read/parse/shape error · quoted: `FAILS CLOSED to emptyAllowlist on any read/parse/shape error` · ref: `src/broker/services/safety-kernel/kernel-allowlist.ts:40-59`
- claim: egress is deny-by-default · quoted: `egress-allowlist: deny outbound contact/egress unless the target host is allowlisted (ships EMPTY = deny-all)` · ref: `src/broker/services/safety-kernel/kernel-policy.ts:57-64`
- claim: guard wired into live broker startup · quoted: `allowlist: loadAllowlist(SAFETY_ALLOWLIST_PATH)` · ref: `src/broker/startup.ts:313-315`

**Controls**
- **Positive**: an allowlisted host is allowed + audited · `test/unit/broker/services/outward/consult-source.test.ts:37-47`
- **Negative**: an off-list host is refused + fetch never fires; malformed URL/reason refuses before the kernel · `test/unit/broker/services/outward/consult-source.test.ts:49-87`
- **Separation**: clear (allow vs deny), 1.0 · `consult-source` gates through `checkEgress` first.

**Gap** (to `usable`): an archived live end-to-end deny-all row from the running broker (verbatim
`quoted_output` + artifact_ref), obtained via a guarded live probe — deferred here because it would touch the
broker; queue-able as a future controlled exercise. The policy itself is complete.

**Blocked**: null.

**Distance to usable**: very close. The guardrail is deny-all/fail-closed, wired live, and proven by pos/neg
controlled tests; the only missing piece for `usable` is an archived live e2e row (a runtime broker probe),
not any change to the policy.
