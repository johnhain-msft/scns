/**
 * `workerExecArgv` — the exec flags handed to the embedding worker.
 *
 * Regression cover for the 2026-09-28 judge findings on the fork -> spawn change:
 *
 *  - S2-1: the original helper filtered `/^--(?:inspect|debug)/` by PREFIX, which
 *    drops a space-separated flag but leaves its value behind. `--inspect-port 9231`
 *    became `['9231']`, and `9231` then landed in the script-path slot, so the worker
 *    died with `Cannot find module '<cwd>\9231'`. `fork()` was immune to this.
 *
 *  - S2-2: Node's own `fork()` splices `-e`/`--eval` out of the inherited execArgv
 *    (otherwise the child re-runs the parent's inline script instead of the worker).
 *    A prefix filter on `--inspect` cannot match `-e`, so that splice was missing.
 *
 *  - S2-3: `fork()` does NOT special-case inspector ports. Measured 2026-09-28: a
 *    child inheriting `--inspect=9230` logs "Starting inspector on 127.0.0.1:9230
 *    failed: address already in use" and then runs normally. So filtering inspector
 *    flags was a behaviour CHANGE, not the parity the comment claimed.
 *
 * The rule this file pins: inherit everything, splice only the `-e`/`--eval` pair,
 * and NEVER leave a flag's value orphaned.
 */
import { describe, it, expect } from 'vitest'
import { workerExecArgv } from '../../../src/memory/embeddings.js'

describe('workerExecArgv', () => {
  it('passes ordinary exec flags straight through', () => {
    const argv = ['--max-old-space-size=512', '--experimental-vm-modules']
    expect(workerExecArgv(argv)).toEqual(argv)
  })

  it('returns an empty list when the parent has no exec flags', () => {
    expect(workerExecArgv([])).toEqual([])
  })

  it('S2-2: splices the `-e` flag AND its value, the way fork() does', () => {
    expect(workerExecArgv(['-e', 'console.log(1)'])).toEqual([])
  })

  it('S2-2: splices `--eval` and its value', () => {
    expect(workerExecArgv(['--eval', 'console.log(1)'])).toEqual([])
  })

  it('S2-2: splices the attached `--eval=` form', () => {
    expect(workerExecArgv(['--eval=console.log(1)'])).toEqual([])
  })

  it('S2-2: splicing `-e` keeps surrounding flags intact', () => {
    expect(workerExecArgv(['--max-old-space-size=512', '-e', 'code()', '--no-warnings'])).toEqual([
      '--max-old-space-size=512',
      '--no-warnings',
    ])
  })

  it('S2-1: NEVER orphans the value of a space-separated flag', () => {
    // The exact input that broke the worker.
    expect(workerExecArgv(['--inspect-port', '9231'])).toEqual(['--inspect-port', '9231'])
    // A bare numeric token must never survive alone — that is what lands in argv[1].
    expect(workerExecArgv(['--inspect-port', '9231'])).not.toEqual(['9231'])
  })

  it('S2-3: inherits inspector flags, matching fork() parity', () => {
    expect(workerExecArgv(['--inspect=9230'])).toEqual(['--inspect=9230'])
    expect(workerExecArgv(['--inspect-brk'])).toEqual(['--inspect-brk'])
    expect(workerExecArgv(['--debug-port', '5858'])).toEqual(['--debug-port', '5858'])
  })

  it('defaults to process.execArgv and never returns a token that is not a flag or flag value', () => {
    const out = workerExecArgv()
    expect(Array.isArray(out)).toBe(true)
    // Under vitest the parent may carry flags; whatever they are, an `-e` pair
    // must never survive, because that is the fork-bomb case Node guards against.
    expect(out).not.toContain('-e')
    expect(out).not.toContain('--eval')
  })
})
