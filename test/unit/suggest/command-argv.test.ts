import { describe, expect, it } from 'vitest'

import { parseCommandArgv } from '../../../src/suggest/command-argv.js'

describe('parseCommandArgv', () => {
  it('splits a plain command on whitespace', () => {
    expect(parseCommandArgv('npm run build')).toEqual(['npm', 'run', 'build'])
  })

  it('collapses repeated whitespace and tabs', () => {
    expect(parseCommandArgv('git \t status   --short')).toEqual(['git', 'status', '--short'])
  })

  it('groups double-quoted tokens and strips the quotes', () => {
    expect(parseCommandArgv('node "my script.js" --flag')).toEqual([
      'node',
      'my script.js',
      '--flag',
    ])
  })

  it('groups single-quoted tokens and strips the quotes', () => {
    expect(parseCommandArgv("grep 'two words' file.txt")).toEqual(['grep', 'two words', 'file.txt'])
  })

  it('treats shell operators inside quotes as literal data', () => {
    expect(
      parseCommandArgv(`node -e "require('fs').writeFileSync(process.argv[1], 'x')" out`),
    ).toEqual(['node', '-e', "require('fs').writeFileSync(process.argv[1], 'x')", 'out'])
  })

  it('passes Windows backslash paths through literally', () => {
    expect(parseCommandArgv('node C:\\repo\\tool.js')).toEqual(['node', 'C:\\repo\\tool.js'])
  })

  it.each([
    'echo hi > out.txt',
    'cat a | sh',
    'a && b',
    'a; b',
    'echo `id`',
    'echo $(id)',
    'tool <input',
  ])('refuses unquoted shell operators: %s', (cmd) => {
    expect(parseCommandArgv(cmd)).toBeNull()
  })

  it('refuses newlines — one command per step', () => {
    expect(parseCommandArgv('echo a\necho b')).toBeNull()
  })

  it('refuses unbalanced quotes', () => {
    expect(parseCommandArgv('echo "unterminated')).toBeNull()
  })

  it('refuses empty and whitespace-only input', () => {
    expect(parseCommandArgv('')).toBeNull()
    expect(parseCommandArgv('   ')).toBeNull()
  })
})
