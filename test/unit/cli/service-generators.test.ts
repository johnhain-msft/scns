import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  generateLaunchAgentPlist,
  generateWatchdogPlist,
  generateMetaBrokerPlist,
  generateSystemdUnit,
  generateDailyRestartPlist,
  generateSoakPlist,
  generateBrokerPlist,
  getServicePaths,
  detectPlatform,
  findPlistDrift,
  parsePlistProgramPaths,
  generateWindowsStartupCmd,
} from '../../../src/cli/service-generators.js'
import type {
  ServiceConfig,
  ScheduledPlistConfig,
  BrokerPlistConfig,
  WindowsStartupCmdConfig,
} from '../../../src/cli/service-generators.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

const baseConfig: ServiceConfig = {
  execPath: '/usr/local/bin/node',
  scriptPath: '/home/user/scns/dist/cli.js',
  port: 3456,
  autonomyLevel: 1,
}

describe('service-generators', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── generateLaunchAgentPlist ────────────────────────────────

  describe('generateLaunchAgentPlist', () => {
    it('contains correct Label', () => {
      const plist = generateLaunchAgentPlist(baseConfig)
      expect(plist).toContain('<string>com.scns.brain</string>')
    })

    it('contains ProgramArguments with execPath, scriptPath, and start', () => {
      const plist = generateLaunchAgentPlist(baseConfig)
      expect(plist).toContain(`<string>${baseConfig.execPath}</string>`)
      expect(plist).toContain(`<string>${baseConfig.scriptPath}</string>`)
      expect(plist).toContain('<string>start</string>')
    })

    it('includes port and autonomy in ProgramArguments', () => {
      const plist = generateLaunchAgentPlist(baseConfig)
      expect(plist).toContain('<string>--port</string>')
      expect(plist).toContain('<string>3456</string>')
      expect(plist).toContain('<string>--autonomy</string>')
      expect(plist).toContain('<string>1</string>')
    })

    it('contains log paths under ~/.scns/logs', () => {
      const plist = generateLaunchAgentPlist(baseConfig)
      const home = homedir()
      expect(plist).toContain(join(home, '.scns', 'logs', 'launchd-stdout.log'))
      expect(plist).toContain(join(home, '.scns', 'logs', 'launchd-stderr.log'))
    })

    it('is valid plist XML structure', () => {
      const plist = generateLaunchAgentPlist(baseConfig)
      expect(plist).toContain('<?xml version="1.0"')
      expect(plist).toContain('<plist version="1.0">')
      expect(plist).toContain('</plist>')
    })

    it('escapes XML special characters in paths', () => {
      const config: ServiceConfig = {
        ...baseConfig,
        scriptPath: '/path/with <special> & "chars"',
      }
      const plist = generateLaunchAgentPlist(config)
      expect(plist).toContain('&lt;special&gt;')
      expect(plist).toContain('&amp;')
      expect(plist).toContain('&quot;chars&quot;')
      expect(plist).not.toContain('<special>')
    })
  })

  // ── generateWatchdogPlist ──────────────────────────────────

  describe('generateWatchdogPlist', () => {
    it('uses the com.scns.watchdog label', () => {
      expect(generateWatchdogPlist(baseConfig)).toContain('<string>com.scns.watchdog</string>')
    })

    it('runs `watchdog run` with the broker port', () => {
      const plist = generateWatchdogPlist(baseConfig)
      expect(plist).toContain('<string>watchdog</string>')
      expect(plist).toContain('<string>run</string>')
      expect(plist).toContain('<string>--port</string>')
      expect(plist).toContain('<string>3456</string>')
      expect(plist).toContain(`<string>${baseConfig.execPath}</string>`)
      expect(plist).toContain(`<string>${baseConfig.scriptPath}</string>`)
    })

    it('keeps itself alive (RunAtLoad + KeepAlive) so launchd relaunches it', () => {
      const plist = generateWatchdogPlist(baseConfig)
      expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
      expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    })

    it('sets an EnvironmentVariables block with PATH and HOME (launchctl needs PATH)', () => {
      const plist = generateWatchdogPlist(baseConfig)
      expect(plist).toContain('<key>EnvironmentVariables</key>')
      expect(plist).toContain('<key>PATH</key>')
      expect(plist).toContain('<key>HOME</key>')
    })

    it('writes logs under ~/.scns/logs and is valid plist XML', () => {
      const plist = generateWatchdogPlist(baseConfig)
      const home = homedir()
      expect(plist).toContain(join(home, '.scns', 'logs', 'watchdog-stdout.log'))
      expect(plist).toContain(join(home, '.scns', 'logs', 'watchdog-stderr.log'))
      expect(plist).toContain('<?xml version="1.0"')
      expect(plist).toContain('</plist>')
    })
  })

  // ── generateMetaBrokerPlist ────────────────────────────────

  describe('generateMetaBrokerPlist', () => {
    it('uses the com.scns.meta-broker label and runs `meta-broker run`', () => {
      const plist = generateMetaBrokerPlist(baseConfig)
      expect(plist).toContain('<string>com.scns.meta-broker</string>')
      expect(plist).toContain('<string>meta-broker</string>')
      expect(plist).toContain('<string>run</string>')
      expect(plist).toContain(`<string>${baseConfig.execPath}</string>`)
      expect(plist).toContain(`<string>${baseConfig.scriptPath}</string>`)
    })

    it('keeps itself alive and sets WorkingDirectory + EnvironmentVariables', () => {
      const plist = generateMetaBrokerPlist(baseConfig)
      expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
      expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
      expect(plist).toContain('<key>WorkingDirectory</key>')
      expect(plist).toContain('<key>EnvironmentVariables</key>')
      expect(plist).toContain('<key>PATH</key>')
      expect(plist).toContain('<key>HOME</key>')
    })

    it('writes logs under ~/.scns/logs and is valid plist XML', () => {
      const plist = generateMetaBrokerPlist(baseConfig)
      const home = homedir()
      expect(plist).toContain(join(home, '.scns', 'logs', 'meta-broker-stdout.log'))
      expect(plist).toContain(join(home, '.scns', 'logs', 'meta-broker-stderr.log'))
      expect(plist).toContain('<?xml version="1.0"')
      expect(plist).toContain('</plist>')
    })
  })

  // ── generateSystemdUnit ────────────────────────────────────

  describe('generateSystemdUnit', () => {
    it('contains correct ExecStart with node, script, and args', () => {
      const unit = generateSystemdUnit(baseConfig)
      expect(unit).toContain(
        `ExecStart=${baseConfig.execPath} ${baseConfig.scriptPath} start --port 3456 --autonomy 1`,
      )
    })

    it('uses Type=simple', () => {
      const unit = generateSystemdUnit(baseConfig)
      expect(unit).toContain('Type=simple')
    })

    it('has Restart=on-failure policy', () => {
      const unit = generateSystemdUnit(baseConfig)
      expect(unit).toContain('Restart=on-failure')
      expect(unit).toContain('RestartSec=5')
    })

    it('sets WorkingDirectory to script parent dir', () => {
      const unit = generateSystemdUnit(baseConfig)
      expect(unit).toContain('WorkingDirectory=/home/user/scns/dist')
    })

    it('includes WantedBy=default.target for user units', () => {
      const unit = generateSystemdUnit(baseConfig)
      expect(unit).toContain('[Install]')
      expect(unit).toContain('WantedBy=default.target')
    })

    it('includes proper unit sections', () => {
      const unit = generateSystemdUnit(baseConfig)
      expect(unit).toContain('[Unit]')
      expect(unit).toContain('[Service]')
      expect(unit).toContain('[Install]')
    })

    it('respects custom port and autonomy', () => {
      const config: ServiceConfig = { ...baseConfig, port: 9999, autonomyLevel: 3 }
      const unit = generateSystemdUnit(config)
      expect(unit).toContain('--port 9999')
      expect(unit).toContain('--autonomy 3')
    })
  })

  // ── generateBrokerPlist (Phase 1c: socket activation) ──────

  const brokerConfig: BrokerPlistConfig = {
    execPath: '/home/user/.nvm/versions/node/v22.20.0/bin/node',
    scriptPath: '/home/user/scns_root/scns/dist/cli.js',
    port: 3456,
    autonomyLevel: 2,
    helperPath: '/home/user/scns_root/scns/dist/native/scns-socket-launch',
    home: '/home/user',
  }

  describe('generateBrokerPlist', () => {
    it('uses the com.scns.broker label and runs the shim then node cli start', () => {
      const plist = generateBrokerPlist(brokerConfig)
      expect(plist).toContain('<string>com.scns.broker</string>')
      // Shim is argv[0]; it exec's node cli.js start …
      const argsIdx = plist.indexOf('<key>ProgramArguments</key>')
      const helperIdx = plist.indexOf(`<string>${brokerConfig.helperPath}</string>`)
      const nodeIdx = plist.indexOf(`<string>${brokerConfig.execPath}</string>`)
      expect(helperIdx).toBeGreaterThan(argsIdx)
      expect(nodeIdx).toBeGreaterThan(helperIdx) // shim precedes node
      expect(plist).toContain(`<string>${brokerConfig.scriptPath}</string>`)
      expect(plist).toContain('<string>start</string>')
      expect(plist).toContain('<string>--port</string>')
      expect(plist).toContain('<string>3456</string>')
      expect(plist).toContain('<string>--autonomy</string>')
      expect(plist).toContain('<string>2</string>')
    })

    it('declares a Sockets → Listeners entry bound to loopback on the broker port', () => {
      const plist = generateBrokerPlist(brokerConfig)
      expect(plist).toContain('<key>Sockets</key>')
      expect(plist).toContain('<key>Listeners</key>')
      expect(plist).toMatch(/<key>SockServiceName<\/key>\s*<string>3456<\/string>/)
      expect(plist).toMatch(/<key>SockType<\/key>\s*<string>stream<\/string>/)
      expect(plist).toMatch(/<key>SockNodeName<\/key>\s*<string>127\.0\.0\.1<\/string>/)
      expect(plist).toMatch(/<key>SockFamily<\/key>\s*<string>IPv4<\/string>/)
    })

    it('honors a custom socketName', () => {
      const plist = generateBrokerPlist({ ...brokerConfig, socketName: 'BrokerSock' })
      expect(plist).toContain('<key>BrokerSock</key>')
    })

    it('keeps itself alive and defaults WorkingDirectory to the checkout root', () => {
      const plist = generateBrokerPlist(brokerConfig)
      expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
      expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
      expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/)
      expect(plist).toContain('<string>Background</string>')
      expect(plist).toContain(
        '<key>WorkingDirectory</key>\n  <string>/home/user/scns_root/scns</string>',
      )
    })

    it('writes broker logs and is valid, drift-free plist XML for its checkout (pos control)', () => {
      const plist = generateBrokerPlist(brokerConfig)
      expect(plist).toContain('/home/user/.scns/logs/broker.log')
      expect(plist).toContain('/home/user/.scns/logs/broker_error.log')
      expect(plist).toContain('<?xml version="1.0"')
      expect(plist).toContain('</plist>')
      expect(findPlistDrift(plist, '/home/user/scns_root/scns', () => false)).toEqual([])
    })
  })

  // ── generateDailyRestartPlist ──────────────────────────────
  const scheduledConfig: ScheduledPlistConfig = {
    repoRoot: '/home/user/scns_root/scns',
    nodePath: '/home/user/.nvm/versions/node/v22.20.0/bin/node',
    home: '/home/user',
  }

  describe('generateDailyRestartPlist', () => {
    it('uses the com.scns.daily-restart label and templates the script path from repoRoot', () => {
      const plist = generateDailyRestartPlist(scheduledConfig)
      expect(plist).toContain('<string>com.scns.daily-restart</string>')
      expect(plist).toContain(
        '<string>/home/user/scns_root/scns/scripts/broker-restart.sh</string>',
      )
      expect(plist).toContain('<string>/bin/bash</string>')
    })

    it('sets WorkingDirectory to repoRoot and runs at 06:00', () => {
      const plist = generateDailyRestartPlist(scheduledConfig)
      expect(plist).toContain(
        '<key>WorkingDirectory</key>\n    <string>/home/user/scns_root/scns</string>',
      )
      expect(plist).toMatch(/<key>Hour<\/key>\s*<integer>6<\/integer>/)
      expect(plist).toMatch(/<key>Minute<\/key>\s*<integer>0<\/integer>/)
    })

    it('sets PATH/HOME/NODE_ENV and log paths, and is valid plist XML', () => {
      const plist = generateDailyRestartPlist(scheduledConfig)
      expect(plist).toContain('<key>PATH</key>')
      expect(plist).toContain('<key>HOME</key>')
      expect(plist).toContain('<string>production</string>')
      expect(plist).toContain('/home/user/.scns/logs/daily-restart-stdout.log')
      expect(plist).toContain('/home/user/.scns/logs/daily-restart-stderr.log')
      expect(plist).toContain('<?xml version="1.0"')
      expect(plist).toContain('</plist>')
    })

    it('round-trips clean through findPlistDrift for its own repoRoot (pos control)', () => {
      const plist = generateDailyRestartPlist(scheduledConfig)
      // Healthy regardless of on-disk existence: paths are under repoRoot.
      expect(findPlistDrift(plist, scheduledConfig.repoRoot, () => false)).toEqual([])
    })
  })

  // ── generateSoakPlist ──────────────────────────────────────

  describe('generateSoakPlist', () => {
    it('uses the com.scns.soak-weekly label, node binary, and templated script path', () => {
      const plist = generateSoakPlist(scheduledConfig)
      expect(plist).toContain('<string>com.scns.soak-weekly</string>')
      expect(plist).toContain(`<string>${scheduledConfig.nodePath}</string>`)
      expect(plist).toContain(
        '<string>/home/user/scns_root/scns/scripts/auto-restart-soak.mjs</string>',
      )
    })

    it('passes the soak args and runs Sunday 03:00 on the sidecar port', () => {
      const plist = generateSoakPlist(scheduledConfig)
      expect(plist).toContain('<string>--port</string>')
      expect(plist).toContain('<string>34567</string>')
      expect(plist).toContain('<string>--duration-sec</string>')
      expect(plist).toMatch(/<key>Weekday<\/key>\s*<integer>0<\/integer>/)
      expect(plist).toMatch(/<key>Hour<\/key>\s*<integer>3<\/integer>/)
    })

    it('is a batch, not a daemon (RunAtLoad + KeepAlive false, Background)', () => {
      const plist = generateSoakPlist(scheduledConfig)
      expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/)
      expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/)
      expect(plist).toContain('<string>Background</string>')
    })

    it('round-trips clean through findPlistDrift for its own repoRoot (pos control)', () => {
      const plist = generateSoakPlist(scheduledConfig)
      expect(findPlistDrift(plist, scheduledConfig.repoRoot, () => false)).toEqual([])
    })
  })

  // ── parsePlistProgramPaths / findPlistDrift ────────────────

  describe('parsePlistProgramPaths', () => {
    it('extracts ProgramArguments strings and WorkingDirectory and unescapes XML', () => {
      const plist = generateDailyRestartPlist(scheduledConfig)
      const parsed = parsePlistProgramPaths(plist)
      expect(parsed.programArguments).toContain('/bin/bash')
      expect(parsed.programArguments).toContain(
        '/home/user/scns_root/scns/scripts/broker-restart.sh',
      )
      expect(parsed.workingDirectory).toBe('/home/user/scns_root/scns')
    })
  })

  describe('findPlistDrift', () => {
    it('flags a stale script + workdir that point at a foreign, missing checkout (neg control)', () => {
      // The exact Phase-0 bug: plist points at the old …/Coding_Projects/scns path.
      const staleXml = generateDailyRestartPlist({
        ...scheduledConfig,
        repoRoot: '/home/user/Coding_Projects/scns',
      })
      const findings = findPlistDrift(staleXml, scheduledConfig.repoRoot, () => false)
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.some((f) => f.kind === 'script' && f.reason === 'missing')).toBe(true)
      expect(findings.some((f) => f.kind === 'workdir' && f.reason === 'missing')).toBe(true)
    })

    it('reports foreign-checkout when the drifted path still exists on disk', () => {
      const staleXml = generateDailyRestartPlist({
        ...scheduledConfig,
        repoRoot: '/home/user/other/scns',
      })
      const findings = findPlistDrift(staleXml, scheduledConfig.repoRoot, () => true)
      expect(findings.every((f) => f.reason === 'foreign-checkout')).toBe(true)
      expect(findings.length).toBeGreaterThan(0)
    })

    it('ignores non-repo ProgramArguments like /bin/bash and the node binary', () => {
      // Healthy plist for its own root → only repo scripts + workdir are checked;
      // /bin/bash and the node path must not be flagged.
      const plist = generateSoakPlist(scheduledConfig)
      const findings = findPlistDrift(plist, scheduledConfig.repoRoot, () => false)
      expect(findings).toEqual([])
    })

    it('treats repoRoot itself (WorkingDirectory) as healthy', () => {
      const plist = generateDailyRestartPlist(scheduledConfig)
      const findings = findPlistDrift(plist, '/home/user/scns_root/scns', () => false)
      expect(findings).toEqual([])
    })
  })

  // ── getServicePaths ────────────────────────────────────────
  describe('getServicePaths', () => {
    it('returns LaunchAgents path for darwin', () => {
      const paths = getServicePaths('darwin')
      const home = homedir()
      expect(paths.installPath).toBe(join(home, 'Library', 'LaunchAgents', 'com.scns.brain.plist'))
      expect(paths.serviceName).toBe('com.scns.brain')
    })

    it('returns systemd user path for linux', () => {
      const paths = getServicePaths('linux')
      const home = homedir()
      expect(paths.installPath).toBe(join(home, '.config', 'systemd', 'user', 'scns.service'))
      expect(paths.serviceName).toBe('scns')
    })

    it('returns the Startup-folder shim for win32 (issue #61)', () => {
      const paths = getServicePaths('win32')
      // Every Windows persistence trigger reachable from a non-admin account is
      // logon-scoped; Task Scheduler and `sc create` both return access-denied.
      expect(paths.installPath).toContain('Startup')
      expect(paths.installPath.endsWith('scns-watchdog.cmd')).toBe(true)
      expect(paths.serviceName).toBe('scns-watchdog')
    })

    it('throws for unsupported platform', () => {
      expect(() => getServicePaths('freebsd')).toThrow('Unsupported platform')
    })
  })

  // ── generateWindowsStartupCmd (issue #61) ──────────────────
  describe('generateWindowsStartupCmd', () => {
    const CONFIG: WindowsStartupCmdConfig = {
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'C:\\Users\\jh\\scns\\dist\\cli.js',
      port: 3456,
      autonomyLevel: 1,
      home: 'C:\\Users\\jh',
    }

    it('launches the WATCHDOG, not the broker — the watchdog is the supervision root', () => {
      const cmd = generateWindowsStartupCmd(CONFIG)
      expect(cmd).toContain('watchdog run')
      expect(cmd).not.toMatch(/cli\.js"\s+start/)
    })

    it('tells the watchdog which entry script to relaunch', () => {
      const cmd = generateWindowsStartupCmd(CONFIG)
      expect(cmd).toContain('--broker-entry "C:\\Users\\jh\\scns\\dist\\cli.js"')
      expect(cmd).toContain('--port 3456')
      expect(cmd).toContain('--autonomy 1')
    })

    it('quotes the interpreter and script so Program Files paths survive', () => {
      const cmd = generateWindowsStartupCmd(CONFIG)
      expect(cmd).toContain('"C:\\Program Files\\nodejs\\node.exe"')
    })

    it('redirects output to a log file so a failed relaunch leaves evidence', () => {
      const cmd = generateWindowsStartupCmd(CONFIG)
      expect(cmd).toContain('watchdog.log')
      expect(cmd).toContain('2>&1')
      expect(cmd).toContain('mkdir')
    })

    it('uses CRLF line endings — cmd.exe is the consumer', () => {
      const cmd = generateWindowsStartupCmd(CONFIG)
      expect(cmd).toContain('\r\n')
      expect(cmd.split('\r\n').length).toBeGreaterThan(3)
      expect(cmd.replace(/\r\n/g, '')).not.toContain('\n')
    })

    it('starts minimized rather than stealing focus at every logon', () => {
      expect(generateWindowsStartupCmd(CONFIG)).toContain('/MIN')
    })

    it('says in the file itself what it is and which issue it closes', () => {
      const cmd = generateWindowsStartupCmd(CONFIG)
      expect(cmd).toContain('REM')
      expect(cmd).toMatch(/#61/)
    })

    it('omits --autonomy when none is configured', () => {
      const { autonomyLevel: _drop, ...rest } = CONFIG
      expect(generateWindowsStartupCmd(rest)).not.toContain('--autonomy')
    })
  })

  // ── detectPlatform ─────────────────────────────────────────

  describe('detectPlatform', () => {
    it('returns darwin on macOS', () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' })
      expect(detectPlatform()).toBe('darwin')
    })

    it('returns linux on Linux', () => {
      vi.stubGlobal('process', { ...process, platform: 'linux' })
      expect(detectPlatform()).toBe('linux')
    })

    it('returns win32 on Windows', () => {
      vi.stubGlobal('process', { ...process, platform: 'win32' })
      expect(detectPlatform()).toBe('win32')
    })
  })
})
