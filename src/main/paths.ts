import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

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

function compute(): {
  cloxdeDir: string
  configPath: string
  dbPath: string
  workspaceDir: string
} {
  if (cached) return cached
  const home = app.getPath('home')
  cached = {
    cloxdeDir: join(home, '.cloxde'),
    configPath: join(home, '.cloxde', 'config.json'),
    dbPath: join(home, '.cloxde', 'cloxde.db'),
    // The assistant's own workspace — the root under which it scaffolds the
    // projects it creates. The assistant never edits code here itself; it
    // creates a project folder and hands it to the team to work in.
    workspaceDir: join(home, '.cloxde', 'workspace')
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

export function ensureCloxdeDir(): void {
  mkdirSync(compute().cloxdeDir, { recursive: true })
}

export function ensureWorkspaceDir(): void {
  mkdirSync(compute().workspaceDir, { recursive: true })
}
