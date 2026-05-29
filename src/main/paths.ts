import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

// All user data lives under ~/.cloxde (per DESIGN §4.2 / §9).
// We compute paths lazily: the bundler keeps top-level access to electron.app
// minimal so the module loads cleanly even before Electron has finished
// wiring up its runtime API.

let cached: { cloxdeDir: string; configPath: string; dbPath: string } | null = null

function compute(): { cloxdeDir: string; configPath: string; dbPath: string } {
  if (cached) return cached
  const home = app.getPath('home')
  cached = {
    cloxdeDir: join(home, '.cloxde'),
    configPath: join(home, '.cloxde', 'config.json'),
    dbPath: join(home, '.cloxde', 'cloxde.db')
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

export function ensureCloxdeDir(): void {
  mkdirSync(compute().cloxdeDir, { recursive: true })
}
