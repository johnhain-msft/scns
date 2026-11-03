#!/usr/bin/env node
/**
 * Prettier gate scoped to the files a change actually touches.
 *
 * Repo-wide `npm run format:check` currently reports style issues in 350 of
 * the 1049 `.ts` files under `src/` and `test/` (measured 2026-09-21, ~33%).
 * Making that a required CI job would have shipped a pipeline that was red on
 * its very first run for reasons no contributor introduced — the fastest way
 * to teach a team to ignore a red check. Reformatting a third of the tree as a
 * side effect of adding CI is the other bad option.
 *
 * This gate holds the line instead: files changed relative to a base commit
 * must be prettier-clean; the untouched backlog is retired separately with
 * `npm run format`.
 *
 * Base commit comes from `FORMAT_BASE_REF`. GitHub supplies the pull request
 * base SHA or `github.event.before`; both can legitimately be absent or the
 * all-zero SHA (first push to a branch, tag push), and a gate that crashed on
 * those would block releases. Those cases SKIP, loudly.
 *
 * Contract tests: `test/unit/scripts/format-check-changed.test.ts`.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ZERO_SHA = /^0{40}$/
const CHECKED_ROOTS = ['src/', 'test/', 'scripts/']

/**
 * Extensions prettier is configured for here.
 *
 * `.mjs` and `.js` were absent until 2026-09-21, which exempted all 16 `.mjs` helper scripts from
 * the only formatting gate CI runs — this file among them. A standard its own enforcement tool is
 * exempt from is not a standard.
 */
const CHECKED_EXTENSIONS = ['.ts', '.mjs', '.cjs', '.js']

const require = createRequire(import.meta.url)

function log(message) {
  process.stdout.write(`[format:changed] ${message}\n`)
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout : null
}

/**
 * Resolves the base to a commit this checkout actually has, or null.
 * A ref that does not resolve is a skip, not a failure: it means the runner
 * fetched too little history, which is a CI configuration problem rather than
 * evidence about the author's formatting.
 */
function resolveBase(cwd, requested) {
  if (!requested) {
    log('skip: no FORMAT_BASE_REF supplied — nothing to diff against.')
    return null
  }
  if (ZERO_SHA.test(requested)) {
    log('skip: base is the all-zero SHA (first push or tag push) — no previous commit.')
    return null
  }

  const resolved = git(cwd, ['rev-parse', '--verify', `${requested}^{commit}`])
  if (resolved === null) {
    log(`skip: base ref "${requested}" is not present in this checkout (shallow clone?).`)
    return null
  }

  return resolved.trim()
}

/**
 * Files added/copied/modified/renamed since `base`, limited to the sources
 * prettier is configured for — TypeScript plus the JavaScript under `scripts/`.
 *
 * Untracked files are unioned in deliberately. `git diff` reports tracked
 * paths only, so a brand-new, never-added file — the single most likely thing
 * to be misformatted — would otherwise sail straight past the gate whenever it
 * is run locally or over a dirty tree.
 */
function changedFiles(cwd, base) {
  const roots = CHECKED_ROOTS.map((root) => root.replace(/\/$/, ''))
  const tracked = git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', base, '--', ...roots])
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '--', ...roots])

  const candidates = [...(tracked ?? '').split('\n'), ...(untracked ?? '').split('\n')]

  return [...new Set(candidates.map((line) => line.trim()))]
    .filter((line) => CHECKED_EXTENSIONS.some((ext) => line.endsWith(ext)))
    .filter((line) => CHECKED_ROOTS.some((root) => line.startsWith(root)))
    .filter((line) => existsSync(join(cwd, line)))
}

function main() {
  const cwd = process.cwd()
  const base = resolveBase(cwd, (process.env.FORMAT_BASE_REF ?? '').trim())
  if (base === null) return 0

  const files = changedFiles(cwd, base)
  if (files.length === 0) {
    log(
      `no formattable files under ${CHECKED_ROOTS.join(' or ')} changed since ${base.slice(0, 8)}.`,
    )
    return 0
  }

  log(`checking ${files.length} changed file(s) against .prettierrc`)
  // Invoked through the current node binary rather than the .bin shim so the
  // same call works on Windows, where .bin entries are shell/cmd wrappers.
  const prettier = require.resolve('prettier/bin/prettier.cjs')
  const result = spawnSync(process.execPath, [prettier, '--check', ...files], {
    cwd,
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    log('run `npm run format` and commit the result to fix the files listed above.')
  }

  return result.status ?? 1
}

process.exit(main())
