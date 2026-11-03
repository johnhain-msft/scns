#!/usr/bin/env node
/*
 * Compile the launchd socket-activation shim (native/scns-socket-launch.c).
 *
 * macOS only. Best-effort: on non-darwin, or when a C compiler is unavailable,
 * this is a no-op so the JS build still succeeds — the broker then simply falls
 * back to port binding (listen(port)) without socket activation.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url))) // scripts/ → repo root

if (process.platform !== 'darwin') {
  console.log('[build-native] non-darwin platform — skipping launchd socket shim')
  process.exit(0)
}

const src = join(root, 'native', 'scns-socket-launch.c')
if (!existsSync(src)) {
  console.log(`[build-native] source not found (${src}) — skipping`)
  process.exit(0)
}

const outDir = join(root, 'dist', 'native')
const out = join(outDir, 'scns-socket-launch')

try {
  mkdirSync(outDir, { recursive: true })
  execFileSync('cc', ['-O2', '-Wall', '-o', out, src], { stdio: 'inherit' })
  console.log(`[build-native] compiled ${out}`)
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.warn(
    `[build-native] WARN: could not compile socket shim (${msg}); ` +
      'broker will fall back to port listen (no zero-downtime restart).',
  )
  // Do NOT fail the build — socket activation is an enhancement, not a hard dep.
  process.exit(0)
}
