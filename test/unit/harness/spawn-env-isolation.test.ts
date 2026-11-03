/**
 * Harness guard — no test may spawn a child with an inherited env that overrides `HOME` but leaves
 * `SCNS_HOME` to leak in from the operator's shell.
 *
 * ## Why this exists
 * `resolveScnsHome()` (`src/shared/scns-home.ts`) gives `SCNS_HOME` PRECEDENCE over `homedir()`. Two
 * conventions in this repo therefore collide: integration tests isolate a spawned broker by spreading
 * `process.env` into the child env and overriding `HOME`, while the guard preamble
 * (`.github/instructions/00-fix-first.instructions.md` §6) mandates `SCNS_HOME=$(mktemp -d)` on the
 * OUTER shell. When both are in play the outer value rides through the spread, the child points its
 * whole `~/.scns` tree outside the sandbox, and the test fails with
 * `SqliteError: unable to open database file` on a file it created itself. Measured cost before the
 * fix: 7 spurious failures across 2 files, entirely an artifact of the ambient variable.
 *
 * A setup-file guard that simply DELETED an inherited `SCNS_HOME` was rejected: it would strip the
 * in-process protection an operator deliberately opted into, pointing any non-DI production code
 * exercised by a unit test back at the LIVE `~/.scns`. Pinning at the spawn site fixes the children
 * without weakening the sandbox. This static scan keeps the anti-pattern from coming back.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const TEST_ROOT = resolve(__dirname, '..', '..')

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listTypeScriptFiles(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

/** The object literal that directly encloses `index`, via brace matching. `''` when unbalanced. */
function enclosingObjectLiteral(src: string, index: number): string {
  let depth = 0
  let open = -1
  for (let i = index; i >= 0; i--) {
    const ch = src[i]
    if (ch === '}') depth++
    else if (ch === '{') {
      if (depth === 0) {
        open = i
        break
      }
      depth--
    }
  }
  if (open < 0) return ''
  let d = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++
    else if (src[i] === '}') {
      d--
      if (d === 0) return src.slice(open, i + 1)
    }
  }
  return ''
}

/** `HOME:` as its own key — never the tail of `SCNS_HOME:` / `USERPROFILE_HOME:`. */
const SETS_HOME = /(^|[^A-Z_])HOME\s*:/
const SETS_SCNS_HOME = /\bSCNS_HOME\s*:/

/**
 * Opt-out marker for the deliberate anti-pattern fixtures below (and the negative control in
 * `isolation-helper.test.ts`): a scanner whose own controls trip it is useless. Put it on the same
 * line as the `...process.env` spread. Nothing that actually spawns a process may carry it.
 */
const FIXTURE_MARKER = 'scns-home-scan:fixture'

function lineAt(src: string, index: number): string {
  const start = src.lastIndexOf('\n', index) + 1
  const end = src.indexOf('\n', index)
  return src.slice(start, end < 0 ? src.length : end)
}

/** Every `{ ...process.env, … }` literal that overrides `HOME` without pinning `SCNS_HOME`. */
export function findLeakyEnvLiterals(src: string): string[] {
  const needle = '...process.env'
  const offenders: string[] = []
  for (
    let from = src.indexOf(needle);
    from >= 0;
    from = src.indexOf(needle, from + needle.length)
  ) {
    if (lineAt(src, from).includes(FIXTURE_MARKER)) continue
    const literal = enclosingObjectLiteral(src, from)
    if (!literal) continue
    if (SETS_HOME.test(literal) && !SETS_SCNS_HOME.test(literal)) offenders.push(literal)
  }
  return offenders
}

describe('findLeakyEnvLiterals — the scanner itself', () => {
  it('POSITIVE control: flags a spread that overrides HOME but not SCNS_HOME', () => {
    const src = `spawn(node, args, { env: { ...process.env, HOME: home, NODE_ENV: 'test' } })` // scns-home-scan:fixture
    expect(findLeakyEnvLiterals(src)).toHaveLength(1)
  })

  it('NEGATIVE control: does NOT flag a spread that pins both', () => {
    const src = `spawn(node, args, { env: { ...process.env, HOME: home, SCNS_HOME: home } })`
    expect(findLeakyEnvLiterals(src)).toEqual([])
  })

  it('NEGATIVE control: does NOT flag a spread that never touches HOME (e.g. git author vars)', () => {
    const src = `execFileSync('git', a, { env: { ...process.env, GIT_AUTHOR_NAME: 'test' } })`
    expect(findLeakyEnvLiterals(src)).toEqual([])
  })

  it('NEGATIVE control: does NOT mistake `SCNS_HOME:` alone for a bare `HOME:` override', () => {
    const src = `const env = { ...process.env, SCNS_HOME: home }`
    expect(findLeakyEnvLiterals(src)).toEqual([])
  })

  it('NEGATIVE control: ignores a plain `{ HOME: … }` argument with no env spread', () => {
    const src = `expect(resolveSessionStorePath({ HOME: '/home/jh' })).toBe(p)`
    expect(findLeakyEnvLiterals(src)).toEqual([])
  })

  it('finds an offender nested inside an outer options object', () => {
    const src = `spawn(bin, [a], { cwd: r, env: { ...process.env, HOME: h }, stdio: ['ignore'] })` // scns-home-scan:fixture
    const found = findLeakyEnvLiterals(src)
    expect(found).toHaveLength(1)
    expect(found[0]).not.toContain('stdio') // matched the inner literal, not the outer one
  })

  it('the fixture marker exempts a line — and ONLY the marked line', () => {
    const leaky = `{ ...process.env, HOME: h }` // scns-home-scan:fixture
    expect(findLeakyEnvLiterals(leaky)).toHaveLength(1) // unmarked ⇒ still caught
    expect(findLeakyEnvLiterals(`${leaky} // ${FIXTURE_MARKER}`)).toEqual([])
    expect(findLeakyEnvLiterals(`// ${FIXTURE_MARKER}\n${leaky}`)).toHaveLength(1) // marker is per-line
  })
})

describe('the test tree spawns children with a fully pinned isolated home', () => {
  it('no test file overrides HOME in an inherited env without also pinning SCNS_HOME', () => {
    const offenders = listTypeScriptFiles(TEST_ROOT).flatMap((file) =>
      findLeakyEnvLiterals(readFileSync(file, 'utf8')).map(
        (literal) =>
          `${relative(TEST_ROOT, file)}: ${literal.replace(/\s+/g, ' ').slice(0, 120)}` +
          ` — add SCNS_HOME (use isolatedHomeEnv from test/helpers/isolation.ts)`,
      ),
    )
    expect(offenders).toEqual([])
  })

  it('the scan actually reads files (guards against an empty-tree false pass)', () => {
    expect(listTypeScriptFiles(TEST_ROOT).length).toBeGreaterThan(100)
  })
})
