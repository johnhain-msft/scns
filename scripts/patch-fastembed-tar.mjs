#!/usr/bin/env node
/**
 * Patch fastembed's ESM build to work with tar v7.
 *
 * fastembed's ESM entry does `import tar from "tar"` but tar v7 has no
 * default ESM export.  This script rewrites it to use the named `x` export
 * which is the only tar API fastembed actually calls (`tar.x()`).
 *
 * Run automatically via npm postinstall.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const target = resolve(__dirname, '..', 'node_modules', 'fastembed', 'lib', 'esm', 'fastembed.js')

if (!existsSync(target)) {
  // fastembed not installed — nothing to patch
  process.exit(0)
}

const content = readFileSync(target, 'utf8')

if (content.includes('import tar from "tar"')) {
  const patched = content.replace(
    'import tar from "tar";',
    'import * as tar from "tar";',
  )
  writeFileSync(target, patched, 'utf8')
  console.log('✔ Patched fastembed ESM to use tar v7 named exports')
} else {
  console.log('⊘ fastembed ESM already patched or uses different import')
}
