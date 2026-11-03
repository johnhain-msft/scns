/**
 * WI-1(a) native-Windows build — the `cp`/`mkdir -p`/`rm -rf` shell steps in
 * package.json are replaced by pure-Node scripts (`scripts/copy-assets.mjs`,
 * `scripts/clean.mjs`) that run identically under cmd.exe and bash.
 *
 * The tests exercise the REAL scripts against a throwaway root, injected via
 * the SCNS_BUILD_ROOT env override (defaults to the repo root in real builds).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../../..')
const COPY_ASSETS = join(REPO_ROOT, 'scripts', 'copy-assets.mjs')
const CLEAN = join(REPO_ROOT, 'scripts', 'clean.mjs')

/** Every asset `scripts/copy-assets.mjs` is contracted to copy, in its order. */
const ASSETS: ReadonlyArray<readonly string[]> = [
  ['src', 'broker', 'storage', 'schema.sql'],
  ['src', 'otel', 'schema.sql'],
]

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scns-build-scripts-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Seed the COMPLETE asset set (#54 item 7).
 *
 * The fixture used to omit `src/otel/schema.sql` outright, so the
 * missing-asset case was the fixture's default rather than a deliberate
 * choice, and the resulting ENOENT was easy to read as a real failure:
 *
 *   Error: ENOENT: no such file or directory, copyfile
 *     '…\Temp\scns-build-scripts-smJxJr\src\otel\schema.sql'
 *     -> '…\Temp\scns-build-scripts-smJxJr\dist\otel\schema.sql'
 *
 * Now every test starts from a complete tree and a test that wants a gap
 * removes exactly one file, naming which.
 */
function seedAllAssets(): void {
  for (const segments of ASSETS) {
    const file = join(root, ...segments)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `-- ${segments.join('/')}\n`)
  }
}

function runScript(script: string): void {
  execFileSync(process.execPath, [script], {
    env: { ...process.env, SCNS_BUILD_ROOT: root },
  })
}

/**
 * Run a script that is EXPECTED to fail and return its stderr.
 *
 * `execFileSync` inherits the child's stderr by default, so an expected
 * ENOENT stack printed into the middle of an otherwise-green run. Capturing
 * it keeps the output clean AND lets the assertion check which asset the
 * script actually complained about, instead of a bare `.toThrow()` that a
 * failure for any other reason would satisfy.
 */
function runScriptExpectingFailure(script: string): string {
  try {
    execFileSync(process.execPath, [script], {
      env: { ...process.env, SCNS_BUILD_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    return String((err as { stderr?: Buffer | string }).stderr ?? '')
  }
  throw new Error(`${script} exited 0, but the test required it to fail`)
}

describe('scripts/copy-assets.mjs', () => {
  it('copies every build asset into dist, creating directories as needed', () => {
    seedAllAssets()
    // dist/broker/storage exists after tsc, but dist/otel does NOT (no .ts
    // files live there) — the script must create it, like `mkdir -p` did.
    mkdirSync(join(root, 'dist', 'broker', 'storage'), { recursive: true })

    runScript(COPY_ASSETS)

    for (const segments of ASSETS) {
      const dest = join(root, 'dist', ...segments.slice(1))
      expect(readFileSync(dest, 'utf-8'), dest).toBe(`-- ${segments.join('/')}\n`)
    }
  })

  it.each(ASSETS.map((segments) => ({ label: segments.join('/'), segments })))(
    'fails loudly when $label is missing (no silent partial build)',
    ({ segments }) => {
      seedAllAssets()
      const missing = join(root, ...segments)
      rmSync(missing, { force: true })

      const stderr = runScriptExpectingFailure(COPY_ASSETS)

      expect(stderr, 'the failure must name the asset it could not find').toContain(missing)
      expect(stderr).toContain('ENOENT')
    },
  )
})

describe('scripts/clean.mjs', () => {
  it('removes dist and coverage recursively', () => {
    mkdirSync(join(root, 'dist', 'deep', 'nested'), { recursive: true })
    mkdirSync(join(root, 'coverage'), { recursive: true })
    writeFileSync(join(root, 'dist', 'deep', 'nested', 'f.js'), 'x')
    writeFileSync(join(root, 'coverage', 'lcov.info'), 'x')

    runScript(CLEAN)

    expect(existsSync(join(root, 'dist'))).toBe(false)
    expect(existsSync(join(root, 'coverage'))).toBe(false)
  })

  it('succeeds when the targets are already absent (rm -rf semantics)', () => {
    expect(() => runScript(CLEAN)).not.toThrow()
  })

  it('touches nothing else in the root', () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'keep.ts'), 'x')

    runScript(CLEAN)

    expect(existsSync(join(root, 'src', 'keep.ts'))).toBe(true)
  })
})
