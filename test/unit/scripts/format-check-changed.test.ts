/**
 * `scripts/format-check-changed.mjs` — the prettier gate CI can actually pass.
 *
 * DEFECT (2026-09-21): `npm run format:check` is repo-wide and, at the time the
 * CI pipeline was added, reported "Code style issues found in 350 files" — 350
 * of the 1049 `.ts` files under `src/` and `test/` (≈33%). Wiring that script
 * into a blocking job would have produced a pipeline that was red on its first
 * run for reasons no contributor introduced, which trains people to ignore it.
 * Reformatting a third of the tree from inside a CI task is the other bad
 * option: a huge diff, unrelated to the change, on files other work is
 * touching concurrently.
 *
 * So the gate is incremental — it checks only the files a change actually
 * touches, holding the line from now on while the backlog is retired
 * separately. The tests below pin the three behaviours that make that safe:
 *
 *   - a changed file that is not prettier-clean FAILS (the gate has teeth);
 *   - a changed file that is clean PASSES (no false alarm);
 *   - an absent/unresolvable/zero base SHA SKIPS rather than exploding, because
 *     tag pushes and first-pushes have no meaningful "before" commit.
 *
 * The script is exercised for real against throwaway git repos — a mocked git
 * would not catch the diff-filter and rev-parse details that actually break.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../../..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'format-check-changed.mjs')

/** Matches `.prettierrc` at the repo root, so fixtures mean the same thing here. */
const PRETTIER_RC = JSON.stringify({
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  arrowParens: 'always',
})

const CLEAN_TS = "export const greeting = 'hello'\n"
// Semicolon + double quotes + 4-space indent: three separate violations of the
// config above, so this cannot pass by accident if one rule is relaxed.
const MESSY_TS = 'export function greet() {\n    return "hello";\n}\n'

// The same two shapes as plain JavaScript. `scripts/` is ES modules, so these
// are valid `.mjs` on their own.
const CLEAN_MJS = "export const greeting = 'hello'\n"
const MESSY_MJS = 'export function greet() {\n    return "hello";\n}\n'

/**
 * Every test here runs the gate for real, which costs two node process starts — the script itself,
 * then the prettier CLI it spawns. Measured 2026-09-21 on a warm checkout: ~1.0s for bare node
 * startup, ~2.7s for prettier, ~5.1s for one end-to-end `runGate`, and 12.6s for the first test
 * under normal parallel worker contention.
 *
 * That last number is the point: vitest's global `testTimeout` is 10s (vitest.config.ts), so this
 * file failed on a cold run before this constant existed, and would have failed harder on a CI
 * runner slower than a laptop — turning the brand-new required `test` job red on its first push
 * for a reason unrelated to any contributor's change. `lint-scope.test.ts` already carries the
 * same allowance for the same reason (loading typescript-eslint).
 *
 * The cost is deliberate, not waste: spawning the real script against a real throwaway git repo is
 * what catches the `--diff-filter` and `rev-parse` behaviour a mocked git would silently fake.
 */
const GATE_TIMEOUT_MS = 60_000

let root: string

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' })
}

function write(relative: string, contents: string): void {
  const file = join(root, relative)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

/** Runs the real script against `root`; returns its exit status and output. */
function runGate(baseRef?: string): { status: number; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Explicitly cleared unless the case under test sets one, so a stray
      // FORMAT_BASE_REF in the ambient environment cannot alter a result.
      FORMAT_BASE_REF: baseRef ?? '',
    },
  })

  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` }
}

/** Commits a formatted baseline and returns its SHA — the "before" of a change. */
function seedBaseline(): string {
  write('.prettierrc', PRETTIER_RC)
  write('src/baseline.ts', CLEAN_TS)
  git('init', '--quiet', '--initial-branch=main')
  git('config', 'user.email', 'ci@example.test')
  git('config', 'user.name', 'CI Fixture')
  git('add', '-A')
  git('commit', '--quiet', '--no-verify', '-m', 'baseline')

  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scns-format-gate-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('format-check-changed — the gate has teeth', { timeout: GATE_TIMEOUT_MS }, () => {
  it('fails when a changed file is not prettier-clean', () => {
    const base = seedBaseline()
    write('src/added.ts', MESSY_TS)

    const { status, output } = runGate(base)

    expect(status).not.toBe(0)
    expect(output).toContain('src/added.ts')
  })

  it('fails on a modified file, not only on a newly added one', () => {
    const base = seedBaseline()
    write('src/baseline.ts', MESSY_TS)

    const { status } = runGate(base)

    expect(status).not.toBe(0)
  })

  it('checks changed test files too, not just src', () => {
    const base = seedBaseline()
    write('test/unit/added.test.ts', MESSY_TS)

    const { status, output } = runGate(base)

    expect(status).not.toBe(0)
    expect(output).toContain('test/unit/added.test.ts')
  })
})

describe('format-check-changed — JavaScript is gated too', { timeout: GATE_TIMEOUT_MS }, () => {
  // DEFECT (2026-09-21): this gate filtered on `.endsWith('.ts')` under `src/` and `test/` only,
  // so every `.mjs` file in `scripts/` slipped past it — including this gate's own source file,
  // which was not prettier-clean on the day it was added. A formatting standard that exempts the
  // tooling enforcing it is not a standard.
  it('fails when a changed .mjs script is not prettier-clean', () => {
    const base = seedBaseline()
    write('scripts/tool.mjs', MESSY_MJS)

    const { status, output } = runGate(base)

    expect(status).not.toBe(0)
    expect(output).toContain('scripts/tool.mjs')
  })

  it('fails on a modified .mjs script, not only a newly added one', () => {
    write('.prettierrc', PRETTIER_RC)
    write('scripts/tool.mjs', CLEAN_MJS)
    git('init', '--quiet', '--initial-branch=main')
    git('config', 'user.email', 'ci@example.test')
    git('config', 'user.name', 'CI Fixture')
    git('add', '-A')
    git('commit', '--quiet', '--no-verify', '-m', 'baseline')
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    write('scripts/tool.mjs', MESSY_MJS)

    const { status } = runGate(base)

    expect(status).not.toBe(0)
  })

  it('passes when a changed .mjs script is clean', () => {
    const base = seedBaseline()
    write('scripts/tool.mjs', CLEAN_MJS)

    const { status } = runGate(base)

    expect(status).toBe(0)
  })
})

describe('format-check-changed — no false alarms', { timeout: GATE_TIMEOUT_MS }, () => {
  it('passes when every changed file is clean', () => {
    const base = seedBaseline()
    write('src/added.ts', CLEAN_TS)

    const { status } = runGate(base)

    expect(status).toBe(0)
  })

  it('ignores the pre-existing backlog it did not touch', () => {
    // The whole point: an untouched, badly formatted file must not fail the
    // gate, or the incremental design collapses back into the repo-wide one.
    write('.prettierrc', PRETTIER_RC)
    write('src/legacy.ts', MESSY_TS)
    git('init', '--quiet', '--initial-branch=main')
    git('config', 'user.email', 'ci@example.test')
    git('config', 'user.name', 'CI Fixture')
    git('add', '-A')
    git('commit', '--quiet', '--no-verify', '-m', 'legacy backlog')
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    write('src/added.ts', CLEAN_TS)

    const { status } = runGate(base)

    expect(status).toBe(0)
  })

  it('passes and says so when the change touches no formattable file', () => {
    const base = seedBaseline()
    write('docs/notes.md', '# notes\n')

    const { status, output } = runGate(base)

    expect(status).toBe(0)
    expect(output).toMatch(/no .*files/i)
  })
})

describe(
  'format-check-changed — degrades to a skip, never a crash',
  { timeout: GATE_TIMEOUT_MS },
  () => {
    it('skips when no base ref is supplied', () => {
      seedBaseline()
      write('src/added.ts', MESSY_TS)

      const { status, output } = runGate('')

      expect(status).toBe(0)
      expect(output).toMatch(/skip/i)
    })

    it('skips on the all-zero SHA GitHub sends for a first push or a new tag', () => {
      seedBaseline()
      write('src/added.ts', MESSY_TS)

      const { status, output } = runGate('0'.repeat(40))

      expect(status).toBe(0)
      expect(output).toMatch(/skip/i)
    })

    it('skips when the base ref cannot be resolved in this checkout', () => {
      seedBaseline()
      write('src/added.ts', MESSY_TS)

      const { status, output } = runGate('origin/does-not-exist')

      expect(status).toBe(0)
      expect(output).toMatch(/skip/i)
    })
  },
)
