/**
 * Prompt template engine with built-in role-based templates.
 * Pure functions for variable substitution and extraction.
 */

import type { PromptTemplate, TemplateContext } from './template-types.js'
import { NotFoundError } from '../shared/errors.js'

// ── Built-in templates ───────────────────────────────────────────────

const RESEARCHER_TEMPLATE: PromptTemplate = {
  id: 'researcher-default',
  role: 'researcher',
  name: 'Default Researcher',
  description: 'Template for research agents',
  template: `You are a research agent for the SCNS project.

## Your Task
{{taskDescription}}

{{#if memoryContext}}
## Context
{{memoryContext}}
{{/if}}

## Instructions
- Research thoroughly, cite sources
- Focus on practical, actionable findings
- Summarize key findings in structured format
- Report back to team {{teamId}} when complete

{{#if previousResults}}
## Prior Findings
{{previousResults}}
{{/if}}`,
  requiredVars: ['taskDescription'],
  optionalVars: ['memoryContext', 'teamId', 'previousResults'],
}

const IMPLEMENTER_TEMPLATE: PromptTemplate = {
  id: 'implementer-default',
  role: 'implementer',
  name: 'Default Implementer',
  description: 'Template for implementation agents',
  template: `You are an implementation agent for the SCNS project.

## Your Task
{{taskDescription}}

{{#if subtaskDescription}}
## Subtask
{{subtaskDescription}}
{{/if}}

{{#if memoryContext}}
## Context
{{memoryContext}}
{{/if}}

{{#if userPreferences}}
## User Preferences
{{userPreferences}}
{{/if}}

{{#if workingDir}}
## Working Directory
{{workingDir}}
{{/if}}

## Instructions
- Follow TDD: write tests first, then implement
- Use TypeScript 5.8 ESM strict, .js extensions in imports
- 80%+ test coverage required
- Conventional commits
- Report results to team {{teamId}}

{{#if subtaskDependencies}}
## Dependencies (completed)
{{subtaskDependencies}}
{{/if}}

{{#if previousResults}}
## Prior Results
{{previousResults}}
{{/if}}`,
  requiredVars: ['taskDescription'],
  optionalVars: [
    'subtaskDescription',
    'memoryContext',
    'userPreferences',
    'workingDir',
    'teamId',
    'subtaskDependencies',
    'previousResults',
  ],
}

const REVIEWER_TEMPLATE: PromptTemplate = {
  id: 'reviewer-default',
  role: 'reviewer',
  name: 'Default Reviewer',
  description: 'Template for code review agents',
  template: `You are a code review agent for the SCNS project.

## Your Task
Review the following work: {{taskDescription}}

{{#if memoryContext}}
## Context
{{memoryContext}}
{{/if}}

## Instructions
- Check for correctness, edge cases, error handling
- Verify test coverage and quality
- Check TypeScript strict mode compliance
- Verify ESM import conventions (.js extensions)
- Report issues with severity (critical/major/minor/nit)
- Report to team {{teamId}}`,
  requiredVars: ['taskDescription'],
  optionalVars: ['memoryContext', 'teamId'],
}

const TESTER_TEMPLATE: PromptTemplate = {
  id: 'tester-default',
  role: 'tester',
  name: 'Default Tester',
  description: 'Template for testing agents',
  template: `You are a testing agent for the SCNS project.

## Your Task
{{taskDescription}}

{{#if memoryContext}}
## Context
{{memoryContext}}
{{/if}}

{{#if workingDir}}
## Working Directory
{{workingDir}}
{{/if}}

## Instructions
- Write comprehensive test cases (unit + integration)
- Cover happy paths, edge cases, error cases
- Use Vitest as test framework
- Achieve 80%+ coverage for the module under test
- Report test results to team {{teamId}}`,
  requiredVars: ['taskDescription'],
  optionalVars: ['memoryContext', 'workingDir', 'teamId'],
}

const PLANNER_TEMPLATE: PromptTemplate = {
  id: 'planner-default',
  role: 'planner',
  name: 'Default Planner',
  description: 'Template for planning agents',
  template: `You are a planning agent for the SCNS project.

## Your Task
{{taskDescription}}

{{#if memoryContext}}
## Context
{{memoryContext}}
{{/if}}

{{#if soulContext}}
## Project Knowledge
{{soulContext}}
{{/if}}

## Instructions
- Decompose the task into clear, actionable subtasks
- Identify dependencies between subtasks
- Estimate complexity and time for each
- Assign appropriate roles (researcher/implementer/reviewer/tester)
- Produce a structured plan`,
  requiredVars: ['taskDescription'],
  optionalVars: ['memoryContext', 'soulContext'],
}

const BUILT_IN_TEMPLATES: readonly PromptTemplate[] = [
  RESEARCHER_TEMPLATE,
  IMPLEMENTER_TEMPLATE,
  REVIEWER_TEMPLATE,
  TESTER_TEMPLATE,
  PLANNER_TEMPLATE,
]

// ── Pure functions ───────────────────────────────────────────────────

/** Replace {{varName}} placeholders and handle {{#if varName}}...{{/if}} blocks */
export function substituteVariables(
  template: string,
  variables: Record<string, string | undefined>,
): string {
  // Process conditional blocks first
  let result = template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, varName: string, content: string) => {
      const value = variables[varName]
      if (value !== undefined && value !== '') {
        return substituteVariables(content, variables)
      }
      return ''
    },
  )

  // Then substitute simple variables
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
    return variables[varName] ?? ''
  })

  return result
}

/** Extract variable names from template (excluding #if / /if directives) */
export function extractVariables(template: string): readonly string[] {
  const seen = new Set<string>()
  const vars: string[] = []
  const regex = /\{\{(\w+)\}\}/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(template)) !== null) {
    const name = match[1] as string
    if (!seen.has(name)) {
      seen.add(name)
      vars.push(name)
    }
  }

  return vars
}

// ── Template engine ──────────────────────────────────────────────────

export interface TemplateEngineOptions {
  readonly customTemplates?: readonly PromptTemplate[]
}

function contextToVariables(context: TemplateContext): Record<string, string | undefined> {
  const vars: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      vars[key] = value.join('\n')
    } else if (typeof value === 'number') {
      vars[key] = String(value)
    } else {
      vars[key] = value as string
    }
  }
  return vars
}

export function createTemplateEngine(options?: TemplateEngineOptions) {
  const templates = new Map<string, PromptTemplate>()

  // Load built-in templates
  for (const t of BUILT_IN_TEMPLATES) {
    templates.set(t.id, t)
  }

  // Load custom templates from options (may override built-ins)
  if (options?.customTemplates) {
    for (const t of options.customTemplates) {
      templates.set(t.id, t)
    }
  }

  return {
    render(templateId: string, context: TemplateContext): string {
      const tmpl = templates.get(templateId)
      if (!tmpl) {
        throw new NotFoundError('Template', templateId)
      }
      const vars = contextToVariables(context)
      return substituteVariables(tmpl.template, vars)
    },

    getTemplate(templateId: string): PromptTemplate | undefined {
      return templates.get(templateId)
    },

    listTemplates(): readonly PromptTemplate[] {
      return [...templates.values()]
    },

    validateContext(templateId: string, context: TemplateContext): readonly string[] {
      const tmpl = templates.get(templateId)
      if (!tmpl) {
        throw new NotFoundError('Template', templateId)
      }
      const vars = contextToVariables(context)
      return tmpl.requiredVars.filter((v) => !vars[v] || vars[v] === '')
    },

    registerTemplate(template: PromptTemplate): void {
      templates.set(template.id, template)
    },

    selectTemplate(role: string, _context: Partial<TemplateContext>): PromptTemplate {
      // Find templates matching role, prefer first match
      for (const t of templates.values()) {
        if (t.role === role) return t
      }
      // Fallback to planner
      return templates.get('planner-default')!
    },
  }
}
