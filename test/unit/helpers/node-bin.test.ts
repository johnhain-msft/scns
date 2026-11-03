/**
 * Unit coverage for the test-only `.bin` resolver.
 *
 * The helper exists because Windows cannot spawn the extensionless
 * `node_modules/.bin/<tool>` shim, and because the `.cmd` sibling is the wrong
 * fix (Node >= 20.12.2 returns EINVAL for `.bat`/`.cmd` without `shell: true`,
 * and the shim re-resolves `node` from PATH). Both failure paths are covered
 * here so a bad manifest produces a named error rather than a confusing
 * downstream ENOENT.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveBinScript, nodeBinArgv } from '../../helpers/node-bin.js'

let root: string

function addPackage(name: string, manifest: unknown): void {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest), 'utf-8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scns-node-bin-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveBinScript', () => {
  it('resolves the string form of `bin` relative to the package dir', () => {
    addPackage('stringtool', { name: 'stringtool', bin: './dist/cli.mjs' })
    expect(resolveBinScript(root, 'stringtool')).toBe(
      join(root, 'node_modules', 'stringtool', 'dist', 'cli.mjs'),
    )
  })

  it('resolves the object form by bin name', () => {
    addPackage('objtool', {
      name: 'objtool',
      bin: { objtool: './bin/run.js', helper: './bin/helper.js' },
    })
    expect(resolveBinScript(root, 'objtool')).toBe(
      join(root, 'node_modules', 'objtool', 'bin', 'run.js'),
    )
  })

  it('throws a named error when the package is not installed', () => {
    expect(() => resolveBinScript(root, 'absent')).toThrow(/cannot resolve bin "absent"/)
    expect(() => resolveBinScript(root, 'absent')).toThrow(/unreadable manifest/)
  })

  it('throws a named error when the manifest is unparseable', () => {
    const dir = join(root, 'node_modules', 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{ not json', 'utf-8')
    expect(() => resolveBinScript(root, 'broken')).toThrow(/cannot resolve bin "broken"/)
  })

  it('throws when the package declares no matching bin entry', () => {
    addPackage('libonly', { name: 'libonly' })
    expect(() => resolveBinScript(root, 'libonly')).toThrow(/no matching "bin" entry/)
  })

  // Documents a real limitation rather than asserting it away: the lookup is
  // keyed by <name> under node_modules, so a bin whose name differs from its
  // owning package is NOT resolvable. Both current call sites (tsx, vitest)
  // are self-named, and the error names the bin so the cause is obvious.
  it('does not resolve a bin whose name differs from its package', () => {
    addPackage('owner', { name: 'owner', bin: { aliased: './aliased.js' } })
    expect(() => resolveBinScript(root, 'aliased')).toThrow(/cannot resolve bin "aliased"/)
  })
})

describe('nodeBinArgv', () => {
  it('runs the tool under the CURRENT interpreter, not a PATH lookup', () => {
    addPackage('argvtool', { name: 'argvtool', bin: './cli.js' })
    const [command, script] = nodeBinArgv(root, 'argvtool')
    expect(command).toBe(process.execPath)
    expect(script).toBe(join(root, 'node_modules', 'argvtool', 'cli.js'))
  })

  it('never returns a .cmd shim, on any platform', () => {
    addPackage('cmdtool', { name: 'cmdtool', bin: './cli.js' })
    const [, script] = nodeBinArgv(root, 'cmdtool')
    expect(script).not.toMatch(/\.(cmd|bat|ps1)$/)
  })
})
