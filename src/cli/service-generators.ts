// Path-joining is deliberately split two ways in this module:
//  - posix join/dirname (the module default): generators whose paths are
//    templated from INJECTED config (repoRoot/home fixtures, drift checks).
//    launchd plists and systemd units are POSIX artifacts, so their embedded
//    paths always use forward slashes — win32 `\` templating broke the
//    repo-script/under-root checks in `scns service verify`.
//  - nativeJoin/nativeDirname: generators that read the REAL homedir() (no
//    injection); their outputs are asserted host-natively and are only ever
//    installed on the OS that generated them.
import { join as nativeJoin, dirname as nativeDirname, posix } from 'node:path'
import { homedir } from 'node:os'

const { join, dirname } = posix
import { existsSync } from 'node:fs'
import { ConfigurationError } from '../shared/errors.js'

export interface ServiceConfig {
  readonly execPath: string
  readonly scriptPath: string
  readonly port: number
  readonly autonomyLevel: number
}

const PLIST_LABEL = 'com.scns.brain'
const WATCHDOG_PLIST_LABEL = 'com.scns.watchdog'
const METABROKER_PLIST_LABEL = 'com.scns.meta-broker'
const DAILY_RESTART_PLIST_LABEL = 'com.scns.daily-restart'
const SOAK_PLIST_LABEL = 'com.scns.soak-weekly'

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function generateLaunchAgentPlist(config: ServiceConfig): string {
  const home = homedir()
  const logDir = nativeJoin(home, '.scns', 'logs')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(PLIST_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(config.execPath)}</string>
    <string>${escapeXml(config.scriptPath)}</string>
    <string>start</string>
    <string>--port</string>
    <string>${config.port}</string>
    <string>--autonomy</string>
    <string>${config.autonomyLevel}</string>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escapeXml(nativeJoin(logDir, 'launchd-stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(nativeJoin(logDir, 'launchd-stderr.log'))}</string>
</dict>
</plist>
`
}

export function generateWatchdogPlist(config: ServiceConfig): string {
  const home = homedir()
  const logDir = nativeJoin(home, '.scns', 'logs')
  const binDir = nativeDirname(config.execPath)
  const path = `${binDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(WATCHDOG_PLIST_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(config.execPath)}</string>
    <string>${escapeXml(config.scriptPath)}</string>
    <string>watchdog</string>
    <string>run</string>
    <string>--port</string>
    <string>${config.port}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(nativeJoin(logDir, 'watchdog-stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(nativeJoin(logDir, 'watchdog-stderr.log'))}</string>
</dict>
</plist>
`
}

export function generateMetaBrokerPlist(config: ServiceConfig): string {
  const home = homedir()
  const logDir = nativeJoin(home, '.scns', 'logs')
  const binDir = nativeDirname(config.execPath)
  const path = `${binDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(METABROKER_PLIST_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(config.execPath)}</string>
    <string>${escapeXml(config.scriptPath)}</string>
    <string>meta-broker</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>WorkingDirectory</key>
  <string>${escapeXml(nativeDirname(config.scriptPath))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(nativeJoin(logDir, 'meta-broker-stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(nativeJoin(logDir, 'meta-broker-stderr.log'))}</string>
</dict>
</plist>
`
}

/**
 * Config for the scheduled maintenance plists (daily-restart, soak). These jobs
 * reference repo scripts by absolute path, so the path is templated from the
 * live checkout root — a hard-coded path can never drift again (Phase 0).
 */
export interface ScheduledPlistConfig {
  /** Absolute path of the current checkout root (e.g. …/scns_root/scns). */
  readonly repoRoot: string
  /** Absolute path to the node binary (used for PATH + the soak Program). */
  readonly nodePath: string
  /** bash interpreter for the daily-restart job. Defaults to /bin/bash. */
  readonly bashPath?: string
  /** Home dir override (tests). Defaults to os.homedir(). */
  readonly home?: string
}

function scheduledEnvPath(nodePath: string): string {
  const binDir = dirname(nodePath)
  return `${binDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`
}

/**
 * Generate the daily blue/green restart launchd plist. Runs
 * `<repoRoot>/scripts/broker-restart.sh` via bash at 06:00 local.
 */
export function generateDailyRestartPlist(config: ScheduledPlistConfig): string {
  const home = config.home ?? homedir()
  const logDir = join(home, '.scns', 'logs')
  const bash = config.bashPath ?? '/bin/bash'
  const scriptPath = join(config.repoRoot, 'scripts', 'broker-restart.sh')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(DAILY_RESTART_PLIST_LABEL)}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(bash)}</string>
        <string>${escapeXml(scriptPath)}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${escapeXml(config.repoRoot)}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(scheduledEnvPath(config.nodePath))}</string>
        <key>HOME</key>
        <string>${escapeXml(home)}</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>

    <!-- Run daily at 6:00 AM local time (after dream cycle) -->
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>6</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>${escapeXml(join(logDir, 'daily-restart-stdout.log'))}</string>

    <key>StandardErrorPath</key>
    <string>${escapeXml(join(logDir, 'daily-restart-stderr.log'))}</string>
</dict>
</plist>
`
}

/**
 * Generate the weekly soak launchd plist. Runs
 * `<repoRoot>/scripts/auto-restart-soak.mjs` on a sidecar broker (port 34567)
 * every Sunday at 03:00 local. Not a daemon (RunAtLoad/KeepAlive false).
 */
export function generateSoakPlist(config: ScheduledPlistConfig): string {
  const home = config.home ?? homedir()
  const logDir = join(home, '.scns', 'logs')
  const scriptPath = join(config.repoRoot, 'scripts', 'auto-restart-soak.mjs')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(SOAK_PLIST_LABEL)}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(config.nodePath)}</string>
        <string>${escapeXml(scriptPath)}</string>
        <string>--duration-sec</string>
        <string>1800</string>
        <string>--restart-sec</string>
        <string>600</string>
        <string>--cap</string>
        <string>4</string>
        <string>--port</string>
        <string>34567</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${escapeXml(config.repoRoot)}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(scheduledEnvPath(config.nodePath))}</string>
        <key>HOME</key>
        <string>${escapeXml(home)}</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>

    <!-- Weekly: Sunday 03:00 local. Quiet window, no overlap with the 06:00 daily-restart. -->
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>0</integer>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>${escapeXml(join(logDir, 'soak-weekly-stdout.log'))}</string>

    <key>StandardErrorPath</key>
    <string>${escapeXml(join(logDir, 'soak-weekly-stderr.log'))}</string>

    <!-- Do NOT keep alive — this is a scheduled batch, not a daemon. -->
    <key>RunAtLoad</key>
    <false/>

    <key>KeepAlive</key>
    <false/>

    <!-- Cap CPU/IO impact so a runaway soak can't starve the production broker. -->
    <key>ProcessType</key>
    <string>Background</string>

    <key>Nice</key>
    <integer>5</integer>
</dict>
</plist>
`
}

/**
 * Config for the socket-activated broker plist (Phase 1: zero-downtime restart).
 * The launchd `Program` is the native shim (`helperPath`) which retrieves the
 * launchd-held socket and exec's `execPath scriptPath start …`.
 */
export interface BrokerPlistConfig extends ServiceConfig {
  /** Absolute path to the compiled native/scns-socket-launch shim. */
  readonly helperPath: string
  /** launchd Sockets entry name the shim activates. Defaults to 'Listeners'. */
  readonly socketName?: string
  /** Home dir override (tests). Defaults to os.homedir(). */
  readonly home?: string
  /** WorkingDirectory override. Defaults to the checkout root (…/dist/cli.js → …). */
  readonly workingDirectory?: string
}

/**
 * Generate the com.scns.broker launchd plist WITH launchd socket activation.
 *
 * The `Sockets → Listeners` key makes launchd own the listening socket; the
 * shim hands its fd to node (SCNS_LISTEN_FD), so a `launchctl kickstart -k`
 * restart keeps the socket bound and the kernel queues connections → zero
 * dropped connections. Binds 127.0.0.1 (loopback) IPv4 for a single, determin-
 * istic fd — a change from the previous all-interfaces bind (see AWAITING-JOHN).
 *
 * Operator-owned: the live broker carries a rich EnvironmentVariables block
 * (SCNS_* flags); this generator emits only the structural PATH/HOME/NODE_ENV
 * base. Merge the operator env when reinstalling the live job.
 */
export function generateBrokerPlist(config: BrokerPlistConfig): string {
  const home = config.home ?? homedir()
  const logDir = join(home, '.scns', 'logs')
  const binDir = dirname(config.execPath)
  const path = `${binDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`
  const socketName = config.socketName ?? 'Listeners'
  const workDir = config.workingDirectory ?? dirname(dirname(config.scriptPath))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.scns.broker</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(config.helperPath)}</string>
    <string>${escapeXml(config.execPath)}</string>
    <string>${escapeXml(config.scriptPath)}</string>
    <string>start</string>
    <string>--port</string>
    <string>${config.port}</string>
    <string>--autonomy</string>
    <string>${config.autonomyLevel}</string>
  </array>
  <key>Sockets</key>
  <dict>
    <key>${escapeXml(socketName)}</key>
    <dict>
      <key>SockNodeName</key>
      <string>127.0.0.1</string>
      <key>SockServiceName</key>
      <string>${config.port}</string>
      <key>SockType</key>
      <string>stream</string>
      <key>SockFamily</key>
      <string>IPv4</string>
    </dict>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logDir, 'broker.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logDir, 'broker_error.log'))}</string>
</dict>
</plist>
`
}

export function generateSystemdUnit(config: ServiceConfig): string {
  const workDir = dirname(config.scriptPath)
  return `[Unit]
Description=SCNS Agent
After=network.target

[Service]
Type=simple
ExecStart=${config.execPath} ${config.scriptPath} start --port ${config.port} --autonomy ${config.autonomyLevel}
WorkingDirectory=${workDir}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`
}

export interface ServicePaths {
  readonly installPath: string
  readonly serviceName: string
}

/**
 * Issue #61 — Windows supervision root.
 *
 * Every Windows persistence mechanism reachable from a non-admin account is
 * logon-scoped: `Register-ScheduledTask`, `schtasks /create` and `sc create`
 * all return access-denied on the affected host, leaving only the HKCU Run key
 * and the Startup folder. The Startup folder wins because it is a plain file:
 * inspectable, removable, and it needs no registry write.
 *
 * What it starts is deliberately the WATCHDOG, not the broker. Starting the
 * broker directly would reproduce the defect — a process with nothing above it,
 * whose self-heal exit is a permanent death. The watchdog supervises the broker
 * and spawns it with `SCNS_SUPERVISED=1`, which is what lets self-heal arm.
 *
 * This still cannot survive a machine that goes days without a logon — the
 * observed 11h47m outage — which is the gap session-start reconciliation
 * (option A, `copilot-extension/broker-reconcile.ts`) covers.
 */
export const WINDOWS_STARTUP_CMD_NAME = 'scns-watchdog.cmd'

export interface WindowsStartupCmdConfig {
  readonly execPath: string
  readonly scriptPath: string
  readonly port: number
  readonly autonomyLevel?: number
  /** Home dir override (tests). Defaults to os.homedir(). */
  readonly home?: string
}

/** `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` for `home`. */
export function windowsStartupDir(home: string, appData?: string): string {
  if (appData && appData.trim() !== '') {
    return nativeJoin(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  }
  return nativeJoin(
    home,
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  )
}

/**
 * Generate the Startup-folder shim that runs `scns watchdog run`.
 *
 * CRLF throughout — cmd.exe is the consumer and a LF-only batch file misparses
 * on some shells. The nested `cmd /c "…"` under `start /MIN` is the standard
 * idiom for redirecting a *started* process's output: `start` would otherwise
 * apply the redirection to itself and the watchdog's log would stay empty.
 */
export function generateWindowsStartupCmd(config: WindowsStartupCmdConfig): string {
  const home = config.home ?? homedir()
  const logDir = nativeJoin(home, '.scns', 'logs')
  const logFile = nativeJoin(logDir, 'watchdog.log')
  const autonomy = config.autonomyLevel !== undefined ? ` --autonomy ${config.autonomyLevel}` : ''
  const inner =
    `"${config.execPath}" "${config.scriptPath}" watchdog run ` +
    `--port ${config.port} --broker-entry "${config.scriptPath}"${autonomy} ` +
    `>> "${logFile}" 2>&1`

  return [
    '@echo off',
    'REM SCNS supervision root (issue #61) - generated by `scns install`.',
    'REM',
    'REM Starts the external watchdog, NOT the broker. The watchdog polls',
    'REM /api/health, restarts a hung or dead broker, and spawns it with',
    'REM SCNS_SUPERVISED=1 so the broker may arm its own self-heal. Starting the',
    'REM broker directly here would recreate the defect: a root process with',
    'REM nothing above it, whose self-heal exit(1) is a permanent death.',
    'REM',
    'REM Logon-scoped, because no other Windows trigger is available to a',
    'REM non-admin account. A machine that stays up for days without a logon is',
    'REM covered instead by session-start reconciliation in the Copilot extension.',
    `if not exist "${logDir}" mkdir "${logDir}"`,
    `start "SCNS watchdog" /MIN cmd /c "${inner}"`,
    '',
  ].join('\r\n')
}

export function getServicePaths(platform: string): ServicePaths {
  const home = homedir()
  switch (platform) {
    case 'darwin':
      return {
        installPath: nativeJoin(home, 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`),
        serviceName: PLIST_LABEL,
      }
    case 'linux':
      return {
        installPath: nativeJoin(home, '.config', 'systemd', 'user', 'scns.service'),
        serviceName: 'scns',
      }
    case 'win32':
      return {
        installPath: nativeJoin(
          windowsStartupDir(home, process.env['APPDATA']),
          WINDOWS_STARTUP_CMD_NAME,
        ),
        serviceName: 'scns-watchdog',
      }
    default:
      throw new ConfigurationError(`Unsupported platform for service installation: ${platform}`)
  }
}

export function detectPlatform(): 'darwin' | 'linux' | 'win32' {
  const p = process.platform
  if (p === 'darwin') return 'darwin'
  if (p === 'linux') return 'linux'
  if (p === 'win32') return 'win32'
  return p as 'linux'
}

// ── Service path drift verification (Phase 0) ────────────────────────────
//
// `scns service verify` reads each installed ~/Library/LaunchAgents/com.scns.*
// plist and confirms the repo paths it references point at the CURRENT checkout
// and exist on disk. This catches the class of bug where a plist carries a stale
// hard-coded path after the checkout moves (the daily-restart/soak drift fixed
// in Phase 0).

/** Why a referenced path is considered drifted. */
export type PlistDriftReason = 'missing' | 'foreign-checkout'

export interface PlistDriftFinding {
  /** 'script' = a ProgramArguments file; 'workdir' = WorkingDirectory. */
  readonly kind: 'script' | 'workdir'
  readonly path: string
  readonly reason: PlistDriftReason
}

/** Extract the ProgramArguments strings and WorkingDirectory from a plist XML. */
export function parsePlistProgramPaths(xml: string): {
  programArguments: string[]
  workingDirectory: string | null
} {
  const programArguments: string[] = []
  // ProgramArguments <array> … </array>
  const argsMatch = xml.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/)
  if (argsMatch) {
    const stringRe = /<string>([\s\S]*?)<\/string>/g
    let m: RegExpExecArray | null
    while ((m = stringRe.exec(argsMatch[1]!)) !== null) {
      programArguments.push(unescapeXml(m[1]!.trim()))
    }
  }
  let workingDirectory: string | null = null
  const wdMatch = xml.match(/<key>\s*WorkingDirectory\s*<\/key>\s*<string>([\s\S]*?)<\/string>/)
  if (wdMatch) workingDirectory = unescapeXml(wdMatch[1]!.trim())
  return { programArguments, workingDirectory }
}

function unescapeXml(str: string): string {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** True if `p` is `repoRoot` itself or nested under it. */
function isUnderRoot(p: string, repoRoot: string): boolean {
  const root = repoRoot.replace(/\/+$/, '')
  return p === root || p.startsWith(root + '/')
}

/** A ProgramArguments entry that references a repo script (worth checking). */
function isRepoScriptPath(p: string): boolean {
  return p.startsWith('/') && /\.(sh|mjs|js)$/.test(p)
}

/**
 * Inspect a plist XML for path drift relative to `repoRoot`. Pure: an optional
 * `fileExists` is injectable for tests (defaults to fs.existsSync). Returns the
 * drifted references; an empty array means the plist is healthy.
 */
export function findPlistDrift(
  xml: string,
  repoRoot: string,
  fileExists: (p: string) => boolean = existsSync,
): PlistDriftFinding[] {
  const { programArguments, workingDirectory } = parsePlistProgramPaths(xml)
  const findings: PlistDriftFinding[] = []

  const check = (path: string, kind: 'script' | 'workdir'): void => {
    if (isUnderRoot(path, repoRoot)) return
    findings.push({ kind, path, reason: fileExists(path) ? 'foreign-checkout' : 'missing' })
  }

  for (const arg of programArguments) {
    if (isRepoScriptPath(arg)) check(arg, 'script')
  }
  if (workingDirectory !== null) check(workingDirectory, 'workdir')

  return findings
}
