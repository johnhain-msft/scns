import { describe, it, expect } from 'vitest'
import { getTeamTemplate, listTeamTemplates } from '../../../../src/broker/a2a/templates.js'
import { TeamManifestSchema } from '../../../../src/broker/a2a/team-manifest.js'

describe('listTeamTemplates', () => {
  it('returns 4 template names', () => {
    const names = listTeamTemplates()
    expect(names).toHaveLength(4)
  })

  it('includes all expected names', () => {
    const names = listTeamTemplates()
    expect(names).toContain('research')
    expect(names).toContain('implementation')
    expect(names).toContain('review')
    expect(names).toContain('full')
  })
})

describe('getTeamTemplate', () => {
  it('returns undefined for unknown template', () => {
    expect(getTeamTemplate('nonexistent')).toBeUndefined()
  })

  it('returns research template', () => {
    const tmpl = getTeamTemplate('research')
    expect(tmpl).toBeDefined()
    expect(tmpl!.name).toContain('Research')
  })

  it('returns implementation template', () => {
    const tmpl = getTeamTemplate('implementation')
    expect(tmpl).toBeDefined()
    expect(tmpl!.name).toContain('Implementation')
  })

  it('returns review template', () => {
    const tmpl = getTeamTemplate('review')
    expect(tmpl).toBeDefined()
    expect(tmpl!.name).toContain('Review')
  })

  it('returns full template', () => {
    const tmpl = getTeamTemplate('full')
    expect(tmpl).toBeDefined()
    expect(tmpl!.name).toContain('Full')
  })

  it('research template has 3 researchers + 1 planner', () => {
    const tmpl = getTeamTemplate('research')!
    const researchers = tmpl.roles.find((r) => r.role === 'researcher')
    const planners = tmpl.roles.find((r) => r.role === 'planner')
    expect(researchers?.count).toBe(3)
    expect(planners?.count).toBe(1)
  })

  it('implementation template has planner + implementers + tester', () => {
    const tmpl = getTeamTemplate('implementation')!
    expect(tmpl.roles.find((r) => r.role === 'planner')?.count).toBe(1)
    expect(tmpl.roles.find((r) => r.role === 'implementer')?.count).toBe(2)
    expect(tmpl.roles.find((r) => r.role === 'tester')?.count).toBe(1)
  })

  it('each template has valid phases', () => {
    for (const name of listTeamTemplates()) {
      const tmpl = getTeamTemplate(name)!
      expect(tmpl.phases).toBeDefined()
      expect(tmpl.phases!.length).toBeGreaterThan(0)
    }
  })

  it('phases reference roles that exist in the manifest', () => {
    for (const name of listTeamTemplates()) {
      const tmpl = getTeamTemplate(name)!
      const roleNames = tmpl.roles.map((r) => r.role)
      for (const phase of tmpl.phases!) {
        for (const phaseRole of phase.roles) {
          expect(roleNames).toContain(phaseRole)
        }
      }
    }
  })

  it('all templates pass schema validation', () => {
    for (const name of listTeamTemplates()) {
      const tmpl = getTeamTemplate(name)!
      expect(() => TeamManifestSchema.parse(tmpl)).not.toThrow()
    }
  })
})
