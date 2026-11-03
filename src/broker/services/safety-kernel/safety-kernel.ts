/**
 * WS-0 Immutable Safety Kernel — the single non-bypassable policy chokepoint.
 *
 * Every gated agent action — tool call, spawn, or outbound egress/spend —
 * flows through {@link SafetyKernel.check}, which:
 *   1. evaluates the runtime gates (no-spend, egress-allowlist) with
 *      deny-all defaults (the allowlist ships EMPTY), and
 *   2. records the decision (allow AND deny) on the immutable, hash-chained
 *      audit log (Gate 4).
 *
 * Tool calls reach the kernel via {@link SafetyKernel.asPermissionPolicy},
 * an ACP permission-policy adapter that the agent-spawner wires in. The
 * adapter can only ADD denies (egress/spend) on top of a base policy — when
 * the kernel allows, the base policy decides — so autopilot autonomy for
 * safe tools is preserved (Decision A, Option A).
 *
 * NOTE (Gate 3, non-self-editable) lives in protected-paths.ts +
 * auto-merger.ts + qg-changeset-classifier.ts + quality-gate-arbiter.ts.
 *
 * NOTE (honest scope): the in-process tool-call layer is signature-based
 * and shell-obfuscation can defeat command-string egress detection. The
 * truly unbypassable OS egress jail (Option B) is the scheduled L0 item and
 * is NOT implemented here. Also: this kernel is constructed + enforcing in
 * the code path, but the LIVE broker only adopts it on its next start — the
 * live cutover is the L0 go-live (AWAITING-JOHN), not an in-process restart.
 */
import type Database from 'better-sqlite3'
import type {
  AcpPermissionPolicy,
  AcpRequestPermissionParams,
  AcpPermissionOutcome,
} from '../acp-client.js'
import { type ToolView, hostOf } from './egress-signatures.js'
import {
  evaluateToolAction,
  type DecisionGate,
  type PolicyConfig,
} from './kernel-policy.js'
import { emptyAllowlist, toPolicyConfig, type Allowlist } from './kernel-allowlist.js'
import {
  appendAudit,
  ensureKernelAuditTable,
  verifyAuditChain,
} from './kernel-audit.js'

export type KernelActionKind = 'tool_call' | 'spawn' | 'egress' | 'spend'

export interface KernelActionContext {
  readonly sessionId?: string | null
  readonly teamId?: string | null
  readonly role?: string | null
}

export interface KernelAction extends KernelActionContext {
  readonly kind: KernelActionKind
  readonly tool?: ToolView
  /** For 'egress'/'spend': the target URL or host. */
  readonly target?: string
}

export interface KernelDecision {
  readonly allow: boolean
  readonly gate: DecisionGate
  readonly detail: string
}

/** Optional sink to mirror kernel decisions into the broker event stream. */
export interface KernelEventSink {
  readonly kernelDecision?: (payload: {
    actionKind: KernelActionKind
    sessionId: string | null
    gate: DecisionGate
    allow: boolean
    detail: string
  }) => void
}

export interface SafetyKernelDeps {
  readonly db: Database.Database
  /** Human-owned allowlist; defaults to the EMPTY (deny-all) allowlist. */
  readonly allowlist?: Allowlist
  readonly eventSink?: KernelEventSink | null
  readonly now?: () => string
}

export interface SafetyKernel {
  /** THE chokepoint. Evaluates gates + audits every allow AND deny. */
  check(action: KernelAction): KernelDecision
  /** ACP tool-call adapter: wraps `base`, adding egress/spend denials. */
  asPermissionPolicy(base?: AcpPermissionPolicy): AcpPermissionPolicy
  /** Broker-side outbound seam (WS-4 ready). */
  checkEgress(url: string, ctx?: KernelActionContext): KernelDecision
  /** Agent-spawn seam (audit; observe-only this cycle). */
  checkSpawn(ctx?: KernelActionContext): KernelDecision
  /** Tamper check over the immutable audit chain. */
  verifyAuditChain(): { ok: boolean; brokenAtId?: number; count: number }
}

function pickReject(params: AcpRequestPermissionParams): AcpPermissionOutcome {
  const reject =
    params.options.find((o) => o.kind === 'reject_once') ??
    params.options.find((o) => o.kind.startsWith('reject_'))
  return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' }
}

function pickAllow(params: AcpRequestPermissionParams): AcpPermissionOutcome {
  const allow =
    params.options.find((o) => o.kind === 'allow_always') ??
    params.options.find((o) => o.kind.startsWith('allow_'))
  return allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' }
}

export function createSafetyKernel(deps: SafetyKernelDeps): SafetyKernel {
  ensureKernelAuditTable(deps.db)
  const cfg: PolicyConfig = toPolicyConfig(deps.allowlist ?? emptyAllowlist())
  const now = deps.now ?? (() => new Date().toISOString())

  function decide(action: KernelAction): KernelDecision {
    switch (action.kind) {
      case 'tool_call':
        return evaluateToolAction(action.tool ?? {}, cfg)
      case 'egress':
        return evaluateToolAction({ kind: 'fetch', url: action.target }, cfg)
      case 'spend': {
        const host = action.target ? hostOf(action.target) : null
        if (host && cfg.spendApis.has(host)) {
          return { allow: true, gate: 'default-allow', detail: `approved spend API: ${host}` }
        }
        return {
          allow: false,
          gate: 'no-spend',
          detail: host ? `paid API ${host} not in spend allowlist` : 'spend attempt blocked (deny-all)',
        }
      }
      case 'spawn':
      default:
        return { allow: true, gate: 'default-allow', detail: `spawn permitted (role=${action.role ?? 'unknown'})` }
    }
  }

  function check(action: KernelAction): KernelDecision {
    const d = decide(action)
    const sessionId = action.sessionId ?? null
    appendAudit(deps.db, {
      actionKind: action.kind,
      sessionId,
      gate: d.gate,
      allow: d.allow,
      detail: d.detail,
      ts: now(),
      payload: {
        role: action.role ?? null,
        teamId: action.teamId ?? null,
        target: action.target ?? null,
        toolKind: action.tool?.kind ?? null,
        toolTitle: action.tool?.title ?? null,
      },
    })
    deps.eventSink?.kernelDecision?.({
      actionKind: action.kind,
      sessionId,
      gate: d.gate,
      allow: d.allow,
      detail: d.detail,
    })
    return d
  }

  function asPermissionPolicy(base?: AcpPermissionPolicy): AcpPermissionPolicy {
    return {
      decide(params: AcpRequestPermissionParams): AcpPermissionOutcome {
        const tool: ToolView = {
          kind: params.toolCall?.kind,
          title: params.toolCall?.title,
          rawInput: params.toolCall?.rawInput,
        }
        const d = check({ kind: 'tool_call', sessionId: params.sessionId, tool })
        if (!d.allow) return pickReject(params)
        return base ? base.decide(params) : pickAllow(params)
      },
    }
  }

  return {
    check,
    asPermissionPolicy,
    checkEgress: (url, ctx) => check({ kind: 'egress', target: url, ...ctx }),
    checkSpawn: (ctx) => check({ kind: 'spawn', ...ctx }),
    verifyAuditChain: () => verifyAuditChain(deps.db),
  }
}
