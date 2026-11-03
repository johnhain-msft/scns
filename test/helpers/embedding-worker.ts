/**
 * Compile the embedding worker so integration tests can fork the REAL fastembed worker.
 *
 * Under vitest, `src/memory/embedding-worker.js` does not exist (vitest transpiles TS in-memory,
 * but `child_process.fork()` spawns a fresh Node process with no vitest transform, so it needs a
 * real file on disk — see embeddings.ts `resolveWorkerPath`). We esbuild-bundle the worker `.ts`
 * once into `node_modules/.cache/` so its runtime `import('fastembed')` still resolves up the
 * module tree, then point the worker spawn at it via `SCNS_EMBED_WORKER_PATH`.
 *
 * esbuild is always present (vite/vitest depend on it). `packages: 'external'` keeps fastembed /
 * onnxruntime as runtime imports (no bundling of native modules); only local code
 * (embedding-protocol) is inlined.
 *
 * That bundle location also forces us to pin the model cache explicitly. The worker resolves its
 * cache as `../../local_cache` from its own module URL, which is correct at the two REAL layouts
 * (`src/memory/*` and `dist/memory/*` both land on `<root>/local_cache`) but falls one level short
 * from `node_modules/.cache/scns/*`, landing on `<root>/node_modules/local_cache`. fastembed treats
 * a missing cache as "download the model", so this silently pulled a fresh 130MB copy; when that
 * download was truncated it left a cache with no `tokenizer.json` and every embed failed with
 * `embedding worker exited (code 1)`. `SCNS_EMBED_CACHE_DIR` is the override the worker documents
 * for exactly this "non-standard layout" case.
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

let cachedPath: string | null = null

export async function compileEmbeddingWorker(): Promise<string> {
  if (cachedPath) return cachedPath
  const entry = fileURLToPath(new URL('../../src/memory/embedding-worker.ts', import.meta.url))
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
  const outfile = join(projectRoot, 'node_modules', '.cache', 'scns', 'embedding-worker.mjs')
  mkdirSync(dirname(outfile), { recursive: true })
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    logLevel: 'silent',
  })
  // Inherited by the forked worker. Points at the one real cache instead of a bundle-relative
  // guess, so tests reuse the checked-out model and never trigger a re-download.
  process.env.SCNS_EMBED_CACHE_DIR = join(projectRoot, 'local_cache')
  cachedPath = outfile
  return outfile
}
