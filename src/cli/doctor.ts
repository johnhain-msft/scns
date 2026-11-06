/**
 * WI-5 — `scns doctor`: cross-platform self-diagnosis.
 *
 * Runs a ladder of checks ordered to LOCALIZE failures (each layer assumes
 * the ones above it): node → build → native modules → embedding cache →
 * SCNS_HOME → broker → auth → meta registry → cwd routing → extension →
 * strict mode. Every check yields one [OK]/[FAIL]/[WARN]/[info] line and a
 * fix hint, so "something's wrong" on a fresh machine (the native-Windows
 * work machine especially) becomes "layer N failed because X".
 *
 * All probes are injected (DoctorDeps) — the default deps touch the real
 * system; tests exercise every branch on any host. Output is ASCII-only so
 * cmd.exe renders it faithfully.
 */
import { execFile } from 'node:child_process'
import { existsSync as fsExistsSync, readdirSync, readFileSync as fsReadFileSync } from 'node:fs'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir as osHomedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { resolveScnsHome } from '../shared/scns-home.js'
import { deriveSelfIssueRepoFromGit } from '../brain/self-issue-source.js'
import {
  isProcessAlive,
  readLiveBrokerPid,
  watchdogPidfilePath,
} from '../broker/services/broker-pidfile.js'
import {
  SELF_HEAL_ENV,
  SUPERVISED_ENV,
  decideSelfHealArming,
  describeSupervision,
} from '../broker/services/supervision.js'
import { getServicePaths } from './service-generators.js'
import { countRegisteredProjects, metaBrokerPidfilePath } from './meta-supervision.js'
import {
  UNATTENDED_EFFECTS,
  UNATTENDED_FEATURES,
  UNATTENDED_MASTER_ENV,
  isUnattendedEnabled,
  unattendedEnvVar,
  type UnattendedFeature,
} from '../shared/unattended.js'

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'info'

/** #58 — how the authenticated `gh` account relates to a target repo. */
export type RepoOwnership = 'owned' | 'not-owned' | 'unverifiable'

/**
 * Node majors SCNS actually runs on.
 *
 * This is a floor AND a ceiling, and the ceiling is not cosmetic: it tracks the
 * `better-sqlite3` prebuild matrix, because a contributor without a C++
 * toolchain cannot build the native module from source. For win32-x64 the
 * `~12.9` line ships NODE_MODULE_VERSION 115 (Node 20), 127 (22), 131 (23),
 * 137 (24) and 141 (25).
 *
 * Node 21 (ABI 120) is deliberately absent: it falls *inside* 20..25 but has no
 * prebuild, which is why this is an explicit list of majors rather than a plain
 * `>=20 <26` range. The previous check was `major >= 20` — a floor with no
 * ceiling — so it passed Node 24 while the very next check failed with an ABI
 * mismatch, blessing the cause of the failure it then reported.
 */
export const SUPPORTED_NODE_MAJORS = [20, 22, 23, 24, 25] as const

/**
 * The same fact as a semver range, for `package.json#engines`. Derived rather
 * than written twice so the two cannot drift; a unit test asserts the manifest
 * matches this string exactly.
 */
export const SUPPORTED_NODE_RANGE = SUPPORTED_NODE_MAJORS.map((m) => `^${m}.0.0`).join(' || ')

export interface DoctorCheck {
  readonly id: string
  readonly status: CheckStatus
  readonly detail: string
  readonly hint?: string
}

export interface DoctorReport {
  readonly checks: ReadonlyArray<DoctorCheck>
  /** True when nothing FAILED (warns/infos allowed). */
  readonly ok: boolean
}

export interface HttpResult {
  readonly status: number
  readonly body: unknown
}

export interface DoctorDeps {
  readonly platform: NodeJS.Platform
  readonly nodeVersion: string
  readonly env: Record<string, string | undefined>
  readonly cwd: string
  /** resolveScnsHome() — base dir whose `.scns/` subtree holds SCNS data. */
  readonly scnsHome: string
  /** Repo/package root (where dist/ and local_cache/ live). */
  readonly packageRoot: string
  readonly homedir: string
  readonly existsSync: (path: string) => boolean
  /** List a directory; empty array when missing/unreadable. */
  readonly listDir: (path: string) => ReadonlyArray<string>
  /** Try a write+delete probe in the given directory. */
  readonly probeWritable: (dir: string) => boolean
  readonly readFileSync: (path: string) => string
  /** Load better-sqlite3 + sqlite-vec + fastembed; report the first error. */
  readonly loadNativeModules: () => { ok: boolean; detail: string }
  /** GET a URL with a short timeout; throws on network failure. */
  readonly httpGet: (url: string, headers?: Record<string, string>) => Promise<HttpResult>
  /** #61 — liveness probe for a recorded supervisor pid. Defaults to signal 0. */
  readonly isProcessAlive?: (pid: number) => boolean
  /** #61 — registered projects in the meta registry; null when unreadable. */
  readonly countRegisteredProjects?: (metaDbPath: string) => number | null
  /** #61 — pid recorded in a runtime pidfile whose process is alive, or null. */
  readonly readLivePid?: (pidfilePath: string) => number | null
  /** #58 — GitHub `owner/name` of a directory's origin remote, or null. */
  readonly getOriginRepoSlug?: (dir: string) => Promise<string | null>
  /** #58 — whether the authenticated gh account owns (is admin on) `slug`. */
  readonly probeRepoOwnership?: (slug: string) => Promise<RepoOwnership>
}

function defaultListDir(path: string): ReadonlyArray<string> {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function defaultProbeWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.doctor-probe-${process.pid}`)
    writeFileSync(probe, 'probe')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

function defaultLoadNativeModules(): { ok: boolean; detail: string } {
  const loaded: string[] = []
  try {
    const req = createRequireForDoctor()
    const Database = req('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(':memory:')
    loaded.push('better-sqlite3')
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    sqliteVec.load(db)
    loaded.push('sqlite-vec')
    db.close()
    req.resolve('fastembed')
    loaded.push('fastembed')
    return { ok: true, detail: loaded.join(' + ') }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, detail: `loaded [${loaded.join(', ')}] then: ${msg}` }
  }
}

function createRequireForDoctor(): NodeRequire {
  // require() the native modules dynamically so a doctor binary never crashes
  // at import time on the very layer it exists to diagnose.
  return createRequire(import.meta.url)
}

const execFileAsync = promisify(execFile)

/**
 * #58 — default ownership probe: `gh repo view` reports the viewer's
 * permission on the repo; only ADMIN counts as ownership. Any failure
 * (gh missing, unauthenticated, repo unreachable) is `unverifiable`,
 * which the target check treats as a FAIL — consent to write somewhere
 * must be verifiable, not assumed.
 */
async function defaultProbeRepoOwnership(slug: string): Promise<RepoOwnership> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['repo', 'view', slug, '--json', 'viewerPermission', '-q', '.viewerPermission'],
      { windowsHide: true },
    )
    return stdout.trim() === 'ADMIN' ? 'owned' : 'not-owned'
  } catch {
    return 'unverifiable'
  }
}

async function defaultHttpGet(url: string, headers?: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(url, {
    ...(headers ? { headers } : {}),
    signal: AbortSignal.timeout(4000),
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // non-JSON body is fine for a probe
  }
  return { status: res.status, body }
}

export function defaultDoctorDeps(): DoctorDeps {
  return {
    platform: process.platform,
    nodeVersion: process.version,
    env: process.env,
    cwd: process.cwd(),
    scnsHome: resolveScnsHome(),
    packageRoot: dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
    homedir: osHomedir(),
    existsSync: fsExistsSync,
    listDir: defaultListDir,
    probeWritable: defaultProbeWritable,
    readFileSync: (p: string) => fsReadFileSync(p, 'utf-8'),
    loadNativeModules: defaultLoadNativeModules,
    httpGet: defaultHttpGet,
    countRegisteredProjects,
    readLivePid: (p: string) => readLiveBrokerPid(p),
    getOriginRepoSlug: (dir: string) => deriveSelfIssueRepoFromGit(dir),
    probeRepoOwnership: defaultProbeRepoOwnership,
  }
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []
  const add = (c: DoctorCheck): void => {
    checks.push(c)
  }

  // 1. Node version
  const major = parseInt(deps.nodeVersion.replace(/^v/, '').split('.')[0] ?? '0', 10)
  const nodeTarget = deps.nodeVersion.replace(/^v/, '')
  const supportedMajors: readonly number[] = SUPPORTED_NODE_MAJORS
  const floor = Math.min(...supportedMajors)
  const readableMajors = supportedMajors.join(', ')
  add(
    supportedMajors.includes(major)
      ? { id: 'node-version', status: 'pass', detail: deps.nodeVersion }
      : {
          id: 'node-version',
          status: 'fail',
          detail:
            major < floor
              ? `${deps.nodeVersion} is below the required Node ${floor}`
              : `${deps.nodeVersion} is not a supported Node major (supported: ${readableMajors})`,
          hint:
            `SCNS runs on Node ${readableMajors} — the majors better-sqlite3 ships ` +
            'prebuilt binaries for, and building it from source needs a C++ toolchain. ' +
            `Switch with a version manager (e.g. \`nvm use ${Math.max(...supportedMajors)}\`), ` +
            'then re-run `npm ci && npm run build`.',
        },
  )

  // 2. Build artifacts (tsc output + the copied schema assets)
  const artifacts = [
    join(deps.packageRoot, 'dist', 'cli.js'),
    join(deps.packageRoot, 'dist', 'broker', 'storage', 'schema.sql'),
    join(deps.packageRoot, 'dist', 'otel', 'schema.sql'),
  ]
  const missing = artifacts.filter((a) => !deps.existsSync(a))
  add(
    missing.length === 0
      ? { id: 'dist-build', status: 'pass', detail: 'dist/ build present (cli + schema assets)' }
      : {
          id: 'dist-build',
          status: 'fail',
          detail: `missing: ${missing.join(', ')}`,
          hint: 'run `npm run build` in the repo root',
        },
  )

  // 3. Native modules
  const native = deps.loadNativeModules()
  // An ABI mismatch describes the interpreter running `scns doctor`, not the
  // install. SCNS pins Node 20 for better-sqlite3 while the Copilot CLI requires
  // Node >= 24, so doctor normally runs under a different Node than the stack
  // does, and reporting that as a FAIL told alpha testers a healthy machine was
  // broken. `broker-reachable` is the authority on the RUNNING stack: a stack
  // that genuinely cannot load the binary cannot serve, and fails there.
  const abiMismatch = !native.ok && /NODE_MODULE_VERSION/.test(native.detail)
  add(
    native.ok
      ? { id: 'native-modules', status: 'pass', detail: native.detail }
      : {
          id: 'native-modules',
          status: abiMismatch ? 'warn' : 'fail',
          detail: native.detail,
          hint: abiMismatch
            ? `this is the ABI of the Node running \`scns doctor\` (${deps.nodeVersion}), ` +
              'not necessarily the one running the stack — see `broker-reachable` for ' +
              'whether the live broker loads it. To clear this locally, run doctor under ' +
              'the pinned Node, or install the prebuild for THIS Node: ' +
              '`cd node_modules/better-sqlite3 && node ../prebuild-install/bin.js ' +
              `--runtime node --target ${nodeTarget}\`.`
            : 'the installed binary was built for a different Node. `npm ci` alone can ' +
              'refetch the SAME wrong ABI, because it runs prebuild-install under ' +
              'whichever `node` is on PATH, and its node-gyp fallback needs a C++ ' +
              'toolchain. Install the prebuild for THIS Node instead: ' +
              '`cd node_modules/better-sqlite3 && node ../prebuild-install/bin.js ' +
              `--runtime node --target ${nodeTarget}\`. ` +
              'Behind a corporate proxy set HTTPS_PROXY first.',
        },
  )

  // 4. Embedding model cache
  const cacheDir = deps.env['SCNS_EMBED_CACHE_DIR'] ?? join(deps.packageRoot, 'local_cache')
  const cacheEntries = deps.listDir(cacheDir)
  add(
    cacheEntries.length > 0
      ? {
          id: 'embedding-cache',
          status: 'pass',
          detail: `${cacheDir} (${cacheEntries.length} entries)`,
        }
      : {
          id: 'embedding-cache',
          status: 'warn',
          detail: `no embedding model cache at ${cacheDir} — first use downloads ~128 MB`,
          hint:
            'copy local_cache/ from an existing install (proxy-proof), or set ' +
            'SCNS_EMBED_CACHE_DIR to a pre-populated cache; otherwise ensure the proxy allows the download',
        },
  )

  // 5. SCNS_HOME writable
  const scnsDir = join(deps.scnsHome, '.scns')
  add(
    deps.probeWritable(scnsDir)
      ? { id: 'scns-home-writable', status: 'pass', detail: scnsDir }
      : {
          id: 'scns-home-writable',
          status: 'fail',
          detail: `cannot write ${scnsDir}`,
          hint: 'check SCNS_HOME (currently derived home) and directory permissions',
        },
  )

  // 6-7. Broker reachability + auth
  const port = parseInt(deps.env['BROKER_PORT'] ?? '3456', 10)
  const base = `http://127.0.0.1:${port}`
  const token = deps.env['BROKER_TOKEN']
  let brokerUp = false
  try {
    const health = await deps.httpGet(`${base}/health`)
    brokerUp = health.status === 200
    add(
      brokerUp
        ? { id: 'broker-reachable', status: 'pass', detail: `${base}/health OK` }
        : {
            id: 'broker-reachable',
            status: 'fail',
            detail: `${base}/health answered HTTP ${health.status}`,
            hint: 'check the broker logs; restart with `scns start`',
          },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    add({
      id: 'broker-reachable',
      status: 'fail',
      detail: `${base}/health unreachable (${msg})`,
      hint:
        'start the broker: `scns start` (or the Task Scheduler at-logon task on Windows); ' +
        'if it is running on another port, set BROKER_PORT',
    })
  }
  if (brokerUp) {
    try {
      const auth = await deps.httpGet(
        `${base}/api/sessions`,
        token ? { Authorization: `Bearer ${token}` } : undefined,
      )
      if (auth.status === 200) {
        add({
          id: 'broker-auth',
          status: 'pass',
          detail: token ? 'token accepted' : 'broker runs tokenless; requests accepted',
        })
      } else if (auth.status === 401) {
        add({
          id: 'broker-auth',
          status: 'fail',
          detail: token
            ? 'broker rejected the configured BROKER_TOKEN'
            : 'broker requires a token but BROKER_TOKEN is not set in this shell',
          hint:
            'align BROKER_TOKEN between the broker process and this shell, then re-run ' +
            '`scns install-extension` so the extension embeds the same token',
        })
      } else {
        add({
          id: 'broker-auth',
          status: 'warn',
          detail: `unexpected HTTP ${auth.status} from /api/sessions`,
        })
      }
    } catch (err) {
      add({
        id: 'broker-auth',
        status: 'fail',
        detail: `auth probe failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  } else {
    add({
      id: 'broker-auth',
      status: 'fail',
      detail: 'skipped — broker not reachable',
      hint: 'fix broker-reachable first',
    })
  }

  // 8. Meta registry present
  const registryPath = join(deps.scnsHome, '.scns', 'meta-broker.db')
  add(
    deps.existsSync(registryPath)
      ? { id: 'meta-registry', status: 'pass', detail: registryPath }
      : {
          id: 'meta-registry',
          status: 'fail',
          detail: `no meta registry at ${registryPath}`,
          hint:
            'register each work repo: `scns meta-broker register <repoRoot>`, then start ' +
            'the supervisor so child brokers spawn',
        },
  )

  // 9. Meta-resolve for cwd
  if (brokerUp) {
    try {
      const resolve = await deps.httpGet(
        `${base}/api/meta/resolve?path=${encodeURIComponent(deps.cwd)}`,
        token ? { Authorization: `Bearer ${token}` } : undefined,
      )
      const body = resolve.body as {
        resolved?: boolean
        projectId?: string
        boundPort?: number
        reason?: string
      } | null
      if (body?.resolved) {
        add({
          id: 'meta-resolve-cwd',
          status: 'pass',
          detail: `cwd routes to ${body.projectId} on :${body.boundPort}`,
        })
      } else {
        add({
          id: 'meta-resolve-cwd',
          status: 'warn',
          detail: `cwd does NOT route to a child broker (${body?.reason ?? `HTTP ${resolve.status}`}) — sessions here use the GLOBAL brain`,
          hint:
            '`scns meta-broker register <this repo root>` + ensure the supervisor is ' +
            'running; with SCNS_REQUIRE_PROJECT_BROKER=1 stores will be refused until then',
        })
      }
    } catch (err) {
      add({
        id: 'meta-resolve-cwd',
        status: 'fail',
        detail: `resolve probe failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  } else {
    add({
      id: 'meta-resolve-cwd',
      status: 'fail',
      detail: 'skipped — broker not reachable',
      hint: 'fix broker-reachable first',
    })
  }

  // 10. Copilot extension installed
  const extensionPath = join(deps.homedir, '.copilot', 'extensions', 'scns', 'extension.mjs')
  if (deps.existsSync(extensionPath)) {
    let tokenNote = 'unknown token state'
    try {
      const src = deps.readFileSync(extensionPath)
      tokenNote = /const BROKER_TOKEN = null/.test(src)
        ? 'no token embedded'
        : /const BROKER_TOKEN = "/.test(src)
          ? 'token embedded'
          : 'pre-token build'
    } catch {
      // unreadable → keep unknown
    }
    add({ id: 'extension-installed', status: 'pass', detail: `${extensionPath} (${tokenNote})` })
  } else {
    add({
      id: 'extension-installed',
      status: 'fail',
      detail: `no extension at ${extensionPath}`,
      hint: 'run `scns install-extension` (with BROKER_TOKEN set if the broker uses one)',
    })
  }

  // 11. Strict-mode flag
  const strict = deps.env['SCNS_REQUIRE_PROJECT_BROKER'] === '1'
  add({
    id: 'strict-mode',
    status: 'info',
    detail: strict
      ? 'SCNS_REQUIRE_PROJECT_BROKER=1 — ON (stores refused on the global brain)'
      : 'SCNS_REQUIRE_PROJECT_BROKER — OFF (stores allowed anywhere; work machine should set =1)',
  })

  // 12. Unattended actions (#53 AC4) — anything that reaches outside this
  // machine on the operator's behalf. Default is all-OFF; when something
  // IS enabled, say so loudly and by name.
  const enabledUnattended = UNATTENDED_FEATURES.filter((f) => isUnattendedEnabled(f, deps.env))
  add(
    enabledUnattended.length === 0
      ? {
          id: 'unattended-actions',
          status: 'info',
          detail:
            'all OFF (opt-in) — nothing will push branches, open PRs, file issues, ' +
            'or spend credits on your behalf',
        }
      : {
          id: 'unattended-actions',
          status: 'warn',
          detail: `ENABLED: ${enabledUnattended
            .map((f) => `${f} (${UNATTENDED_EFFECTS[f]})`)
            .join('; ')}`,
          hint: `unset ${enabledUnattended
            .map((f) => unattendedEnvVar(f))
            .join('/')} (and ${UNATTENDED_MASTER_ENV}) to return to the safe default`,
        },
  )

  // 13. Unattended target repos (#58) — the check above answers "is
  // anything allowed to act?"; this one answers "and at WHAT repo?". An
  // enabled writer with no resolvable target, or a target the authenticated
  // account does not own, is a misdirected daemon: it would push branches
  // or file issues on somebody else's repository — most likely the public
  // upstream this install was cloned from. That is a FAIL, not a warning,
  // and it fails CLOSED when ownership cannot be verified.
  const githubWritingFeatures: readonly UnattendedFeature[] = [
    'gate-pass-publisher',
    'north-star-nudge',
    'drift-watchdog',
  ]
  const enabledGithubWriters = githubWritingFeatures.filter((f) => isUnattendedEnabled(f, deps.env))
  const selfIssueTarget = (deps.env['SCNS_SELF_ISSUE_REPO'] ?? '').trim()
  if (enabledGithubWriters.length === 0 && selfIssueTarget === '') {
    add({
      id: 'unattended-target-repo',
      status: 'info',
      detail:
        'no unattended GitHub writer is enabled and no self-issue target is set — nothing to verify',
    })
  } else {
    const problems: string[] = []
    const targets = new Map<string, readonly string[]>()
    const noteTarget = (slug: string, source: string): void => {
      targets.set(slug, [...(targets.get(slug) ?? []), source])
    }
    if (enabledGithubWriters.length > 0) {
      // The writers act on the origin remote of the broker's project root —
      // same resolution the broker itself uses (BROKER_PROJECT_ROOT, else cwd).
      const writerRoot = deps.env['BROKER_PROJECT_ROOT'] ?? deps.cwd
      const writerNames = enabledGithubWriters.join(' + ')
      const slug = await (deps.getOriginRepoSlug ?? deriveSelfIssueRepoFromGit)(writerRoot)
      if (slug === null) {
        problems.push(
          `${writerNames} act on the origin remote of ${writerRoot}, ` +
            'which has no GitHub origin — their target is unset',
        )
      } else {
        noteTarget(slug, writerNames)
      }
    }
    if (selfIssueTarget !== '') {
      noteTarget(selfIssueTarget, 'self-issue ingestion (SCNS_SELF_ISSUE_REPO)')
    }
    const probeOwnership = deps.probeRepoOwnership ?? defaultProbeRepoOwnership
    const verified: string[] = []
    for (const [slug, sources] of targets) {
      const ownership = await probeOwnership(slug)
      if (ownership === 'owned') {
        verified.push(`${slug} (${sources.join('; ')})`)
      } else if (ownership === 'not-owned') {
        problems.push(
          `${slug} (${sources.join('; ')}) is not owned by the authenticated gh account`,
        )
      } else {
        problems.push(
          `${slug} (${sources.join('; ')}) ownership could not be verified — ` +
            'is gh installed and authenticated?',
        )
      }
    }
    add(
      problems.length === 0
        ? {
            id: 'unattended-target-repo',
            status: 'pass',
            detail: `every target is owned by the authenticated account: ${verified.join(', ')}`,
          }
        : {
            id: 'unattended-target-repo',
            status: 'fail',
            detail: problems.join('; '),
            hint:
              'every unattended writer must target a repository the authenticated account ' +
              'owns (for SCNS self-improvement that means your own private fork, never the ' +
              'public upstream) — set SCNS_SELF_ISSUE_REPO / fix the origin remote, or ' +
              'disable the writer',
          },
    )
  }

  // 14. Supervision root (#61) — DURABILITY, not current health.
  //
  // Every check above asks "is it up now?". This one asks "will anything bring
  // it back?" — the question that would have caught an 11h47m outage while the
  // report still said "all checks passed".
  const supervisionPort = parseInt(deps.env['BROKER_PORT'] ?? '3456', 10)
  const supervisionRoot = supervisionRootCheck(deps, supervisionPort)
  add(supervisionRoot)

  // 15. Meta-broker supervision (#61).
  //
  // The meta-broker fails quietly and totally: when it dies every per-project
  // child dies with it, and every session in every registered repo silently
  // latches `global:fallback` — writing to the shared brain instead of its own
  // project. Nothing about that shows up in the checks above, because the
  // GLOBAL broker stays perfectly healthy throughout.
  add(metaBrokerSupervisionCheck(deps, registryPath))

  // 16. Self-heal arming (#61). Self-heal drains and exit(1)s expecting a
  // supervisor to relaunch. Where none exists that is a permanent death, so
  // say out loud which way this host is configured.
  const arming = decideSelfHealArming({ platform: deps.platform, env: deps.env })
  // `decideSelfHealArming` reads THIS process's env, so on a supervised host it
  // would otherwise report "disarmed — install a supervision root" in the same
  // report whose `supervision-root` check says the watchdog is running, and while
  // the live broker logs "Self-heal armed". The broker is spawned BY the root with
  // SUPERVISED_ENV=1; describe that broker, not the operator's shell.
  const supervisedHost = supervisionRoot.status === 'pass'
  add(
    arming.armed && arming.reason !== 'env-forced'
      ? {
          id: 'self-heal-arming',
          status: 'info',
          detail: `armed — ${describeSupervision(arming.supervision)}`,
        }
      : {
          id: 'self-heal-arming',
          status:
            arming.reason === 'env-disabled'
              ? 'info'
              : !arming.armed && supervisedHost
                ? 'info'
                : 'warn',
          detail: arming.armed
            ? `armed (forced) — ${arming.detail}`
            : supervisedHost
              ? `armed in the supervised broker — the supervision root spawns it with ` +
                `${SUPERVISED_ENV}=1. This shell is not supervised, so a broker started ` +
                `here by hand would not arm.`
              : `disarmed — ${arming.detail}`,
          ...(arming.reason === 'env-disabled' || (!arming.armed && supervisedHost)
            ? {}
            : {
                hint: arming.armed
                  ? `unset ${SELF_HEAL_ENV} unless a supervisor really is running`
                  : 'install a supervision root (`scns install`) to let the broker heal itself',
              }),
        },
  )

  return { checks, ok: checks.every((c) => c.status !== 'fail') }
}

/**
 * #61 — is there anything that will restart the broker if it dies?
 *
 * darwin/linux: the service file must exist, because that is where the
 * `KeepAlive` / `Restart=on-failure` contract actually lives.
 *
 * win32: two things must hold. The Startup shim brings a watchdog up at logon,
 * and a watchdog must actually be running now — the observed outage had a host
 * that was up for days with no logon, so an installed-but-never-triggered shim
 * is a warning, not a pass.
 */
function supervisionRootCheck(deps: DoctorDeps, port: number): DoctorCheck {
  const id = 'supervision-root'
  let installPath: string
  try {
    installPath = getServicePaths(deps.platform).installPath
  } catch {
    return {
      id,
      status: 'fail',
      detail: `no supervision mechanism is implemented for ${deps.platform}`,
      hint: 'run the broker under a process supervisor you control',
    }
  }

  const installed = deps.existsSync(installPath)

  if (deps.platform !== 'win32') {
    const mechanism = deps.platform === 'darwin' ? 'launchd' : 'systemd'
    return installed
      ? { id, status: 'pass', detail: `${mechanism} service installed at ${installPath}` }
      : {
          id,
          status: 'fail',
          detail: `no ${mechanism} service at ${installPath} — nothing would relaunch a dead broker`,
          hint: 'run `scns install`, then load/enable the generated service',
        }
  }

  const watchdogPid = readSupervisorPid(deps, watchdogPidfilePath(deps.scnsHome, port))
  if (watchdogPid !== null) {
    return {
      id,
      status: 'pass',
      detail: `watchdog running (pid ${watchdogPid}, port ${port})${
        installed ? `; Startup shim at ${installPath}` : '; NOT installed at logon'
      }`,
      ...(installed
        ? {}
        : { hint: 'run `scns install` so the watchdog also comes back after a reboot' }),
    }
  }
  return installed
    ? {
        id,
        status: 'warn',
        detail:
          `Startup shim installed at ${installPath}, but no watchdog is running for ` +
          `port ${port} — nothing is supervising the broker right now`,
        hint: `start it: \`scns watchdog run --port ${port}\` (or run the shim)`,
      }
    : {
        id,
        status: 'fail',
        detail:
          `no supervision root: no Startup shim at ${installPath} and no watchdog ` +
          `running for port ${port}. A dead broker stays dead.`,
        hint: 'run `scns install` to install the Startup-folder supervision root',
      }
}

/**
 * #61 — is the meta-broker supervised, if this machine actually uses it?
 *
 * Reported on every platform, because the hole is not Windows-specific:
 * `scns install` only ever wrote the broker's service file, so even on macOS
 * the `com.scns.meta-broker` job is generated but never installed.
 *
 * Silent when the meta-broker is not in use. Starting a supervisor for a
 * feature nobody opted into would be worse than the gap.
 */
function metaBrokerSupervisionCheck(deps: DoctorDeps, registryPath: string): DoctorCheck {
  const id = 'meta-broker-supervision'
  const count = (deps.countRegisteredProjects ?? countRegisteredProjects)(registryPath)

  if (count === null) {
    return {
      id,
      status: 'info',
      detail: `meta registry not readable at ${registryPath} — cannot tell whether the meta-broker is in use`,
    }
  }
  if (count === 0) {
    return { id, status: 'info', detail: 'no registered projects — nothing to supervise' }
  }

  const pidfile = metaBrokerPidfilePath(deps.scnsHome)
  const readLive = deps.readLivePid ?? ((p: string) => readLiveBrokerPid(p))
  const pid = readLive(pidfile)

  return pid !== null
    ? {
        id,
        status: 'pass',
        detail: `meta-broker running (pid ${pid}) for ${count} registered project(s)`,
      }
    : {
        id,
        status: 'fail',
        detail:
          `${count} project(s) are registered but no meta-broker is running — every session ` +
          'in those repos resolves to global:fallback and writes to the shared brain',
        hint:
          'start the supervision root (`scns watchdog run --supervise-meta on`), or run ' +
          '`scns meta-broker run` directly',
      }
}

/** Pid from a supervisor pidfile, or null when missing, malformed or stale. */
function readSupervisorPid(deps: DoctorDeps, path: string): number | null {
  if (!deps.existsSync(path)) return null
  let pid: unknown
  try {
    pid = (JSON.parse(deps.readFileSync(path)) as { pid?: unknown }).pid
  } catch {
    return null
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  const alive = deps.isProcessAlive ?? ((p: number) => isProcessAlive(p))
  return alive(pid) ? pid : null
}

const TAGS: Record<CheckStatus, string> = {
  pass: '[OK]  ',
  fail: '[FAIL]',
  warn: '[WARN]',
  info: '[info]',
}

/** ASCII-only rendering — cmd.exe/PowerShell-safe. */
export function formatReport(report: DoctorReport): string {
  const lines: string[] = ['scns doctor', '']
  for (const c of report.checks) {
    lines.push(`${TAGS[c.status]} ${c.id} — ${c.detail}`)
    if (c.hint && c.status !== 'pass') {
      lines.push(`       hint: ${c.hint}`)
    }
  }
  const failed = report.checks.filter((c) => c.status === 'fail').length
  lines.push('')
  lines.push(failed === 0 ? 'all checks passed' : `${failed} check(s) failed`)
  return lines.join('\n')
}
