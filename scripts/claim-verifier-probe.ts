/* eslint-disable no-console */
/**
 * Claim-evidence verifier probe (Track 1 / 1B harness).
 *
 * A reusable, committed probe for the blind go-live test loop — replaces the
 * throwaway /tmp runners used in the first two sessions. Runs the SAME
 * `verifyClaimEvidence` the live quality-gate uses.
 *
 * Usage (tsx is the repo's .ts runner — see docs/evidence/*.RAW.md):
 *   npx tsx scripts/claim-verifier-probe.ts <file.md>          # deterministic verdict on a file
 *   cat report.md | npx tsx scripts/claim-verifier-probe.ts -  # deterministic verdict on stdin
 *   npx tsx scripts/claim-verifier-probe.ts --strip-disclaimer <file.md>
 *                                                              # positive control:
 *                                                              # remove code-only hedges,
 *                                                              # expect the SAME claims to FAIL
 *   npx tsx scripts/claim-verifier-probe.ts --fixtures         # run the DETERMINISTIC corpus
 *                                                              # (test/fixtures/claim-verifier)
 *   npx tsx scripts/claim-verifier-probe.ts --reverify <file|-> # producer≠verifier SPAWN:
 *                                                              # a real independent agent RE-RUNS
 *                                                              # each cited probe and confirms the
 *                                                              # quoted row (execution-grounded).
 *   npx tsx scripts/claim-verifier-probe.ts --reverify --fixtures
 *                                                              # run the SPAWN over the re-verifiable
 *                                                              # corpus subset (fixtures with a
 *                                                              # `reverify_expected`) — the corpus is
 *                                                              # the SHARED eval set for both the
 *                                                              # deterministic pre-filter AND the spawn.
 *
 * Broker contact: --reverify spawns route SCNS_BROKER_URL to SCNS_ISO_BROKER_URL
 * (else a dead local port) so the verifier never briefs against the singleton :3456.
 *
 * Blind-test protocol: capture a REAL agent output, PRE-REGISTER your predicted
 * verdict/flags (expected.json `expected` for the core, `reverify_expected` for the
 * spawn), THEN run this and compare. If not close, iterate the verifier against the
 * whole fixtures corpus at once (build-from-data, measure once).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyClaimEvidence } from '../src/broker/services/claim-evidence-verifier.js'
import {
  runClaimReverification,
  createDefaultVerifierSpawner,
} from '../src/broker/services/claim-verifier-backend.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(HERE, '..', 'test', 'fixtures', 'claim-verifier')

/** Remove document-level code-only hedges to simulate a bare-fact overclaim. */
function stripDisclaimer(text: string): string {
  const hedge =
    /code-only|code-traced|static\s+(investigation|read|analysis)|not\s+a\s+live\s+\w+\s+run|broker\s+was\s+not\s+run|read-only\s+\w*\s*investigation|inferred|\[code|evidence\s+level:/i
  return text
    .split('\n')
    .filter((l) => !hedge.test(l))
    .join('\n')
}

function report(label: string, text: string): void {
  const v = verifyClaimEvidence(text)
  console.log(`\n=== ${label} ===`)
  console.log(`verdict: ${v.kind}   claims: ${v.claims.length}   flagged: ${v.findings.length}`)
  for (const c of v.claims) {
    console.log(`  [${c.label ?? 'unlabeled'} ev=${c.hasQuotedEvidence}] ${c.text.slice(0, 110)}`)
  }
  for (const f of v.findings) console.log(`  ! ${f.slice(0, 130)}`)
}

function runFixtures(): void {
  const expected = JSON.parse(readFileSync(join(FIXTURES_DIR, 'expected.json'), 'utf8')) as Record<
    string,
    { expected?: string }
  >
  let pass = 0
  let fail = 0
  for (const file of readdirSync(FIXTURES_DIR).sort()) {
    if (!file.endsWith('.md')) continue
    const text = readFileSync(join(FIXTURES_DIR, file), 'utf8')
    const got = verifyClaimEvidence(text).kind
    const want = expected[file]?.expected ?? '(unlisted)'
    const ok = got === want
    console.log(`${ok ? 'OK  ' : 'MISS'}  ${file}: got=${got} want=${want}`)
    if (ok) pass++
    else fail++
  }
  console.log(`\nfixtures: ${pass} ok, ${fail} miss`)
  if (fail > 0) process.exitCode = 1
}

/** The REAL producer≠verifier spawn (copilot one-shot, read-only tools), routed off :3456. */
function makeReverifier() {
  return createDefaultVerifierSpawner({
    command: 'copilot',
    args: ['--allow-all-tools', '-p'],
    env: {
      ...process.env,
      SCNS_BROKER_URL: process.env.SCNS_ISO_BROKER_URL ?? 'http://127.0.0.1:59999',
    } as NodeJS.ProcessEnv,
  })
}

async function reverifyOne(label: string, text: string): Promise<string> {
  const v = await runClaimReverification(
    { output: text },
    { enabled: true, spawnVerifier: makeReverifier(), timeoutMs: 170_000 },
  )
  console.log(`\n=== ${label} (reverify) ===`)
  console.log(
    `verdict: ${v.verdict}   perClaim: ${v.perClaim.length}` +
      (v.degradedReason ? `   degraded: ${v.degradedReason}` : ''),
  )
  for (const p of v.perClaim) {
    console.log(
      `  [reran=${p.reran} corroborated=${p.corroborated}] probe=${p.probe ?? '—'}` +
        (p.note ? `\n     note: ${p.note.slice(0, 160)}` : ''),
    )
  }
  for (const f of v.findings) console.log(`  ! ${f.slice(0, 180)}`)
  return v.verdict
}

async function runReverifyFixtures(): Promise<void> {
  const expected = JSON.parse(readFileSync(join(FIXTURES_DIR, 'expected.json'), 'utf8')) as Record<
    string,
    { reverify_expected?: string }
  >
  let pass = 0
  let miss = 0
  for (const file of readdirSync(FIXTURES_DIR).sort()) {
    if (!file.endsWith('.md')) continue
    const want = expected[file]?.reverify_expected
    if (!want) continue // only fixtures with a pre-registered re-verify expectation
    const text = readFileSync(join(FIXTURES_DIR, file), 'utf8')
    const got = await reverifyOne(file, text)
    const ok = got === want
    console.log(`${ok ? 'OK  ' : 'MISS'}  ${file}: reverify got=${got} want=${want}`)
    if (ok) pass++
    else miss++
  }
  console.log(`\nreverify fixtures: ${pass} ok, ${miss} miss`)
  if (miss > 0) process.exitCode = 1
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const reverify = args.includes('--reverify')
  const fixtures = args.includes('--fixtures')

  if (reverify && fixtures) return runReverifyFixtures()
  if (fixtures) return runFixtures()

  const strip = args.includes('--strip-disclaimer')
  const target = args.find((a) => !a.startsWith('--'))
  if (!target) {
    console.error(
      'usage: claim-verifier-probe.ts [--strip-disclaimer] <file|-> | --fixtures | --reverify <file|-> | --reverify --fixtures',
    )
    process.exitCode = 2
    return
  }
  const raw = target === '-' ? readFileSync(0, 'utf8') : readFileSync(target, 'utf8')
  if (reverify) {
    await reverifyOne(target, strip ? stripDisclaimer(raw) : raw)
    return
  }
  report(strip ? 'stripped (positive control)' : 'as-is', strip ? stripDisclaimer(raw) : raw)
}

void main()
