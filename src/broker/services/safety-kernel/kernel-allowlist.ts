/**
 * WS-0 Safety Kernel — allowlist loader (human-owned data).
 *
 * The allowlist is the ONLY thing that opens egress/spend. It ships EMPTY
 * (= deny-all) and is non-self-editable (Gate 3). The loader FAILS CLOSED:
 * any missing/corrupt/garbage input yields an EMPTY allowlist, never an
 * open one. Populating it is a deferred HUMAN decision — do not invent
 * entries.
 */
import { readFileSync } from 'node:fs'
import type { PolicyConfig } from './kernel-policy.js'

export interface Allowlist {
  readonly egressHosts: ReadonlySet<string>
  readonly spendApis: ReadonlySet<string>
}

function normHosts(input: unknown): Set<string> {
  if (!Array.isArray(input)) return new Set()
  const out = new Set<string>()
  for (const v of input) {
    if (typeof v === 'string' && v.trim()) out.add(v.trim().toLowerCase())
  }
  return out
}

/** The empty (deny-all) allowlist. */
export function emptyAllowlist(): Allowlist {
  return { egressHosts: new Set(), spendApis: new Set() }
}

/** Build an allowlist from explicit arrays (normalized lowercase). TEST/wiring use. */
export function allowlistFrom(input: { hosts?: readonly string[]; spendApis?: readonly string[] }): Allowlist {
  return {
    egressHosts: normHosts(input.hosts),
    spendApis: normHosts(input.spendApis),
  }
}

/**
 * Load the allowlist from a JSON file. FAILS CLOSED to {@link emptyAllowlist}
 * on any read/parse/shape error. Inject `deps.readFile` in tests.
 */
export function loadAllowlist(
  path: string,
  deps?: { readFile?: (p: string) => string },
): Allowlist {
  const read = deps?.readFile ?? ((p: string) => readFileSync(p, 'utf-8'))
  try {
    const parsed = JSON.parse(read(path)) as unknown
    if (parsed === null || typeof parsed !== 'object') return emptyAllowlist()
    const obj = parsed as { hosts?: unknown; spendApis?: unknown }
    return {
      egressHosts: normHosts(obj.hosts),
      spendApis: normHosts(obj.spendApis),
    }
  } catch {
    return emptyAllowlist()
  }
}

/** Project an allowlist into the policy config shape. */
export function toPolicyConfig(a: Allowlist): PolicyConfig {
  return { egressHosts: a.egressHosts, spendApis: a.spendApis }
}
