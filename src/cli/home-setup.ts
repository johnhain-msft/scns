/**
 * #64 — `scns home setup`: convert a plain clone of the public repo into a
 * self-improvement-capable install with a private home repository.
 *
 * Design (docs/plans/public-private-split.md, question 1): the public
 * upstream is distribution only. Every install that opts in to
 * self-improvement gets a detached private mirror — an ordinary private
 * repository, NOT a GitHub fork, because a fork of a public repository can
 * never be made private and would republish every scns/auto/* branch and
 * self-filed issue. Re-pointing `origin` at the home redirects the entire
 * write surface in one move: every GitHub writer in the codebase acts on
 * `origin` of the project root and nothing else.
 *
 * Shape: one idempotent pass — every step checks before it acts, so the
 * command is safe to re-run on a half-converted clone. All git/gh calls go
 * through an injected runner; tests script the full conversation. Nothing
 * here runs unattended: this is interactive, human-invoked setup.
 *
 * The one deliberate guard interaction: the seed `git push -u origin main`
 * carries SCNS_ALLOW_MAIN_PUSH=1, the pre-push hook's own logged escape
 * hatch. The hook exists to keep daemons and habit off `main`; this push is
 * a human running setup, targeting the private home this same command just
 * created (or verified) as private and owned. Every other push this
 * codebase ever makes still goes through the hook unassisted.
 */

import { basename } from 'node:path'

import { parseGithubRepoSlug } from '../brain/self-issue-source.js'

export interface HomeSetupRunResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

/** One recorded command invocation (exported for the test runner's benefit). */
export interface HomeSetupCall {
  readonly file: 'git' | 'gh'
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly cwd?: string | undefined
}

export type HomeSetupRunner = (
  file: 'git' | 'gh',
  args: readonly string[],
  opts?: { readonly env?: Readonly<Record<string, string>>; readonly cwd?: string },
) => Promise<HomeSetupRunResult>

export interface HomeSetupDeps {
  readonly run: HomeSetupRunner
  /** Seed the meta registry's reserved global row (#63). */
  readonly recordTargets: (targets: {
    readonly upstreamRepo: string
    readonly writeTargetRepo: string
  }) => void
}

export interface HomeSetupOptions {
  readonly cwd: string
  /** `--repo owner/name`; null → `<gh login>/<clone directory name>`. */
  readonly repo: string | null
}

export interface HomeSetupResult {
  readonly ok: boolean
  /** Why the command refused; null on success. */
  readonly refusal: string | null
  readonly homeRepo: string | null
  readonly upstreamRepo: string | null
  /** Human-readable account of what was done, skipped, or found done. */
  readonly steps: ReadonlyArray<string>
}

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function sameSlug(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function isSshUrl(url: string): boolean {
  return url.startsWith('git@') || url.startsWith('ssh://')
}

interface HomeRepoInfo {
  readonly isPrivate: boolean
  readonly viewerPermission: string
}

function parseRepoInfo(stdout: string): HomeRepoInfo | null {
  try {
    const parsed = JSON.parse(stdout) as Partial<HomeRepoInfo>
    if (typeof parsed.isPrivate !== 'boolean' || typeof parsed.viewerPermission !== 'string') {
      return null
    }
    return { isPrivate: parsed.isPrivate, viewerPermission: parsed.viewerPermission }
  } catch {
    return null
  }
}

export async function runHomeSetup(
  opts: HomeSetupOptions,
  deps: HomeSetupDeps,
): Promise<HomeSetupResult> {
  const steps: string[] = []
  let homeRepo: string | null = null
  let upstreamRepo: string | null = null
  const refuse = (why: string): HomeSetupResult => ({
    ok: false,
    refusal: why,
    homeRepo,
    upstreamRepo,
    steps,
  })

  // 1. gh must be authenticated — everything else acts as this account.
  const who = await deps.run('gh', ['api', 'user', '--jq', '.login'])
  const login = who.stdout.trim()
  if (!who.ok || login === '') {
    return refuse('gh is not authenticated — run `gh auth login` first')
  }
  steps.push(`gh authenticated as ${login}`)

  // 2. Locate the clone and insist on a clean tree: re-pointing remotes and
  // pushing from a half-finished working state helps nobody.
  const top = await deps.run('git', ['rev-parse', '--show-toplevel'], { cwd: opts.cwd })
  if (!top.ok) {
    return refuse(`${opts.cwd} is not inside a git repository`)
  }
  const root = top.stdout.trim()
  const status = await deps.run('git', ['-C', root, 'status', '--porcelain'])
  if (!status.ok) {
    return refuse(`git status failed in ${root}: ${status.stderr.trim()}`)
  }
  if (status.stdout.trim() !== '') {
    return refuse('the work tree has uncommitted changes — commit or stash them, then re-run')
  }

  // 3. Read the remote topology as it stands.
  const originUrlRes = await deps.run('git', ['-C', root, 'remote', 'get-url', 'origin'])
  const upstreamUrlRes = await deps.run('git', ['-C', root, 'remote', 'get-url', 'upstream'])
  const originUrl = originUrlRes.ok ? originUrlRes.stdout.trim() : null
  const upstreamUrl = upstreamUrlRes.ok ? upstreamUrlRes.stdout.trim() : null
  const originSlug = originUrl !== null ? parseGithubRepoSlug(originUrl) : null
  const upstreamSlug = upstreamUrl !== null ? parseGithubRepoSlug(upstreamUrl) : null

  // 4. Name the home and the public upstream it must differ from.
  const homeSlug =
    (opts.repo ?? '').trim() !== '' ? opts.repo!.trim() : `${login}/${basename(root)}`
  if (!SLUG_RE.test(homeSlug)) {
    return refuse(`'${homeSlug}' is not an owner/name repository slug`)
  }
  const publicCandidate = upstreamSlug ?? originSlug
  if (publicCandidate !== null && sameSlug(publicCandidate, homeSlug)) {
    return refuse(
      `the home repository must differ from the public upstream ${publicCandidate} — ` +
        'pass --repo <owner/name> naming a different, private repository ' +
        '(a write target identical to the upstream is the misdirection the ' +
        'target-graph doctor rule exists to catch)',
    )
  }
  if (publicCandidate === null) {
    return refuse(
      'cannot determine the public upstream: neither the upstream remote nor the ' +
        'origin remote is a GitHub repository',
    )
  }
  upstreamRepo = publicCandidate
  steps.push(`public upstream: ${upstreamRepo}`)

  // 5. Create the home, or adopt an existing repo — refusing anything that
  // is not private and owned. Fail CLOSED when the answer is unparseable:
  // these branches decide where daemons may write.
  const viewArgs = ['repo', 'view', homeSlug, '--json', 'isPrivate,viewerPermission']
  const firstView = await deps.run('gh', viewArgs)
  let info: HomeRepoInfo | null = firstView.ok ? parseRepoInfo(firstView.stdout) : null
  if (!firstView.ok) {
    const create = await deps.run('gh', ['repo', 'create', homeSlug, '--private'])
    if (!create.ok) {
      return refuse(
        `could not view or create ${homeSlug}: ${create.stderr.trim() || firstView.stderr.trim()}`,
      )
    }
    steps.push(`created private repository ${homeSlug}`)
    const secondView = await deps.run('gh', viewArgs)
    info = secondView.ok ? parseRepoInfo(secondView.stdout) : null
  } else {
    steps.push(`found existing repository ${homeSlug}`)
  }
  if (info === null) {
    return refuse(`could not verify the visibility and ownership of ${homeSlug}`)
  }
  if (!info.isPrivate) {
    return refuse(
      `${homeSlug} is PUBLIC — the home must be private: auto branches, self-filed ` +
        'issues, and evidence carry machine-local and private-project context',
    )
  }
  if (info.viewerPermission !== 'ADMIN') {
    return refuse(
      `${login} does not own ${homeSlug} (viewer permission: ${info.viewerPermission}) — ` +
        'the home must be a repository the authenticated account owns',
    )
  }
  homeRepo = homeSlug
  steps.push(`${homeSlug} verified: private, owned by ${login}`)

  // 6. Re-point remotes: public upstream becomes `upstream`, the home
  // becomes `origin`. Each move checks before it acts.
  let originNowUrl = originUrl
  let originNowSlug = originSlug
  if (upstreamUrl === null && originSlug !== null && sameSlug(originSlug, upstreamRepo)) {
    const rename = await deps.run('git', ['-C', root, 'remote', 'rename', 'origin', 'upstream'])
    if (!rename.ok) {
      return refuse(`renaming origin to upstream failed: ${rename.stderr.trim()}`)
    }
    steps.push(`renamed remote origin (${upstreamRepo}) to upstream`)
    originNowUrl = null
    originNowSlug = null
  } else if (upstreamUrl !== null) {
    steps.push(`upstream remote already present (${upstreamSlug ?? upstreamUrl})`)
  }

  const homeUrl = isSshUrl(upstreamUrl ?? originUrl ?? '')
    ? `git@github.com:${homeSlug}.git`
    : `https://github.com/${homeSlug}.git`
  if (originNowUrl === null) {
    const add = await deps.run('git', ['-C', root, 'remote', 'add', 'origin', homeUrl])
    if (!add.ok) {
      return refuse(`adding the origin remote failed: ${add.stderr.trim()}`)
    }
    steps.push(`added origin -> ${homeUrl}`)
  } else if (originNowSlug !== null && sameSlug(originNowSlug, homeSlug)) {
    steps.push('origin already points at the home')
  } else {
    const setUrl = await deps.run('git', ['-C', root, 'remote', 'set-url', 'origin', homeUrl])
    if (!setUrl.ok) {
      return refuse(`re-pointing the origin remote failed: ${setUrl.stderr.trim()}`)
    }
    steps.push(`re-pointed origin from ${originNowSlug ?? originNowUrl} to ${homeUrl}`)
  }

  // 7. Seed the home with main. This one push carries the pre-push hook's
  // logged escape hatch: a human just asked for this conversion, and the
  // target is the private, owned home verified above — exactly the
  // deliberate main push the hatch exists for. Never forced, so adopting a
  // repo with its own diverged history refuses here rather than clobbering.
  steps.push(
    'pushing main to the home with SCNS_ALLOW_MAIN_PUSH=1 (one-time seed push; ' +
      'the pre-push guard stays armed for everything else)',
  )
  const push = await deps.run('git', ['-C', root, 'push', '-u', 'origin', 'main'], {
    env: { SCNS_ALLOW_MAIN_PUSH: '1' },
  })
  if (!push.ok) {
    return refuse(
      `pushing main to ${homeSlug} failed: ${push.stderr.trim()} — fix the cause and ` +
        're-run `home setup`; every completed step is kept and re-checked',
    )
  }
  steps.push(`pushed main to ${homeSlug}`)

  // 8. Pin gh's repo resolution for the ambiguous cases (issue commands run
  // with the clone as cwd and let gh pick a repo from the remotes).
  const setDefault = await deps.run('gh', ['repo', 'set-default', homeSlug], { cwd: root })
  if (!setDefault.ok) {
    return refuse(`gh repo set-default ${homeSlug} failed: ${setDefault.stderr.trim()}`)
  }
  steps.push(`gh repo set-default ${homeSlug}`)

  // 9. Declare the graph (#63): global broker writes to the home, updates
  // merge down from the public upstream. This is what `doctor` verifies and
  // what the singleton's self-issue ingestion resolves when env is unset.
  deps.recordTargets({ upstreamRepo, writeTargetRepo: homeSlug })
  steps.push(`recorded target graph in the meta registry: global ${upstreamRepo} -> ${homeSlug}`)

  return { ok: true, refusal: null, homeRepo, upstreamRepo, steps }
}
