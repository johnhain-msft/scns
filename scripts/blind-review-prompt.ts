import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildReviewPrompt, parseReviewRequest } from './lib/blind-review-envelope.js'

export interface BlindReviewPromptCliResult {
  readonly mode: 'blind' | 'followup'
  readonly requestPath: string
  readonly promptPath: string
  readonly manifestPath: string
  readonly requestSha256: string
  readonly promptSha256: string
}

export function runBlindReviewPromptCli(args: readonly string[]): BlindReviewPromptCliResult {
  const parsed = parseArgs({
    args: [...args],
    options: {
      request: { type: 'string' },
      output: { type: 'string' },
      manifest: { type: 'string' },
    },
    strict: true,
  })

  if (!parsed.values.request || !parsed.values.output || !parsed.values.manifest) {
    throw new Error('usage: --request <json> --output <prompt.txt> --manifest <manifest.json>')
  }

  const requestPath = resolve(parsed.values.request)
  const promptPath = resolve(parsed.values.output)
  const manifestPath = resolve(parsed.values.manifest)
  const request = parseReviewRequest(JSON.parse(readFileSync(requestPath, 'utf8')) as unknown)
  const generated = buildReviewPrompt(request)

  mkdirSync(dirname(promptPath), { recursive: true })
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(promptPath, generated.prompt, 'utf8')

  const result: BlindReviewPromptCliResult = {
    mode: generated.mode,
    requestPath,
    promptPath,
    manifestPath,
    requestSha256: generated.requestSha256,
    promptSha256: generated.promptSha256,
  }
  writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return result
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const result = runBlindReviewPromptCli(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
