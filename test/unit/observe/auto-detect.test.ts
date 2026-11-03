import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { autoDetectProjectDirs, autoDetectGitRepos } from '../../../src/observe/auto-detect.js'

describe('auto-detect', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scns-autodetect-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('autoDetectProjectDirs', () => {
    it('detects directories containing package.json', () => {
      const project = join(tempDir, 'my-project')
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, 'package.json'), '{}')

      const dirs = autoDetectProjectDirs([project])
      expect(dirs).toContain(project)
    })

    it('deduplicates paths', () => {
      const project = join(tempDir, 'my-project')
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, 'package.json'), '{}')

      const dirs = autoDetectProjectDirs([project, project, project])
      expect(dirs).toHaveLength(1)
    })

    it('returns empty for non-existent paths', () => {
      const dirs = autoDetectProjectDirs([join(tempDir, 'nope')])
      expect(dirs).toHaveLength(0)
    })

    it('filters out node_modules directories', () => {
      const nm = join(tempDir, 'node_modules', 'dep')
      mkdirSync(nm, { recursive: true })
      writeFileSync(join(nm, 'package.json'), '{}')

      const dirs = autoDetectProjectDirs([nm])
      expect(dirs).toHaveLength(0)
    })
  })

  describe('autoDetectGitRepos', () => {
    it('detects directories with .git folder', () => {
      const repo = join(tempDir, 'my-repo')
      mkdirSync(join(repo, '.git'), { recursive: true })

      const repos = autoDetectGitRepos([repo])
      expect(repos).toContain(repo)
    })

    it('returns empty for non-git directories', () => {
      const dir = join(tempDir, 'plain')
      mkdirSync(dir)

      const repos = autoDetectGitRepos([dir])
      expect(repos).toHaveLength(0)
    })

    it('deduplicates repos', () => {
      const repo = join(tempDir, 'my-repo')
      mkdirSync(join(repo, '.git'), { recursive: true })

      const repos = autoDetectGitRepos([repo, repo])
      expect(repos).toHaveLength(1)
    })

    it('filters out non-existent paths', () => {
      const repos = autoDetectGitRepos([join(tempDir, 'gone')])
      expect(repos).toHaveLength(0)
    })
  })
})
