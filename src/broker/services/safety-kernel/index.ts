/**
 * WS-0 Immutable Safety Kernel — public barrel.
 *
 * The single non-bypassable policy chokepoint every gated agent action
 * (tool call / spawn / egress / spend) passes through. See safety-kernel.ts.
 */
export {
  createSafetyKernel,
  type SafetyKernel,
  type SafetyKernelDeps,
  type KernelAction,
  type KernelActionKind,
  type KernelActionContext,
  type KernelDecision,
  type KernelEventSink,
} from './safety-kernel.js'
export {
  emptyAllowlist,
  allowlistFrom,
  loadAllowlist,
  toPolicyConfig,
  type Allowlist,
} from './kernel-allowlist.js'
export {
  evaluateToolAction,
  type PolicyConfig,
  type PolicyDecision,
  type RuntimeGate,
  type DecisionGate,
} from './kernel-policy.js'
export {
  isSafetyKernelPath,
  SAFETY_KERNEL_DIR_PREFIX,
  SAFETY_ALLOWLIST_PATH,
  SAFETY_KERNEL_PROTECTED_EXACT,
} from './protected-paths.js'
export {
  ensureKernelAuditTable,
  appendAudit,
  getAuditRows,
  verifyAuditChain,
  computeRowHash,
  KERNEL_AUDIT_GENESIS_HASH,
  type AuditInput,
  type AuditRow,
} from './kernel-audit.js'
export {
  type ToolView,
  isEgressAttempt,
  isSpendAttempt,
  isInternalControlPlane,
  hostOf,
  extractCommand,
  extractUrl,
  NETWORK_VERBS,
} from './egress-signatures.js'
