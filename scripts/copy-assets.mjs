#!/usr/bin/env node
/*
 * Copy non-TS build assets into dist/ — the cross-platform replacement for the
 * `cp` + `mkdir -p` steps that used to live inline in `npm run build` (those
 * fail under cmd.exe on native Windows).
 *
 * Fails loudly (non-zero exit) if any source asset is missing: a silent
 * partial dist/ would surface later as a confusing runtime error.
 *
 * SCNS_BUILD_ROOT overrides the repo root — used only by the unit tests.
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.env.SCNS_BUILD_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)))

const ASSETS = [
  ['src', 'broker', 'storage', 'schema.sql'],
  ['src', 'otel', 'schema.sql'],
]

for (const segments of ASSETS) {
  const from = join(root, ...segments)
  const to = join(root, 'dist', ...segments.slice(1))
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  console.log(`[copy-assets] ${segments.join('/')} → dist/${segments.slice(1).join('/')}`)
}
