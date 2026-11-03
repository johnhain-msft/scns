import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { execSync } from 'node:child_process'

const RUNNER = join(homedir(), '.copilot', 'skills', 'browser-automation', 'run.mjs')

async function loadRunner(): Promise<any> {
  if (!existsSync(RUNNER)) return null
  return await import(/* @vite-ignore */ RUNNER)
}

describe('browser-automation skill runner', () => {
  describe('parsePlan', () => {
    it('parses a valid plan', async () => {
      const mod = await loadRunner()
      if (!mod) return
      const plan = mod.parsePlan(
        JSON.stringify({
          runId: 'abc',
          steps: [{ op: 'navigate', url: 'https://example.com' }],
        }),
      )
      expect(plan.runId).toBe('abc')
      expect(plan.steps).toHaveLength(1)
    })

    it('rejects non-JSON', async () => {
      const mod = await loadRunner()
      if (!mod) return
      expect(() => mod.parsePlan('<not json>')).toThrow(/invalid JSON/)
    })

    it('rejects empty steps', async () => {
      const mod = await loadRunner()
      if (!mod) return
      expect(() => mod.parsePlan(JSON.stringify({ steps: [] }))).toThrow(/non-empty array/)
    })

    it('rejects unknown ops', async () => {
      const mod = await loadRunner()
      if (!mod) return
      expect(() =>
        mod.parsePlan(JSON.stringify({ steps: [{ op: 'rm-rf', path: '/' }] })),
      ).toThrow(/op must be one of/)
    })

    it('rejects >50 steps', async () => {
      const mod = await loadRunner()
      if (!mod) return
      const steps = Array.from({ length: 51 }, () => ({ op: 'navigate', url: 'https://x.y' }))
      expect(() => mod.parsePlan(JSON.stringify({ steps }))).toThrow(/capped at 50/)
    })

    it('defaults runId to a timestamp when missing', async () => {
      const mod = await loadRunner()
      if (!mod) return
      const plan = mod.parsePlan(
        JSON.stringify({ steps: [{ op: 'navigate', url: 'https://x.y' }] }),
      )
      expect(plan.runId).toMatch(/^run-\d+/)
    })
  })

  describe('resolveSafeRelative', () => {
    it('allows paths inside run dir', async () => {
      const mod = await loadRunner()
      if (!mod) return
      const r = mod.resolveSafeRelative('/tmp/run-x', 'sub/a.png')
      expect(r).toBe('/tmp/run-x/sub/a.png')
    })

    it('refuses parent escapes', async () => {
      const mod = await loadRunner()
      if (!mod) return
      expect(() => mod.resolveSafeRelative('/tmp/run-x', '../leak.txt')).toThrow(/escapes run dir/)
    })

    it('refuses absolute paths', async () => {
      const mod = await loadRunner()
      if (!mod) return
      expect(() => mod.resolveSafeRelative('/tmp/run-x', '/etc/passwd')).toThrow(/escapes run dir/)
    })
  })

  describe('runPlan (forced stub mode)', () => {
    it('writes plan.json, log.jsonl, final-state.json inside run dir', async () => {
      const mod = await loadRunner()
      if (!mod) return
      const runDir = mkdtempSync(join(tmpdir(), 'scns-bskill-'))
      try {
        const summary = await mod.runPlan(
          { runId: 'test-run', title: null, steps: [{ op: 'navigate', url: 'https://example.com' }] },
          runDir,
          { loader: async () => null },
        )
        expect(summary.mode).toBe('stub')
        expect(existsSync(join(runDir, 'plan.json'))).toBe(true)
        expect(existsSync(join(runDir, 'log.jsonl'))).toBe(true)
        expect(existsSync(join(runDir, 'final-state.json'))).toBe(true)
        const final = JSON.parse(readFileSync(join(runDir, 'final-state.json'), 'utf-8'))
        expect(final.mode).toBe('stub')
        expect(final.runId).toBe('test-run')
      } finally {
        rmSync(runDir, { recursive: true, force: true })
      }
    }, 15_000)

    it('records an error in final-state when a step fails', async () => {
      const mod = await loadRunner()
      if (!mod) return
      const runDir = mkdtempSync(join(tmpdir(), 'scns-bskill-err-'))
      try {
        const summary = await mod.runPlan(
          { runId: 'err-run', title: null, steps: [{ op: 'navigate' }] },
          runDir,
          { loader: async () => null },
        )
        expect(summary.error).toMatch(/navigate requires url/)
      } finally {
        rmSync(runDir, { recursive: true, force: true })
      }
    })
  })

  describe('integration via stdin (real process)', () => {
    it('writes artifacts when invoked as a subprocess', () => {
      if (!existsSync(RUNNER)) return
      const runDir = mkdtempSync(join(tmpdir(), 'scns-bskill-proc-'))
      try {
        execSync(`node ${JSON.stringify(RUNNER)}`, {
          input: JSON.stringify({
            runId: 'proc-run',
            steps: [{ op: 'navigate', url: 'https://example.com' }],
          }),
          env: { ...process.env, SCNS_BROWSER_RUN_DIR: runDir },
          timeout: 30_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        expect(existsSync(join(runDir, 'plan.json'))).toBe(true)
        expect(existsSync(join(runDir, 'final-state.json'))).toBe(true)
      } finally {
        rmSync(runDir, { recursive: true, force: true })
      }
    }, 30_000)
  })
})
