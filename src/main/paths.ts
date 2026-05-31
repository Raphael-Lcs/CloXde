import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'

// All user data lives under ~/.cloxde (per DESIGN §4.2 / §9).
// We compute paths lazily: the bundler keeps top-level access to electron.app
// minimal so the module loads cleanly even before Electron has finished
// wiring up its runtime API.

let cached: {
  cloxdeDir: string
  configPath: string
  dbPath: string
  workspaceDir: string
} | null = null

// The assistant's workspace can grow large (it holds the full project codebases
// teams build), so it's relocatable independently of the small data files (db,
// auth). config.json's optional `workspaceDir` overrides the default; everything
// else stays under ~/.cloxde. Read is best-effort — a missing/garbled config
// just falls back to the default.
function readWorkspaceOverride(cloxdeDir: string): string | null {
  try {
    const configPath = join(cloxdeDir, 'config.json')
    if (!existsSync(configPath)) return null
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as { workspaceDir?: unknown }
    return typeof cfg.workspaceDir === 'string' && cfg.workspaceDir.trim()
      ? cfg.workspaceDir.trim()
      : null
  } catch {
    return null
  }
}

function compute(): {
  cloxdeDir: string
  configPath: string
  dbPath: string
  workspaceDir: string
} {
  if (cached) return cached
  const home = app.getPath('home')
  const cloxdeDir = join(home, '.cloxde')
  cached = {
    cloxdeDir,
    configPath: join(cloxdeDir, 'config.json'),
    dbPath: join(cloxdeDir, 'cloxde.db'),
    // The assistant's own workspace — the root under which it scaffolds the
    // projects it creates. The assistant never edits code here itself; it
    // creates a project folder and hands it to the team to work in. Defaults
    // under ~/.cloxde but can be relocated (e.g. to another drive) via
    // config.json's `workspaceDir`.
    workspaceDir: readWorkspaceOverride(cloxdeDir) ?? join(cloxdeDir, 'workspace')
  }
  return cached
}

export function getCloxdeDir(): string {
  return compute().cloxdeDir
}
export function getConfigPath(): string {
  return compute().configPath
}
export function getDbPath(): string {
  return compute().dbPath
}
export function getWorkspaceDir(): string {
  return compute().workspaceDir
}
/** The assistant's editable persona file (Hermes-style SOUL.md). Lives beside
 *  config.json in ~/.cloxde — it's a small, user-authored config, NOT part of the
 *  relocatable workspace that holds project codebases. */
export function getSoulPath(): string {
  return join(compute().cloxdeDir, 'SOUL.md')
}

export function ensureCloxdeDir(): void {
  mkdirSync(compute().cloxdeDir, { recursive: true })
}

export function ensureWorkspaceDir(): void {
  mkdirSync(compute().workspaceDir, { recursive: true })
}

// --- Self-modification (Milestone 2) ---------------------------------------
// The assistant can treat "improve CloXde itself" as a project: a team edits
// CloXde's own source on an isolated git worktree, gates run, and on success
// the branch merges back. That is only possible when we're running from a real
// git checkout (dev), NOT from a packaged asar bundle where the source is
// read-only and there's no .git tree to branch from.

let repoRootCache: string | null | undefined

/**
 * The CloXde source git working tree root, or null when unavailable
 * (packaged build, or no .git found walking up from the app path).
 *
 * In dev, app.getAppPath() resolves to the project root (the dir holding
 * package.json). We walk upward looking for a `.git` entry so the result holds
 * even if the layout shifts. Cached after first probe.
 */
export function getRepoRoot(): string | null {
  if (repoRootCache !== undefined) return repoRootCache
  if (app.isPackaged) {
    repoRootCache = null
    return null
  }
  let dir = app.getAppPath()
  // Walk up at most a handful of levels to find the repo root.
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, '.git'))) {
      repoRootCache = dir
      return dir
    }
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  repoRootCache = null
  return null
}

/** True only when self-modification is mechanically possible: running from
 *  source with a reachable git working tree. Packaged builds always return
 *  false — the watchdog/self-mod loop is a dev-only capability for now. */
export function isSelfModAvailable(): boolean {
  return getRepoRoot() !== null
}
