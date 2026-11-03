import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { homedir } from 'node:os'

export interface DiscoveredMcp {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly source: string
}

export interface DiscoveredSkill {
  readonly name: string
  readonly description: string
  readonly argumentHint: string | null
  readonly source: string
}

export interface DiscoveredInstruction {
  readonly source: string
  readonly contentPreview: string
  readonly fullLength: number
}

export interface DiscoveredConfig {
  readonly mcpServers: readonly DiscoveredMcp[]
  readonly skills: readonly DiscoveredSkill[]
  readonly instructions: readonly DiscoveredInstruction[]
  readonly scannedPaths: readonly string[]
  readonly scannedAt: string
}

interface ConfigScannerOptions {
  readonly homeDir?: string
  readonly cwd?: string
}

/** Parse simple YAML frontmatter delimited by --- */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match?.[1]) return null

  const result: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key) result[key] = value
  }
  return result
}

function readJsonSafe(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

function readdirSafe(dirPath: string): readonly string[] {
  try {
    return readdirSync(dirPath)
  } catch {
    return []
  }
}

function parseMcpServersFromFile(filePath: string): readonly DiscoveredMcp[] {
  const data = readJsonSafe(filePath)
  if (!data || typeof data !== 'object') return []

  const record = data as Record<string, unknown>
  const mcpServers = record['mcpServers']
  if (!mcpServers || typeof mcpServers !== 'object') return []

  const entries = mcpServers as Record<string, unknown>
  const results: DiscoveredMcp[] = []

  for (const [name, value] of Object.entries(entries)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const command = entry['command']
    if (typeof command !== 'string') continue

    const rawArgs = Array.isArray(entry['args'])
      ? (entry['args'] as unknown[]).filter((a): a is string => typeof a === 'string')
      : []

    results.push({
      name,
      command,
      args: rawArgs,
      source: filePath,
    })
  }

  return results
}

function parseSkillsFromDir(dirPath: string): readonly DiscoveredSkill[] {
  const files = readdirSafe(dirPath)
  const results: DiscoveredSkill[] = []

  for (const file of files) {
    if (extname(file) !== '.md') continue

    const filePath = join(dirPath, file)
    const content = readFileSafe(filePath)
    if (content === null) continue

    const frontmatter = parseFrontmatter(content)
    const nameFromFile = basename(file, '.md')

    results.push({
      name: frontmatter?.['name'] ?? nameFromFile,
      description: frontmatter?.['description'] ?? '',
      argumentHint: frontmatter?.['argument-hint'] ?? null,
      source: filePath,
    })
  }

  return results
}

function parseExtensionsFromDir(dirPath: string): readonly DiscoveredSkill[] {
  const files = readdirSafe(dirPath)
  const validExts = new Set(['.js', '.ts', '.yaml', '.yml'])
  const results: DiscoveredSkill[] = []

  for (const file of files) {
    const ext = extname(file)
    if (!validExts.has(ext)) continue

    const filePath = join(dirPath, file)
    results.push({
      name: basename(file, ext),
      description: '',
      argumentHint: null,
      source: filePath,
    })
  }

  return results
}

function parseInstructionFile(filePath: string): DiscoveredInstruction | null {
  const content = readFileSafe(filePath)
  if (content === null) return null

  return {
    source: filePath,
    contentPreview: content.slice(0, 200),
    fullLength: content.length,
  }
}

export function createConfigScanner(options?: ConfigScannerOptions) {
  const home = options?.homeDir ?? homedir()
  const cwd = options?.cwd ?? process.cwd()

  const homeClaudeSettings = join(home, '.claude', 'settings.json')
  const projectClaudeSettings = join(cwd, '.claude', 'settings.json')
  const homeCommandsDir = join(home, '.claude', 'commands')
  const projectCommandsDir = join(cwd, '.claude', 'commands')
  const extensionsDir = join(cwd, '.github', 'extensions')
  const claudeMdPath = join(cwd, 'CLAUDE.md')
  const copilotInstructionsPath = join(cwd, '.github', 'copilot-instructions.md')

  function scanMcpServers(): readonly DiscoveredMcp[] {
    return [
      ...parseMcpServersFromFile(homeClaudeSettings),
      ...parseMcpServersFromFile(projectClaudeSettings),
    ]
  }

  function scanSkills(): readonly DiscoveredSkill[] {
    return [
      ...parseSkillsFromDir(homeCommandsDir),
      ...parseSkillsFromDir(projectCommandsDir),
      ...parseExtensionsFromDir(extensionsDir),
    ]
  }

  function scanInstructions(): readonly DiscoveredInstruction[] {
    const results: DiscoveredInstruction[] = []

    const claudeMd = parseInstructionFile(claudeMdPath)
    if (claudeMd) results.push(claudeMd)

    const copilotInstructions = parseInstructionFile(copilotInstructionsPath)
    if (copilotInstructions) results.push(copilotInstructions)

    return results
  }

  function scan(): DiscoveredConfig {
    const scannedPaths = [
      homeClaudeSettings,
      projectClaudeSettings,
      homeCommandsDir,
      projectCommandsDir,
      extensionsDir,
      claudeMdPath,
      copilotInstructionsPath,
    ].filter((p) => existsSync(p))

    return {
      mcpServers: scanMcpServers(),
      skills: scanSkills(),
      instructions: scanInstructions(),
      scannedPaths,
      scannedAt: new Date().toISOString(),
    }
  }

  return { scan, scanMcpServers, scanSkills, scanInstructions }
}
