import { describe, it, expect } from 'vitest'
import {
  resolveAcpPromptTimeoutMs,
  DEFAULT_ACP_PROMPT_TIMEOUT_MS,
} from '../../../../src/broker/services/agent-spawner.js'

describe('resolveAcpPromptTimeoutMs (Phase 13.12.23)', () => {
  it('returns the 30-minute default when no option and no env', () => {
    const result = resolveAcpPromptTimeoutMs(undefined, {})
    expect(result).toBe(DEFAULT_ACP_PROMPT_TIMEOUT_MS)
    expect(result).toBe(30 * 60 * 1000)
  })

  it('prefers an explicit option value', () => {
    expect(
      resolveAcpPromptTimeoutMs(5000, { SCNS_ACP_PROMPT_TIMEOUT_MS: '999999' }),
    ).toBe(5000)
  })

  it('uses SCNS_ACP_PROMPT_TIMEOUT_MS env var when option is undefined', () => {
    expect(
      resolveAcpPromptTimeoutMs(undefined, { SCNS_ACP_PROMPT_TIMEOUT_MS: '120000' }),
    ).toBe(120000)
  })

  it('ignores non-positive env values and falls back to default', () => {
    expect(
      resolveAcpPromptTimeoutMs(undefined, { SCNS_ACP_PROMPT_TIMEOUT_MS: '0' }),
    ).toBe(DEFAULT_ACP_PROMPT_TIMEOUT_MS)
    expect(
      resolveAcpPromptTimeoutMs(undefined, { SCNS_ACP_PROMPT_TIMEOUT_MS: '-1' }),
    ).toBe(DEFAULT_ACP_PROMPT_TIMEOUT_MS)
    expect(
      resolveAcpPromptTimeoutMs(undefined, { SCNS_ACP_PROMPT_TIMEOUT_MS: 'abc' }),
    ).toBe(DEFAULT_ACP_PROMPT_TIMEOUT_MS)
  })

  it('ignores non-positive option values and falls back to env/default', () => {
    expect(
      resolveAcpPromptTimeoutMs(0, { SCNS_ACP_PROMPT_TIMEOUT_MS: '777' }),
    ).toBe(777)
    expect(resolveAcpPromptTimeoutMs(-1, {})).toBe(DEFAULT_ACP_PROMPT_TIMEOUT_MS)
  })

  it('floors fractional values', () => {
    expect(resolveAcpPromptTimeoutMs(1500.7, {})).toBe(1500)
  })
})
