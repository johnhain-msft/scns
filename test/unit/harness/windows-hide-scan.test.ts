/**
 * Harness guard — every `child_process` call in `src/` must pass `windowsHide: true`.
 *
 * ## Why this exists
 * The SCNS supervision root, the global broker and every per-project child broker run
 * DETACHED, which on Windows means they own no console. When such a process spawns a
 * console child WITHOUT `windowsHide`, Windows has no console to inherit and allocates a
 * BRAND-NEW one — and on Windows 11 the default console host is Windows Terminal, so a
 * real window appears on the user's desktop.
 *
 * Measured live 2026-09-15 (win-watch, 120s):
 *   00:30:18 NEWWIN WindowsTerminal.exe -Embedding
 *   00:30:20 NEWWIN gh.exe  ppid=15652 (global broker, `dist/cli.js start --port 3456`)
 *            cmd: gh issue list --state open --json … -R johnhain-msft/scns
 * That is the `self-issue-ingest` cron (`*​/15 * * * *`) in `brain/self-issue-source.ts`,
 * multiplied by the eight brokers then live (3456 + 3500–3506).
 *
 * Three PER-SITE tests already existed — `broker/session-discovery-windowshide`,
 * `meta-broker/child-spawn-windowshide`, `observe/shell-out-windowshide`. Each closed one
 * instance; none closed the CLASS, so `src/brain/*` was simply missed and the popups
 * survived a full day of fixing. This scan is the class-level guard.
 *
 * `windowsHide` is inert on POSIX, so POSIX-only shell-outs (`lsof`, `ps`, `tmux`,
 * `osascript`) are required to carry it too rather than be exempted — a per-call
 * exemption is exactly the hole that let `brain/` through.
 *
 * ## Known limits (documented, not silently tolerated)
 * - Brace/paren matching is naive: it does not tokenize strings, comments or template
 *   literals. Prior art `spawn-env-isolation.test.ts` accepts the same limit.
 * - Only direct calls of a `node:child_process` binding — or of a parameter whose DEFAULT
 *   VALUE is such a binding (the repo's DI convention, e.g.
 *   `exec: Exec = nodeExecFileSync`) — are scanned. A function passed through two layers
 *   of indirection is out of reach of a static scan.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC_ROOT = resolve(__dirname, '..', '..', '..', 'src')

/**
 * Opt-out marker for this file's own fixtures. A scanner whose own positive controls trip
 * the tree scan is useless. Put it on the same line as the call. Nothing in `src/` that
 * actually spawns a process may carry it.
 */
const FIXTURE_MARKER = 'scns-windowshide-scan:fixture'

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listTypeScriptFiles(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

function lineAt(src: string, index: number): string {
  const start = src.lastIndexOf('\n', index) + 1
  const end = src.indexOf('\n', index)
  return src.slice(start, end < 0 ? src.length : end)
}

/**
 * Spawning members of `node:child_process`.
 *
 * `fork` USED TO BE excluded here, on the premise that "a forked child inherits
 * the parent's console rather than allocating its own" — citing a 2026-09-15
 * measurement in which the embedding worker under the broker had no `conhost`
 * of its own. **That premise was falsified on 2026-09-25.**
 *
 * It holds only while the parent still HAS a console. It does not survive
 * `detached: true`: Windows ignores `CREATE_NO_WINDOW` when it is combined with
 * `DETACHED_PROCESS`, so such a parent owns NO console, and a forked child of a
 * console-less parent must allocate a BRAND-NEW one — which Windows 11 delegates
 * to Windows Terminal (`OpenConsole.exe -Embedding`), i.e. a real window.
 *
 * The brokers are spawned exactly that way (`cli/watchdog-runtime.ts`,
 * `detached: true`), which was committed in 39b9675 on 2026-09-14 and reached
 * `main` on 2026-09-16 via PR #63 (merge 75c0544) — i.e. it was on a feature
 * branch, not in `main`, when the exemption was written. Exactly when the live
 * stack began running it is NOT established: the pre-2026-09-24 `dist` was
 * overwritten and is unrecoverable. The MECHANISM below is measured; the
 * changeover DATE is not.
 *
 * Measured live 2026-09-25, clean-room (nothing else running, 5.5 min):
 *   13:52:07.181 POPUP OpenConsole.exe pid=34288
 *   13:52:07.181 FORK  embedding-worker pid=38684 ppid=47456   (broker :3456)
 *   forks 1, popups 1, correlated. Zero popups in a 200s window with no fork,
 *   while session-discovery kept shelling out every 15s across 11 brokers.
 * Controlled repro, parent `detached:true`: fork → new console host 3/3;
 * `spawn(execPath, [worker], { stdio: [...,'ipc'], windowsHide: true })` → 0/3.
 *
 * Because `ForkOptions` has no `windowsHide` (tsc rejects it — TS2353), listing
 * `fork` here means: do not use `fork` in `src/` at all. Use `spawn` with an
 * explicit `'ipc'` stdio slot, which provides the same IPC channel AND accepts
 * `windowsHide`.
 */
const SPAWNERS = new Set([
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'spawn',
  'spawnSync',
  'fork',
])

/** Local binding names imported from `node:child_process`, resolving `as` aliases. */
export function childProcessBindings(src: string): Set<string> {
  const names = new Set<string>()
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g
  for (const m of src.matchAll(importRe)) {
    for (const raw of m[1]!.split(',')) {
      const part = raw.trim()
      if (!part || part.startsWith('type ')) continue
      const aliased = part.match(/^(\w+)\s+as\s+(\w+)$/)
      const original = aliased ? aliased[1]! : part
      const local = aliased ? aliased[2]! : part
      if (/^\w+$/.test(local) && SPAWNERS.has(original)) names.add(local)
    }
  }
  return names
}

/**
 * Local binding names that resolve specifically to `fork`, including `as` aliases.
 *
 * These are flagged regardless of options: `ForkOptions` has no `windowsHide`, so
 * there is no compliant way to call `fork` here — the rule is simply "don't".
 */
export function forkOnlyBindings(src: string): Set<string> {
  const names = new Set<string>()
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g
  for (const m of src.matchAll(importRe)) {
    for (const raw of m[1]!.split(',')) {
      const part = raw.trim()
      if (!part || part.startsWith('type ')) continue
      const aliased = part.match(/^(\w+)\s+as\s+(\w+)$/)
      const original = aliased ? aliased[1]! : part
      const local = aliased ? aliased[2]! : part
      if (/^\w+$/.test(local) && original === 'fork') names.add(local)
    }
  }
  return names
}

/**
 * The repo injects spawners for testability while defaulting to the real one:
 * `exec: Exec = nodeExecFileSync` / `exec: typeof nodeExecSync = nodeExecSync`.
 * Those parameters ARE the real function at runtime, so their call sites count.
 */
export function diAliasBindings(src: string, seeds: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const seed of seeds) {
    const re = new RegExp(`(\\w+)\\s*:\\s*(?:typeof\\s+)?\\w+\\s*=\\s*${seed}\\b`, 'g')
    for (const m of src.matchAll(re)) out.add(m[1]!)
  }
  return out
}

/** Text between the parentheses of the call whose `(` sits at `openParen`. */
function callArguments(src: string, openParen: number): string {
  let depth = 0
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return src.slice(openParen + 1, i)
    }
  }
  return ''
}

/**
 * `promisify(execFile)` is the repo's other indirection: `session-discovery.ts`,
 * `self-issue-source.ts` and `tracked-issue.ts` all call the promisified form, and the
 * `gh` call proven to open a window live was exactly this shape.
 */
export function promisifiedBindings(src: string, seeds: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const seed of seeds) {
    const re = new RegExp(
      `(?:const|let|var)\\s+(\\w+)\\s*=\\s*promisify\\s*\\(\\s*${seed}\\s*\\)`,
      'g',
    )
    for (const m of src.matchAll(re)) out.add(m[1]!)
  }
  return out
}

/** The object literal starting at `open`, via brace matching. `''` when unbalanced. */
function objectLiteralAt(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return ''
}

/**
 * Options hoisted into a local before the call — `const options = { windowsHide: true }`
 * in `observe/command-executor.ts` is already correct, and flagging it would train the
 * next reader to "fix" a call that has no defect.
 */
export function hiddenOptionIdentifiers(src: string): Set<string> {
  const out = new Set<string>()
  const re = /(?:const|let|var)\s+(\w+)\s*(?::[^=]+?)?=\s*\{/g
  for (const m of src.matchAll(re)) {
    const brace = src.indexOf('{', m.index! + m[0]!.length - 1)
    if (brace < 0) continue
    if (objectLiteralAt(src, brace).includes('windowsHide')) out.add(m[1]!)
  }
  return out
}

/** Every child_process call in `src` whose arguments never mention `windowsHide`. */
export function findUnhiddenSpawns(src: string): string[] {
  const seeds = childProcessBindings(src)
  if (seeds.size === 0) return []
  const callable = new Set([
    ...seeds,
    ...diAliasBindings(src, seeds),
    ...promisifiedBindings(src, seeds),
  ])
  const hoisted = hiddenOptionIdentifiers(src)
  const offenders: string[] = []
  // `fork` bindings are flagged UNCONDITIONALLY. Judge finding 2026-09-28: gating
  // them on a literal `windowsHide` in the args is not the stated rule ("do not use
  // fork in src/ at all") — `const o = { windowsHide: true }; fork(p, [], o)` both
  // compiles (TS excess-property checking does not apply to a variable reference)
  // and slipped past the options check. Since `ForkOptions` has no `windowsHide`,
  // the only honest enforcement is: no `fork` in `src/`, options notwithstanding.
  const forkBindings = forkOnlyBindings(src)

  for (const name of callable) {
    // Bare identifier only: never `db.exec(`, `deps.spawnSync(`, `this.exec(`.
    const re = new RegExp(`(?<![.\\w$])${name}\\s*\\(`, 'g')
    for (const m of src.matchAll(re)) {
      const openParen = m.index! + m[0]!.length - 1
      if (lineAt(src, m.index!).includes(FIXTURE_MARKER)) continue
      const args = callArguments(src, openParen)
      if (!args) continue
      if (forkBindings.has(name)) {
        offenders.push(`${name}(${args.replace(/\s+/g, ' ').trim().slice(0, 100)})`)
        continue
      }
      const viaHoisted = [...hoisted].some((id) =>
        new RegExp(`(?<![.\\w$])${id}(?![\\w$])`).test(args),
      )
      if (!args.includes('windowsHide') && !viaHoisted) {
        offenders.push(`${name}(${args.replace(/\s+/g, ' ').trim().slice(0, 100)})`)
      }
    }
  }
  return offenders
}

describe('findUnhiddenSpawns — the scanner itself', () => {
  const imp = `import { execFile, spawnSync } from 'node:child_process'\n`

  it('POSITIVE control: flags a child_process call with no windowsHide', () => {
    const src = `${imp}execFile('gh', args, { cwd, maxBuffer: 10 })`
    expect(findUnhiddenSpawns(src)).toHaveLength(1)
  })

  it('NEGATIVE control: does NOT flag a call that passes windowsHide', () => {
    const src = `${imp}execFile('gh', args, { cwd, windowsHide: true })`
    expect(findUnhiddenSpawns(src)).toEqual([])
  })

  it('NEGATIVE control: ignores SQLite `db.exec(...)` — a property call, not child_process', () => {
    const src = `${imp}db.exec('ALTER TABLE retrieval_experience ADD COLUMN propensity REAL')`
    expect(findUnhiddenSpawns(src)).toEqual([])
  })

  it('NEGATIVE control: ignores a file that never imports child_process', () => {
    const src = `execFile('gh', args, { cwd })`
    expect(findUnhiddenSpawns(src)).toEqual([])
  })

  it('resolves `as` aliases — `spawn as nodeSpawn` is still a spawner', () => {
    const src = `import { spawn as nodeSpawn } from 'node:child_process'\nnodeSpawn('x', a, { detached: true })`
    expect(findUnhiddenSpawns(src)).toHaveLength(1)
  })

  it('resolves the DI convention — a param defaulting to the real spawner counts', () => {
    const src =
      `import { execSync as nodeExecSync } from 'node:child_process'\n` +
      `export function f(cwd: string, exec: typeof nodeExecSync = nodeExecSync) {\n` +
      `  return exec('git rev-parse --show-toplevel', { cwd, encoding: 'utf8' })\n}`
    expect(findUnhiddenSpawns(src)).toHaveLength(1)
  })

  it('does NOT flag the DI parameter declaration itself — only its call sites', () => {
    const src =
      `import { execSync as nodeExecSync } from 'node:child_process'\n` +
      `export function f(exec: typeof nodeExecSync = nodeExecSync) { return exec('git', { windowsHide: true }) }`
    expect(findUnhiddenSpawns(src)).toEqual([])
  })

  it('resolves `promisify(execFile)` — the shape of the call proven to pop a window', () => {
    const src =
      `import { execFile } from 'node:child_process'\n` +
      `const execFileAsync = promisify(execFile)\n` +
      `const { stdout } = await execFileAsync('gh', args, { cwd, maxBuffer: 10 })`
    expect(findUnhiddenSpawns(src)).toHaveLength(1)
  })

  it('NEGATIVE control: a promisified call that passes windowsHide is clean', () => {
    const src =
      `import { exec } from 'node:child_process'\n` +
      `const execAsync = promisify(exec)\n` +
      `await execAsync(cmd, { timeout: 2000, windowsHide: true })`
    expect(findUnhiddenSpawns(src)).toEqual([])
  })

  it('NEGATIVE control: accepts options hoisted into a local const carrying windowsHide', () => {
    const src =
      `import { execFile } from 'node:child_process'\n` +
      `const options = { windowsHide: true }\n` +
      `execFile(command, args, options, (e, out) => resolve(out))`
    expect(findUnhiddenSpawns(src)).toEqual([])
  })

  it('POSITIVE control: a hoisted local WITHOUT windowsHide is still flagged', () => {
    const src =
      `import { execFile } from 'node:child_process'\n` +
      `const options = { timeout: 5000 }\n` +
      `execFile(command, args, options, (e, out) => resolve(out))`
    expect(findUnhiddenSpawns(src)).toHaveLength(1)
  })

  it('the fixture marker exempts a line — and ONLY the marked line', () => {
    const call = `execFile('gh', args, { cwd })`
    expect(findUnhiddenSpawns(`${imp}${call}`)).toHaveLength(1)
    expect(findUnhiddenSpawns(`${imp}${call} // ${FIXTURE_MARKER}`)).toEqual([])
    expect(findUnhiddenSpawns(`${imp}// ${FIXTURE_MARKER}\n${call}`)).toHaveLength(1)
  })

  it('POSITIVE control: flags `fork` — it cannot carry windowsHide (see SPAWNERS)', () => {
    const src =
      `import { fork } from 'node:child_process'\n` +
      `const child = fork(workerPath, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })`
    expect(findUnhiddenSpawns(src)).toHaveLength(1)
  })

  it('NEGATIVE control: the `spawn` + ipc replacement for fork is clean', () => {
    const src =
      `import { spawn } from 'node:child_process'\n` +
      `const child = spawn(process.execPath, [workerPath], {\n` +
      `  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],\n` +
      `  windowsHide: true,\n})`
    expect(findUnhiddenSpawns(src)).toEqual([])
  })

  it('POSITIVE control: `fork` is flagged even with a hoisted windowsHide option', () => {
    // Judge finding 2026-09-28 (S2-4): this compiles, because TS excess-property
    // checking does not apply to a variable reference, and the old options check
    // let it through — defeating the stated "no fork in src/" rule.
    const src =
      `import { fork } from 'node:child_process'\n` +
      `const opts = { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true }\n` +
      `const child = fork(workerPath, [], opts)`
    expect(findUnhiddenSpawns(src)).toHaveLength(1)
  })

  it('POSITIVE control: `fork` is flagged even when windowsHide is inline', () => {
    const src =
      `import { fork } from 'node:child_process'\n` +
      `const child = fork(workerPath, [], { windowsHide: true })`
    expect(findUnhiddenSpawns(src)).toHaveLength(1)
  })

  it('POSITIVE control: an aliased `fork as nodeFork` is still flagged', () => {
    const src =
      `import { fork as nodeFork } from 'node:child_process'\n` +
      `const child = nodeFork(workerPath, [], { windowsHide: true })`
    expect(findUnhiddenSpawns(src)).toHaveLength(1)
  })

  it('NEGATIVE control: flagging fork does not affect a same-file `spawn` that is compliant', () => {
    const src =
      `import { fork, spawn } from 'node:child_process'\n` +
      `spawn('git', args, { windowsHide: true })`
    expect(findUnhiddenSpawns(src)).toEqual([])
  })
})

describe('src/ never spawns a child that can open a console window', () => {
  it('every child_process call passes windowsHide', () => {
    const offenders = listTypeScriptFiles(SRC_ROOT).flatMap((file) =>
      findUnhiddenSpawns(readFileSync(file, 'utf8')).map(
        (call) => `${relative(SRC_ROOT, file)}: ${call} — add windowsHide: true`,
      ),
    )
    expect(offenders).toEqual([])
  })
})
