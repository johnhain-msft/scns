import { describe, it, expect } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { createLinePrompt } from '../../../src/cli/line-prompt.js'

function sink(): { stream: Writable; text: () => string } {
  let buf = ''
  return {
    stream: new Writable({
      write(chunk, _enc, cb) {
        buf += String(chunk)
        cb()
      },
    }),
    text: () => buf,
  }
}

describe('createLinePrompt', () => {
  it('returns each line in order, even when they all arrive at once', async () => {
    // The decisive case: a piped stdin delivers every line before the second question is asked.
    // A naive readline.question loop drops the lines emitted during that gap.
    const input = Readable.from(['one\ntwo\nthree\n'])
    const out = sink()
    const p = createLinePrompt({ input, output: out.stream })
    expect(await p.ask('a? ')).toBe('one')
    expect(await p.ask('b? ')).toBe('two')
    expect(await p.ask('c? ')).toBe('three')
    p.close()
  })

  it('survives an await gap between questions (the exact failure mode)', async () => {
    const input = Readable.from(['first\nsecond\n'])
    const p = createLinePrompt({ input, output: sink().stream })
    const a = await p.ask('a? ')
    await new Promise((r) => setTimeout(r, 20))
    const b = await p.ask('b? ')
    expect([a, b]).toEqual(['first', 'second'])
    p.close()
  })

  it('returns null at end of input rather than hanging forever', async () => {
    const p = createLinePrompt({ input: Readable.from(['only\n']), output: sink().stream })
    expect(await p.ask('a? ')).toBe('only')
    expect(await p.ask('b? ')).toBeNull()
    p.close()
  })

  it('writes the prompt so the human knows what is being asked', async () => {
    const out = sink()
    const p = createLinePrompt({ input: Readable.from(['x\n']), output: out.stream })
    await p.ask('pick one: ')
    expect(out.text()).toContain('pick one: ')
    p.close()
  })

  it('preserves empty lines as empty strings, not as end of input', async () => {
    const p = createLinePrompt({ input: Readable.from(['\nnext\n']), output: sink().stream })
    expect(await p.ask('a? ')).toBe('')
    expect(await p.ask('b? ')).toBe('next')
    p.close()
  })
})
