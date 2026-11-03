/**
 * Regression: the meta-supervisor's default health probe must authenticate.
 *
 * Observed live on Windows 2026-09-11 (native-windows bring-up): with
 * `BROKER_TOKEN` set — which README.md prescribes as the hardened default for
 * a work machine — every child broker sat in an infinite spawn/kill loop.
 *
 * Cause: `defaultHttpProbe` calls `/api/health` with no Authorization header.
 * The auth middleware exempts `/health*` and `/api/hooks/*` only; `/api/health`
 * does NOT match the `/health` prefix, so the probe got 401, `res.ok` was
 * false, the supervisor recorded "probe returned non-OK / identity mismatch",
 * marked the child `failing`, SIGTERM'd it, and respawned it ~every 5s.
 *
 * This is not Windows-specific — it reproduces anywhere BROKER_TOKEN is set.
 * It survived because every existing supervisor test injects `cfg.httpProbe`,
 * so the real `defaultHttpProbe` had no coverage at all.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { defaultHttpProbe } from '../../../src/meta-broker/meta-supervisor.js'

const INSTANCE_ID = 'instance-abc-123'

let server: Server | null = null
const originalToken = process.env.BROKER_TOKEN

/** A child broker that enforces bearer auth on /api/health, like the real one. */
async function startTokenProtectedChild(token: string | null): Promise<number> {
  server = createServer((req, res) => {
    if (token !== null && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', instance_id: INSTANCE_ID }))
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return (server!.address() as { port: number }).port
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
  if (originalToken === undefined) delete process.env.BROKER_TOKEN
  else process.env.BROKER_TOKEN = originalToken
})

describe('defaultHttpProbe — authenticated child health probe', () => {
  it('succeeds against a token-protected child when BROKER_TOKEN is set', async () => {
    process.env.BROKER_TOKEN = 'super-secret-token'
    const port = await startTokenProtectedChild('super-secret-token')

    // Before the fix this returned false (401), causing the restart loop.
    await expect(defaultHttpProbe(port, INSTANCE_ID)).resolves.toBe(true)
  })

  it('still succeeds against a tokenless child (unchanged legacy behavior)', async () => {
    delete process.env.BROKER_TOKEN
    const port = await startTokenProtectedChild(null)

    await expect(defaultHttpProbe(port, INSTANCE_ID)).resolves.toBe(true)
  })

  it('negative control: rejects when the child echoes a different instance id', async () => {
    process.env.BROKER_TOKEN = 'super-secret-token'
    const port = await startTokenProtectedChild('super-secret-token')

    await expect(defaultHttpProbe(port, 'some-other-instance')).resolves.toBe(false)
  })

  it('negative control: rejects when the probe token is wrong', async () => {
    process.env.BROKER_TOKEN = 'wrong-token'
    const port = await startTokenProtectedChild('super-secret-token')

    await expect(defaultHttpProbe(port, INSTANCE_ID)).resolves.toBe(false)
  })
})
