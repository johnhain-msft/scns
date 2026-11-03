/**
 * WS-0 Safety Kernel — runtime gate policy (pure).
 *
 * Two runtime gates, evaluated against a tool view + the (human-owned)
 * allowlist config:
 *   - no-spend:         deny paid/billing/API-spend unless the host is an
 *                       approved spend API (allowlist ships EMPTY).
 *   - egress-allowlist: deny outbound contact/egress unless the target host
 *                       is allowlisted (ships EMPTY = deny-all). Loopback /
 *                       broker control-plane is non-egress (Decision B).
 *
 * Precedence: spend is checked before egress (a paid API is also egress;
 * it classifies as no-spend). Everything else is default-allow so that the
 * kernel preserves autopilot autonomy for safe tools (read/edit/search/
 * think/non-network execute).
 */
import {
  type ToolView,
  extractUrl,
  hostOf,
  isEgressAttempt,
  isInternalControlPlane,
  isSpendAttempt,
} from './egress-signatures.js'

export type RuntimeGate = 'no-spend' | 'egress-allowlist'
export type DecisionGate = RuntimeGate | 'default-allow'

export interface PolicyConfig {
  readonly egressHosts: ReadonlySet<string>
  readonly spendApis: ReadonlySet<string>
}

export interface PolicyDecision {
  readonly allow: boolean
  readonly gate: DecisionGate
  readonly detail: string
}

function allow(detail: string): PolicyDecision {
  return { allow: true, gate: 'default-allow', detail }
}
function deny(gate: RuntimeGate, detail: string): PolicyDecision {
  return { allow: false, gate, detail }
}

/** Evaluate a single tool call against the runtime gates. Pure + deterministic. */
export function evaluateToolAction(tool: ToolView, cfg: PolicyConfig): PolicyDecision {
  // Gate 1 — no money spend (checked first).
  if (isSpendAttempt(tool)) {
    const url = extractUrl(tool)
    const host = url ? hostOf(url) : null
    if (host && cfg.spendApis.has(host)) return allow(`approved spend API: ${host}`)
    return deny('no-spend', host ? `paid API ${host} not in spend allowlist` : 'spend attempt blocked (deny-all)')
  }

  // Gate 2 — egress allowlist (deny-all default).
  if (isEgressAttempt(tool)) {
    const url = extractUrl(tool)
    if (url && isInternalControlPlane(url)) return allow('internal control-plane (non-egress)')
    const host = url ? hostOf(url) : null
    if (host && cfg.egressHosts.has(host)) return allow(`allowlisted host: ${host}`)
    return deny('egress-allowlist', host ? `host ${host} not in egress allowlist` : 'egress to unknown target blocked (deny-all)')
  }

  return allow(`tool kind ${tool.kind ?? 'unknown'} permitted`)
}
