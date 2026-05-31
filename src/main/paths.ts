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
