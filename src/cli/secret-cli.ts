/**
 * Phase 13.12.17 — `scns secret` CLI helpers.
 *
 * Exposes pure, testable helpers for `scns secret set/list/delete`. Wired
 * into the Commander tree from src/cli.ts. There is intentionally no
 * `scns secret get` — we don't want values landing in clipboards or
 * terminal scrollback; the brain fetches via the internal HTTP route.
 *
 * `set` reads the value from stdin with echo suppressed via the raw-tty
 * technique (readline + setRawMode). Never accepts a `--value` arg.
 */

import readline from 'node:readline'
import type { SecretStore, SecretMetadata } from '../secrets/secret-store.js'
import { isValidKey } from '../secrets/secret-store.js'

export interface ActionResult {
  readonly ok: boolean
  readonly message: string
}

export function formatList(items: readonly SecretMetadata[]): string {
  if (items.length === 0) return 'No secrets stored. Use `scns secret set <key>` to add one.'
  const header = ['KEY', 'CREATED', 'UPDATED', 'BYTES']
  const widths = [40, 24, 24, 6]
  const row = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join(' ')
  const lines = [row(header), row(widths.map((w) => '-'.repeat(w)))]
  for (const m of items) {
    lines.push(row([m.key, m.createdAt, m.updatedAt, String(m.sizeBytes)]))
  }
  return lines.join('\n')
}

/** `scns secret list`. */
export function runList(store: SecretStore): string {
  return formatList(store.list())
}

/** `scns secret delete <key>`. Pure helper — confirmation handled by the CLI wrapper. */
export function runDelete(store: SecretStore, key: string): ActionResult {
  if (!isValidKey(key)) {
    return { ok: false, message: `Invalid key: ${JSON.stringify(key)}` }
  }
  const removed = store.delete(key)
  if (!removed) {
    return { ok: false, message: `Secret ${key} not found` }
  }
  return { ok: true, message: `Deleted secret ${key}` }
}

/** `scns secret set <key>` — pure helper; value is already captured by caller. */
export function runSet(store: SecretStore, key: string, value: string): ActionResult {
  if (!isValidKey(key)) {
    return { ok: false, message: `Invalid key: ${JSON.stringify(key)}` }
  }
  if (value.length === 0) {
    return { ok: false, message: 'Empty value; aborting' }
  }
  store.set(key, value)
  return { ok: true, message: `Set secret ${key} (${value.length} bytes)` }
}

// ── Interactive helpers (stdin) ───────────────────────────────────────────

export interface PromptDeps {
  readonly input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (v: boolean) => unknown }
  readonly output: NodeJS.WritableStream
}

/**
 * Read a single line of secret input from stdin with echo suppressed. The
 * user's keystrokes are NEVER printed. On a non-TTY stdin (e.g. piped input
 * in tests / scripts) the line is read without muting, on the assumption
 * that the caller already controls that stream.
 *
 * Returns the value exactly as entered, minus the trailing newline.
 */
export async function readSecretFromStdin(
  prompt: string,
  deps: PromptDeps = {
    input: process.stdin as NodeJS.ReadableStream & { isTTY?: boolean },
    output: process.stdout,
  },
): Promise<string> {
  deps.output.write(prompt)

  const isTty = deps.input.isTTY === true && typeof deps.input.setRawMode === 'function'

  if (!isTty) {
    // Non-TTY: just read a line from the stream. Caller is responsible for
    // not echoing it anywhere.
    const rl = readline.createInterface({ input: deps.input, terminal: false })
    return new Promise<string>((resolve, reject) => {
      let buf = ''
      rl.once('line', (line) => {
        buf = line
        rl.close()
      })
      rl.once('close', () => resolve(buf))
      rl.once('error', reject)
    })
  }

  // TTY path: raw-mode capture, never echo.
  const rawInput = deps.input as NodeJS.ReadableStream & {
    setRawMode: (v: boolean) => unknown
    resume: () => void
    pause: () => void
    setEncoding: (enc: string) => void
    on: (ev: string, cb: (data: string) => void) => void
    removeListener: (ev: string, cb: (data: string) => void) => void
  }

  rawInput.setRawMode(true)
  rawInput.resume()
  rawInput.setEncoding('utf-8')

  return new Promise<string>((resolve, reject) => {
    let buf = ''
    const onData = (data: string): void => {
      for (const ch of data) {
        // ctrl-c
        if (ch === '\u0003') {
          cleanup()
          reject(new Error('Aborted'))
          return
        }
        // enter
        if (ch === '\n' || ch === '\r') {
          cleanup()
          deps.output.write('\n')
          resolve(buf)
          return
        }
        // backspace / DEL
        if (ch === '\u0008' || ch === '\u007f') {
          if (buf.length > 0) buf = buf.slice(0, -1)
          continue
        }
        buf += ch
      }
    }
    const cleanup = (): void => {
      rawInput.setRawMode(false)
      rawInput.pause()
      rawInput.removeListener('data', onData)
    }
    rawInput.on('data', onData)
  })
}
