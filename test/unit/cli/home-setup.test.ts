/**
 * #64 — `scns home setup`: convert a plain clone of the public repo into a
 * self-improvement-capable install with a private home repository.
 *
 * Everything is driven through an injected command runner, so every branch
 * (create, adopt, re-run, each refusal) runs here without touching git, gh,
 * or the network. The pre-push guard interaction is pinned explicitly: the
 * one seed push of main carries SCNS_ALLOW_MAIN_PUSH=1 — the hook's own
 * logged escape hatch — because the target is the private home this same
 * human-invoked command just created and verified as owned.
 */
import { describe, it, expect } from 'vitest'

import {
  runHomeSetup,
  type HomeSetupCall,
  type HomeSetupRunResult,
} from '../../../src/cli/home-setup.js'

const ok = (stdout = ''): HomeSetupRunResult => ({ ok: true, stdout, stderr: '' })
const fail = (stderr = ''): HomeSetupRunResult => ({ ok: false, stdout: '', stderr })

/**
 * Scripted runner: each `${file} ${args.join(' ')}` key maps to a QUEUE of
 * results (the same command can behave differently across calls, e.g.
 * `gh repo view` before and after `gh repo create`). An un-scripted command
 * fails the test loudly.
 */
function makeRunner(script: Record<string, HomeSetupRunResult[]>, calls: HomeSetupCall[]) {
  return async (
    file: 'git' | 'gh',
    args: readonly string[],
    opts?: { env?: Readonly<Record<string, string>>; cwd?: string },
  ): Promise<HomeSetupRunResult> => {
    const key = `${file} ${args.join(' ')}`
    calls.push({ file, args: [...args], env: opts?.env, cwd: opts?.cwd })
    const queue = script[key]
    if (!queue || queue.length === 0) throw new Error(`unexpected command: ${key}`)
    return queue.shift()!
  }
}

const ROOT = '/home/me/tool'
const VIEW_HOME = 'gh repo view me/tool --json isPrivate,viewerPermission'
const PRIVATE_ADMIN = ok('{"isPrivate":true,"viewerPermission":"ADMIN"}')

/** The command script for a never-converted clone of owner/tool over https. */
function freshCloneScript(): Record<string, HomeSetupRunResult[]> {
  return {
    'gh api user --jq .login': [ok('me\n')],
    'git rev-parse --show-toplevel': [ok(`${ROOT}\n`)],
    [`git -C ${ROOT} status --porcelain`]: [ok('')],
    [`git -C ${ROOT} remote get-url origin`]: [ok('https://github.com/owner/tool.git\n')],
    [`git -C ${ROOT} remote get-url upstream`]: [fail('no such remote')],
    [VIEW_HOME]: [fail('Could not resolve to a Repository'), PRIVATE_ADMIN],
    'gh repo create me/tool --private': [ok()],
    [`git -C ${ROOT} remote rename origin upstream`]: [ok()],
    [`git -C ${ROOT} remote add origin https://github.com/me/tool.git`]: [ok()],
    [`git -C ${ROOT} push -u origin main`]: [ok()],
    'gh repo set-default me/tool': [ok()],
  }
}

function recordingDeps(script: Record<string, HomeSetupRunResult[]>) {
  const calls: HomeSetupCall[] = []
  const recorded: Array<{ upstreamRepo: string; writeTargetRepo: string }> = []
  return {
    calls,
    recorded,
    deps: {
      run: makeRunner(script, calls),
      recordTargets: (t: { upstreamRepo: string; writeTargetRepo: string }) => {
        recorded.push(t)
      },
    },
  }
}

describe('runHomeSetup — fresh conversion (create path)', () => {
  it('creates the home, re-points remotes, pushes main, and records the graph', async () => {
    const { calls, recorded, deps } = recordingDeps(freshCloneScript())
    const result = await runHomeSetup({ cwd: ROOT, repo: null }, deps)

    expect(result.refusal).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.homeRepo).toBe('me/tool')
    expect(result.upstreamRepo).toBe('owner/tool')
    expect(recorded).toEqual([{ upstreamRepo: 'owner/tool', writeTargetRepo: 'me/tool' }])

    const keys = calls.map((c) => `${c.file} ${c.args.join(' ')}`)
    expect(keys).toContain('gh repo create me/tool --private')
    expect(keys).toContain(`git -C ${ROOT} remote rename origin upstream`)
    expect(keys).toContain(`git -C ${ROOT} remote add origin https://github.com/me/tool.git`)
  })

  it('carries the pre-push escape hatch ONLY on the seed push, and says so in the steps', async () => {
    const { calls, deps } = recordingDeps(freshCloneScript())
    const result = await runHomeSetup({ cwd: ROOT, repo: null }, deps)

    const push = calls.find((c) => c.args.includes('push'))!
    expect(push.env).toEqual({ SCNS_ALLOW_MAIN_PUSH: '1' })
    for (const c of calls) {
      if (!c.args.includes('push')) expect(c.env).toBeUndefined()
    }
    expect(result.steps.join('\n')).toMatch(/SCNS_ALLOW_MAIN_PUSH/)
  })

  it('runs gh repo set-default inside the clone', async () => {
    const { calls, deps } = recordingDeps(freshCloneScript())
    await runHomeSetup({ cwd: ROOT, repo: null }, deps)
    const setDefault = calls.find((c) => c.args.join(' ').startsWith('repo set-default'))!
    expect(setDefault.cwd).toBe(ROOT)
  })

  it('matches the home remote protocol to the clone (ssh origin -> ssh home URL)', async () => {
    const script = freshCloneScript()
    script[`git -C ${ROOT} remote get-url origin`] = [ok('git@github.com:owner/tool.git\n')]
    delete script[`git -C ${ROOT} remote add origin https://github.com/me/tool.git`]
    script[`git -C ${ROOT} remote add origin git@github.com:me/tool.git`] = [ok()]
    const { deps } = recordingDeps(script)
    const result = await runHomeSetup({ cwd: ROOT, repo: null }, deps)
    expect(result.ok).toBe(true)
  })
})

describe('runHomeSetup — re-run on a converted clone (idempotent)', () => {
  it('is a no-op that reports the existing state', async () => {
    const { calls, recorded, deps } = recordingDeps({
      'gh api user --jq .login': [ok('me\n')],
      'git rev-parse --show-toplevel': [ok(`${ROOT}\n`)],
      [`git -C ${ROOT} status --porcelain`]: [ok('')],
      [`git -C ${ROOT} remote get-url origin`]: [ok('git@github.com:me/tool.git\n')],
      [`git -C ${ROOT} remote get-url upstream`]: [ok('https://github.com/owner/tool.git\n')],
      [VIEW_HOME]: [PRIVATE_ADMIN],
      [`git -C ${ROOT} push -u origin main`]: [ok('Everything up-to-date')],
      'gh repo set-default me/tool': [ok()],
    })
    const result = await runHomeSetup({ cwd: ROOT, repo: null }, deps)

    expect(result.ok).toBe(true)
    expect(result.homeRepo).toBe('me/tool')
    expect(result.upstreamRepo).toBe('owner/tool')
    // Still records the graph — that is what makes a half-converted clone
    // (remotes done, registry missed) converge on re-run.
    expect(recorded).toHaveLength(1)

    const keys = calls.map((c) => `${c.file} ${c.args.join(' ')}`)
    expect(keys.some((k) => k.includes('repo create'))).toBe(false)
    expect(keys.some((k) => k.includes('remote rename'))).toBe(false)
    expect(keys.some((k) => k.includes('remote add'))).toBe(false)
    expect(keys.some((k) => k.includes('set-url'))).toBe(false)
  })
})

describe('runHomeSetup — adopting an existing repo (--repo)', () => {
  it('adopts a private, owned repo named by --repo', async () => {
    const { recorded, deps } = recordingDeps({
      'gh api user --jq .login': [ok('me\n')],
      'git rev-parse --show-toplevel': [ok(`${ROOT}\n`)],
      [`git -C ${ROOT} status --porcelain`]: [ok('')],
      [`git -C ${ROOT} remote get-url origin`]: [ok('https://github.com/owner/tool.git\n')],
      [`git -C ${ROOT} remote get-url upstream`]: [fail('no such remote')],
      'gh repo view me/custom-home --json isPrivate,viewerPermission': [PRIVATE_ADMIN],
      [`git -C ${ROOT} remote rename origin upstream`]: [ok()],
      [`git -C ${ROOT} remote add origin https://github.com/me/custom-home.git`]: [ok()],
      [`git -C ${ROOT} push -u origin main`]: [ok()],
      'gh repo set-default me/custom-home': [ok()],
    })
    const result = await runHomeSetup({ cwd: ROOT, repo: 'me/custom-home' }, deps)
    expect(result.ok).toBe(true)
    expect(result.homeRepo).toBe('me/custom-home')
    expect(recorded).toEqual([{ upstreamRepo: 'owner/tool', writeTargetRepo: 'me/custom-home' }])
  })

  it('refuses to adopt a PUBLIC repo', async () => {
    const { deps } = recordingDeps({
      'gh api user --jq .login': [ok('me\n')],
      'git rev-parse --show-toplevel': [ok(`${ROOT}\n`)],
      [`git -C ${ROOT} status --porcelain`]: [ok('')],
      [`git -C ${ROOT} remote get-url origin`]: [ok('https://github.com/owner/tool.git\n')],
      [`git -C ${ROOT} remote get-url upstream`]: [fail('no such remote')],
      'gh repo view me/leaky --json isPrivate,viewerPermission': [
        ok('{"isPrivate":false,"viewerPermission":"ADMIN"}'),
      ],
    })
    const result = await runHomeSetup({ cwd: ROOT, repo: 'me/leaky' }, deps)
    expect(result.ok).toBe(false)
    expect(result.refusal).toMatch(/public/i)
  })

  it('refuses a repo the authenticated account does not own', async () => {
    const { deps } = recordingDeps({
      'gh api user --jq .login': [ok('me\n')],
      'git rev-parse --show-toplevel': [ok(`${ROOT}\n`)],
      [`git -C ${ROOT} status --porcelain`]: [ok('')],
      [`git -C ${ROOT} remote get-url origin`]: [ok('https://github.com/owner/tool.git\n')],
      [`git -C ${ROOT} remote get-url upstream`]: [fail('no such remote')],
      'gh repo view other/theirs --json isPrivate,viewerPermission': [
        ok('{"isPrivate":true,"viewerPermission":"WRITE"}'),
      ],
    })
    const result = await runHomeSetup({ cwd: ROOT, repo: 'other/theirs' }, deps)
    expect(result.ok).toBe(false)
    expect(result.refusal).toMatch(/own/i)
  })
})

describe('runHomeSetup — refusals', () => {
  it('refuses when gh is not authenticated', async () => {
    const { deps } = recordingDeps({ 'gh api user --jq .login': [fail('not logged in')] })
    const result = await runHomeSetup({ cwd: ROOT, repo: null }, deps)
    expect(result.ok).toBe(false)
    expect(result.refusal).toMatch(/gh auth login/)
  })

  it('refuses outside a git repository', async () => {
    const { deps } = recordingDeps({
      'gh api user --jq .login': [ok('me\n')],
      'git rev-parse --show-toplevel': [fail('not a git repository')],
    })
    const result = await runHomeSetup({ cwd: '/somewhere', repo: null }, deps)
    expect(result.ok).toBe(false)
    expect(result.refusal).toMatch(/git repository/i)
  })

  it('refuses on a dirty work tree', async () => {
    const { deps } = recordingDeps({
      'gh api user --jq .login': [ok('me\n')],
      'git rev-parse --show-toplevel': [ok(`${ROOT}\n`)],
      [`git -C ${ROOT} status --porcelain`]: [ok(' M src/file.ts\n')],
    })
    const result = await runHomeSetup({ cwd: ROOT, repo: null }, deps)
    expect(result.ok).toBe(false)
    expect(result.refusal).toMatch(/uncommitted/i)
  })

  it('refuses a home identical to the public upstream', async () => {
    // The maintainer's own trap: login == upstream owner makes the DEFAULT
    // home name collide with the public repo itself. Must refuse, never
    // silently pick something else.
    const { deps } = recordingDeps({
      'gh api user --jq .login': [ok('owner\n')],
      'git rev-parse --show-toplevel': [ok(`${ROOT}\n`)],
      [`git -C ${ROOT} status --porcelain`]: [ok('')],
      [`git -C ${ROOT} remote get-url origin`]: [ok('https://github.com/owner/tool.git\n')],
      [`git -C ${ROOT} remote get-url upstream`]: [fail('no such remote')],
    })
    const result = await runHomeSetup({ cwd: ROOT, repo: null }, deps)
    expect(result.ok).toBe(false)
    expect(result.refusal).toMatch(/upstream/i)
    expect(result.refusal).toMatch(/--repo/)
  })

  it('refuses when no public upstream can be determined', async () => {
    const { deps } = recordingDeps({
      'gh api user --jq .login': [ok('me\n')],
      'git rev-parse --show-toplevel': [ok(`${ROOT}\n`)],
      [`git -C ${ROOT} status --porcelain`]: [ok('')],
      [`git -C ${ROOT} remote get-url origin`]: [ok('https://gitlab.example.com/owner/tool.git\n')],
      [`git -C ${ROOT} remote get-url upstream`]: [fail('no such remote')],
    })
    const result = await runHomeSetup({ cwd: ROOT, repo: null }, deps)
    expect(result.ok).toBe(false)
    expect(result.refusal).toMatch(/upstream/i)
  })

  it('reports a failed creation instead of continuing', async () => {
    const script = freshCloneScript()
    script[VIEW_HOME] = [fail('Could not resolve to a Repository')]
    script['gh repo create me/tool --private'] = [fail('name already exists on this account')]
    const { deps } = recordingDeps(script)
    const result = await runHomeSetup({ cwd: ROOT, repo: null }, deps)
    expect(result.ok).toBe(false)
    expect(result.refusal).toMatch(/create/i)
  })

  it('stops when the seed push fails, with re-run guidance', async () => {
    const script = freshCloneScript()
    script[`git -C ${ROOT} push -u origin main`] = [fail('non-fast-forward')]
    const { recorded, deps } = recordingDeps(script)
    const result = await runHomeSetup({ cwd: ROOT, repo: null }, deps)
    expect(result.ok).toBe(false)
    expect(result.refusal).toMatch(/push/i)
    expect(result.refusal).toMatch(/re-run/i)
    // Nothing recorded for a conversion that did not complete.
    expect(recorded).toHaveLength(0)
  })
})
