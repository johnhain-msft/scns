/**
 * Team composition templates for the orchestrator.
 *
 * Each template defines the recommended roles and counts for a given task type.
 * The orchestrator calls `get_team_template` to look up the right composition
 * before spawning agents.
 */

export interface RoleSlot {
  readonly role: 'manager' | 'pm' | 'scrum-master' | 'dev' | 'qa' | 'lead' | 'reviewer' | 'general'
  readonly count: number
  readonly agent: string
  readonly description: string
}

export interface TeamTemplate {
  readonly name: string
  readonly description: string
  readonly roles: readonly RoleSlot[]
}

const TEMPLATES: Record<string, TeamTemplate> = {
  feature: {
    name: 'feature',
    description: 'Standard feature development — PM writes requirements, devs implement, QA validates.',
    roles: [
      { role: 'pm', count: 1, agent: 'pm', description: 'Gathers requirements and writes acceptance criteria' },
      { role: 'dev', count: 2, agent: 'dev', description: 'Implements the feature' },
      { role: 'qa', count: 1, agent: 'qa', description: 'Writes tests and validates acceptance criteria' },
    ],
  },

  bugfix: {
    name: 'bugfix',
    description: 'Bug investigation and fix — dev reproduces and fixes, QA writes regression tests.',
    roles: [
      { role: 'dev', count: 1, agent: 'dev', description: 'Investigates root cause and implements fix' },
      { role: 'qa', count: 1, agent: 'qa', description: 'Writes regression test and validates fix' },
    ],
  },

  research: {
    name: 'research',
    description: 'Research and analysis — PM researches options, dev prototypes solutions.',
    roles: [
      { role: 'pm', count: 1, agent: 'pm', description: 'Researches approaches and documents findings' },
      { role: 'dev', count: 1, agent: 'dev', description: 'Prototypes and evaluates technical feasibility' },
    ],
  },

  full: {
    name: 'full',
    description: 'Full team for large efforts — manager coordinates, PM defines scope, scrum master tracks progress, devs build, QA tests.',
    roles: [
      { role: 'manager', count: 1, agent: 'manager', description: 'Makes assignment decisions and resolves conflicts' },
      { role: 'pm', count: 1, agent: 'pm', description: 'Gathers requirements and writes acceptance criteria' },
      { role: 'scrum-master', count: 1, agent: 'scrum-master', description: 'Tracks velocity and removes blockers' },
      { role: 'dev', count: 2, agent: 'dev', description: 'Implements features' },
      { role: 'qa', count: 1, agent: 'qa', description: 'Writes tests and validates acceptance criteria' },
    ],
  },
}

/**
 * Get a team composition template by name.
 * Returns undefined if the template name is not recognized.
 */
export function getTeamTemplate(name: string): TeamTemplate | undefined {
  return TEMPLATES[name]
}

/**
 * List all available template names.
 */
export function listTemplateNames(): readonly string[] {
  return Object.keys(TEMPLATES)
}

/**
 * Get all templates as a record.
 */
export function getAllTemplates(): Readonly<Record<string, TeamTemplate>> {
  return TEMPLATES
}
