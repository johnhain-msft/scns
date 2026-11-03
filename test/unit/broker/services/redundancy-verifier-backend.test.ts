import { describe, it, expect, vi } from 'vitest'
import {
  parseRedundancyResponse,
  runRedundancyVerification,
  createRedundancyVerifierBackend,
} from '../../../../src/broker/services/redundancy-verifier-backend.js'
import type { SpawnVerifier, VerifierSpawnResult } from '../../../../src/broker/services/claim-verifier-backend.js'
import type { RedundancyFlag } from '../../../../src/broker/services/redundancy-flag-scanner.js'

const FLAGS: readonly RedundancyFlag[] = [{ phrase: 'duplicates', excerpt: '…duplicates assignRole…' }]

function fakeSpawn(stdout: string, over: Partial<VerifierSpawnResult> = {}): SpawnVerifier {
  return vi.fn(async () => ({ stdout, stderr: '', sessionId: 'rv-1', timedOut: false, exitCode: 0, ...over }))
}

describe('redundancy-verifier-backend', () => {
  describe('parseRedundancyResponse', () => {
    it('parses a fenced JSON verdict', () => {
      const v = parseRedundancyResponse('```json\n{"verdict":"fail","findings":["dup of assignRole"]}\n```')
      expect(v.verdict).toBe('fail')
      expect(v.findings).toEqual(['dup of assignRole'])
    })

    it('degrades malformed output to needs-explanation (never a silent pass)', () => {
      const v = parseRedundancyResponse('the model rambled with no json')
      expect(v.verdict).toBe('needs-explanation')
      expect(v.degradedReason).toBe('malformed-response')
    })

    it('maps an unrecognized verdict to needs-explanation', () => {
      const v = parseRedundancyResponse('{"verdict":"maybe"}')
      expect(v.verdict).toBe('needs-explanation')
      expect(v.degradedReason).toMatch(/unrecognized-verdict/)
    })
  })

  describe('runRedundancyVerification', () => {
    it('short-circuits to pass when disabled', async () => {
      const v = await runRedundancyVerification({ output: 'x', flags: FLAGS }, { enabled: false })
      expect(v.verdict).toBe('pass')
      expect(v.degradedReason).toBe('disabled')
    })

    it('passes when there are no flags (nothing to judge)', async () => {
      const spawn = fakeSpawn('')
      const v = await runRedundancyVerification({ output: 'x', flags: [] }, { enabled: true, spawnVerifier: spawn })
      expect(v.verdict).toBe('pass')
      expect(spawn).not.toHaveBeenCalled()
    })

    it('needs-explanation when enabled but no spawner is wired', async () => {
      const v = await runRedundancyVerification({ output: 'x', flags: FLAGS }, { enabled: true })
      expect(v.verdict).toBe('needs-explanation')
      expect(v.degradedReason).toBe('no-spawner')
    })

    it('returns the model verdict (fail) from the single spawn', async () => {
      const spawn = fakeSpawn('{"verdict":"fail","findings":["real duplicate"]}')
      const v = await runRedundancyVerification(
        { output: 'duplicates assignRole', flags: FLAGS },
        { enabled: true, spawnVerifier: spawn },
      )
      expect(v.verdict).toBe('fail')
      expect(spawn).toHaveBeenCalledTimes(1) // single-shot, non-recursive
    })

    it('clears a false positive when the model says pass', async () => {
      const spawn = fakeSpawn('{"verdict":"pass"}')
      const v = await runRedundancyVerification({ output: 'x', flags: FLAGS }, { enabled: true, spawnVerifier: spawn })
      expect(v.verdict).toBe('pass')
    })

    it('degrades a timeout to needs-explanation', async () => {
      const spawn = fakeSpawn('', { timedOut: true, exitCode: null })
      const v = await runRedundancyVerification({ output: 'x', flags: FLAGS }, { enabled: true, spawnVerifier: spawn })
      expect(v.verdict).toBe('needs-explanation')
      expect(v.degradedReason).toBe('verifier-timeout')
    })

    it('degrades a non-zero exit to needs-explanation', async () => {
      const spawn = fakeSpawn('', { exitCode: 2, stderr: 'boom' })
      const v = await runRedundancyVerification({ output: 'x', flags: FLAGS }, { enabled: true, spawnVerifier: spawn })
      expect(v.verdict).toBe('needs-explanation')
      expect(v.degradedReason).toBe('verifier-exit-nonzero')
    })

    it('degrades a thrown spawner to needs-explanation', async () => {
      const spawn: SpawnVerifier = vi.fn(async () => {
        throw new Error('spawn failed')
      })
      const v = await runRedundancyVerification({ output: 'x', flags: FLAGS }, { enabled: true, spawnVerifier: spawn })
      expect(v.verdict).toBe('needs-explanation')
      expect(v.degradedReason).toBe('spawn-failed')
    })
  })

  describe('createRedundancyVerifierBackend', () => {
    it('judges via the injected spawner (single-shot)', async () => {
      const spawn = fakeSpawn('{"verdict":"fail"}')
      const backend = createRedundancyVerifierBackend({ spawnVerifier: spawn })
      const v = await backend.judge({ output: 'duplicates X', flags: FLAGS })
      expect(v.verdict).toBe('fail')
      expect(spawn).toHaveBeenCalledTimes(1)
    })
  })
})
