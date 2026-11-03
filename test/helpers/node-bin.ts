/**
 * Cross-platform execution of `node_modules/.bin/` tooling from tests.
 *
 * `node_modules/.bin/<name>` is an extensionless shell script. On Windows
 * `CreateProcess` cannot execute it, so `spawn`/`execFileSync` without
 * `shell: true` fail with ENOENT even though the tool is installed correctly.
 * npm ships `<name>.cmd` and `<name>.ps1` siblings for exactly this reason —
 * but reaching for the `.cmd` is the wrong fix here, for two measured reasons:
 *
 *   1. Node >= 20.12.2 / 21.7.3 / 22 refuses to `spawn`/`execFile` a `.bat` or
 *      `.cmd` without `shell: true` (the CVE-2024-27980 fix). It returns
 *      EINVAL. A `.cmd` call site works on an unpatched Node 20.10.0 and
 *      breaks the moment the toolchain is bumped.
 *   2. The `.cmd` shim re-resolves `node` from PATH, so the child does NOT
 *      inherit the interpreter that spawned it. Measured on this repo:
 *      `tsx.cmd --version` spawned from Node 20.10.0 reports `node v24.15.0`,
 *      which loads the wrong native ABI for better-sqlite3.
 *
 * Both problems disappear if we skip the shim and run the tool's real JS entry
 * point under `process.execPath`: no shell quoting, no PATH lookup, and the
 * child provably inherits the current interpreter.
 *
 * Production code does NOT need this helper — `agent-spawner.ts` prepends
 * `node_modules/.bin` to PATH (PATHEXT resolves the `.cmd`), which is the
 * correct pattern for a PATH-based lookup.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface PackageManifest {
  readonly bin?: string | Record<string, string>
}

/**
 * Resolve the JS entry point that `node_modules/.bin/<name>` would execute,
 * by reading the owning package's `bin` field the same way npm does.
 *
 * Limitation: the package is looked up as `node_modules/<name>`, so this
 * resolves bins whose name matches their package (`tsx`, `vitest` — both
 * current call sites). A bin published under a different package name is not
 * resolvable; the thrown error names the bin so the cause is obvious.
 *
 * @param root Directory containing `node_modules` (a repo root or a worktree).
 * @param name Bin name, e.g. `tsx` or `vitest`.
 */
export function resolveBinScript(root: string, name: string): string {
  const manifestPath = join(root, 'node_modules', name, 'package.json')
  let manifest: PackageManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PackageManifest
  } catch (err) {
    throw new Error(
      `cannot resolve bin "${name}": unreadable manifest at ${manifestPath} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    )
  }
  const { bin } = manifest
  const relative = typeof bin === 'string' ? bin : bin?.[name]
  if (!relative) {
    throw new Error(`cannot resolve bin "${name}": no matching "bin" entry in ${manifestPath}`)
  }
  return join(dirname(manifestPath), relative)
}

/**
 * Argv prefix that runs `<name>` under the current interpreter.
 *
 * Spread it into the call site:
 *   const [cmd, ...args] = nodeBinArgv(root, 'tsx')
 *   spawn(cmd, [...args, ...toolArgs])
 */
export function nodeBinArgv(root: string, name: string): readonly [string, string] {
  return [process.execPath, resolveBinScript(root, name)]
}
