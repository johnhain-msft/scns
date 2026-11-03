/**
 * T055 [US5] (specs/001-learning-memory-loop) — the `consult_source` outward action (FR-020/021).
 *
 * Read an APPROVED-LIST source. `safetyKernel.checkEgress` runs FIRST and is the only authority:
 * spend signatures are denied before egress (deny-all unless the host is on the human-owned
 * `spendApis` list), and egress is denied unless the host is on the human-owned `hosts` list —
 * which SHIPS EMPTY, so by default every consult is refused + audited. The fetch itself is
 * dependency-injected (tests inject a spy; the broker wires a bounded real fetch), and it NEVER
 * fires on a deny.
 */
import type { SafetyKernel } from '../safety-kernel/safety-kernel.js'

export const CONSULT_REASON_MAX_CHARS = 500

export interface ConsultSourceInput {
  readonly url: string
  /** Why this source is needed — recorded with the audit trail. */
  readonly reason: string
}

export interface ConsultSourceResult {
  readonly allowed: boolean
  /** Fetched body (present iff allowed AND the fetch succeeded). */
  readonly body?: string
  readonly status?: number
  readonly detail: string
}

export interface ConsultSourceDeps {
  readonly kernel: SafetyKernel
  /** Bounded source reader (the broker wires real fetch with a timeout; tests inject a spy). */
  readonly fetchSource: (url: string) => Promise<{ status: number; body: string }>
}

export interface ConsultSourceHandler {
  consultSource(input: ConsultSourceInput): Promise<ConsultSourceResult>
}

export function createConsultSourceHandler(deps: ConsultSourceDeps): ConsultSourceHandler {
  return {
    async consultSource(input: ConsultSourceInput): Promise<ConsultSourceResult> {
      const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
      if (reason.length === 0 || reason.length > CONSULT_REASON_MAX_CHARS) {
        return {
          allowed: false,
          detail: `reason must be 1..${CONSULT_REASON_MAX_CHARS} chars (got ${reason.length})`,
        }
      }
      let host: string
      try {
        host = new URL(input.url).host
        if (!host) throw new Error('no host')
      } catch {
        return { allowed: false, detail: `malformed url: ${JSON.stringify(input.url)}` }
      }
      // THE chokepoint — spend precedence then deny-all egress; every allow AND deny is audited.
      const decision = deps.kernel.checkEgress(input.url)
      if (!decision.allow) {
        return { allowed: false, detail: `kernel denied (${decision.gate}): ${decision.detail}` }
      }
      try {
        const res = await deps.fetchSource(input.url)
        return {
          allowed: true,
          body: res.body,
          status: res.status,
          detail: `consulted ${host} (${res.status}) — reason: ${reason}`,
        }
      } catch (e) {
        return {
          allowed: true, // the kernel allowed the consult; the read itself failed
          detail: `fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        }
      }
    },
  }
}
