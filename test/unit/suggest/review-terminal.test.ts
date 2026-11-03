/**
 * RED tests for the interactive weekly-review terminal launch.
 *
 * The `weekly-promotion-review` cron writes the packet and logs "run `scns review weekly`" — but
 * `scns` is not installed on this machine (`which scns` → not found in a login shell; package.json
 * declares `bin.scns` but it was never linked). So the one instruction the cron gives is not
 * runnable as written, and the review only happens if John independently remembers to go do it.
 *
 * John's ruling 2026-08-03: "running from broker is fine; however, it needs to actually open a
 * terminal so i can interact with it."
 *
 * Nothing here spawns a real process — `spawn` is injected, EXCEPT in the `defaultSpawn` describe
 * block, which resolves (but never calls) the real one. See the comment there for why that gap
 * mattered.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawn as realSpawn } from 'node:child_process'
import {
  defaultSpawn,
  launchInteractiveReview,
  resolveReviewCommand,
  type SpawnFn,
} from '../../../src/suggest/review-terminal.js'

const NODE = '/Users/x/.nvm/versions/node/v22.20.0/bin/node'
const CLI = '/Users/x/Coding_Projects/scns_root/scns/dist/cli.js'

describe('resolveReviewCommand', () => {
  it('is self-locating — absolute node + cli path, never a bare `scns`', () => {
    const cmd = resolveReviewCommand({ execPath: NODE, cliPath: CLI })

    expect(cmd).toContain(NODE)
    expect(cmd).toContain(CLI)
    expect(cmd).toContain('review weekly')
    // The broker's PATH is `/usr/bin:/bin:/usr/sbin:/sbin` plus its node dir, and `scns` is not on
    // it — nor on John's login PATH. A bare `scns` would produce "command not found" in a window
    // that pops up and dies, which is worse than the current silence.
    expect(cmd).not.toMatch(/(^|\s|&&\s*)scns\s/)
  })

  it('quotes paths so a space in the path cannot split the command', () => {
    const cmd = resolveReviewCommand({
      execPath: '/Users/x/Application Support/node',
      cliPath: '/Users/x/My Projects/scns/dist/cli.js',
    })
    expect(cmd).toContain("'/Users/x/Application Support/node'")
    expect(cmd).toContain("'/Users/x/My Projects/scns/dist/cli.js'")
  })

  it('carries the broker\u2019s SCNS_HOME so the review reads the home the broker reviewed', () => {
    // A Terminal window opened via `osascript` starts a LOGIN shell — it does NOT inherit the
    // broker's environment. `resolveScnsHome()` (src/shared/scns-home.ts:17) falls back to
    // `homedir()`, so a broker running under a non-default SCNS_HOME would render its packet from
    // that home and then open a window reviewing a DIFFERENT one. The live singleton sets no
    // SCNS_HOME so it is unaffected, but the child brokers do (the Cosmere broker on :3500 runs
    // under `~/.session-broker/projects/cosmere-rpg-.../`), and a review of the wrong corpus is
    // worse than no review because its labels would be attributed to the wrong project.
    const cmd = resolveReviewCommand({
      execPath: NODE,
      cliPath: CLI,
      env: { SCNS_HOME: '/tmp/isolated home' },
    })
    expect(cmd).toContain("SCNS_HOME='/tmp/isolated home'")
    expect(cmd.indexOf('SCNS_HOME=')).toBeLessThan(cmd.indexOf(NODE))
  })

  it('omits SCNS_HOME entirely when the broker has none, so the login default is used', () => {
    expect(resolveReviewCommand({ execPath: NODE, cliPath: CLI, env: {} })).not.toContain(
      'SCNS_HOME',
    )
    expect(
      resolveReviewCommand({ execPath: NODE, cliPath: CLI, env: { SCNS_HOME: '  ' } }),
    ).not.toContain('SCNS_HOME')
    expect(resolveReviewCommand({ execPath: NODE, cliPath: CLI })).not.toContain('SCNS_HOME')
  })
})

describe('launchInteractiveReview', () => {
  function spy(): { fn: SpawnFn; calls: Array<{ cmd: string; args: readonly string[] }> } {
    const calls: Array<{ cmd: string; args: readonly string[] }> = []
    const fn: SpawnFn = (cmd, args) => {
      calls.push({ cmd, args })
      return { unref: () => {} }
    }
    return { fn, calls }
  }

  it('opens Terminal.app running the review command', () => {
    const { fn, calls } = spy()

    const res = launchInteractiveReview({
      command: 'node cli.js review weekly',
      platform: 'darwin',
      spawn: fn,
    })

    expect(res).toEqual({ launched: true, app: 'Terminal' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.cmd).toBe('osascript')
    const script = calls[0]!.args.join(' ')
    expect(script).toContain('Terminal')
    expect(script).toContain('do script')
    expect(script).toContain('node cli.js review weekly')
    // It must come to the front — a window opened behind the editor is the same as no window.
    expect(script).toContain('activate')
  })

  it('escapes double quotes and backslashes so the AppleScript string cannot be broken out of', () => {
    const { fn, calls } = spy()

    launchInteractiveReview({
      command: 'node "a b.js" review weekly \\ end',
      platform: 'darwin',
      spawn: fn,
    })

    const script = calls[0]!.args.join(' ')
    // Every embedded quote must be backslash-escaped for AppleScript; an unescaped one would
    // terminate the string and let the remainder be interpreted as AppleScript source.
    expect(script).toContain('\\"a b.js\\"')
    expect(script).toContain('\\\\')
  })

  it('does NOT launch on a non-darwin platform, and does not spawn anything', () => {
    const { fn, calls } = spy()

    const res = launchInteractiveReview({
      command: 'anything',
      platform: 'linux',
      spawn: fn,
    })

    expect(res).toEqual({ launched: false, reason: 'unsupported-platform' })
    expect(calls).toHaveLength(0)
  })

  it('NEVER throws when spawn fails — the cron must continue to its outcome sweep', () => {
    // This is the whole point of the guard. The `proposal_outcomes` sweep runs AFTER this call in
    // the cron handler and carries John's already-written reasons the last mile to the learner. A
    // throw here would skip it, so a cosmetic failure (no window server, Terminal removed, osascript
    // missing) would silently cost real learning data.
    const boom: SpawnFn = () => {
      throw new Error('posix_spawn failed')
    }

    let res: unknown
    expect(() => {
      res = launchInteractiveReview({ command: 'x', platform: 'darwin', spawn: boom })
    }).not.toThrow()
    expect(res).toEqual({ launched: false, reason: 'spawn-failed' })
  })

  it('detaches the child so the broker does not hold the terminal open', () => {
    const calls: Array<Record<string, unknown>> = []
    const unref = vi.fn()
    const fn: SpawnFn = (_cmd, _args, opts) => {
      calls.push(opts as Record<string, unknown>)
      return { unref }
    }

    launchInteractiveReview({ command: 'x', platform: 'darwin', spawn: fn })

    expect(calls[0]).toMatchObject({ detached: true, stdio: 'ignore' })
    expect(unref).toHaveBeenCalled()
  })
})

/**
 * THE GAP THAT MADE EVERY TEST ABOVE INSUFFICIENT.
 *
 * Every case above injects `spawn`, so not one of them ever reached the module's own resolution of
 * the real `spawn`. That resolution was `require('node:child_process')` — and `package.json` is
 * `"type": "module"`, so the emitted `dist/suggest/review-terminal.js` is an ES module where
 * `require` is not defined:
 *
 *     $ node --input-type=module -e "require('node:child_process')"
 *     ReferenceError: require is not defined
 *
 * `launchInteractiveReview`'s `try/catch` — correctly there so a launch failure can never skip the
 * `proposal_outcomes` sweep — then SWALLOWED that ReferenceError and returned
 * `{ launched: false, reason: 'spawn-failed' }`. So the launcher could report a tidy handled failure
 * on every single invocation while being structurally incapable of opening a window, and a suite of
 * 7 green tests would say nothing was wrong. `src/memory/db.ts:8` gets this right with
 * `createRequire(import.meta.url)`; this module simply did not.
 *
 * These cases resolve the real `spawn` but never call it, so still nothing is spawned.
 */
describe('defaultSpawn — the real, non-injected path', () => {
  it('resolves node\u2019s real spawn under ESM instead of throwing ReferenceError', () => {
    expect(() => defaultSpawn()).not.toThrow()
    expect(defaultSpawn()).toBe(realSpawn)
  })

  it('returns a spawn that actually works, without opening any window', () => {
    // Deliberately NOT routed through `launchInteractiveReview`: that hardcodes `osascript` and
    // would pop a real Terminal window on every unit run. Spawning a harmless binary proves the
    // resolved reference is a live, callable spawn rather than merely a truthy value.
    // (process.execPath: exists on every platform, unlike /usr/bin/true.)
    const resolved = defaultSpawn()
    const child = resolved(process.execPath, ['-e', ''], { stdio: 'ignore' }) as {
      unref?: () => void
      pid?: number
    }
    expect(typeof child.pid).toBe('number')
    child.unref?.()
  })

  it('SOURCE GUARD: uses a static ESM import, never a bare `require`', () => {
    // This has to be a SOURCE assertion, because no runtime assertion can catch the bug.
    // `package.json` is `"type": "module"`, so the built module has no `require` — but vitest's
    // Vite SSR transform supplies one, and so does `node -e` (CJS, global `require`). The regression
    // therefore passes every test harness and fails only in the broker. Measured, ESM entry:
    //   DEFAULTSPAWN THREW: ReferenceError - require is not defined
    // `createRequire(import.meta.url)` (as in src/memory/db.ts:8) would also be correct; a bare
    // `require(` is what must never come back.
    const source = readFileSync(
      new URL('../../../src/suggest/review-terminal.ts', import.meta.url),
      'utf-8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')

    expect(code).not.toMatch(/(^|[^.\w])require\s*\(/)
    expect(source).toMatch(/import\s*\{[^}]*spawn[^}]*\}\s*from\s*'node:child_process'/)
  })
})
