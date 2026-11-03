/**
 * LINT SCOPE — the JavaScript in this repo must actually be linted.
 *
 * DEFECT (2026-09-21): `npm run lint` was `eslint src/ test/`. ESLint itself was configured
 * perfectly well for JavaScript — `npx eslint scripts/clean.mjs` works and always did — but the
 * npm script never handed it a single `.js` or `.mjs` path. So the 16 tracked `.mjs` helper
 * scripts, the 29 `.ts` scripts beside them, `eslint.config.js` itself and all three
 * `vitest.config*.ts` files were linted by nothing, and the CI `Lint` step inherited that hole.
 *
 * It was not cosmetic. The first run over that surface found 6 genuine errors — four of them
 * unused imports in `scripts/phase-13-5-live-verify.mjs` — sitting in `main` unnoticed.
 *
 * The fix is `eslint .` rather than a longer list of directories, and these tests pin the property
 * that choice buys: coverage is the DEFAULT, so a directory added next month is linted the day it
 * appears instead of the day somebody remembers to extend an npm script. The invariant below is
 * therefore written against the real tracked file list and the real resolved ESLint config, not
 * against a hardcoded expectation of what the script says — a test asserting `lint === 'eslint .'`
 * would pass just as happily with every source file ignored.
 *
 * `ESLint.isPathIgnored` is the authority on exclusions. Re-parsing the `ignores` array out of
 * `eslint.config.js` by hand would be a second, drifting implementation of ESLint's own matcher.
 */
import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../../..')

/** Loading the flat config pulls in typescript-eslint; well past vitest's 5s default. */
const ESLINT_TIMEOUT_MS = 120_000

/** Extensions the root ESLint setup is responsible for. */
const LINTABLE = /\.(js|cjs|mjs|ts|tsx)$/

interface PackageJson {
  readonly scripts: Readonly<Record<string, string>>
}

function packageJson(): PackageJson {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as PackageJson
}

/** Every lintable path git tracks, repo-root-relative. */
function trackedLintableFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '*.js', '*.cjs', '*.mjs', '*.ts', '*.tsx'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })

  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && LINTABLE.test(line))
}

/**
 * The path arguments an npm script hands to eslint — flags and their values removed.
 *
 * Deliberately simple: the point is to learn which paths ESLint is pointed at, and every form this
 * repo uses is a bare path or a leading flag.
 */
function eslintTargets(script: string): string[] {
  const tokens = script.split(/\s+/).filter((token) => token.length > 0)
  const start = tokens.indexOf('eslint')
  expect(start, `"${script}" does not invoke eslint`).toBeGreaterThanOrEqual(0)

  return tokens.slice(start + 1).filter((token) => !token.startsWith('-'))
}

/** Whether `file` lies inside one of the paths handed to eslint. */
function isWithinTargets(file: string, targets: readonly string[]): boolean {
  return targets.some((target) => {
    if (target === '.' || target === './') return true
    const normalised = target.replace(/^\.\//, '').replace(/\/$/, '')
    return file === normalised || file.startsWith(`${normalised}/`)
  })
}

describe('npm run lint — scope covers the whole repo, JavaScript included', () => {
  it(
    'leaves no tracked lintable file both un-ignored and outside lint scope',
    async () => {
      const targets = eslintTargets(packageJson().scripts.lint)
      const eslint = new ESLint({ cwd: REPO_ROOT })

      const unlinted: string[] = []
      for (const file of trackedLintableFiles()) {
        if (isWithinTargets(file, targets)) continue
        // Outside scope is only acceptable when ESLint would have skipped it anyway.
        if (await eslint.isPathIgnored(join(REPO_ROOT, file))) continue
        unlinted.push(file)
      }

      expect(unlinted, `these files are linted by nothing:\n${unlinted.join('\n')}`).toEqual([])
    },
    ESLINT_TIMEOUT_MS,
  )

  it('points eslint at the repo root so new directories are covered by default', () => {
    expect(eslintTargets(packageJson().scripts.lint)).toContain('.')
  })

  it('covers the .mjs helper scripts, which are the JavaScript in this repo', () => {
    const targets = eslintTargets(packageJson().scripts.lint)
    const mjs = trackedLintableFiles().filter(
      (file) => file.endsWith('.mjs') && file.startsWith('scripts/'),
    )

    expect(mjs.length, 'expected tracked .mjs scripts to exist').toBeGreaterThan(0)
    for (const file of mjs) {
      expect(isWithinTargets(file, targets), `${file} is outside lint scope`).toBe(true)
    }
  })

  it('fixes exactly what it checks — lint:fix and lint share one scope', () => {
    const { lint, 'lint:fix': lintFix } = packageJson().scripts

    expect(eslintTargets(lintFix)).toEqual(eslintTargets(lint))
  })
})

describe('ESLint config — exclusions are deliberate and narrow', () => {
  it(
    'ignores dashboard/, which is a separate project linting itself',
    async () => {
      // dashboard/package.json declares its own `lint` script and eslint.config.mjs (Next.js
      // rules). Linting it from the root would apply the wrong config, not extra coverage.
      const eslint = new ESLint({ cwd: REPO_ROOT })

      expect(await eslint.isPathIgnored(join(REPO_ROOT, 'dashboard/postcss.config.mjs'))).toBe(true)
    },
    ESLINT_TIMEOUT_MS,
  )

  it(
    'still lints src/, test/ and scripts/ — the widened scope excludes nothing real',
    async () => {
      const eslint = new ESLint({ cwd: REPO_ROOT })

      for (const file of ['src/cli.ts', 'scripts/clean.mjs', 'eslint.config.js']) {
        expect(await eslint.isPathIgnored(join(REPO_ROOT, file)), `${file} is ignored`).toBe(false)
      }
    },
    ESLINT_TIMEOUT_MS,
  )
})

describe('no-console — relaxed for command-line scripts, enforced everywhere else', () => {
  it(
    'keeps no-console active for application code under src/',
    async () => {
      const eslint = new ESLint({ cwd: REPO_ROOT })
      const config = (await eslint.calculateConfigForFile(join(REPO_ROOT, 'src/cli.ts'))) as {
        rules?: Record<string, unknown>
      }

      // The house rule is Pino structured logging in application code; widening lint scope must
      // not become a pretext for dropping it.
      expect(config.rules?.['no-console']).toBeDefined()
      expect(JSON.stringify(config.rules?.['no-console'])).not.toContain('off')
    },
    ESLINT_TIMEOUT_MS,
  )

  it(
    'turns no-console off under scripts/, whose job is to print to a terminal',
    async () => {
      const eslint = new ESLint({ cwd: REPO_ROOT })
      const config = (await eslint.calculateConfigForFile(
        join(REPO_ROOT, 'scripts/clean.mjs'),
      )) as { rules?: Record<string, [number | string, ...unknown[]] | undefined> }

      // Without this exemption the new scope reports 418 no-console warnings across scripts/ and
      // buries the 6 real errors it was added to surface.
      const severity = config.rules?.['no-console']?.[0]
      expect(severity === 0 || severity === 'off').toBe(true)
    },
    ESLINT_TIMEOUT_MS,
  )
})
