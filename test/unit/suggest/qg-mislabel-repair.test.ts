/**
 * Repair of the mislabelled quality-gate rows — with the negative control that matters.
 *
 * The census's selection rule is deliberately loose (it counts anything with a `human:` reason so
 * it cannot under-report), which makes it unsafe to drive writes from directly: "human:wrong-target:
 * it targets the wrong file" is a REFUSAL and satisfies that rule. The load-bearing test here is
 * therefore the one asserting a genuine refusal is left alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyQgMislabelRepair,
  isHumanApproval,
  planQgMislabelRepair,
  applyDestinationTextRepair,
  planDestinationTextRepair,
} from '../../../src/suggest/qg-mislabel-repair.js'
import { suggestedInstructionsPath } from '../../../src/suggest/artifact-targets.js'
import { homedir } from 'node:os'
import { parseFrontmatter } from '../../../src/suggest/suggestion-file.js'

let root: string

function writeRow(status: string, id: string, frontmatter: Record<string, string>): string {
  const dir = join(root, status)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.md`)
  const lines = ['---', `id: "${id}"`, `status: "${status}"`]
  for (const [k, v] of Object.entries(frontmatter)) lines.push(`${k}: "${v}"`)
  lines.push('---', '', '## Description', '', 'body text')
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8')
  return path
}

function frontmatterOf(path: string): Record<string, unknown> {
  return parseFrontmatter(readFileSync(path, 'utf-8')).frontmatter
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scns-repair-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('qg-mislabel repair', () => {
  it('restores an approval the gate relabelled as a refusal', () => {
    // The live 65a914f4 shape: verdict erased, the approve-coded human reason left behind.
    writeRow('rejected', '65a914f4-b229-4fde-874e-c46a44dd845f', {
      reviewReason: 'human:cheap-win:',
      machineReason: 'qg-fail:tests-failed',
    })

    const report = applyQgMislabelRepair(root, { dryRun: false })
    expect(report.applied).toBe(1)
    expect(report.items[0]!.action).toBe('restore-approval')

    const moved = join(root, 'approved', '65a914f4-b229-4fde-874e-c46a44dd845f.md')
    expect(existsSync(moved)).toBe(true)
    expect(existsSync(join(root, 'rejected', '65a914f4-b229-4fde-874e-c46a44dd845f.md'))).toBe(
      false,
    )

    const fm = frontmatterOf(moved)
    expect(fm['status']).toBe('approved')
    expect(fm['reviewVerdict']).toBe('approve')
    // His words and the gate's bookkeeping both survive, in their own fields.
    expect(fm['reviewReason']).toBe('human:cheap-win:')
    expect(fm['machineReason']).toBe('qg-fail:tests-failed')
    expect(fm['repairedAt']).toBeTypeOf('string')
  })

  it('leaves a GENUINE human refusal alone even though the census counts it', () => {
    // Reachable by correct post-fix operation: approve → gate fails (machineReason survives) →
    // he later rejects for real. Promoting this to `approved` would invent a decision.
    const path = writeRow('rejected', '11111111-1111-4111-8111-111111111111', {
      reviewReason: 'human:wrong-target: it targets the wrong file',
      machineReason: 'qg-fail:tests-failed',
    })

    const plan = planQgMislabelRepair(root)
    expect(plan).toHaveLength(0)
    expect(frontmatterOf(path)['status']).toBe('rejected')
  })

  it('demotes a machine-written refusal to needs-human without claiming he approved', () => {
    writeRow('rejected', '22222222-2222-4222-8222-222222222222', {
      reviewReason: 'qg-fail:no-diff',
    })

    const report = applyQgMislabelRepair(root, { dryRun: false })
    expect(report.items[0]!.action).toBe('demote-to-needs-human')

    const moved = join(root, 'needs-human', '22222222-2222-4222-8222-222222222222.md')
    const fm = frontmatterOf(moved)
    expect(fm['status']).toBe('needs-human')
    expect(fm['escalation']).toBe('gate-exhausted')
    // The gate's string moves OUT of the human's field, and no verdict is invented.
    expect(fm['machineReason']).toBe('qg-fail:no-diff')
    expect(fm['reviewReason']).toBeUndefined()
    expect(fm['reviewVerdict']).toBeUndefined()
  })

  it('does not touch rows the gate never failed', () => {
    const path = writeRow('rejected', '33333333-3333-4333-8333-333333333333', {
      reviewReason: 'human:not-worth-it: no thanks',
    })
    expect(planQgMislabelRepair(root)).toHaveLength(0)
    expect(frontmatterOf(path)['status']).toBe('rejected')
  })

  it('defaults to a dry run that writes nothing', () => {
    const path = writeRow('rejected', '44444444-4444-4444-8444-444444444444', {
      reviewReason: 'human:cheap-win:',
      machineReason: 'qg-fail:tests-failed',
    })
    const report = applyQgMislabelRepair(root)
    expect(report.dryRun).toBe(true)
    expect(report.applied).toBe(0)
    expect(report.scanned).toBe(1)
    expect(frontmatterOf(path)['status']).toBe('rejected')
  })

  it('is idempotent — a second run finds nothing left to repair', () => {
    writeRow('rejected', '55555555-5555-4555-8555-555555555555', {
      reviewReason: 'human:cheap-win:',
      machineReason: 'qg-fail:tests-failed',
    })
    applyQgMislabelRepair(root, { dryRun: false })
    expect(planQgMislabelRepair(root)).toHaveLength(0)
  })

  it('classifies approve codes apart from reject and explain codes', () => {
    expect(isHumanApproval('human:cheap-win:')).toBe(true)
    expect(isHumanApproval('human:unblocks: I need this')).toBe(true)
    expect(isHumanApproval('human:wrong-target: nope')).toBe(false)
    expect(isHumanApproval('human:needs-explanation: what is it')).toBe(false)
    expect(isHumanApproval('qg-fail:tests-failed')).toBe(false)
    expect(isHumanApproval(null)).toBe(false)
  })
})

describe('lsp type mislabel repair', () => {
  it('retypes an lsp-tagged instruction row, at any status, without moving it', () => {
    writeRow('approved', '66666666-6666-4666-8666-666666666666', {
      type: 'instruction',
      title: 'Configure Python LSP (Pyright/Pylsp)',
      tags: 'PLACEHOLDER',
    })
    // Rewrite tags as a real YAML list — writeRow quotes every value.
    const p = join(root, 'approved', '66666666-6666-4666-8666-666666666666.md')
    writeFileSync(p, readFileSync(p, 'utf-8').replace('tags: "PLACEHOLDER"', 'tags: [lsp, python]'))

    const report = applyQgMislabelRepair(root, { dryRun: false })
    expect(report.items[0]!.action).toBe('retype-lsp')

    const fm = frontmatterOf(p)
    expect(fm['type']).toBe('lsp')
    expect(fm['status']).toBe('approved')
  })

  it('does not retype an instruction row that merely mentions lsp without a known server', () => {
    const p = writeRow('approved', '77777777-7777-4777-8777-777777777777', {
      type: 'instruction',
      title: 'Some instruction',
      tags: 'PLACEHOLDER',
    })
    writeFileSync(p, readFileSync(p, 'utf-8').replace('tags: "PLACEHOLDER"', 'tags: [lsp, cobol]'))

    expect(planQgMislabelRepair(root)).toHaveLength(0)
    expect(frontmatterOf(p)['type']).toBe('instruction')
  })
})

describe('stale destination text repair', () => {
  it('rewrites the sentence John actually read, preserving the rest of the body', () => {
    const p = writeRow('approved', '88888888-8888-4888-8888-888888888888', {
      type: 'instruction',
      title: 'Prefer single quotes',
    })
    const body = [
      '## Description',
      'Prefer single quotes.',
      '',
      '**If you approve** — Approving queues the work; files would be written under ' +
        '/Users/dev/Coding_Projects/scns_root/scns/.github/instructions. Nothing runs ' +
        'until you approve. The work would be carried out by a single agent.',
    ].join('\n')
    writeFileSync(p, readFileSync(p, 'utf-8') + '\n' + body)

    const report = applyDestinationTextRepair(root, { dryRun: false })

    expect(report.items).toHaveLength(1)
    expect(report.items[0]!.from).toBe(
      '/Users/dev/Coding_Projects/scns_root/scns/.github/instructions',
    )
    expect(report.items[0]!.to).toBe(suggestedInstructionsPath(homedir()))

    const after = readFileSync(p, 'utf-8')
    expect(after).toContain(`the file written would be ${suggestedInstructionsPath(homedir())}.`)
    expect(after).not.toContain('.github/instructions')
    // Everything around the corrected clause survives untouched.
    expect(after).toContain('Nothing runs until you approve.')
    expect(after).toContain('The work would be carried out by a single agent.')
    expect(after).toContain('Prefer single quotes.')
  })

  it('is idempotent and leaves an already-correct row alone', () => {
    const p = writeRow('approved', '99999999-9999-4999-8999-999999999999', {
      type: 'instruction',
      title: 'Already correct',
    })
    writeFileSync(
      p,
      readFileSync(p, 'utf-8') +
        `\nthe file written would be ${suggestedInstructionsPath(homedir())}. Nothing runs.\n`,
    )

    expect(planDestinationTextRepair(root)).toHaveLength(0)
  })
})

/**
 * `retype-lsp` is the one repair that runs at ANY status, so it is the one that can echo back a
 * status the row does not have. Everything here guards the blast radius of that.
 */
describe('qg-mislabel repair — rows that are not rows, and rows without a status', () => {
  function writeRaw(status: string, filename: string, body: string): string {
    const dir = join(root, status)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, filename)
    writeFileSync(path, body, 'utf-8')
    return path
  }

  const LSP_TYPED_AS_INSTRUCTION = [
    '---',
    'id: "28a7d818-fe5f-4948-84ae-6813d25e2380"',
    'type: "instruction"',
    'tags: [lsp, python]',
    '---',
    '',
    'body text',
  ].join('\n')

  it('never moves a status-less row into the store root, where nothing would ever find it again', () => {
    // The walk only descends into DIRECTORIES, so a row deposited in the root is invisible to
    // every later scan — including this tool's own. An empty `toStatus` reaching
    // `join(suggestionsDir, '')` is exactly how that happens.
    const path = writeRaw(
      'pending',
      '28a7d818-fe5f-4948-84ae-6813d25e2380.md',
      LSP_TYPED_AS_INSTRUCTION,
    )

    const plan = planQgMislabelRepair(root)
    expect(plan).toHaveLength(1)
    expect(plan[0]!.action).toBe('retype-lsp')
    expect(plan[0]!.toStatus).toBe('pending')

    const report = applyQgMislabelRepair(root, { dryRun: false })
    expect(report.applied).toBe(1)

    expect(existsSync(join(root, '28a7d818-fe5f-4948-84ae-6813d25e2380.md'))).toBe(false)
    expect(existsSync(path)).toBe(true)
    const fm = frontmatterOf(path)
    expect(fm['type']).toBe('lsp')
    expect(fm['status']).toBe('pending')
  })

  it('ignores .critique.md sidecars, which carry no status and are not suggestions', () => {
    // These live in the same directories as the rows they describe. Read as rows they are the
    // live source of status-less input.
    const sidecar = writeRaw(
      'needs-human',
      '1fe872c4-fc45-489b-a641-205f11a6f192.critique.md',
      LSP_TYPED_AS_INSTRUCTION,
    )
    const before = readFileSync(sidecar, 'utf-8')

    const report = applyQgMislabelRepair(root, { dryRun: false })

    expect(report.items).toEqual([])
    expect(report.applied).toBe(0)
    expect(report.scanned).toBe(0)
    expect(readFileSync(sidecar, 'utf-8')).toBe(before)
  })

  it('reports scanned as rows inspected, not repairs made', () => {
    writeRow('approved', 'aaaaaaaa-0000-0000-0000-000000000001', {})
    writeRow('approved', 'aaaaaaaa-0000-0000-0000-000000000002', {})
    writeRow('rejected', 'aaaaaaaa-0000-0000-0000-000000000003', {
      reviewReason: 'human:cheap-win:',
      machineReason: 'qg-fail:tests-failed',
    })
    // Unreadable rows were still examined and must still be counted.
    writeRaw('pending', 'aaaaaaaa-0000-0000-0000-000000000004.md', 'not frontmatter at all')

    const report = applyQgMislabelRepair(root, { dryRun: true })

    expect(report.items).toHaveLength(1)
    expect(report.scanned).toBe(4)
  })
})
