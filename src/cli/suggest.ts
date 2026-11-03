/**
 * Phase 13.12.16 — `scns suggest` CLI.
 *
 * Manages the on-disk suggestion pile: list, delete, retry (failed items),
 * dismiss (mark rejected), and repromote (needs-human → pending).
 *
 * All actions operate directly on the filesystem store so they work even
 * when the broker is down. Where sensible, helpers are exported for unit
 * testing with an injectable store.
 */

import type { SuggestionStatus, SuggestionType, Suggestion } from '../suggest/types.js'
import { isGateExhausted as isGateExhaustedItem } from '../suggest/escalation.js'

/**
 * Minimal store surface the CLI depends on. Exported for test injection.
 */
export interface SuggestCliStore {
  list(status?: SuggestionStatus): readonly Suggestion[]
  get(id: string): Suggestion | null
  remove(id: string): boolean
  clearBackoff(id: string): Suggestion | null
  updateStatus(id: string, status: SuggestionStatus, reason?: string): Suggestion | null
  repromote(id: string): Suggestion | null
}

export interface ListOptions {
  readonly status?: string
  readonly type?: string
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return ''
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

/** Render the `list` table. Exported for testing. */
export function formatList(suggestions: readonly Suggestion[]): string {
  if (suggestions.length === 0) return 'No suggestions match the filter.'
  const header = ['ID', 'STATUS', 'TYPE', 'TITLE', 'CREATED']
  const widths = [36, 18, 14, 48, 20]
  const row = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join(' ')
  const lines = [row(header), row(widths.map((w) => '-'.repeat(w)))]
  for (const s of suggestions) {
    lines.push(
      row([
        s.id,
        s.status,
        s.type ?? '',
        truncate(s.title, widths[3]!),
        truncate(s.createdAt, widths[4]!),
      ]),
    )
  }
  return lines.join('\n')
}

/** `scns suggest list` — filter optionally by status and/or type. */
export function runList(store: SuggestCliStore, opts: ListOptions): string {
  const statusFilter = opts.status as SuggestionStatus | undefined
  const all = store.list(statusFilter)
  const filtered = opts.type ? all.filter((s) => s.type === opts.type) : all
  return formatList(filtered)
}

export interface ActionResult {
  readonly ok: boolean
  readonly message: string
}

/** `scns suggest delete <id>` — removes the markdown file. */
export function runDelete(store: SuggestCliStore, id: string): ActionResult {
  const existing = store.get(id)
  if (!existing) return { ok: false, message: `Suggestion ${id} not found` }
  const removed = store.remove(id)
  if (!removed) {
    return { ok: false, message: `Failed to remove suggestion ${id}` }
  }
  return { ok: true, message: `Deleted suggestion ${id} (was ${existing.status})` }
}

/**
 * `scns suggest retry <id>` — only valid for status=failed. Clears backoff
 * counters and moves the suggestion back so the brain will pick it up.
 */
export function runRetry(store: SuggestCliStore, id: string): ActionResult {
  const existing = store.get(id)
  if (!existing) return { ok: false, message: `Suggestion ${id} not found` }
  // FR-058 — `needs-human` is retryable when it got there by EXHAUSTING the gate's retry budget,
  // which is the state Phase 10f escalates an approved-but-unbuildable proposal into. Refusing it
  // here left that escalation with no way back: the whole point of surfacing it to John is that he
  // can say "try again" or "close it", and only the second was reachable.
  //
  // A `needs-human` that came from the OTHER meaning (13.12.16 — a safety gate refused it and it
  // needs rebuilding) is still refused; that one needs `repromote`, not another attempt.
  const isGateExhausted = isGateExhaustedItem(existing)
  if (existing.status !== 'failed' && !isGateExhausted) {
    return {
      ok: false,
      message: `Suggestion ${id} is ${existing.status}, not failed; cannot retry`,
    }
  }
  const updated = store.clearBackoff(id)
  if (!updated) return { ok: false, message: `Failed to reset ${id}` }
  return {
    ok: true,
    message: `Reset ${id}: attempt_count=0, status=${updated.status}`,
  }
}

/**
 * `scns suggest dismiss <id>` — mark as rejected with
 * reason "dismissed by user".
 */
export function runDismiss(store: SuggestCliStore, id: string): ActionResult {
  const existing = store.get(id)
  if (!existing) return { ok: false, message: `Suggestion ${id} not found` }
  const updated = store.updateStatus(id, 'rejected', 'dismissed by user')
  if (!updated) return { ok: false, message: `Failed to dismiss ${id}` }
  return { ok: true, message: `Dismissed suggestion ${id} (was ${existing.status})` }
}

/**
 * `scns suggest repromote <id>` — only valid for status=needs-human.
 * Moves back to pending and clears review fields.
 */
export function runRepromote(store: SuggestCliStore, id: string): ActionResult {
  const existing = store.get(id)
  if (!existing) return { ok: false, message: `Suggestion ${id} not found` }
  if (existing.status !== 'needs-human') {
    return {
      ok: false,
      message: `Suggestion ${id} is ${existing.status}, not needs-human; cannot repromote`,
    }
  }
  const updated = store.repromote(id)
  if (!updated) return { ok: false, message: `Failed to repromote ${id}` }
  return { ok: true, message: `Repromoted ${id} → pending` }
}

export type { SuggestionType }
