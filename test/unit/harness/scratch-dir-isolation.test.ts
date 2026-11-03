/**
 * Harness guard — no test may create scratch files or directories rooted at `process.cwd()`.
 *
 * ## Why this exists
 * `process.cwd()` under vitest is the repository root. Nine test files built their scratch space
 * there instead of `os.tmpdir()` (#57 §2). Three consequences, in ascending order of severity:
 *
 * 1. **Litter.** Seven stray `.test-tmp-*` directories were found by hand. They survive a failed
 *    run and compound on the next one.
 * 2. **A test artifact can reach a commit.** SCNS's own auto-stage (`team-lifecycle` / QG) runs
 *    `git add -A`. A leaked fixture is an untracked file in the repo root, so it gets swept in.
 *    `.gitignore` is a backstop, not a fix — one of the nine wrote `test-vault-<ts>` with no
 *    leading dot, which no `.test-*` pattern covers.
 * 3. **It causes an intermittent failure.** Teardown races Windows file handles:
 *    `ENOTEMPTY: directory not empty, rmdir '\\?\C:\...\scns\.test-tmp-02ce09cd\.claude'`.
 *    Retry options on `rmSync` treat the symptom; putting scratch space in `os.tmpdir()` — where
 *    the other 255 test files already put it — removes the cause.
 *
 * ## What the scan checks
 * A file-local taint pass: a binding initialised from `join(process.cwd(), …)` is cwd-rooted, as
 * is anything joined onto it. Passing a cwd-rooted path to a mutating `fs` call is the offence.
 *
 * It deliberately does NOT chase `process.cwd()` handed to production code (e.g.
 * `projectRoot: process.cwd()`), which is a legitimate read-mostly configuration and not
 * statically decidable here. Read-only uses such as `const SRC = join(process.cwd(), 'src')` are
 * fine and must stay unflagged — see the negative controls.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const TEST_ROOT = resolve(__dirname, '..', '..')

/**
 * This is a whole-tree scan, not a unit test: it opens every `.ts` file under `test/`. The suite's
 * global 10s `testTimeout` is sized for single-unit work, and the scan blew through it under
 * full-suite parallel load (204ms alone, >10s contended) — the reads are cheap individually but
 * there are hundreds of them competing for the disk. The reads below are issued concurrently so
 * the latency overlaps; this ceiling is the backstop for a slow or virus-scanned filesystem.
 */
const WHOLE_TREE_SCAN_TIMEOUT_MS = 60_000

/** `fs` calls that create or destroy something on disk. */
const MUTATORS = [
  'mkdirSync',
  'mkdtempSync',
  'writeFileSync',
  'appendFileSync',
  'rmSync',
  'rmdirSync',
  'unlinkSync',
  'cpSync',
  'copyFileSync',
  'renameSync',
  'symlinkSync',
] as const

/**
 * Opt-out marker for the scanner's own fixtures: a scanner whose controls trip it is useless.
 * Put it on the same line. Nothing that actually touches disk may carry it.
 */
const FIXTURE_MARKER = 'scratch-dir-scan:fixture'

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = []
  // `withFileTypes` answers "is this a directory?" from the directory entry itself, which drops one
  // `statSync` per file. It reports a symlinked directory as a link rather than a directory, so
  // such a link is not descended into — the test tree has none, and refusing to follow one also
  // means this walk cannot be sent round a cycle.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTypeScriptFiles(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

function lineAt(src: string, index: number): string {
  const start = src.lastIndexOf('\n', index) + 1
  const end = src.indexOf('\n', index)
  return src.slice(start, end < 0 ? src.length : end)
}

/** Text inside the parenthesis group that opens at `open`. `''` when unbalanced. */
function balancedParens(src: string, open: number): string {
  let depth = 0
  let quote = ''
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return ''
}

/** The first comma-separated argument at paren depth 0, quotes respected. */
function firstArgument(args: string): string {
  let depth = 0
  let quote = ''
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) return args.slice(0, i)
  }
  return args
}

/** Every call to `name(` in `src`, as the text of its first argument. */
function firstArgumentsOf(src: string, name: string): Array<{ index: number; arg: string }> {
  const out: Array<{ index: number; arg: string }> = []
  const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g')
  for (let m = pattern.exec(src); m; m = pattern.exec(src)) {
    const open = src.indexOf('(', m.index)
    if (open < 0) continue
    out.push({ index: m.index, arg: firstArgument(balancedParens(src, open)).trim() })
  }
  return out
}

const CWD_CALL = /\bprocess\s*\.\s*cwd\s*\(\s*\)/

/** Bindings whose value is a path underneath `process.cwd()`, propagated through `join`/`resolve`. */
function cwdRootedBindings(src: string): Set<string> {
  const rooted = new Set<string>()
  const binding = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^\n]+)/g
  // Two passes so `const a = join(process.cwd(), x)` can taint a later `const b = join(a, y)`
  // regardless of declaration order within the file.
  for (let pass = 0; pass < 2; pass++) {
    binding.lastIndex = 0
    for (let m = binding.exec(src); m; m = binding.exec(src)) {
      const [, name, init] = m as unknown as [string, string, string]
      if (lineAt(src, m.index).includes(FIXTURE_MARKER)) continue
      if (CWD_CALL.test(init)) rooted.add(name)
      else if (/\b(?:join|resolve)\s*\(/.test(init)) {
        for (const ident of init.matchAll(/[A-Za-z_$][\w$]*/g)) {
          if (rooted.has(ident[0])) rooted.add(name)
        }
      }
    }
  }
  return rooted
}

/** Mutating `fs` calls whose path argument is rooted at `process.cwd()`. */
export function findCwdScratchWrites(src: string): string[] {
  const rooted = cwdRootedBindings(src)
  const offenders: string[] = []
  for (const mutator of MUTATORS) {
    for (const { index, arg } of firstArgumentsOf(src, mutator)) {
      if (lineAt(src, index).includes(FIXTURE_MARKER)) continue
      const tainted =
        CWD_CALL.test(arg) || [...arg.matchAll(/[A-Za-z_$][\w$]*/g)].some((i) => rooted.has(i[0]))
      if (tainted) offenders.push(`${mutator}(${arg.replace(/\s+/g, ' ').slice(0, 80)})`)
    }
  }
  return offenders
}

describe('findCwdScratchWrites — the scanner itself', () => {
  it('POSITIVE control: flags a mkdirSync on a cwd-rooted binding', () => {
    const src = `const base = join(process.cwd(), '.test-tmp')\nmkdirSync(base, { recursive: true })` // scratch-dir-scan:fixture
    expect(findCwdScratchWrites(src)).toHaveLength(1)
  })

  it('POSITIVE control: flags an inline process.cwd() path', () => {
    const src = `writeFileSync(join(process.cwd(), 'leak.txt'), 'x')` // scratch-dir-scan:fixture
    expect(findCwdScratchWrites(src)).toHaveLength(1)
  })

  it('POSITIVE control: taint propagates one join deep', () => {
    const src = `const root = join(process.cwd(), '.scratch')\nconst sub = join(root, 'a')\nmkdirSync(sub)` // scratch-dir-scan:fixture
    expect(findCwdScratchWrites(src)).toHaveLength(1)
  })

  it('POSITIVE control: taint propagates regardless of declaration order', () => {
    const src = `function f() { const sub = join(root, 'a'); mkdirSync(sub) }\nconst root = join(process.cwd(), '.scratch')` // scratch-dir-scan:fixture
    expect(findCwdScratchWrites(src)).toHaveLength(1)
  })

  it('NEGATIVE control: the approved os.tmpdir() pattern is clean', () => {
    const src = `const base = mkdtempSync(join(tmpdir(), 'scns-area-'))\nmkdirSync(join(base, 'x'))`
    expect(findCwdScratchWrites(src)).toEqual([])
  })

  it('NEGATIVE control: a read-only cwd path is not a write', () => {
    const src = `const SRC = join(process.cwd(), 'src')\nconst files = readdirSync(SRC)`
    expect(findCwdScratchWrites(src)).toEqual([])
  })

  it('NEGATIVE control: process.cwd() passed as a value, not a path to create', () => {
    const src = `const r = defaultRunCommand('echo hi', process.cwd())\nexpect(cfg.projectRoot).toBe(process.cwd())`
    expect(findCwdScratchWrites(src)).toEqual([])
  })

  it('NEGATIVE control: a same-named identifier in an unrelated file is not tainted', () => {
    const src = `const base = mkdtempSync(join(tmpdir(), 'x-'))\nrmSync(base, { recursive: true })`
    expect(findCwdScratchWrites(src)).toEqual([])
  })

  it('the fixture marker exempts a line — and ONLY the marked line', () => {
    const leak = `writeFileSync(join(process.cwd(), 'a.txt'), '')` // scratch-dir-scan:fixture
    expect(findCwdScratchWrites(leak)).toHaveLength(1)
    expect(findCwdScratchWrites(`${leak} // ${FIXTURE_MARKER}`)).toEqual([])
    expect(findCwdScratchWrites(`// ${FIXTURE_MARKER}\n${leak}`)).toHaveLength(1)
  })
})

describe('the test tree keeps its scratch space out of the repository', () => {
  it(
    'no test file creates scratch files or directories under process.cwd()',
    async () => {
      const files = listTypeScriptFiles(TEST_ROOT)
      const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')))
      const offenders = files.flatMap((file, i) =>
        findCwdScratchWrites(sources[i]!).map(
          (call) =>
            `${relative(TEST_ROOT, file)}: ${call}` +
            ` — use mkdtempSync(join(tmpdir(), 'scns-<area>-')) instead of process.cwd()`,
        ),
      )
      expect(offenders).toEqual([])
    },
    WHOLE_TREE_SCAN_TIMEOUT_MS,
  )

  it('the scan actually reads files (guards against an empty-tree false pass)', () => {
    expect(listTypeScriptFiles(TEST_ROOT).length).toBeGreaterThan(100)
  })
})
