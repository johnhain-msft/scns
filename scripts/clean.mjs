#!/usr/bin/env node
/*
 * Remove build outputs — the cross-platform replacement for `rm -rf dist
 * coverage` (fails under cmd.exe on native Windows). `force: true` gives the
 * same already-absent-is-fine semantics as `rm -rf`.
 *
 * SCNS_BUILD_ROOT overrides the repo root — used only by the unit tests.
 */
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.env.SCNS_BUILD_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)))

for (const target of ['dist', 'coverage']) {
  rmSync(join(root, target), { recursive: true, force: true })
  console.log(`[clean] removed ${target}/`)
}
