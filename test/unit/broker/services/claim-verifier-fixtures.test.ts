/**
 * Track 1 / 1B — regression corpus. Runs the claim-evidence verifier over REAL
 * captured agent outputs (test/fixtures/claim-verifier) and asserts the verdict
 * in expected.json. This is the shared eval set: when tuning the verifier
 * (or replacing the deterministic core with the LLM semantic verifier), tune
 * against this whole corpus at once rather than reactively per example.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyClaimEvidence } from '../../../../src/broker/services/claim-evidence-verifier.js'

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/claim-verifier',
)

const expected = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'expected.json'), 'utf8'),
) as Record<string, { expected?: string; why?: string }>

describe('claim-evidence verifier — real-output regression corpus', () => {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.md'))

  it('has an expected verdict for every fixture', () => {
    for (const f of files) expect(expected[f]?.expected, `missing expected for ${f}`).toBeDefined()
  })

  for (const file of files) {
    it(`${file} → ${expected[file]?.expected}`, () => {
      const text = readFileSync(join(FIXTURES_DIR, file), 'utf8')
      expect(verifyClaimEvidence(text).kind).toBe(expected[file]!.expected)
    })
  }
})
