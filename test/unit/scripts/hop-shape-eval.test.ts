/**
 * Step 2 (D2) — the OFFLINE hop-shape evaluation harness (`scripts/hop-shape-eval.ts`) end to end:
 * spawn it against a seeded temp store and check it prints the same routing section the weekly
 * review renders, plus the JSON summary, without writing to the store.
 *
 * Spawns `npx tsx` (the documented invocation). Generous timeout: cold tsx + the src graph is ~2–4 s
 * idle and the QG tests-gate runs this suite under agent load.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openExperienceStore } from '../../../src/memory/experience-store.js'
import { resolveBinScript } from '../../helpers/node-bin.js'

const SCRIPT = resolve(__dirname, '../../../scripts/hop-shape-eval.ts')
// Invoke tsx's JS entry with the current node binary instead of `npx tsx`:
// on win32 `npx` is npx.cmd, which execFileSync cannot spawn without a shell.
// Resolved from tsx's own `bin` field rather than a hardcoded dist/ path, so a
// layout change upstream surfaces as a named error instead of ENOENT.
const TSX_CLI = resolveBinScript(resolve(__dirname, '../../..'), 'tsx')
const SINGLE = 'continue'
const MULTI = 'why is the brains consolidate branch the reason for the starvation?'

let dir: string
let dbPath: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'scns-hop-eval-'))
  dbPath = join(dir, 'experience.db')
  const store = openExperienceStore(dbPath)
  const ins = store.db.prepare(
    `INSERT INTO retrieval_experience (query_text, retriever, explore_arm, human_outcome, propensity)
     VALUES (?, 'magma', ?, ?, 0.5)`,
  )
  for (let i = 0; i < 6; i++) ins.run(SINGLE, 'magma', i < 5 ? 1.0 : 0.2)
  for (let i = 0; i < 4; i++) ins.run(SINGLE, 'multihop-iter', i < 1 ? 1.0 : 0.2)
  for (let i = 0; i < 4; i++) ins.run(MULTI, 'multihop-iter', 1.0)
  for (let i = 0; i < 4; i++) ins.run(MULTI, 'magma', 0.2)
  for (let i = 0; i < 3; i++) ins.run(SINGLE, 'magma', null)
  store.close()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(args: readonly string[]): string {
  return execFileSync(process.execPath, [TSX_CLI, SCRIPT, dbPath, ...args], {
    encoding: 'utf-8',
    timeout: 120_000,
    env: { ...process.env, SCNS_HOME: dir },
  })
}

describe('scripts/hop-shape-eval.ts — offline, read-only, same renderer as the weekly review', () => {
  it('prints the routing section with per-shape numbers, agreement, and the cutover bar', () => {
    const before = readFileSync(dbPath)
    const out = run(['--json', '--show', '2', '--settled-only'])
    expect(out).toContain('Routing accuracy — was each query sent to the tool its shape required?')
    expect(out).toMatch(/single-hop \(calls for magma\): 10 settled of 13 served/)
    expect(out).toMatch(/multi-hop \(calls for multihop-iter\): 8 settled of 8 served/)
    // stratified: single-hop magma 5/6=0.83 vs mh 1/4=0.25 ⇒ 0.79 (w=10/18);
    //             multi-hop mh 4/4=1.00 vs magma 0/4=0.00 ⇒ 1.00 (w=8/18) ⇒ 0.884 → 0.88 on n=18
    expect(out).toMatch(/Classifier-vs-outcome agreement: 0\.88 \(over 18 comparable settled rows/)
    expect(out).toMatch(/Today: lower bound 0\.\d\d on n=18 — bar NOT met/)
    // samples with typed reasons
    expect(out).toMatch(/=== single-hop: 10 row\(s\) \(settled only\)/)
    expect(out).toMatch(/\[short-directive\] continue/)
    // JSON summary
    const json = JSON.parse(out.slice(out.lastIndexOf('\n{'))) as {
      classifierVersion: string
      agreement: { n: number; agreeAccept: number; agreeWaste: number }
      cutover: { met: boolean; minClassified: number }
    }
    expect(json.classifierVersion).toMatch(/^heuristic-v\d+$/)
    expect(json.agreement).toMatchObject({ n: 18, agreeAccept: 9, agreeWaste: 7 })
    expect(json.cutover).toMatchObject({ met: false, minClassified: 100 })
    // read-only: byte-identical store
    expect(readFileSync(dbPath).equals(before)).toBe(true)
  })

  it('exits non-zero with an honest message when the store does not exist', () => {
    let code = 0
    let out = ''
    try {
      out = execFileSync(process.execPath, [TSX_CLI, SCRIPT, join(dir, 'nope.db')], {
        encoding: 'utf-8',
        timeout: 120_000,
        env: { ...process.env, SCNS_HOME: dir },
      })
    } catch (err) {
      const e = err as { status?: number; stdout?: string }
      code = e.status ?? 1
      out = e.stdout ?? ''
    }
    expect(code).toBe(2)
    expect(out).toContain('no experience store at')
  })
})
