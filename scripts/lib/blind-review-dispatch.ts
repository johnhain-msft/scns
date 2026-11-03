import { readFileSync } from 'node:fs'
import { auditBlindPrompt, sha256File, sha256Text } from './blind-review-envelope.js'

export interface CaptureBlindReviewDispatchInput {
  readonly eventsPath: string
  readonly reviewerName: string
  readonly expectedPromptPath: string
  readonly expectedPromptSha256: string
}

export interface BlindReviewDispatchProof {
  readonly eventTimestamp: string
  readonly toolCallId: string
  readonly reviewerName: string
  readonly expectedPromptSha256: string
  readonly dispatchedPromptSha256: string
  readonly exactMatch: boolean
  readonly framingLeaks: readonly string[]
  readonly dispatchedPrompt: string
}

interface TaskDispatchEvent {
  readonly timestamp?: unknown
  readonly type?: unknown
  readonly data?: {
    readonly toolCallId?: unknown
    readonly toolName?: unknown
    readonly parentToolCallId?: unknown
    readonly arguments?: {
      readonly name?: unknown
      readonly prompt?: unknown
    }
  }
}

function parseEvent(line: string, lineNumber: number): TaskDispatchEvent {
  try {
    return JSON.parse(line) as TaskDispatchEvent
  } catch (error) {
    throw new Error(
      `invalid JSON in events file at line ${lineNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

export function captureBlindReviewDispatch(
  input: CaptureBlindReviewDispatchInput,
): BlindReviewDispatchProof {
  const expectedPrompt = readFileSync(input.expectedPromptPath, 'utf8')
  const expectedFileSha256 = sha256File(input.expectedPromptPath)
  if (expectedFileSha256 !== input.expectedPromptSha256) {
    throw new Error(
      `expected prompt sha256 mismatch: manifest ${input.expectedPromptSha256}, file ${expectedFileSha256}`,
    )
  }

  const events = readFileSync(input.eventsPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => parseEvent(line, index + 1))
    .filter(
      (event) =>
        event.type === 'tool.execution_start' &&
        event.data?.toolName === 'task' &&
        event.data.parentToolCallId === undefined &&
        event.data.arguments?.name === input.reviewerName,
    )

  const event = events.at(-1)
  if (!event) {
    throw new Error(`no top-level task dispatch found for reviewer "${input.reviewerName}"`)
  }

  const prompt = event.data?.arguments?.prompt
  if (typeof prompt !== 'string') {
    throw new Error(`task dispatch for reviewer "${input.reviewerName}" has no string prompt`)
  }
  const timestamp = event.timestamp
  const toolCallId = event.data?.toolCallId
  if (typeof timestamp !== 'string' || typeof toolCallId !== 'string') {
    throw new Error(`task dispatch for reviewer "${input.reviewerName}" lacks event identity`)
  }

  const dispatchedPromptSha256 = sha256Text(prompt)
  return {
    eventTimestamp: timestamp,
    toolCallId,
    reviewerName: input.reviewerName,
    expectedPromptSha256: input.expectedPromptSha256,
    dispatchedPromptSha256,
    exactMatch: prompt === expectedPrompt && dispatchedPromptSha256 === input.expectedPromptSha256,
    framingLeaks: auditBlindPrompt(prompt),
    dispatchedPrompt: prompt,
  }
}
