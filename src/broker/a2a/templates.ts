import { TeamManifestSchema } from './team-manifest.js'
import type { TeamManifest } from './team-manifest.js'

// ---------------------------------------------------------------------------
// Built-in team templates for common scenarios
// ---------------------------------------------------------------------------

const TEMPLATES: ReadonlyMap<string, TeamManifest> = new Map([
  [
    'research',
    TeamManifestSchema.parse({
      id: 'template-research',
      name: 'Research Team',
      description: 'Parallel research with synthesis',
      roles: [
        { role: 'researcher', count: 3 },
        { role: 'planner', count: 1 },
      ],
      phases: [
        { name: 'research', roles: ['researcher'], gateCondition: 'all-complete' },
        { name: 'synthesis', roles: ['planner'], gateCondition: 'all-complete' },
      ],
      strategy: 'parallel',
    }),
  ],
  [
    'implementation',
    TeamManifestSchema.parse({
      id: 'template-implementation',
      name: 'Implementation Team',
      description: 'Plan, implement, test',
      roles: [
        { role: 'planner', count: 1 },
        { role: 'implementer', count: 2 },
        { role: 'tester', count: 1 },
      ],
      phases: [
        { name: 'planning', roles: ['planner'], gateCondition: 'all-complete' },
        { name: 'implementation', roles: ['implementer'], gateCondition: 'all-complete' },
        { name: 'testing', roles: ['tester'], gateCondition: 'all-complete' },
      ],
      strategy: 'sequential',
    }),
  ],
  [
    'review',
    TeamManifestSchema.parse({
      id: 'template-review',
      name: 'Review Team',
      description: 'Code review and verification',
      roles: [
        { role: 'reviewer', count: 2 },
        { role: 'tester', count: 1 },
      ],
      phases: [
        { name: 'review', roles: ['reviewer'], gateCondition: 'all-complete' },
        { name: 'verification', roles: ['tester'], gateCondition: 'all-complete' },
      ],
      strategy: 'sequential',
    }),
  ],
  [
    'full',
    TeamManifestSchema.parse({
      id: 'template-full',
      name: 'Full Team',
      description: 'Complete development lifecycle',
      roles: [
        { role: 'planner', count: 1 },
        { role: 'researcher', count: 1 },
        { role: 'implementer', count: 2 },
        { role: 'reviewer', count: 1 },
        { role: 'tester', count: 1 },
      ],
      phases: [
        { name: 'research', roles: ['researcher'], gateCondition: 'all-complete' },
        { name: 'planning', roles: ['planner'], gateCondition: 'all-complete' },
        { name: 'implementation', roles: ['implementer'], gateCondition: 'all-complete' },
        { name: 'review', roles: ['reviewer'], gateCondition: 'all-complete' },
        { name: 'verification', roles: ['tester'], gateCondition: 'all-complete' },
      ],
      strategy: 'hybrid',
    }),
  ],
])

export function getTeamTemplate(templateName: string): TeamManifest | undefined {
  return TEMPLATES.get(templateName)
}

export function listTeamTemplates(): readonly string[] {
  return [...TEMPLATES.keys()]
}
