/**
 * Contract for the repository CI/CD pipeline, `.github/workflows/ci.yml`.
 *
 * DEFECT (2026-09-21): scns had no CI. The one workflow in the repo,
 * `windows-smoke.yml`, is `continue-on-error: true` and says so in its own
 * header — "Advisory only — a red run must not block a merge" — and it fires
 * only on `pull_request` / `workflow_dispatch`. Consequences, all of them
 * silent:
 *
 *   - `lint`, `format:check` and `typecheck` were never run by any automation,
 *     despite all three existing as npm scripts;
 *   - the 37 integration suites were never run by any automation;
 *   - nothing whatsoever ran on a push to `main`, so a broken merge was only
 *     discovered by the next person to run the suite locally.
 *
 * These tests pin the properties of the pipeline that are cheap to lose in a
 * later edit and expensive to notice once lost. They deliberately assert
 * STRUCTURE (parsed YAML), not substrings, so a reformat does not fail them
 * and a semantic regression does.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'

const REPO_ROOT = resolve(__dirname, '../../..')
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows')
const CI_WORKFLOW = join(WORKFLOW_DIR, 'ci.yml')

interface WorkflowStep {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly with?: Record<string, unknown>
}

interface WorkflowJob {
  readonly 'runs-on'?: unknown
  readonly 'continue-on-error'?: unknown
  readonly 'timeout-minutes'?: unknown
  readonly if?: unknown
  readonly needs?: unknown
  readonly strategy?: { readonly matrix?: Record<string, unknown> }
  readonly steps?: readonly WorkflowStep[]
}

interface Workflow {
  readonly name?: string
  // `on` survives as a string key: js-yaml 4 follows YAML 1.2 core, where
  // `on` is NOT a boolean (it was under the YAML 1.1 rules js-yaml 3 used).
  readonly on?: Record<string, unknown>
  readonly concurrency?: { readonly group?: unknown; readonly 'cancel-in-progress'?: unknown }
  readonly jobs?: Record<string, WorkflowJob>
}

function loadWorkflow(file: string): Workflow {
  return load(readFileSync(file, 'utf8')) as Workflow
}

function jobEntries(wf: Workflow): ReadonlyArray<readonly [string, WorkflowJob]> {
  return Object.entries(wf.jobs ?? {})
}

function stepsOf(job: WorkflowJob): readonly WorkflowStep[] {
  return job.steps ?? []
}

function allSteps(wf: Workflow): readonly WorkflowStep[] {
  return jobEntries(wf).flatMap(([, job]) => stepsOf(job))
}

function runScriptsOf(job: WorkflowJob): readonly string[] {
  return stepsOf(job)
    .flatMap((step) => [...(step.run ?? '').matchAll(/\bnpm run ([\w:-]+)/g)])
    .map((match) => match[1]!)
}

/** Major versions declared supported by `package.json#engines.node`. */
function declaredNodeMajors(): readonly number[] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    engines?: { node?: string }
  }
  const range = pkg.engines?.node ?? ''
  return [...range.matchAll(/\^(\d+)\./g)].map((match) => Number(match[1]))
}

function packageScriptNames(): ReadonlySet<string> {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  return new Set(Object.keys(pkg.scripts ?? {}))
}

/** Every workflow file in `.github/workflows`, as absolute paths. */
function workflowFiles(): readonly string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => join(WORKFLOW_DIR, file))
}

describe('ci.yml — the pipeline exists and parses', () => {
  it('is present at .github/workflows/ci.yml', () => {
    expect(existsSync(CI_WORKFLOW)).toBe(true)
  })

  it('parses as a workflow with a name, triggers and jobs', () => {
    const wf = loadWorkflow(CI_WORKFLOW)

    expect(typeof wf.name).toBe('string')
    expect(wf.on).toBeTypeOf('object')
    expect(Object.keys(wf.jobs ?? {}).length).toBeGreaterThan(0)
  })
})

describe('ci.yml — triggers', () => {
  it('runs on pushes to main, not just on pull requests', () => {
    const push = loadWorkflow(CI_WORKFLOW).on?.push as { branches?: string[] } | undefined

    expect(push?.branches).toContain('main')
  })

  it('runs on pull requests targeting main', () => {
    const pr = loadWorkflow(CI_WORKFLOW).on?.pull_request as { branches?: string[] } | undefined

    expect(pr?.branches).toContain('main')
  })

  it('can be dispatched by hand for an ad-hoc run', () => {
    expect(Object.keys(loadWorkflow(CI_WORKFLOW).on ?? {})).toContain('workflow_dispatch')
  })

  it('cancels superseded runs on the same ref so a push storm costs one run', () => {
    const { concurrency } = loadWorkflow(CI_WORKFLOW)

    expect(typeof concurrency?.group).toBe('string')
    expect(concurrency?.['cancel-in-progress']).toBe(true)
  })
})

describe('ci.yml — it is a blocking gate, unlike windows-smoke', () => {
  it('marks no job advisory with continue-on-error', () => {
    const advisory = jobEntries(loadWorkflow(CI_WORKFLOW))
      .filter(([, job]) => job['continue-on-error'] === true)
      .map(([id]) => id)

    expect(advisory).toEqual([])
  })

  it('marks no individual step advisory with continue-on-error', () => {
    const advisory = allSteps(loadWorkflow(CI_WORKFLOW)).filter(
      (step) => (step as { 'continue-on-error'?: unknown })['continue-on-error'] === true,
    )

    expect(advisory).toEqual([])
  })

  it('still leaves windows-smoke advisory — this suite does not promote it', () => {
    const smoke = loadWorkflow(join(WORKFLOW_DIR, 'windows-smoke.yml'))
    const advisory = jobEntries(smoke).every(([, job]) => job['continue-on-error'] === true)

    expect(advisory).toBe(true)
  })
})

describe('ci.yml — static checks that previously ran nowhere', () => {
  it('runs lint and typecheck in a single quality job', () => {
    const quality = loadWorkflow(CI_WORKFLOW).jobs?.quality

    expect(quality).toBeDefined()
    expect(runScriptsOf(quality!)).toEqual(expect.arrayContaining(['lint', 'typecheck']))
  })

  it('enforces formatting incrementally, not repo-wide', () => {
    // Measured 2026-09-21: repo-wide `format:check` reported issues in 350 of
    // the 1049 `.ts` files under src/ and test/. A blocking repo-wide job
    // would therefore have been red on its first run for reasons no
    // contributor introduced. The gate checks the files a change touches.
    const scripts = runScriptsOf(loadWorkflow(CI_WORKFLOW).jobs!.quality!)

    expect(scripts).toContain('format:check:changed')
    expect(scripts).not.toContain('format:check')
  })

  it('keeps repo-wide format:check available for retiring the backlog', () => {
    expect(packageScriptNames()).toContain('format:check')
  })

  it('gives the quality job the history its base-ref diff needs', () => {
    // `format:check:changed` diffs against a base commit; the default shallow
    // checkout does not contain one, and the gate would silently skip forever.
    const checkout = stepsOf(loadWorkflow(CI_WORKFLOW).jobs!.quality!).find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    )

    expect(checkout?.with?.['fetch-depth']).toBe(0)
  })
})

describe('ci.yml — the test job', () => {
  it('builds before testing, so the asset/native pipeline is covered too', () => {
    const test = loadWorkflow(CI_WORKFLOW).jobs?.test

    expect(test).toBeDefined()
    expect(runScriptsOf(test!)).toContain('build')
  })

  it('runs unit AND integration suites', () => {
    const scripts = runScriptsOf(loadWorkflow(CI_WORKFLOW).jobs!.test!)

    expect(scripts).toEqual(expect.arrayContaining(['test:unit', 'test:integration']))
  })

  it('exercises every Node major package.json#engines claims to support', () => {
    // A supported-range claim that no job runs is a promise to users that
    // nothing checks. Assert the set, not a count: adding `^26` to engines
    // must fail here until the matrix grows to match.
    const matrix = loadWorkflow(CI_WORKFLOW).jobs?.test?.strategy?.matrix
    const versions = (matrix?.['node-version'] as unknown[] | undefined) ?? []

    expect([...versions].map(Number).sort((a, b) => a - b)).toEqual(
      [...declaredNodeMajors()].sort((a, b) => a - b),
    )
  })

  it('does not fail-fast, so one bad Node major does not hide the others', () => {
    const strategy = loadWorkflow(CI_WORKFLOW).jobs?.test?.strategy as
      | { 'fail-fast'?: unknown }
      | undefined

    expect(strategy?.['fail-fast']).toBe(false)
  })
})

describe('ci.yml — the release job (the CD half)', () => {
  it('exists and publishes the built dist as a retrievable artifact', () => {
    const release = loadWorkflow(CI_WORKFLOW).jobs?.release

    expect(release).toBeDefined()
    expect(runScriptsOf(release!)).toContain('build')
    expect(
      stepsOf(release!).some((step) => step.uses?.startsWith('actions/upload-artifact@')),
    ).toBe(true)
  })

  it('waits for quality and test rather than shipping an unverified build', () => {
    const needs = loadWorkflow(CI_WORKFLOW).jobs?.release?.needs

    expect(needs).toEqual(expect.arrayContaining(['quality', 'test']))
  })

  it('is gated on a tag or a manual dispatch, so ordinary pushes do not release', () => {
    const release = loadWorkflow(CI_WORKFLOW).jobs?.release

    expect(typeof release?.if).toBe('string')
    expect(release!.if as string).toMatch(/refs\/tags\/|workflow_dispatch/)
  })
})

describe('every workflow — a hung job cannot hold a runner for six hours', () => {
  /**
   * DEFECT (2026-09-21): no job in either workflow declared `timeout-minutes`, so every job
   * inherited GitHub's 360-minute default. This is not hypothetical here — the very change that
   * introduced this pipeline shipped a test file whose first case exceeded vitest's 10s budget
   * (`test/unit/scripts/format-check-changed.test.ts`, measured 12.6s under worker contention).
   * A test that hangs rather than merely overruns pins a runner for six hours, five times over
   * on the Node matrix, and the run still has to be cancelled by hand.
   *
   * A bound that is generous but finite turns "hung forever" into "red in minutes".
   */
  it('gives every job an explicit timeout-minutes', () => {
    const unbounded = workflowFiles().flatMap((file) =>
      jobEntries(loadWorkflow(file))
        .filter(([, job]) => typeof job['timeout-minutes'] !== 'number')
        .map(([id]) => `${id} (${file})`),
    )

    expect(unbounded).toEqual([])
  })

  it('keeps every timeout well under GitHub\u2019s 360-minute default', () => {
    // A timeout set to the default it is meant to replace buys nothing.
    const timeouts = workflowFiles().flatMap((file) =>
      jobEntries(loadWorkflow(file)).map(([, job]) => job['timeout-minutes'] as number),
    )

    expect(timeouts.length).toBeGreaterThan(0)
    for (const minutes of timeouts) {
      expect(minutes).toBeGreaterThan(0)
      expect(minutes).toBeLessThan(360)
    }
  })
})

describe('every workflow — reproducible, cached, pinned', () => {
  it('installs with `npm ci`, never `npm install`, so the lockfile is honoured', () => {
    const loose = workflowFiles().flatMap((file) =>
      allSteps(loadWorkflow(file))
        .map((step) => step.run ?? '')
        .filter((run) => /\bnpm (install|i)\b/.test(run))
        .map((run) => `${file}: ${run.trim()}`),
    )

    expect(loose).toEqual([])
  })

  it('only invokes npm scripts that package.json actually defines', () => {
    // A renamed script turns into a red run nobody predicted; catch it here,
    // where the rename happens, instead of on the next push.
    const known = packageScriptNames()
    const missing = workflowFiles().flatMap((file) =>
      jobEntries(loadWorkflow(file))
        .flatMap(([, job]) => runScriptsOf(job))
        .filter((script) => !known.has(script))
        .map((script) => `${file}: npm run ${script}`),
    )

    expect(missing).toEqual([])
  })

  it('pins every action to a major version tag', () => {
    const unpinned = workflowFiles().flatMap((file) =>
      allSteps(loadWorkflow(file))
        .map((step) => step.uses)
        .filter((uses): uses is string => typeof uses === 'string')
        .filter((uses) => !/@v\d+/.test(uses))
        .map((uses) => `${file}: ${uses}`),
    )

    expect(unpinned).toEqual([])
  })

  it('caches the npm store in ci.yml so `npm ci` is not a cold download each job', () => {
    const setupNode = allSteps(loadWorkflow(CI_WORKFLOW)).filter((step) =>
      step.uses?.startsWith('actions/setup-node@'),
    )

    expect(setupNode.length).toBeGreaterThan(0)
    for (const step of setupNode) {
      expect(step.with?.cache).toBe('npm')
    }
  })
})
