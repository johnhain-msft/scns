/**
 * Doc-drift guard (#53 AC6, carried from #47 §6).
 *
 * `docs/copilot-integration.md` claimed the extension exposed 4 tools while
 * `tool-definitions.ts` defined 19, and documented the broker on port 4100
 * while the code default is 3456. Both were wrong for long enough that a
 * reader could not tell. Prose cannot be trusted to stay in sync by good
 * intentions, so the few load-bearing numbers are pinned here: change the
 * code, and this test tells you which document to update.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TOOL_DEFINITIONS } from '../../../src/copilot-extension/tool-definitions.js'
import { DEFAULTS } from '../../../src/broker/config.js'
import type { DoctorDeps } from '../../../src/cli/doctor.js'

/** Fully stubbed deps: runDoctor here must not touch the real machine. */
function doctorProbeDeps(): DoctorDeps {
  return {
    nodeVersion: 'v20.10.0',
    packageRoot: '/repo',
    scnsHome: '/home/dev',
    homedir: '/home/dev',
    cwd: '/repo',
    env: {},
    existsSync: () => true,
    readFileSync: () => 'const BROKER_TOKEN = null;',
    listDir: () => ['model'],
    probeWritable: () => true,
    loadNativeModules: () => ({ ok: true, detail: 'ok' }),
    httpGet: async () => ({ status: 200, body: '{"resolved":true,"projectId":"demo"}' }),
  } as unknown as DoctorDeps
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const doc = readFileSync(join(repoRoot, 'docs', 'copilot-integration.md'), 'utf8')
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')

describe('docs/copilot-integration.md stays true to the code', () => {
  it('states the real tool count', () => {
    expect(doc).toContain(`**${TOOL_DEFINITIONS.length}** tools exposed`)
  })

  it('names every tool that is actually defined', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(doc, `${tool.name} missing from docs/copilot-integration.md`).toContain(
        `\`${tool.name}\``,
      )
    }
  })

  it('does not document a tool that no longer exists', () => {
    const documented = [...doc.matchAll(/`(scns_[a-z_]+)`/g)].map((m) => m[1])
    const defined = new Set(TOOL_DEFINITIONS.map((t) => t.name))
    for (const name of new Set(documented)) {
      expect(defined.has(name!), `${name} is documented but not defined`).toBe(true)
    }
  })

  it('uses the code default broker port, not a stale one', () => {
    expect(doc).toContain(`localhost:${DEFAULTS.port}`)
    expect(doc).not.toContain('4100')
  })
})

describe('README stays true to the code', () => {
  it('quotes the real tool count', () => {
    expect(readme).toContain(`${TOOL_DEFINITIONS.length} tools`)
  })

  it('quotes the real default broker port', () => {
    expect(readme).toContain(String(DEFAULTS.port))
  })

  it('does not tell the reader every doctor line must be [OK]', () => {
    // `strict-mode` and `unattended-actions` emit [info] BY DESIGN, and
    // `embedding-cache` can legitimately [WARN]. The old README said every
    // line must be [OK], which made a correct install look broken.
    expect(readme).not.toMatch(/[Ee]very line must be `?\[OK\]/)
  })

  it('states the real number of doctor checks and names each one', async () => {
    // Caught in review of this very change: the README said "Eleven checks"
    // while listing twelve, because `unattended-actions` was added and the
    // prose was not. Derive the count from runDoctor itself.
    const { runDoctor } = await import('../../../src/cli/doctor.js')
    const report = await runDoctor(doctorProbeDeps())
    const words = [
      'Zero',
      'One',
      'Two',
      'Three',
      'Four',
      'Five',
      'Six',
      'Seven',
      'Eight',
      'Nine',
      'Ten',
      'Eleven',
      'Twelve',
      'Thirteen',
      'Fourteen',
      'Fifteen',
    ]
    expect(readme).toContain(`${words[report.checks.length]} checks run`)
    for (const c of report.checks) {
      expect(readme, `doctor check ${c.id} is not named in the README`).toContain(`\`${c.id}\``)
    }
  })
})
