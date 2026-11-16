/**
 * Shell-free command parsing for executor RunCommand steps.
 *
 * RunCommand used to pass the step's command string to `execSync`, which
 * routes through /bin/sh (cmd.exe on Windows). A regex denylist cannot make
 * that safe: shell operators compose (`$(...)`, backticks, `;`, pipes) and
 * any miss is arbitrary shell execution at autonomy level 3. Parsing the
 * string into argv and spawning WITHOUT a shell makes injection structurally
 * impossible — operators are either quoted data or a refusal, never syntax.
 */

/** Characters that only mean something to a shell; outside quotes they signal
 * the command expects shell semantics this executor deliberately refuses. */
const SHELL_OPERATORS = /[|&;<>`$()]/

/**
 * Parse a command string into argv for `execFileSync(argv[0], argv.slice(1))`.
 *
 * Supports whitespace-separated tokens and `'...'` / `"..."` quoting (quotes
 * group and are stripped; no escape processing, so Windows `\` paths pass
 * through literally). Returns `null` when the string is empty, has unbalanced
 * quotes, or uses a shell operator outside quotes — callers must surface that
 * as "no shell is spawned" rather than silently degrading.
 */
export function parseCommandArgv(command: string): string[] | null {
  const argv: string[] = []
  let current = ''
  let inToken = false
  let quote: '"' | "'" | null = null

  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (inToken) {
        argv.push(current)
        current = ''
        inToken = false
      }
      continue
    }
    if (ch === '\n' || ch === '\r' || SHELL_OPERATORS.test(ch)) {
      return null
    }
    current += ch
    inToken = true
  }

  if (quote !== null) return null
  if (inToken) argv.push(current)
  return argv.length > 0 ? argv : null
}
