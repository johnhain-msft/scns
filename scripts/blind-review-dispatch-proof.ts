import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { captureBlindReviewDispatch } from './lib/blind-review-dispatch.js'

export function runBlindReviewDispatchProofCli(args: readonly string[]) {
  const parsed = parseArgs({
    args: [...args],
    options: {
      events: { type: 'string' },
      reviewer: { type: 'string' },
      'expected-prompt': { type: 'string' },
      'expected-sha256': { type: 'string' },
      output: { type: 'string' },
      'captured-prompt': { type: 'string' },
    },
    strict: true,
  })

  const eventsPath = parsed.values.events
  const reviewerName = parsed.values.reviewer
  const expectedPromptPath = parsed.values['expected-prompt']
  const expectedPromptSha256 = parsed.values['expected-sha256']
  const outputPath = parsed.values.output
  const capturedPromptPath = parsed.values['captured-prompt']
  if (
    !eventsPath ||
    !reviewerName ||
    !expectedPromptPath ||
    !expectedPromptSha256 ||
    !outputPath ||
    !capturedPromptPath
  ) {
    throw new Error(
      'usage: --events <events.jsonl> --reviewer <name> --expected-prompt <path> ' +
        '--expected-sha256 <hash> --output <proof.json> --captured-prompt <path>',
    )
  }

  const proof = captureBlindReviewDispatch({
    eventsPath: resolve(eventsPath),
    reviewerName,
    expectedPromptPath: resolve(expectedPromptPath),
    expectedPromptSha256,
  })
  const resolvedOutput = resolve(outputPath)
  const resolvedCapturedPrompt = resolve(capturedPromptPath)
  mkdirSync(dirname(resolvedOutput), { recursive: true })
  mkdirSync(dirname(resolvedCapturedPrompt), { recursive: true })
  writeFileSync(resolvedCapturedPrompt, proof.dispatchedPrompt, 'utf8')
  writeFileSync(resolvedOutput, `${JSON.stringify(proof, null, 2)}\n`, 'utf8')
  return { proof, outputPath: resolvedOutput, capturedPromptPath: resolvedCapturedPrompt }
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const result = runBlindReviewDispatchProofCli(process.argv.slice(2))
    process.stdout.write(
      `${JSON.stringify({
        outputPath: result.outputPath,
        capturedPromptPath: result.capturedPromptPath,
        exactMatch: result.proof.exactMatch,
        framingLeaks: result.proof.framingLeaks,
      })}\n`,
    )
    if (!result.proof.exactMatch || result.proof.framingLeaks.length > 0) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
