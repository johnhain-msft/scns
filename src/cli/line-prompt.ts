/**
 * A line prompt that does not lose input.
 *
 * `readline.question()` in a loop looks correct and works fine at a terminal, where the next line
 * does not exist until the human types it. Against a PIPE it silently drops answers: readline emits
 * `'line'` as fast as the stream delivers, and any line emitted between one question resolving and
 * the next being asked — an `await` gap, a `console.log`, a store write — arrives with no callback
 * registered and is discarded. In the weekly review that meant the first verdict was read, the
 * reason prompt printed, and every remaining answer vanished; the command exited 0 having recorded
 * nothing. It passed unit tests and failed the moment it was actually run, which is the whole reason
 * live verification is not optional.
 *
 * This buffers lines instead, so a question either takes the next queued line or waits for one.
 */

import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export interface LinePrompt {
  /** Ask a question and resolve with the next line, or null once input is exhausted. */
  ask(prompt: string): Promise<string | null>
  close(): void
}

export interface LinePromptOptions {
  readonly input: Readable
  readonly output: Writable
}

export function createLinePrompt(opts: LinePromptOptions): LinePrompt {
  const rl: Interface = createInterface({ input: opts.input, terminal: false })

  const queued: string[] = []
  const waiting: Array<(line: string | null) => void> = []
  let ended = false

  rl.on('line', (line) => {
    const next = waiting.shift()
    if (next) next(line)
    else queued.push(line)
  })
  rl.on('close', () => {
    ended = true
    // Release every pending question so a caller can never hang on a closed stream.
    while (waiting.length > 0) waiting.shift()!(null)
  })

  return {
    ask(prompt: string): Promise<string | null> {
      opts.output.write(prompt)
      if (queued.length > 0) return Promise.resolve(queued.shift()!)
      if (ended) return Promise.resolve(null)
      return new Promise<string | null>((resolve) => waiting.push(resolve))
    },
    close(): void {
      rl.close()
    },
  }
}
