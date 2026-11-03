/**
 * Open a real, interactive terminal for the weekly review.
 *
 * WHY THIS EXISTS. The `weekly-promotion-review` cron renders the packet to
 * `~/.scns/reviews/weekly-<date>.md` and then logs `run \`scns review weekly\``. Two problems, both
 * measured on 2026-08-03:
 *
 *   1. `scns` is not installed. `which scns` finds nothing, in this shell or in a login shell.
 *      `package.json` declares `bin: { "scns": "./dist/cli.js" }` but it was never `npm link`ed. So
 *      the single instruction the cron emits is not runnable as written.
 *   2. Even if it were, a pino line in a log nobody is watching is not a prompt. The review only
 *      happened when John independently remembered to go and do it.
 *
 * The cost is not cosmetic. The review is the ONLY source of human accept/reject labels, and the
 * routing learner reports an under-powered null for want of them. A review that does not happen is
 * a week of labels that do not exist.
 *
 * John's ruling, 2026-08-03: *"running from broker is fine; however, it needs to actually open a
 * terminal so i can interact with it."*
 *
 * DESIGN CONSTRAINTS, each one measured rather than assumed:
 *
 * - **Self-locating, never PATH-dependent.** The broker's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`
 *   plus its own node dir (`launchctl print gui/501/com.scns.broker`). The command is built from
 *   `process.execPath` and the CLI's own path, so it works whether or not `scns` is ever linked.
 * - **GUI session required.** The broker runs in the `gui/501` launchd domain, which has Aqua
 *   session access, so `osascript` can drive Terminal. A broker moved to a `system/` domain would
 *   lose this, which is why failure is handled rather than assumed away.
 * - **Fail-safe.** This must NEVER throw. In the cron handler the `proposal_outcomes` sweep runs
 *   after this call and carries John's already-written reasons the last mile to the learner. A
 *   throw here would skip it, so a cosmetic failure would cost real learning data.
 * - **ESM-safe module loading.** `package.json` is `"type": "module"`, so this file is emitted as an
 *   ES module and `require` does not exist in it. An earlier version resolved `spawn` with a bare
 *   `require('node:child_process')`; the fail-safe `try/catch` below then swallowed the resulting
 *   `ReferenceError` and reported a tidy `spawn-failed` on EVERY invocation, so the launcher was
 *   structurally incapable of opening a window while looking healthy. Measured under the broker's
 *   own conditions (an ESM entry, `node dist/cli.js start`):
 *
 *       DEFAULTSPAWN THREW: ReferenceError - require is not defined
 *
 *   No test could have caught it: BOTH vitest's Vite SSR transform AND `node -e` (which is CJS and
 *   exposes a global `require`) provide a shim, so the same call succeeds in every test harness and
 *   fails only in production. Hence the static import below, and the source-level guard in
 *   `review-terminal.test.ts`.
 */
import { spawn as nodeSpawn } from 'node:child_process'

/** The subset of `child_process.spawn` this module needs. Injected so tests spawn nothing. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => { unref?: () => void }
export interface ResolveReviewCommandInput {
  /** The node binary running the broker — i.e. `process.execPath`. */
  readonly execPath: string
  /** The CLI entrypoint — i.e. the broker's own `dist/cli.js`. */
  readonly cliPath: string
  /** Extra args after `review weekly`. */
  readonly extraArgs?: readonly string[]
  /**
   * The broker's own environment — i.e. `process.env`. Only `SCNS_HOME` is carried across, and only
   * when set: the Terminal window `osascript` opens is a fresh LOGIN shell that inherits nothing
   * from the broker, so without this a broker running under a non-default home would render its
   * packet from one corpus and open a review of another.
   */
  readonly env?: Record<string, string | undefined>
}

export interface LaunchInteractiveReviewInput {
  readonly command: string
  readonly platform?: NodeJS.Platform
  readonly spawn?: SpawnFn
}

export type LaunchOutcome =
  | { readonly launched: true; readonly app: string }
  | {
      readonly launched: false
      readonly reason: 'unsupported-platform' | 'spawn-failed'
    }

/** POSIX single-quoting: everything inside is literal, and `'` is closed/escaped/reopened. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Escape a string for embedding in an AppleScript double-quoted literal.
 *
 * Backslashes MUST be replaced before quotes, or the backslash introduced by quote-escaping would
 * itself be escaped a second time and the quote would be emitted raw — which would terminate the
 * AppleScript string and let the remainder be read as AppleScript source.
 */
function appleScriptQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** The shell command the terminal window should run. Absolute, quoted, PATH-independent. */
export function resolveReviewCommand(input: ResolveReviewCommandInput): string {
  const scnsHome = input.env?.['SCNS_HOME']
  const parts = [
    ...(scnsHome && scnsHome.trim() !== '' ? [`SCNS_HOME=${shellQuote(scnsHome)}`] : []),
    shellQuote(input.execPath),
    shellQuote(input.cliPath),
    'review',
    'weekly',
    ...(input.extraArgs ?? []),
  ]
  return parts.join(' ')
}

/**
 * Open a Terminal.app window running `command`, bring it to the front, and return.
 *
 * Returns an outcome rather than throwing; see the fail-safe note above.
 */
export function launchInteractiveReview(input: LaunchInteractiveReviewInput): LaunchOutcome {
  const platform = input.platform ?? process.platform
  if (platform !== 'darwin') {
    return { launched: false, reason: 'unsupported-platform' }
  }

  const escaped = appleScriptQuote(input.command)

  try {
    const spawn = input.spawn ?? defaultSpawn()
    const child = spawn(
      'osascript',
      [
        '-e',
        'tell application "Terminal"',
        '-e',
        'activate',
        '-e',
        `do script "${escaped}"`,
        '-e',
        'end tell',
      ],
      { detached: true, stdio: 'ignore' },
    )
    child.unref?.()
    return { launched: true, app: 'Terminal' }
  } catch {
    return { launched: false, reason: 'spawn-failed' }
  }
}

export function defaultSpawn(): SpawnFn {
  return nodeSpawn as unknown as SpawnFn
}
