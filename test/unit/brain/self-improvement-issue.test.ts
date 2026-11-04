import { describe, it, expect, vi } from 'vitest'
import {
  fileSelfImprovementIssues,
  resolveFileGapsTargetRepo,
  selfImproveMarker,
  SCNS_SELF_IMPROVEMENT_GAPS,
  SELF_IMPROVE_LABEL,
  type SelfImprovementGap,
  type OpenIssue,
} from '../../../src/brain/self-improvement-issue.js'

const GAPS: readonly SelfImprovementGap[] = [
  { key: 'k1', title: 'Gap one', body: 'Body one' },
  { key: 'k2', title: 'Gap two', body: 'Body two' },
  { key: 'k3', title: 'Gap three', body: 'Body three' },
]

function deps(opts: {
  existing?: readonly OpenIssue[]
  dryRun?: boolean
  maxPerRun?: number
  createUrl?: (title: string) => string
}) {
  const createIssue = vi.fn(
    async (i: { title: string; body: string; labels: readonly string[] }) => ({
      url: opts.createUrl ? opts.createUrl(i.title) : `https://example/issues/${i.title}`,
    }),
  )
  const listOpenIssues = vi.fn(async () => opts.existing ?? [])
  return {
    createIssue,
    listOpenIssues,
    dryRun: opts.dryRun,
    maxPerRun: opts.maxPerRun,
    _spies: { createIssue, listOpenIssues },
  }
}

describe('fileSelfImprovementIssues', () => {
  it('plans all gaps and creates them when none exist (apply)', async () => {
    const d = deps({ existing: [] })
    const res = await fileSelfImprovementIssues(GAPS, d)
    expect(res.toCreate.map((p) => p.key)).toEqual(['k1', 'k2', 'k3'])
    expect(res.created.map((c) => c.key)).toEqual(['k1', 'k2', 'k3'])
    expect(d._spies.createIssue).toHaveBeenCalledTimes(3)
    // Each created body embeds the stable dedupe marker + the label is applied.
    const firstCall = d._spies.createIssue.mock.calls[0]![0]
    expect(firstCall.body).toContain(selfImproveMarker('k1'))
    expect(firstCall.labels).toContain(SELF_IMPROVE_LABEL)
  })

  it('skips a gap whose marker already appears in an open issue body (dedupe)', async () => {
    const d = deps({
      existing: [{ title: 'pre-existing', body: `something ${selfImproveMarker('k2')} more` }],
    })
    const res = await fileSelfImprovementIssues(GAPS, d)
    expect(res.skippedDuplicate).toEqual(['k2'])
    expect(res.toCreate.map((p) => p.key)).toEqual(['k1', 'k3'])
    expect(d._spies.createIssue).toHaveBeenCalledTimes(2)
  })

  it('caps creation at maxPerRun and reports the rest as skippedCap', async () => {
    const d = deps({ existing: [], maxPerRun: 2 })
    const res = await fileSelfImprovementIssues(GAPS, d)
    expect(res.toCreate.map((p) => p.key)).toEqual(['k1', 'k2'])
    expect(res.skippedCap).toEqual(['k3'])
    expect(d._spies.createIssue).toHaveBeenCalledTimes(2)
  })

  it('does NOT create anything in dry-run, but still reports the plan', async () => {
    const d = deps({ existing: [], dryRun: true })
    const res = await fileSelfImprovementIssues(GAPS, d)
    expect(res.toCreate.map((p) => p.key)).toEqual(['k1', 'k2', 'k3'])
    expect(res.created).toEqual([])
    expect(d._spies.createIssue).not.toHaveBeenCalled()
  })

  it('queries open issues using the configured label', async () => {
    const d = deps({ existing: [] })
    await fileSelfImprovementIssues(GAPS, d)
    expect(d._spies.listOpenIssues).toHaveBeenCalledWith(SELF_IMPROVE_LABEL)
  })
})

describe('resolveFileGapsTargetRepo (#58)', () => {
  it('an explicit --repo wins over the env', () => {
    expect(resolveFileGapsTargetRepo('me/mine', { SCNS_SELF_ISSUE_REPO: 'other/repo' })).toEqual({
      ok: true,
      repo: 'me/mine',
    })
  })

  it('falls back to SCNS_SELF_ISSUE_REPO', () => {
    expect(resolveFileGapsTargetRepo(undefined, { SCNS_SELF_ISSUE_REPO: 'me/mine' })).toEqual({
      ok: true,
      repo: 'me/mine',
    })
  })

  it('refuses with a reason when neither is set — there is no hardcoded default target', () => {
    const r = resolveFileGapsTargetRepo(undefined, {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('--repo')
      expect(r.reason).toContain('SCNS_SELF_ISSUE_REPO')
    }
  })

  it('treats blank values as unset', () => {
    expect(resolveFileGapsTargetRepo('   ', { SCNS_SELF_ISSUE_REPO: '  ' }).ok).toBe(false)
  })

  it('trims the winning value', () => {
    expect(resolveFileGapsTargetRepo('  me/mine  ', {})).toEqual({ ok: true, repo: 'me/mine' })
  })
})

describe('SCNS_SELF_IMPROVEMENT_GAPS catalog', () => {
  it('is non-empty with unique keys and non-empty bodies', () => {
    expect(SCNS_SELF_IMPROVEMENT_GAPS.length).toBeGreaterThan(0)
    const keys = SCNS_SELF_IMPROVEMENT_GAPS.map((g) => g.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const g of SCNS_SELF_IMPROVEMENT_GAPS) {
      expect(g.title.length).toBeGreaterThan(0)
      expect(g.body.length).toBeGreaterThan(0)
    }
  })
})
