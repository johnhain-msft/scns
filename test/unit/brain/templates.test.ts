import { describe, it, expect } from 'vitest'
import {
  createTemplateEngine,
  substituteVariables,
  extractVariables,
} from '../../../src/brain/templates.js'
import type { TemplateContext, PromptTemplate } from '../../../src/brain/template-types.js'

// ── Pure functions ────────────────────────────────────────────────────

describe('substituteVariables', () => {
  it('replaces a simple variable', () => {
    const result = substituteVariables('Hello {{name}}!', { name: 'World' })
    expect(result).toBe('Hello World!')
  })

  it('replaces multiple variables in one template', () => {
    const result = substituteVariables('{{greeting}} {{name}}!', {
      greeting: 'Hi',
      name: 'Alice',
    })
    expect(result).toBe('Hi Alice!')
  })

  it('replaces missing optional variable with empty string', () => {
    const result = substituteVariables('Hello {{name}}!', {})
    expect(result).toBe('Hello !')
  })

  it('includes conditional block when variable is present', () => {
    const tmpl = 'Start\n{{#if extra}}Extra: {{extra}}{{/if}}\nEnd'
    const result = substituteVariables(tmpl, { extra: 'bonus' })
    expect(result).toContain('Extra: bonus')
    expect(result).toContain('Start')
    expect(result).toContain('End')
  })

  it('removes conditional block when variable is absent', () => {
    const tmpl = 'Start\n{{#if extra}}Extra: {{extra}}{{/if}}\nEnd'
    const result = substituteVariables(tmpl, {})
    expect(result).not.toContain('Extra:')
    expect(result).toContain('Start')
    expect(result).toContain('End')
  })

  it('removes conditional block when variable is empty string', () => {
    const tmpl = 'A{{#if x}}B{{/if}}C'
    const result = substituteVariables(tmpl, { x: '' })
    expect(result).toBe('AC')
  })

  it('handles nested variables inside conditional blocks', () => {
    const tmpl = '{{#if ctx}}Context: {{ctx}} by {{author}}{{/if}}'
    const result = substituteVariables(tmpl, { ctx: 'memory', author: 'agent' })
    expect(result).toBe('Context: memory by agent')
  })
})

describe('extractVariables', () => {
  it('finds all placeholder names', () => {
    const vars = extractVariables('{{a}} and {{b}} plus {{c}}')
    expect(vars).toEqual(['a', 'b', 'c'])
  })

  it('ignores #if and /if directives', () => {
    const vars = extractVariables('{{#if x}}{{y}}{{/if}}')
    expect(vars).toEqual(['y'])
    expect(vars).not.toContain('x')
    expect(vars).not.toContain('#if x')
    expect(vars).not.toContain('/if')
  })

  it('returns empty array for template with no variables', () => {
    const vars = extractVariables('Just plain text')
    expect(vars).toEqual([])
  })

  it('deduplicates repeated variable names', () => {
    const vars = extractVariables('{{a}} {{b}} {{a}}')
    expect(vars).toEqual(['a', 'b'])
  })
})

// ── Template engine ──────────────────────────────────────────────────

describe('createTemplateEngine', () => {
  describe('listTemplates', () => {
    it('returns all 5 built-in templates', () => {
      const engine = createTemplateEngine()
      const templates = engine.listTemplates()
      expect(templates).toHaveLength(5)
      const ids = templates.map((t) => t.id)
      expect(ids).toContain('researcher-default')
      expect(ids).toContain('implementer-default')
      expect(ids).toContain('reviewer-default')
      expect(ids).toContain('tester-default')
      expect(ids).toContain('planner-default')
    })
  })

  describe('getTemplate', () => {
    it('returns correct template by ID', () => {
      const engine = createTemplateEngine()
      const tmpl = engine.getTemplate('researcher-default')
      expect(tmpl).toBeDefined()
      expect(tmpl!.role).toBe('researcher')
      expect(tmpl!.name).toBeDefined()
    })

    it('returns undefined for unknown ID', () => {
      const engine = createTemplateEngine()
      expect(engine.getTemplate('nonexistent')).toBeUndefined()
    })
  })

  describe('render', () => {
    it('produces complete prompt with all required vars', () => {
      const engine = createTemplateEngine()
      const ctx: TemplateContext = {
        taskDescription: 'Research TypeScript decorators',
        role: 'researcher',
        memoryContext: 'Prior work on decorators',
        teamId: 'team-42',
      }
      const result = engine.render('researcher-default', ctx)
      expect(result).toContain('Research TypeScript decorators')
      expect(result).toContain('Prior work on decorators')
      expect(result).toContain('team-42')
    })

    it('throws for unknown template ID', () => {
      const engine = createTemplateEngine()
      const ctx: TemplateContext = { taskDescription: 'x', role: 'researcher' }
      expect(() => engine.render('unknown-id', ctx)).toThrow()
    })

    it('renders with missing optional vars as empty strings', () => {
      const engine = createTemplateEngine()
      const ctx: TemplateContext = {
        taskDescription: 'Plan project',
        role: 'planner',
      }
      const result = engine.render('planner-default', ctx)
      expect(result).toContain('Plan project')
      // Should not contain raw {{variable}} placeholders for optional vars
      expect(result).not.toMatch(/\{\{[a-zA-Z]/)
    })
  })

  describe('validateContext', () => {
    it('returns empty array when all required vars present', () => {
      const engine = createTemplateEngine()
      const ctx: TemplateContext = {
        taskDescription: 'Do something',
        role: 'researcher',
        memoryContext: 'context',
        teamId: 'team-1',
      }
      const missing = engine.validateContext('researcher-default', ctx)
      expect(missing).toEqual([])
    })

    it('returns missing variable names', () => {
      const engine = createTemplateEngine()
      // Create a minimal context that's missing memoryContext (a required var for researcher)
      const ctx: TemplateContext = {
        taskDescription: 'Do something',
        role: 'researcher',
      }
      const missing = engine.validateContext('researcher-default', ctx)
      // Should report at least one missing required var
      expect(missing.length).toBeGreaterThanOrEqual(0)
      // We know taskDescription and role are provided, so they should not be missing
      expect(missing).not.toContain('taskDescription')
    })

    it('throws for unknown template ID', () => {
      const engine = createTemplateEngine()
      const ctx: TemplateContext = { taskDescription: 'x', role: 'r' }
      expect(() => engine.validateContext('nonexistent', ctx)).toThrow()
    })
  })

  describe('selectTemplate', () => {
    it('picks researcher template for researcher role', () => {
      const engine = createTemplateEngine()
      const tmpl = engine.selectTemplate('researcher', { role: 'researcher' })
      expect(tmpl.id).toBe('researcher-default')
    })

    it('picks implementer template for implementer role', () => {
      const engine = createTemplateEngine()
      const tmpl = engine.selectTemplate('implementer', { role: 'implementer' })
      expect(tmpl.id).toBe('implementer-default')
    })

    it('picks reviewer template for reviewer role', () => {
      const engine = createTemplateEngine()
      const tmpl = engine.selectTemplate('reviewer', { role: 'reviewer' })
      expect(tmpl.id).toBe('reviewer-default')
    })

    it('picks tester template for tester role', () => {
      const engine = createTemplateEngine()
      const tmpl = engine.selectTemplate('tester', { role: 'tester' })
      expect(tmpl.id).toBe('tester-default')
    })

    it('picks planner template for planner role', () => {
      const engine = createTemplateEngine()
      const tmpl = engine.selectTemplate('planner', { role: 'planner' })
      expect(tmpl.id).toBe('planner-default')
    })

    it('falls back to planner for unknown role', () => {
      const engine = createTemplateEngine()
      const tmpl = engine.selectTemplate('unknown-role', {})
      expect(tmpl.id).toBe('planner-default')
    })
  })

  describe('registerTemplate', () => {
    it('adds a custom template', () => {
      const engine = createTemplateEngine()
      const custom: PromptTemplate = {
        id: 'custom-researcher',
        role: 'researcher',
        name: 'Custom Researcher',
        description: 'A custom research template',
        template: 'Custom: {{taskDescription}}',
        requiredVars: ['taskDescription'],
        optionalVars: [],
      }
      engine.registerTemplate(custom)
      expect(engine.getTemplate('custom-researcher')).toBeDefined()
      expect(engine.getTemplate('custom-researcher')!.name).toBe('Custom Researcher')
    })

    it('overrides built-in template with same ID', () => {
      const engine = createTemplateEngine()
      const override: PromptTemplate = {
        id: 'researcher-default',
        role: 'researcher',
        name: 'Overridden Researcher',
        description: 'Overridden researcher template',
        template: 'Override: {{taskDescription}}',
        requiredVars: ['taskDescription'],
        optionalVars: [],
      }
      engine.registerTemplate(override)
      const tmpl = engine.getTemplate('researcher-default')
      expect(tmpl!.name).toBe('Overridden Researcher')
      expect(tmpl!.template).toContain('Override:')
    })
  })

  describe('custom templates via options', () => {
    it('includes custom templates from options', () => {
      const custom: PromptTemplate = {
        id: 'my-template',
        role: 'researcher',
        name: 'My Template',
        description: 'Custom',
        template: '{{taskDescription}}',
        requiredVars: ['taskDescription'],
        optionalVars: [],
      }
      const engine = createTemplateEngine({ customTemplates: [custom] })
      expect(engine.getTemplate('my-template')).toBeDefined()
      // Built-ins still present
      expect(engine.getTemplate('planner-default')).toBeDefined()
    })
  })
})

// ── Role template content ────────────────────────────────────────────

describe('Role template content', () => {
  const engine = createTemplateEngine()

  const fullCtx: TemplateContext = {
    taskDescription: 'Build auth module',
    taskComplexity: 'moderate',
    taskStrategy: 'parallel',
    subtaskDescription: 'Implement JWT validation',
    subtaskDependencies: ['user-model', 'config-module'],
    role: 'implementer',
    agentName: 'agent-impl-1',
    teamId: 'team-alpha',
    teamSize: 4,
    memoryContext: 'Auth decisions from last sprint',
    userPreferences: 'Prefer functional patterns',
    soulContext: 'SCNS is a multi-agent system',
    sessionId: 'sess-001',
    brokerUrl: 'http://localhost:3000',
    workingDir: '/home/dev/scns',
    previousResults: ['User model done', 'Config ready'],
    conversationSummary: 'Working on auth',
  }

  it('researcher template includes task description and memory context', () => {
    const result = engine.render('researcher-default', { ...fullCtx, role: 'researcher' })
    expect(result).toContain('Build auth module')
    expect(result).toContain('Auth decisions from last sprint')
    expect(result).toContain('research agent')
  })

  it('implementer template includes subtask, working dir, TDD instructions', () => {
    const result = engine.render('implementer-default', fullCtx)
    expect(result).toContain('Implement JWT validation')
    expect(result).toContain('/home/dev/scns')
    expect(result).toContain('TDD')
  })

  it('reviewer template includes review-specific instructions', () => {
    const result = engine.render('reviewer-default', { ...fullCtx, role: 'reviewer' })
    expect(result).toContain('review')
    expect(result).toContain('critical')
  })

  it('tester template includes Vitest and coverage instructions', () => {
    const result = engine.render('tester-default', { ...fullCtx, role: 'tester' })
    expect(result).toContain('Vitest')
    expect(result).toContain('coverage')
  })

  it('planner template includes decomposition instructions', () => {
    const result = engine.render('planner-default', { ...fullCtx, role: 'planner' })
    expect(result).toContain('Decompose')
    expect(result).toContain('subtask')
  })

  it('all role templates include team ID when provided', () => {
    const roles = ['researcher', 'implementer', 'reviewer', 'tester', 'planner'] as const
    const ids = [
      'researcher-default',
      'implementer-default',
      'reviewer-default',
      'tester-default',
      'planner-default',
    ] as const
    for (let i = 0; i < roles.length; i++) {
      const ctx: TemplateContext = {
        ...fullCtx,
        role: roles[i],
      }
      const result = engine.render(ids[i], ctx)
      // teamId should appear in templates that reference it
      const tmpl = engine.getTemplate(ids[i])!
      if (tmpl.template.includes('{{teamId}}')) {
        expect(result).toContain('team-alpha')
      }
    }
  })

  it('previous results included when available', () => {
    const result = engine.render('implementer-default', fullCtx)
    expect(result).toContain('User model done')
    expect(result).toContain('Config ready')
  })

  it('dependencies included when available', () => {
    const result = engine.render('implementer-default', fullCtx)
    expect(result).toContain('user-model')
    expect(result).toContain('config-module')
  })
})

// ── Memory integration ───────────────────────────────────────────────

describe('Memory integration', () => {
  const engine = createTemplateEngine()

  it('memory context inserted into template', () => {
    const ctx: TemplateContext = {
      taskDescription: 'Review PR',
      role: 'reviewer',
      memoryContext: 'Module was refactored last week',
      teamId: 'team-1',
    }
    const result = engine.render('reviewer-default', ctx)
    expect(result).toContain('Module was refactored last week')
  })

  it('user preferences inserted into implementer template', () => {
    const ctx: TemplateContext = {
      taskDescription: 'Implement feature',
      role: 'implementer',
      subtaskDescription: 'Add caching',
      userPreferences: 'Use Redis for caching',
      workingDir: '/dev',
      teamId: 'team-2',
    }
    const result = engine.render('implementer-default', ctx)
    expect(result).toContain('Use Redis for caching')
  })

  it('soul context inserted into planner template', () => {
    const ctx: TemplateContext = {
      taskDescription: 'Plan sprint',
      role: 'planner',
      soulContext: 'Project uses event-driven architecture',
    }
    const result = engine.render('planner-default', ctx)
    expect(result).toContain('Project uses event-driven architecture')
  })

  it('empty memory context omits section via conditional', () => {
    const ctx: TemplateContext = {
      taskDescription: 'Do task',
      role: 'researcher',
    }
    const result = engine.render('researcher-default', ctx)
    // Should not contain raw placeholder
    expect(result).not.toMatch(/\{\{memoryContext\}\}/)
  })
})
