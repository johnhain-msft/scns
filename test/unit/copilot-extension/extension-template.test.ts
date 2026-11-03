import { describe, it, expect, vi } from 'vitest'
import * as nativeFs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generateExtensionSource } from '../../../src/copilot-extension/extension-template.js'
import { reconcileRuntimeJs } from '../../../src/copilot-extension/broker-reconcile.js'
import { TOOL_DEFINITIONS } from '../../../src/copilot-extension/tool-definitions.js'
import { isolatedHomeEnv } from '../../helpers/isolation.js'

describe('extension-template', () => {
  const defaultConfig = { brokerUrl: 'http://localhost:3456' }

  describe('generateExtensionSource', () => {
    it('produces valid JavaScript with import statement', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('import { joinSession } from "@github/copilot-sdk/extension"')
    })

    it('includes broker URL in source', () => {
      const source = generateExtensionSource({ brokerUrl: 'http://custom:9999' })
      expect(source).toContain('const BROKER_URL = "http://custom:9999"')
    })

    it('includes default timeout', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('const TIMEOUT_MS = 5000')
    })

    it('allows custom timeout', () => {
      const source = generateExtensionSource({ ...defaultConfig, timeoutMs: 1000 })
      expect(source).toContain('const TIMEOUT_MS = 1000')
    })

    it('includes all 6 hooks', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('onSessionStart:')
      expect(source).toContain('onSessionEnd:')
      expect(source).toContain('onUserPromptSubmitted:')
      expect(source).toContain('onPreToolUse:')
      expect(source).toContain('onPostToolUse:')
      expect(source).toContain('onErrorOccurred:')
    })

    it('includes all 13 SCNS tools', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('scns_memory_search')
      expect(source).toContain('scns_memory_store')
      expect(source).toContain('scns_suggestions')
      expect(source).toContain('scns_status')
      expect(source).toContain('scns_send_message')
      expect(source).toContain('scns_read_messages')
      expect(source).toContain('scns_team_status')
      expect(source).toContain('scns_declare_intent')
      expect(source).toContain('scns_release_intent')
      expect(source).toContain('scns_set_state')
      expect(source).toContain('scns_get_state')
      expect(source).toContain('scns_report_progress')
      expect(source).toContain('scns_heartbeat')
    })

    it('includes event listeners', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('tool.execution_start')
      expect(source).toContain('tool.execution_complete')
      expect(source).toContain('session.shutdown')
    })

    it('includes fire-and-forget HTTP helper', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('async function fetchBroker')
      expect(source).toContain('async function postBroker')
      expect(source).toContain('async function fireAndForget')
    })

    it('includes AbortController for timeout', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('AbortController')
      expect(source).toContain('controller.abort()')
    })

    it('includes config cache for context injection', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('getInjectionConfig')
      expect(source).toContain('CONFIG_CACHE_TTL_MS')
    })

    it('includes context injection in onUserPromptSubmitted', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('/api/extension/context')
    })

    it('N1: the context injection POST includes the session key (invocation.sessionId)', () => {
      const source = generateExtensionSource({ ...defaultConfig, contextInjection: true })
      const hookSection =
        source.split('onUserPromptSubmitted: async')[1]?.split('onPreToolUse:')[0] ?? ''
      expect(hookSection).toContain('/api/extension/context')
      expect(hookSection).toContain('sessionId: invocation.sessionId')
    })

    it('when contextInjection=true, skips config check (always injects)', () => {
      const source = generateExtensionSource({ ...defaultConfig, contextInjection: true })
      expect(source).toContain('/api/extension/context')
      // Extract onUserPromptSubmitted hook body (between the async handler and onPreToolUse)
      const hookSection =
        source.split('onUserPromptSubmitted: async')[1]?.split('onPreToolUse:')[0] ?? ''
      expect(hookSection).not.toContain('getInjectionConfig')
      expect(hookSection).not.toContain('contextInjectionEnabled')
      expect(hookSection).toContain('Context injection always enabled')
    })

    it('when contextInjection=false, uses config check (opt-in)', () => {
      const source = generateExtensionSource({ ...defaultConfig, contextInjection: false })
      const hookSection =
        source.split('onUserPromptSubmitted: async')[1]?.split('onPreToolUse:')[0] ?? ''
      expect(hookSection).toContain('getInjectionConfig')
      expect(hookSection).toContain('contextInjectionEnabled')
      expect(hookSection).toContain('opt-in via broker config')
    })

    it('true and false branches produce different context injection code', () => {
      const sourceOn = generateExtensionSource({ ...defaultConfig, contextInjection: true })
      const sourceOff = generateExtensionSource({ ...defaultConfig, contextInjection: false })
      const hookOn =
        sourceOn.split('onUserPromptSubmitted: async')[1]?.split('onPreToolUse:')[0] ?? ''
      const hookOff =
        sourceOff.split('onUserPromptSubmitted: async')[1]?.split('onPreToolUse:')[0] ?? ''
      expect(hookOn).not.toBe(hookOff)
    })

    it('notes context injection default OFF', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('Context injection default: OFF')
    })

    it('notes context injection default ON when configured', () => {
      const source = generateExtensionSource({ ...defaultConfig, contextInjection: true })
      expect(source).toContain('Context injection default: ON')
    })

    it('includes forwardHook function', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('function forwardHook')
      expect(source).toContain('/api/hooks/')
    })

    it('includes a startup confirmation notice, gated to once per activation', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('announceOnce("SCNS extension loaded (broker: "')
      expect(source).toContain('async function announceOnce(')
    })

    // Regression: the extension host was forked 5-8 times PER SESSION, each fork
    // re-printing "SCNS extension loaded". Measured 2026-09-15 for session
    // 77bef3f6: six forks inside 33s (00:19:36 → 00:20:09), five of them
    // "exit code=0 disposition=stopped-normally" before one survived.
    // Cause: `await resolveBrokerUrl("startup")` ran at module top level BEFORE
    // joinSession(), and that resolve retries for up to CHILD_READY_TIMEOUT_MS
    // (20s) whenever the cwd's child broker is missing or recovering — which is
    // exactly the "no child / global fallback" case. A load that blocks longer
    // than the CLI's extension-load deadline is torn down and re-forked.
    describe('startup must not block the extension load (re-fork storm)', () => {
      it('joins the session BEFORE kicking off the startup broker resolve', () => {
        const source = generateExtensionSource(defaultConfig)
        const join = source.indexOf('await joinSession(')
        const startup = source.indexOf('resolveBrokerUrl("startup")')
        expect(join).toBeGreaterThanOrEqual(0)
        expect(startup).toBeGreaterThanOrEqual(0)
        expect(join).toBeLessThan(startup)
      })

      it('never awaits the startup resolve at module top level', () => {
        const source = generateExtensionSource(defaultConfig)
        // Column-0 await === the load path. An await nested inside the deferred
        // IIFE is fine, and is what keeps reconcile-before-resolve ordering.
        expect(source).not.toMatch(/^await resolveBrokerUrl\("startup"\);$/m)
      })

      // The safety invariant this must NOT trade away: no read or write may run
      // on an unresolved route. Every broker call funnels through fetchBroker →
      // recoverProjectRoute, so the startup promise has to be awaited there.
      it('still makes every broker request wait for the startup resolve', () => {
        const source = generateExtensionSource(defaultConfig)
        expect(source).toContain('async function awaitStartupResolution()')
        const recover = source.slice(source.indexOf('async function recoverProjectRoute()'))
        expect(recover.indexOf('await awaitStartupResolution()')).toBeGreaterThanOrEqual(0)
        expect(recover.indexOf('await awaitStartupResolution()')).toBeLessThan(
          recover.indexOf('projectRecoveryPending'),
        )
        const fetchFn = source.slice(source.indexOf('async function fetchBroker('))
        expect(fetchFn.indexOf('await recoverProjectRoute()')).toBeLessThan(
          fetchFn.indexOf('effectiveBrokerUrl'),
        )
      })

      it('logs the loaded banner only after resolution settles', () => {
        const source = generateExtensionSource(defaultConfig)
        const banner = source.indexOf('.then(() => announceRouteStatus())')
        const kickoff = source.indexOf('startupResolution = (async () =>')
        expect(kickoff).toBeGreaterThanOrEqual(0)
        expect(banner).toBeGreaterThanOrEqual(0)
        expect(kickoff).toBeLessThan(banner)
      })
    })

    // The generated file is shipped as-is into ~/.copilot/extensions, so dead
    // imports in it are dead code on the user's machine rather than something a
    // bundler drops. Checked generically so the next added import is covered too.
    it.each([
      ['without reconcile', undefined],
      [
        'with reconcile',
        {
          enabled: true,
          startCommand: { command: 'node', args: ['cli.js', 'watchdog', 'run'] },
          lockPath: 'C:/tmp/session-reconcile.lock',
        },
      ],
    ])('imports nothing it does not use (%s)', (_label, reconcile) => {
      const source = generateExtensionSource(
        reconcile ? { ...defaultConfig, reconcile } : defaultConfig,
      )
      const unused: string[] = []
      for (const m of source.matchAll(/^import \{([^}]*)\} from "[^"]+";$/gm)) {
        for (const raw of m[1]!.split(',')) {
          const name = raw
            .trim()
            .split(/\s+as\s+/)
            .pop()!
            .trim()
          if (!name) continue
          const uses = source.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0
          if (uses <= 1) unused.push(name)
        }
      }
      expect(unused).toEqual([])
    })

    it('truncates prompts to 500 chars', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('input.prompt.slice(0, 500)')
    })

    it('includes event map for hook-to-event translation', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('onSessionStart: "session-start"')
      expect(source).toContain('onSessionEnd: "session-end"')
      expect(source).toContain('onPreToolUse: "pre-tool-use"')
      expect(source).toContain('onPostToolUse: "post-tool-use"')
      expect(source).toContain('onUserPromptSubmitted: "user-prompt"')
      expect(source).toContain('onErrorOccurred: "error"')
    })

    it('does not import from src/ (standalone)', () => {
      const source = generateExtensionSource(defaultConfig)
      // Should only import from @github/copilot-sdk
      const imports = source.match(/^import .+ from .+$/gm) ?? []
      for (const imp of imports) {
        expect(imp).toContain('@github/copilot-sdk')
      }
    })

    it('sets extensionSessionId from invocation', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('extensionSessionId = invocation.sessionId')
    })

    it('uses custom config cache TTL', () => {
      const source = generateExtensionSource({ ...defaultConfig, configCacheTtlMs: 30_000 })
      expect(source).toContain('const CONFIG_CACHE_TTL_MS = 30000')
    })
  })

  describe('team-mode identity (GAP-NEW-004)', () => {
    it('reads SCNS env vars at startup', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('process.env.SCNS_SESSION_ID')
      expect(source).toContain('process.env.SCNS_TEAM_ID')
      expect(source).toContain('process.env.SCNS_ROLE')
      expect(source).toContain('process.env.SCNS_BROKER_URL')
    })

    it('defines IS_TEAM_MODE flag based on env vars', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('IS_TEAM_MODE')
      expect(source).toContain('SCNS_SESSION_ID && SCNS_TEAM_ID && SCNS_BROKER_URL')
    })

    it('effective broker URL prefers the env var over the compiled default', () => {
      // W5 evolved EFFECTIVE_BROKER_URL (const) into effectiveBrokerUrl
      // (resolved); the env-wins contract is unchanged.
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('effectiveBrokerUrl')
      expect(source).toContain('SCNS_BROKER_URL || BROKER_URL')
    })

    it('pins fetch helpers to the checked broker URL, not raw BROKER_URL', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('broker = effectiveBrokerUrl')
      expect(source).toContain('fetch(broker + path')
    })

    it('SCNS_ROLE defaults to dev when env var is not set', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain("process.env.SCNS_ROLE || 'dev'")
    })

    it('env vars are declared before HTTP helpers', () => {
      const source = generateExtensionSource(defaultConfig)
      const envVarPos = source.indexOf('SCNS_SESSION_ID')
      const fetchHelperPos = source.indexOf('async function fetchBroker')
      expect(envVarPos).toBeGreaterThan(-1)
      expect(fetchHelperPos).toBeGreaterThan(-1)
      expect(envVarPos).toBeLessThan(fetchHelperPos)
    })

    it('auto-joins team on session start when in team mode', () => {
      const source = generateExtensionSource(defaultConfig)
      const sessionStartHook =
        source.split('onSessionStart: async')[1]?.split('onSessionEnd: async')[0] ?? ''
      expect(sessionStartHook).toContain('IS_TEAM_MODE')
      expect(sessionStartHook).toContain('/api/teams/')
      expect(sessionStartHook).toContain('SCNS_TEAM_ID')
      expect(sessionStartHook).toContain('SCNS_SESSION_ID')
      expect(sessionStartHook).toContain('SCNS_ROLE')
    })

    it('auto-leaves on session end when in team mode', () => {
      const source = generateExtensionSource(defaultConfig)
      const sessionEndHook =
        source.split('onSessionEnd: async')[1]?.split('onUserPromptSubmitted: async')[0] ?? ''
      expect(sessionEndHook).toContain('IS_TEAM_MODE')
      expect(sessionEndHook).toContain('/api/deregister/')
      expect(sessionEndHook).toContain('SCNS_SESSION_ID')
    })

    it('starts heartbeat interval when in team mode', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('setInterval')
      expect(source).toContain('/api/heartbeat')
      expect(source).toContain('SCNS_SESSION_ID')
      expect(source).toContain('15000')
    })

    it('lease heartbeat runs in ALL modes, keyed to the effective session id (issue #70)', () => {
      const source = generateExtensionSource(defaultConfig)
      // The heartbeat section appears after the joinSession call and tools block
      const heartbeatSection =
        source.split('Team-mode heartbeat')[1]?.split('Event listeners')[0] ?? ''
      // No IS_TEAM_MODE gate around the interval any more — ordinary and
      // resumed sessions must keep their lease alive through approval waits.
      expect(heartbeatSection).toContain('setInterval')
      expect(heartbeatSection).toContain('effectiveSessionId()')
      expect(heartbeatSection).not.toMatch(
        /if \(IS_TEAM_MODE\) \{\s*\n\s*heartbeatInterval = setInterval/,
      )
    })

    it('auto-re-register is interactive-only, 404-only, and carries the real cwd (issue #70 S5)', () => {
      const source = generateExtensionSource(defaultConfig)
      const heartbeatSection =
        source.split('Team-mode heartbeat')[1]?.split('Event listeners')[0] ?? ''
      // Only a genuine "broker forgot this session" (HTTP 404) triggers it —
      // transport errors and 500s never do — and team agents never
      // self-re-register a row the broker deliberately purged.
      expect(heartbeatSection).toContain('res.status === 404 && !IS_TEAM_MODE')
      expect(heartbeatSection).toContain("postBroker('/api/register'")
      // The re-register carries the hook-captured cwd, not a broker guess.
      expect(heartbeatSection).toContain('working_dir: extensionCwd')
      // The verbose helper is used so 404 is distinguishable from transport failure.
      expect(heartbeatSection).toContain("postBrokerVerbose('/api/heartbeat'")
    })

    it('includes team context injection in onUserPromptSubmitted', () => {
      const source = generateExtensionSource(defaultConfig)
      const promptHook =
        source.split('onUserPromptSubmitted: async')[1]?.split('onPreToolUse:')[0] ?? ''
      expect(promptHook).toContain('IS_TEAM_MODE')
    })

    it('fetches team messages and status for context in team mode', () => {
      const source = generateExtensionSource(defaultConfig)
      const promptHook =
        source.split('onUserPromptSubmitted: async')[1]?.split('onPreToolUse:')[0] ?? ''
      expect(promptHook).toContain('/api/messages/')
      expect(promptHook).toContain('/api/teams/')
    })

    it('solo mode does not auto-join or auto-leave (guards present)', () => {
      const source = generateExtensionSource(defaultConfig)
      // The auto-join and auto-leave are inside IS_TEAM_MODE guards
      const sessionStartHook =
        source.split('onSessionStart: async')[1]?.split('onSessionEnd: async')[0] ?? ''
      const sessionEndHook =
        source.split('onSessionEnd: async')[1]?.split('onUserPromptSubmitted: async')[0] ?? ''
      // Verify the team operations only appear inside IS_TEAM_MODE blocks
      expect(sessionStartHook).toContain('if (IS_TEAM_MODE)')
      expect(sessionEndHook).toContain('if (IS_TEAM_MODE)')
    })

    it('clears heartbeat interval on session end', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('clearInterval')
    })
  })

  // ── W5 — single-source tools + per-project routing ────────────────
  describe('W5 single source of truth + child routing', () => {
    it('emits every tool from TOOL_DEFINITIONS (no separate hardcoded list)', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(TOOL_DEFINITIONS.length).toBe(21)
      for (const def of TOOL_DEFINITIONS) {
        expect(source).toContain(JSON.stringify(def.name))
      }
    })

    it('ships scns_report_negative_feedback wired to /api/memory/negative', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('scns_report_negative_feedback')
      expect(source).toContain('/api/memory/negative')
    })

    it('feedback tool fails loudly and echoes which broker stored it', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('FEEDBACK NOT STORED')
      expect(source).toContain('storedAt')
    })

    it('resolves the child broker for cwd at startup (env → meta-resolve → global)', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('/api/meta/resolve?path=')
      expect(source).toContain('resolveBrokerUrl')
      expect(source).toContain('SCNS_BROKER_URL')
    })

    it('re-resolves once when a broker fetch fails', () => {
      const source = generateExtensionSource(defaultConfig)
      expect(source).toContain('re-resolve-after-failure')
    })
  })
})

describe('W5 feedback re-resolve retry (PR review)', () => {
  it('postBrokerVerbose retries once after re-resolve on transport failure', () => {
    const source = generateExtensionSource({ brokerUrl: 'http://localhost:3456' })
    expect(source).toContain('postBrokerVerboseOnce')
    const verbose =
      source.split('async function postBrokerVerbose(')[1]?.split('\nasync function')[0] ?? ''
    expect(verbose).toContain('retriable')
    expect(verbose).toContain('resolveBrokerUrl("re-resolve-after-failure")')
  })
})

describe('W5 feedback transport origin (blind-review finding 1)', () => {
  it('feedback tool declares team-agent transport when in team mode', () => {
    const source = generateExtensionSource({ brokerUrl: 'http://localhost:3456' })
    expect(source).toContain('transportOrigin')
    expect(source).toContain('IS_TEAM_MODE ? "team-agent" : "interactive"')
  })
})

// ── WI-2(b): auth header plumbing in the generated source ─────────────────

describe('WI-2b — generated auth headers', () => {
  it('with a token: every raw fetch site sends Authorization: Bearer', () => {
    const source = generateExtensionSource({
      brokerUrl: 'http://localhost:3456',
      brokerToken: 'secret-token',
    })
    expect(source).toContain('const BROKER_TOKEN = "secret-token"')
    expect(source).toContain('function authHeaders()')
    // All three raw fetch() sites merge authHeaders(): the meta-resolve call,
    // fetchBrokerOnce, and postBrokerVerboseOnce.
    const authUses = source.match(/authHeaders\(\)/g) ?? []
    expect(authUses.length).toBeGreaterThanOrEqual(4) // definition + 3 sites
  })

  it('without a token: BROKER_TOKEN is null and no Bearer literal is baked in', () => {
    const source = generateExtensionSource({ brokerUrl: 'http://localhost:3456' })
    expect(source).toContain('const BROKER_TOKEN = null')
    expect(source).not.toContain('Bearer secret')
  })

  it('caller-supplied headers survive the merge (Content-Type kept)', () => {
    const source = generateExtensionSource({
      brokerUrl: 'http://localhost:3456',
      brokerToken: 't',
    })
    // postBroker sets Content-Type via options.headers — the merged spread in
    // fetchBrokerOnce must keep both. Guard the merge shape textually.
    expect(source).toContain('...authHeaders(), ...(options.headers || {})')
  })
})

// ── WI-4: strict-routing guard (SCNS_REQUIRE_PROJECT_BROKER) ──────────────

describe('WI-4 — strict-routing guard', () => {
  const source = generateExtensionSource({ brokerUrl: 'http://localhost:3456' })

  it('is env-gated and default OFF (flag read at session runtime)', () => {
    expect(source).toContain('process.env.SCNS_REQUIRE_PROJECT_BROKER === "1"')
  })

  it('refuses scns_memory_store on any global:* route with an actionable reason', () => {
    expect(source).toContain('function strictStoreRefusal()')
    expect(source).toContain('brokerRouteLabel.startsWith("global:")')
    expect(source).toContain('scns meta-broker register')
    // The store handler consults the guard before posting.
    const storeHandler = source.slice(source.indexOf('scns_memory_store'))
    expect(storeHandler.indexOf('strictStoreRefusal()')).toBeGreaterThanOrEqual(0)
    expect(storeHandler.indexOf('strictStoreRefusal()')).toBeLessThan(
      storeHandler.indexOf('/api/memory/store'),
    )
  })

  it('logs the loud line exactly once per session (guarded by strictRoutingWarned)', () => {
    expect(source).toContain('strictRoutingWarned')
    expect(source).toContain('STRICT ROUTING')
  })

  it('leaves reads (scns_memory_search) unguarded', () => {
    const searchHandler = source.slice(
      source.indexOf('scns_memory_search'),
      source.indexOf('scns_memory_store'),
    )
    expect(searchHandler).not.toContain('strictStoreRefusal')
  })
})

describe('WI-4 — strict guard runtime behavior (evaluated handler)', () => {
  // Execute the generated guard + store handler in isolation with a stubbed
  // environment to prove the actual refusal semantics, not just the text.
  function runGuard(opts: { flag: string | undefined; label: string }): {
    refusal: { stored: boolean; refused: boolean; reason: string } | null
    warnings: string[]
  } {
    const warnings: string[] = []
    const fn = new Function(
      'process',
      'console',
      'brokerRouteLabel',
      `
      const STRICT_PROJECT_BROKER = process.env.SCNS_REQUIRE_PROJECT_BROKER === "1";
      let strictRoutingWarned = false;
      function strictStoreRefusal() {
        if (!STRICT_PROJECT_BROKER) return null;
        if (!brokerRouteLabel.startsWith("global:")) return null;
        if (!strictRoutingWarned) {
          strictRoutingWarned = true;
          console.error("[SCNS] STRICT ROUTING refused");
        }
        return { stored: false, refused: true, reason: "strict-project-broker: " + brokerRouteLabel };
      }
      return [strictStoreRefusal(), strictStoreRefusal()];
      `,
    )
    const [first] = fn(
      { env: { SCNS_REQUIRE_PROJECT_BROKER: opts.flag } },
      { error: (m: string) => warnings.push(m) },
      opts.label,
    ) as [ReturnType<typeof runGuard>['refusal'], unknown]
    return { refusal: first, warnings }
  }

  it('OFF by default: global route still stores', () => {
    expect(runGuard({ flag: undefined, label: 'global:default' }).refusal).toBeNull()
  })

  it('ON + global:default → refuses; ON + global:fallback → refuses', () => {
    expect(runGuard({ flag: '1', label: 'global:default' }).refusal?.refused).toBe(true)
    expect(runGuard({ flag: '1', label: 'global:fallback' }).refusal?.refused).toBe(true)
  })

  it('ON + project or env-pinned route → allowed', () => {
    expect(runGuard({ flag: '1', label: 'project:my-repo' }).refusal).toBeNull()
    expect(runGuard({ flag: '1', label: 'env:SCNS_BROKER_URL' }).refusal).toBeNull()
  })

  it('warns exactly once across repeated refusals', () => {
    const { warnings } = runGuard({ flag: '1', label: 'global:default' })
    expect(warnings).toHaveLength(1)
  })
})

// ── #61 option A — session-start reconciliation ──────────────────────
describe('#61 — session-start reconciliation', () => {
  const RECONCILE = {
    enabled: true,
    startCommand: {
      command: 'C:\\node\\node.exe',
      args: ['C:\\scns\\dist\\cli.js', 'watchdog', 'run'],
    },
    lockPath: 'C:\\Users\\jh\\.scns\\run\\session-reconcile.lock',
  }

  it('is absent from the generated source when not configured (opt-in, no surprise spawns)', () => {
    const src = generateExtensionSource({ brokerUrl: 'http://localhost:3456' })
    expect(src).not.toContain('ensureBrokerAlive')
    expect(src).not.toContain('node:child_process')
  })

  it('emits the reconcile step when configured', () => {
    const src = generateExtensionSource({
      brokerUrl: 'http://localhost:3456',
      reconcile: RECONCILE,
    })
    expect(src).toContain('ensureBrokerAlive')
    expect(src).toContain('decideReconcile')
  })

  it('runs BEFORE broker resolution — resolving against a dead broker is the bug', () => {
    const src = generateExtensionSource({
      brokerUrl: 'http://localhost:3456',
      reconcile: RECONCILE,
    })
    expect(src.indexOf('await ensureBrokerAlive()')).toBeGreaterThan(-1)
    expect(src.indexOf('await ensureBrokerAlive()')).toBeLessThan(
      src.indexOf('await resolveBrokerUrl("startup")'),
    )
  })

  it('probes /api/health on the GLOBAL broker url, never a write endpoint', () => {
    const src = generateExtensionSource({
      brokerUrl: 'http://localhost:3456',
      reconcile: RECONCILE,
    })
    expect(src).toContain('BROKER_URL + "/api/health"')
    expect(src).not.toContain('reconcile:/api/extension/context')
  })

  it('bakes the start command in as JSON, not as an interpolated shell string', () => {
    const src = generateExtensionSource({
      brokerUrl: 'http://localhost:3456',
      reconcile: RECONCILE,
    })
    expect(src).toContain(JSON.stringify(RECONCILE.startCommand.command))
    expect(src).toContain(JSON.stringify(RECONCILE.startCommand.args))
    expect(src).not.toContain('exec(')
    expect(src).not.toContain('shell: true')
  })

  it('spawns detached and unref-ed so the stack outlives the Copilot session', () => {
    const src = generateExtensionSource({
      brokerUrl: 'http://localhost:3456',
      reconcile: RECONCILE,
    })
    expect(src).toContain('detached: true')
    expect(src).toContain('.unref()')
  })

  it('honours the SCNS_SESSION_RECONCILE=0 kill-switch', () => {
    const src = generateExtensionSource({
      brokerUrl: 'http://localhost:3456',
      reconcile: RECONCILE,
    })
    expect(src).toContain('SCNS_SESSION_RECONCILE')
  })

  it('embeds the same decision core as broker-reconcile.ts', () => {
    const src = generateExtensionSource({
      brokerUrl: 'http://localhost:3456',
      reconcile: RECONCILE,
    })
    expect(src).toContain(reconcileRuntimeJs())
  })

  it('never throws out of the extension — a failed reconcile must not break the session', () => {
    const src = generateExtensionSource({
      brokerUrl: 'http://localhost:3456',
      reconcile: RECONCILE,
    })
    const fn = src.slice(src.indexOf('async function ensureBrokerAlive'))
    expect(fn).toContain('catch')
  })
})

// The generated file is a standalone .mjs that no build step ever sees, so a
// syntax error in an emitted template string would only surface when a Copilot
// session failed to load. Parse it for real.
describe('#61 — generated source parses as a real ES module', () => {
  const RECONCILE = {
    enabled: true,
    startCommand: { command: 'node', args: ['/repo/dist/cli.js', 'watchdog', 'run'] },
    lockPath: '/home/jh/.scns/run/session-reconcile.lock',
  }

  function assertParses(src: string): void {
    const dir = mkdtempSync(join(tmpdir(), 'scns-ext-'))
    const file = join(dir, 'extension.mjs')
    try {
      writeFileSync(file, src, 'utf-8')
      const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' })
      expect(`${res.status} ${res.stderr ?? ''}`).toBe('0 ')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const routeConfig = { brokerUrl: 'http://localhost:3456' }

  it('gates all write methods on route identity', () => {
    const source = generateExtensionSource(routeConfig)
    // The decision helper is emitted from the shared core.
    expect(source).toContain('function routeIdentityVerdict(expectedProjectId, actualProjectId)')
    expect(source).toContain('async function assertRouteIdentity()')
    // Identity is read from the broker's echoed project_id.
    expect(source).toContain('data.project_id')
    // Both write paths are gated; reads are not.
    expect(source).toContain('!["GET", "HEAD"].includes((options.method || "GET").toUpperCase())')
    expect(source).toMatch(/async function postBrokerVerbose\([\s\S]{0,200}assertRouteIdentity\(\)/)
  })

  it('tracks the resolved project id for identity comparison', () => {
    const source = generateExtensionSource(routeConfig)
    expect(source).toContain('let resolvedProjectId = null;')
    expect(source).toContain('if (projectId) resolvedProjectId = projectId;')
    // An outage preserves the owner; clearing it would make the write guard skip.
    expect(source).not.toContain(
      'brokerRouteLabel = "global:fallback";\n  resolvedProjectId = null;',
    )
    expect(source).toContain('projectRecoveryPending = resolvedProjectId !== null;')
  })

  it('leaves team mode pinned to its env broker', () => {
    const source = generateExtensionSource(routeConfig)
    expect(source).toContain(
      'if (IS_TEAM_MODE || expectedProject === null) return { broker, refusal: null };',
    )
  })

  it('parses with reconciliation enabled', () => {
    assertParses(
      generateExtensionSource({ brokerUrl: 'http://localhost:3456', reconcile: RECONCILE }),
    )
  })

  it('parses with reconciliation absent (pre-#61 shape)', () => {
    assertParses(generateExtensionSource({ brokerUrl: 'http://localhost:3456' }))
  })

  it('parses with a Windows start command, whose backslashes must survive escaping', () => {
    assertParses(
      generateExtensionSource({
        brokerUrl: 'http://localhost:3456',
        reconcile: {
          enabled: true,
          startCommand: {
            command: 'C:\\Program Files\\nodejs\\node.exe',
            args: ['C:\\Users\\jh\\scns\\dist\\cli.js', 'watchdog', 'run'],
          },
          lockPath: 'C:\\Users\\jh\\.scns\\run\\session-reconcile.lock',
        },
      }),
    )
  })
})

// ── #61 option C: a child port swap must not strand an in-flight session ──
//
// The child-broker blue/green swap (meta-broker/child-blue-green.ts) moves a
// project to a NEW port and repoints the meta registry. A session that resolved
// the old port at startup keeps using it until blue drains. The only thing that
// rescues it afterwards is the one-shot re-resolve below — so this executes the
// generated code rather than grepping it, because a string match cannot tell
// you whether the retry actually reaches the new broker.
describe('child blue/green port swap, from the session side (#61)', () => {
  /**
   * Build a runnable slice of the generated extension: the resolution chain
   * plus the fetch helpers, with `fetch` and `process.cwd` injected.
   */
  function buildHarness(fetchImpl: (url: string, init?: unknown) => Promise<unknown>) {
    const source = generateExtensionSource({ brokerUrl: 'http://localhost:3456' })
    const slice = (startMarker: string, endMarker: string): string => {
      const from = source.indexOf(startMarker)
      const to = source.indexOf(endMarker, from)
      if (from === -1 || to === -1) throw new Error(`could not slice ${startMarker}`)
      return source.slice(from, to)
    }
    const resolution = slice('let effectiveBrokerUrl', '// ── Config cache')
    const helpers = slice('function authHeaders()', 'async function postBrokerVerboseOnce')

    const factory = new Function(
      'fetch',
      'process',
      'AbortSignal',
      `
      const BROKER_URL = "http://localhost:3456";
      const SCNS_BROKER_URL = "";
      const BROKER_TOKEN = "";
      const TIMEOUT_MS = 5000;
      const IS_TEAM_MODE = false;
      ${resolution}
      ${helpers}
      return {
        resolveBrokerUrl,
        fetchBroker,
        route: () => brokerRouteLabel,
        url: () => effectiveBrokerUrl,
        log: () => brokerResolutionLog,
      };
      `,
    ) as (
      f: unknown,
      p: unknown,
      a: unknown,
    ) => {
      resolveBrokerUrl: (t: string) => Promise<void>
      fetchBroker: (p: string, o?: unknown) => Promise<unknown>
      route: () => string
      url: () => string
      log: () => string[]
    }

    return factory(
      fetchImpl,
      { cwd: () => 'C:\\repo\\proj-a', env: {} },
      {
        timeout: () => undefined,
      },
    )
  }

  const jsonResponse = (body: unknown): unknown => ({
    ok: true,
    status: 200,
    json: async () => body,
  })

  it('follows the registry to the new port after blue stops answering', async () => {
    // Blue on 3500, green on 3502 — exactly what swapChildBroker produces.
    let bluePort = 3500
    const greenPort = 3502
    const seen: string[] = []

    const harness = buildHarness(async (url: string) => {
      seen.push(url)
      if (url.includes('/api/meta/resolve')) {
        return jsonResponse({
          resolved: true,
          projectId: 'proj-a',
          brokerUrl: `http://localhost:${bluePort}`,
        })
      }
      if (url.startsWith(`http://localhost:${greenPort}`)) {
        return jsonResponse({ served: 'green' })
      }
      // Blue has been drained and stopped: transport failure, not an HTTP error.
      throw new Error('ECONNREFUSED')
    })

    await harness.resolveBrokerUrl('startup')
    expect(harness.url()).toBe('http://localhost:3500')
    expect(harness.route()).toBe('project:proj-a')

    // The swap completes: the registry now returns green.
    bluePort = greenPort

    const result = await harness.fetchBroker('/api/memory/search')
    expect(result).toEqual({ served: 'green' })
    expect(harness.url()).toBe('http://localhost:3502')
    expect(seen.filter((u) => u.includes('/api/meta/resolve'))).toHaveLength(2)
  })

  it('does not strand the session on global fallback when the child simply moved', async () => {
    const harness = buildHarness(async (url: string) => {
      if (url.includes('/api/meta/resolve')) {
        return jsonResponse({
          resolved: true,
          projectId: 'proj-a',
          brokerUrl: 'http://localhost:3502',
        })
      }
      if (url.startsWith('http://localhost:3502')) return jsonResponse({ ok: true })
      throw new Error('ECONNREFUSED')
    })

    await harness.resolveBrokerUrl('startup')
    await harness.fetchBroker('/api/memory/search')
    // The failure this guards: falling back to the global broker means every
    // subsequent memory write lands in the shared brain instead of the project.
    expect(harness.route()).toBe('project:proj-a')
  })

  it('re-resolves at most once, so a genuinely dead project cannot loop', async () => {
    let resolves = 0
    const harness = buildHarness(async (url: string) => {
      if (url.includes('/api/meta/resolve')) {
        resolves += 1
        return jsonResponse({
          resolved: true,
          projectId: 'proj-a',
          brokerUrl: 'http://localhost:3500',
        })
      }
      throw new Error('ECONNREFUSED')
    })

    await harness.resolveBrokerUrl('startup')
    expect(await harness.fetchBroker('/api/memory/search')).toBeNull()
    expect(await harness.fetchBroker('/api/memory/search')).toBeNull()
    expect(await harness.fetchBroker('/api/memory/search')).toBeNull()
    expect(resolves).toBe(2) // startup + exactly one re-resolve
  })
})

// ── One startup notice per activation, across process replacement ────
//
// Separate processes are necessary: a module-local flag cannot cover replacement.
describe('startup notice — one per activation (#61 follow-up)', () => {
  const routeConfig = { brokerUrl: 'http://localhost:3456' }

  function lockRuntime() {
    const source = generateExtensionSource(routeConfig)
    // Vitest's Function context has no dynamic-import callback. Supply the
    // actual native modules; the generated lock algorithm remains unchanged.
    const body = source
      .slice(
        source.indexOf('async function acquireNoticeLock('),
        source.indexOf('async function deliverNotice('),
      )
      .replace('await import("node:path")', 'pathModule')
      .replace('await import("node:crypto")', 'cryptoModule')
    return new Function('pathModule', 'cryptoModule', `${body}; return acquireNoticeLock;`)(
      { join },
      { randomUUID },
    ) as (fs: object, file: string) => Promise<{ directory: string }>
  }

  it.each([
    ['publish', 'EPERM'],
    ['publish', 'EACCES'],
    ['publish', 'EBUSY'],
    ['inspect', 'EPERM'],
    ['inspect', 'EACCES'],
    ['inspect', 'EBUSY'],
  ])(
    'retries Windows contention during %s (%s) without bypassing the receipt',
    async (stage, code) => {
      const home = isolatedHome()
      const acquire = lockRuntime()
      let attempts = 0
      const fs = {
        ...nativeFs,
        renameSync(from: nativeFs.PathLike, to: nativeFs.PathLike) {
          if (++attempts === 1) {
            throw Object.assign(new Error('Windows publication contention'), {
              code: stage === 'publish' ? code : 'EEXIST',
            })
          }
          return nativeFs.renameSync(from, to)
        },
        lstatSync(path: nativeFs.PathLike) {
          if (stage === 'inspect' && attempts === 1) {
            throw Object.assign(new Error('Windows handle is closing'), { code })
          }
          return nativeFs.lstatSync(path)
        },
      }
      try {
        const file = join(home, 'notice.json')
        expect((await acquire(fs, file)).directory).toBe(file + '.lock')
        expect(attempts).toBe(2)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
  )

  /** Slice the emitted notice runtime out of the generated extension. */
  function noticeRuntime(): string {
    const source = generateExtensionSource(routeConfig)
    const from = source.indexOf('function decideStartupNotice(')
    const to = source.indexOf('// ── HTTP helpers', from)
    if (from === -1 || to === -1) throw new Error('could not slice the notice runtime')
    return source.slice(from, to)
  }

  /**
   * Run one simulated extension-host fork in its own process and report what
   * it would have shown the user.
   */
  function runFork(opts: {
    scnsHome: string
    sessionId: string
    messages: ReadonlyArray<[string, string]>
    activationId?: string
    now?: number
    rejectLog?: boolean
    concurrent?: boolean
    hostCopies?: number
    abandonedOwner?: boolean
  }): { logged: string[]; stderr: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'scns-notice-'))
    const file = join(dir, 'fork.mjs')
    try {
      writeFileSync(
        file,
        `let brokerResolutionSession = null;
${noticeRuntime()}
${opts.now === undefined ? '' : `Date.now = () => ${opts.now};`}
const shown = [];
brokerResolutionSession = {
  sessionId: ${JSON.stringify(opts.sessionId)},
  workspacePath: ${JSON.stringify(join(opts.scnsHome, '.copilot', 'session-state', opts.sessionId || 'unknown'))},
  getEvents: async () => [{ type: "session.start", id: ${JSON.stringify(opts.activationId ?? 'activation-a')} }],
  log: async (message, options) => {
    if (${opts.rejectLog ?? false}) throw new Error("notice rejected");
    shown.push({ message, level: (options && options.level) || "info" });
  },
};
const diagnostics = [];
const realError = console.error;
console.error = (...a) => { diagnostics.push(a.join(" ")); };
const messages = ${JSON.stringify(opts.messages)};
if (${opts.concurrent ?? false}) {
  await Promise.all(messages.map(([level, message]) => announceOnce(message, level)));
} else {
  for (const [level, message] of messages) await announceOnce(message, level);
}
console.error = realError;
process.stdout.write(JSON.stringify({ shown, diagnostics }));
`,
        'utf-8',
      )
      let executable = file
      if (opts.hostCopies) {
        const ownerScript = join(dir, 'owner.mjs')
        if (opts.abandonedOwner) {
          writeFileSync(
            ownerScript,
            `${noticeRuntime()}
import * as fs from "node:fs";
await acquireNoticeLock(fs, process.argv[2]);
`,
            'utf8',
          )
        }
        executable = join(dir, 'hosts.mjs')
        writeFileSync(
          executable,
          `
import { spawn } from "node:child_process";
if (${opts.abandonedOwner ?? false}) {
  const fs = await import("node:fs");
  const { join } = await import("node:path");
  const workspace = ${JSON.stringify(join(opts.scnsHome, '.copilot', 'session-state', opts.sessionId))};
  fs.mkdirSync(workspace, { recursive: true });
  await new Promise((resolve, reject) => {
    const owner = spawn(process.execPath, [${JSON.stringify(ownerScript)},
      join(workspace, "scns-extension-notice.json"),
    ], { env: process.env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let errors = "";
    owner.stderr.on("data", (data) => { errors += data; });
    owner.on("error", reject);
    owner.on("close", (code) => code === 0 ? resolve() : reject(new Error(errors)));
  });
  if (!fs.existsSync(join(workspace, "scns-extension-notice.json.lock"))) {
    throw new Error("retired owner did not leave the expected lock");
  }
}
const copies = await Promise.all(Array.from({ length: ${opts.hostCopies} }, () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [${JSON.stringify(file)}], {
    env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { errors += data; });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code !== 0) { reject(new Error(errors)); return; }
    try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
  });
})));
process.stdout.write(JSON.stringify({
  shown: copies.flatMap((copy) => copy.shown),
  diagnostics: copies.flatMap((copy) => copy.diagnostics),
}));
`,
          'utf8',
        )
      }
      const res = spawnSync(process.execPath, [executable], {
        encoding: 'utf-8',
        timeout: 20_000,
        windowsHide: true,
        env: isolatedHomeEnv(opts.scnsHome, {
          SESSION_ID: opts.sessionId,
          COPILOT_HOME: join(opts.scnsHome, '.copilot'),
        }),
      })
      if (res.status !== 0) throw new Error(`fork failed: ${res.status} ${res.stderr}`)
      const parsed = JSON.parse(res.stdout) as {
        shown: { message: string; level: string }[]
        diagnostics: string[]
      }
      return {
        logged: parsed.shown.map((s) => s.message),
        stderr: parsed.diagnostics,
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  function isolatedHome(): string {
    return mkdtempSync(join(tmpdir(), 'scns-home-'))
  }

  const READY = 'SCNS extension loaded (broker: http://localhost:3456 [global:fallback])'

  it.each(['owner', 'directory'])(
    'does not reclaim a live replacement generation after a stale %s observation',
    async (stage) => {
      const home = isolatedHome()
      const acquire = lockRuntime()
      const file = join(home, 'notice.json')
      const lock = file + '.lock'
      const replacement = join(home, 'replacement.json.lock')
      const retired = join(home, 'retired-lock')
      const ownerFile = (root: string) =>
        nativeFs.lstatSync(root).isDirectory() ? join(root, nativeFs.readdirSync(root)[0]!) : root
      const setOwner = (root: string, pid: number) =>
        nativeFs.writeFileSync(
          ownerFile(root),
          nativeFs.lstatSync(root).isDirectory() ? JSON.stringify({ pid }) : String(pid),
        )
      const readOwner = (root: string) => {
        const text = nativeFs.readFileSync(ownerFile(root), 'utf8')
        return nativeFs.lstatSync(root).isDirectory()
          ? (JSON.parse(text) as { pid: number }).pid
          : Number(text)
      }
      try {
        const owner = spawnSync(process.execPath, ['-e', ''], {
          env: isolatedHomeEnv(home),
          windowsHide: true,
        })
        expect(owner.status).toBe(0)
        await acquire(nativeFs, file)
        setOwner(lock, owner.pid)
        await acquire(nativeFs, join(home, 'replacement.json'))
        setOwner(replacement, process.ppid)

        let swapped = false
        const swap = () => {
          nativeFs.renameSync(lock, retired)
          nativeFs.renameSync(replacement, lock)
          swapped = true
        }
        const fs: typeof nativeFs = {
          ...nativeFs,
          rmSync(path, options) {
            if (!swapped && String(path) === lock) swap()
            return nativeFs.rmSync(path, options)
          },
          unlinkSync(path) {
            if (!swapped && stage === 'owner' && dirname(String(path)) === lock) swap()
            return nativeFs.unlinkSync(path)
          },
          rmdirSync(path, options) {
            if (!swapped && stage === 'directory' && String(path) === lock) swap()
            return nativeFs.rmdirSync(path, options)
          },
        }
        let acquired = false
        const pending = acquire(fs, file).then(() => {
          acquired = true
        })
        let enteredWhileHeld = false
        let liveGenerationPreserved = false
        try {
          await vi.waitFor(() => expect(swapped).toBe(true), { timeout: 3000, interval: 10 })
          await new Promise((resolve) => setTimeout(resolve, 50))
          enteredWhileHeld = acquired
          liveGenerationPreserved = readOwner(lock) === process.ppid
        } finally {
          nativeFs.rmSync(lock, { recursive: true, force: true })
          await pending
        }
        expect(enteredWhileHeld).toBe(false)
        expect(liveGenerationPreserved).toBe(true)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
  )

  it('shows the ready notice on the first fork of an activation', () => {
    const home = isolatedHome()
    try {
      expect(
        runFork({ scnsHome: home, sessionId: 'sess-a', messages: [['info', READY]] }).logged,
      ).toEqual([READY])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  // The regression, executed: six separate processes, one activation.
  it('stays silent on the five replacement forks that follow', () => {
    const home = isolatedHome()
    try {
      const shown: string[] = []
      for (let fork = 0; fork < 6; fork++) {
        shown.push(
          ...runFork({ scnsHome: home, sessionId: 'sess-a', messages: [['info', READY]] }).logged,
        )
      }
      expect(shown).toEqual([READY])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('shows it again for a different session (a fresh CLI launch)', () => {
    const home = isolatedHome()
    try {
      runFork({ scnsHome: home, sessionId: 'sess-a', messages: [['info', READY]] })
      expect(
        runFork({ scnsHome: home, sessionId: 'sess-b', messages: [['info', READY]] }).logged,
      ).toEqual([READY])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('announces an immediate resume of the same conversation', () => {
    const home = isolatedHome()
    try {
      runFork({ scnsHome: home, sessionId: 'sess-a', messages: [['info', READY]] })
      expect(
        runFork({
          scnsHome: home,
          sessionId: 'sess-a',
          activationId: 'activation-b',
          messages: [['info', READY]],
        }).logged,
      ).toEqual([READY])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not mistake elapsed time for a new activation', () => {
    const home = isolatedHome()
    try {
      const now = Date.now()
      runFork({ scnsHome: home, sessionId: 'sess-a', now, messages: [['info', READY]] })
      expect(
        runFork({
          scnsHome: home,
          sessionId: 'sess-a',
          now: now + 3_600_000,
          messages: [['info', READY]],
        }).logged,
      ).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('announces recovery even when the healthy route was previously announced', () => {
    const home = isolatedHome()
    try {
      const failure = 'SCNS broker unavailable'
      expect(
        runFork({
          scnsHome: home,
          sessionId: 'sess-a',
          messages: [
            ['info', READY],
            ['warning', failure],
            ['info', READY],
          ],
        }).logged,
      ).toEqual([READY, failure, READY])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('retries a notice rejected by the CLI instead of marking it delivered', () => {
    const home = isolatedHome()
    try {
      const failed = runFork({
        scnsHome: home,
        sessionId: 'sess-a',
        rejectLog: true,
        messages: [['info', READY]],
      })
      expect(failed.logged).toEqual([])
      expect(failed.stderr.join('\n')).toContain('notice rejected')
      expect(
        runFork({ scnsHome: home, sessionId: 'sess-a', messages: [['info', READY]] }).logged,
      ).toEqual([READY])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('serializes overlapping notice requests', () => {
    const home = isolatedHome()
    try {
      expect(
        runFork({
          scnsHome: home,
          sessionId: 'sess-a',
          concurrent: true,
          messages: Array.from({ length: 6 }, () => ['info', READY]),
        }).logged,
      ).toEqual([READY])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('arbitrates simultaneous replacement processes, not just calls in one process', () => {
    const home = isolatedHome()
    try {
      expect(
        runFork({
          scnsHome: home,
          sessionId: 'sess-a',
          hostCopies: 6,
          messages: [['info', READY]],
        }).logged,
      ).toEqual([READY])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('deduplicates concurrent replacements after the lock-owning process exits', () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const home = isolatedHome()
      try {
        expect(
          runFork({
            scnsHome: home,
            sessionId: 'sess-a',
            hostCopies: 6,
            abandonedOwner: true,
            messages: [['info', READY]],
          }).logged,
        ).toEqual([READY])
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  }, 60_000)

  it('keeps a failure and its recovery visible within the same activation', () => {
    const home = isolatedHome()
    try {
      const failure = 'SCNS extension loaded (broker unresolved: ECONNREFUSED)'
      const first = runFork({
        scnsHome: home,
        sessionId: 'sess-a',
        messages: [['error', failure]],
      })
      expect(first.logged).toEqual([failure])
      const second = runFork({
        scnsHome: home,
        sessionId: 'sess-a',
        messages: [
          ['error', failure],
          ['info', READY],
        ],
      })
      // The repeated failure is suppressed; the recovery is not.
      expect(second.logged).toEqual([READY])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('shows a meaningful route change even inside one activation', () => {
    const home = isolatedHome()
    try {
      const project = 'SCNS extension loaded (broker: http://localhost:3500 [project:scns])'
      runFork({ scnsHome: home, sessionId: 'sess-a', messages: [['info', READY]] })
      expect(
        runFork({ scnsHome: home, sessionId: 'sess-a', messages: [['info', project]] }).logged,
      ).toEqual([project])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  // The notice must never be swallowed because the state directory is
  // unwritable: a missing notice is worse than a repeated one.
  it('still shows the notice when its state cannot be persisted', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'scns-home-')), 'not-a-dir')
    try {
      writeFileSync(home, 'this is a file, so mkdir under it must fail', 'utf-8')
      const first = runFork({ scnsHome: home, sessionId: 'sess-a', messages: [['info', READY]] })
      const second = runFork({ scnsHome: home, sessionId: 'sess-a', messages: [['info', READY]] })
      expect(first.logged).toEqual([READY])
      expect(second.logged).toEqual([READY])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('cannot dedup across sessions when SESSION_ID is unset — it shows the notice', () => {
    const home = isolatedHome()
    try {
      runFork({ scnsHome: home, sessionId: '', messages: [['info', READY]] })
      expect(
        runFork({ scnsHome: home, sessionId: '', messages: [['info', READY]] }).logged,
      ).toEqual([READY])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('writes its receipt in the isolated CLI session workspace', () => {
    const home = isolatedHome()
    try {
      runFork({ scnsHome: home, sessionId: 'sess-a', messages: [['info', READY]] })
      const marker = join(home, '.copilot', 'session-state', 'sess-a', 'scns-extension-notice.json')
      expect(existsSync(marker)).toBe(true)
      const parsed = JSON.parse(readFileSync(marker, 'utf-8')) as {
        sessionId: string
        message: string
      }
      expect(parsed.sessionId).toBe('sess-a')
      expect(parsed.message).toBe(READY)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('uses the session lifecycle instead of growing a separate global marker directory', () => {
    const home = isolatedHome()
    try {
      runFork({ scnsHome: home, sessionId: 'sess-a', messages: [['info', READY]] })
      expect(existsSync(join(home, '.scns', 'state', 'extension-notice'))).toBe(false)
      expect(
        existsSync(join(home, '.copilot', 'session-state', 'sess-a', 'scns-extension-notice.json')),
      ).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('leaves no temp files behind after writing its state', () => {
    const home = isolatedHome()
    try {
      runFork({ scnsHome: home, sessionId: 'sess-a', messages: [['info', READY]] })
      const dir = join(home, '.copilot', 'session-state', 'sess-a')
      expect(readdirSync(dir)).toEqual(['scns-extension-notice.json'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ── Successful startup detail is diagnostics, not a timeline notice ──
describe('startup notice — routing of resolution detail', () => {
  const routeConfig = { brokerUrl: 'http://localhost:3456' }

  it('sends every broker-resolve line to stderr', () => {
    const source = generateExtensionSource(routeConfig)
    const record = source.slice(
      source.indexOf('function recordBrokerResolution('),
      source.indexOf('// WI-4 strict routing'),
    )
    expect(record).toContain('console.error(')
  })

  // The old code did `brokerResolutionSession.log(...)` for EVERY resolution
  // line, so a healthy startup posted its detail to the timeline once per fork.
  it('does not post ordinary resolution detail to the session timeline', () => {
    const source = generateExtensionSource(routeConfig)
    const record = source.slice(
      source.indexOf('function recordBrokerResolution('),
      source.indexOf('// WI-4 strict routing'),
    )
    expect(record).not.toMatch(/brokerResolutionSession\.log\(/)
  })

  it('replays no buffered resolution lines to the timeline after joinSession', () => {
    const source = generateExtensionSource(routeConfig)
    expect(source).not.toContain('await session.log("SCNS broker-resolve: " + line)')
  })

  it('routes the startup banner through the once-per-activation gate', () => {
    const source = generateExtensionSource(routeConfig)
    expect(source).toContain('announceOnce("SCNS extension loaded (broker: "')
    expect(source).not.toContain('session.log("SCNS extension loaded')
  })

  it('reports an unresolved route as an error-level notice', () => {
    const source = generateExtensionSource(routeConfig)
    const tail = source.slice(source.indexOf('startupResolution\n  .then('))
    expect(tail).toContain('broker unresolved: ')
    expect(tail).toContain('"error"')
  })

  it('keeps a project-recovery stall user-visible', () => {
    const source = generateExtensionSource(routeConfig)
    expect(source).toContain('recordBrokerResolution("[" + trigger + "] meta-resolve: " + reason +')
    // Visible flag is passed for the two abnormal paths.
    expect(source).toMatch(/waiting for project recovery",\s*true\)/)
  })

  it('never blocks the extension load on notice persistence', () => {
    const source = generateExtensionSource(routeConfig)
    // announceOnce is async; the load path must not await it at column 0.
    expect(source).not.toMatch(/^await announceOnce\(/m)
  })
})

// ── Issue #70 — mailbox delivery behavioral contract (evaluated hook) ──────
describe('issue #70 — onUserPromptSubmitted mailbox delivery (evaluated hook)', () => {
  interface HookRun {
    result: { additionalContext?: string } | undefined
    fetchCalls: string[]
    fireAndForgetCalls: Array<{ path: string; body: any }>
  }

  async function runPromptHook(opts: {
    sessionId: string | null
    isTeamMode?: boolean
    mailboxResponse?: unknown
    teamResponse?: unknown
    injectionEnabled?: boolean
    memoryContext?: string | null
  }): Promise<HookRun> {
    const source = generateExtensionSource({ brokerUrl: 'http://localhost:3456' })
    const start = source.indexOf('onUserPromptSubmitted: async')
    const end = source.indexOf('onPreToolUse:', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const handlerSrc = source
      .slice(start + 'onUserPromptSubmitted:'.length, end)
      .trim()
      .replace(/,\s*$/, '')

    const fetchCalls: string[] = []
    const fireAndForgetCalls: Array<{ path: string; body: any }> = []

    const factory = new Function(
      'forwardHook',
      'effectiveSessionId',
      'fetchBroker',
      'fireAndForget',
      'postBroker',
      'getInjectionConfig',
      'IS_TEAM_MODE',
      'SCNS_TEAM_ID',
      'TIMEOUT_MS',
      `return (${handlerSrc});`,
    )
    const handler = factory(
      () => {},
      () => opts.sessionId,
      async (path: string) => {
        fetchCalls.push(path)
        if (path.startsWith('/api/messages/')) return opts.mailboxResponse ?? null
        if (path.startsWith('/api/teams/')) return opts.teamResponse ?? null
        return null
      },
      (path: string, body: unknown) => {
        fireAndForgetCalls.push({ path, body })
      },
      async () => (opts.memoryContext != null ? { additionalContext: opts.memoryContext } : null),
      async () => ({ contextInjectionEnabled: opts.injectionEnabled ?? false }),
      opts.isTeamMode ?? false,
      'team-1',
      5000,
    )
    const result = await handler({ prompt: 'hi', cwd: '/w' }, { sessionId: opts.sessionId })
    return { result, fetchCalls, fireAndForgetCalls }
  }

  it('consumes the REAL {messages:[...]} envelope and injects the mail', async () => {
    // The historical bug: the hook checked messages?.length on the envelope
    // object, so every real broker response read as "no mail".
    const run = await runPromptHook({
      sessionId: 'sess-1',
      mailboxResponse: {
        messages: [{ id: 'm1', receiver_id: 'sess-1', sender_id: 'peer', content: 'finding' }],
      },
    })
    expect(run.result?.additionalContext).toContain('finding')
    expect(run.fetchCalls.some((p) => p.startsWith('/api/messages/sess-1'))).toBe(true)
  })

  it('marks DIRECTED injected mail delivered — never broadcasts', async () => {
    const run = await runPromptHook({
      sessionId: 'sess-1',
      mailboxResponse: {
        messages: [
          { id: 'direct-1', receiver_id: 'sess-1', content: 'private' },
          { id: 'bcast-1', receiver_id: null, content: 'to all' },
        ],
      },
    })
    const delivered = run.fireAndForgetCalls.find((c) => c.path === '/api/messages/mark-delivered')
    expect(delivered).toBeDefined()
    expect(delivered!.body.message_ids).toEqual(['direct-1'])
    expect(delivered!.body.receiver_id).toBe('sess-1')
  })

  it('ordinary (non-team) sessions get mailbox delivery too', async () => {
    // The incident's interactive-mode control made ZERO mailbox requests.
    const run = await runPromptHook({
      sessionId: 'interactive-1',
      isTeamMode: false,
      mailboxResponse: { messages: [{ id: 'm1', receiver_id: 'interactive-1', content: 'x' }] },
    })
    expect(run.fetchCalls.some((p) => p.startsWith('/api/messages/interactive-1'))).toBe(true)
    expect(run.result?.additionalContext).toContain('"m1"')
  })

  it('mail and memory context COMBINE — neither overwrites the other', async () => {
    const run = await runPromptHook({
      sessionId: 'sess-1',
      mailboxResponse: { messages: [{ id: 'm1', receiver_id: 'sess-1', content: 'mail-body' }] },
      injectionEnabled: true,
      memoryContext: 'MEMORY-CONTEXT-BLOCK',
    })
    expect(run.result?.additionalContext).toContain('mail-body')
    expect(run.result?.additionalContext).toContain('MEMORY-CONTEXT-BLOCK')
  })

  it('an empty mailbox injects nothing and does not fabricate context', async () => {
    const run = await runPromptHook({
      sessionId: 'sess-1',
      mailboxResponse: { messages: [] },
    })
    expect(run.result).toBeUndefined()
    // But delivery was still attempted-nothing: no mark-delivered call.
    expect(run.fireAndForgetCalls).toHaveLength(0)
  })

  it('with no session identity yet, the hook neither fetches mail nor crashes', async () => {
    const run = await runPromptHook({ sessionId: null })
    expect(run.fetchCalls.filter((p) => p.startsWith('/api/messages/'))).toHaveLength(0)
    expect(run.result).toBeUndefined()
  })
})

// ── Issue #70 — identity capture from any hook (evaluated) ────────────────
describe('issue #70 — forwardHook captures identity from any invocation', () => {
  it('binds extensionSessionId on the first hook that carries an id', () => {
    const source = generateExtensionSource({ brokerUrl: 'http://localhost:3456' })
    const start = source.indexOf('function forwardHook')
    const end = source.indexOf('let extensionSessionId')
    const forwardSrc = source.slice(start, end)

    const sent: any[] = []
    const factory = new Function(
      'fireAndForget',
      `let extensionSessionId = null;
       let extensionCwd = null;
       ${forwardSrc}
       return { forwardHook, getId: () => extensionSessionId, getCwd: () => extensionCwd };`,
    )
    const rt = factory((_path: string, body: any) => sent.push(body))

    // Session-start never fired; a later hook still binds identity AND cwd
    // (the cwd feeds heartbeat-path re-registration — issue #70 S5).
    rt.forwardHook('onPreToolUse', { toolName: 'bash', cwd: '/real/project' }, 'late-bound-id')
    expect(rt.getId()).toBe('late-bound-id')
    expect(rt.getCwd()).toBe('/real/project')
    expect(sent[0].sessionId).toBe('late-bound-id')

    // A subsequent null id does not clobber the bound identity.
    rt.forwardHook('onPostToolUse', { toolName: 'bash' }, null)
    expect(rt.getId()).toBe('late-bound-id')
    expect(rt.getCwd()).toBe('/real/project')
  })
})
