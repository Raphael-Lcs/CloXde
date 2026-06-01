// Bridge between the running app and the Node.js supervisor (scripts/supervisor.mjs).
//
// electron-vite sits between the supervisor and Electron and does NOT reliably
// propagate the child's exit code, so we can't rely on `exit(42)` alone to tell
// the supervisor "this was an intentional restart, not a crash". Instead the app
// writes its intent to a file the supervisor reads (and deletes) after the child
// exits: 'restart' → re-spawn immediately, 'quit' → stop supervising, absent →
// treated as a crash (crash-loop counting + conservative rollback).
//
// The path MUST match INTENT_FILE in scripts/supervisor.mjs.

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type SupervisorIntent = 'restart' | 'quit'

// Recorded ahead of the actual exit so the canonical before-quit teardown can
// flush the right intent. Defaults to 'quit' (a plain user quit) when nothing
// set a restart.
let pending: SupervisorIntent | null = null

/** Record the intent for the imminent exit. Call before app.quit()/app.exit(). */
export function setSupervisorIntent(intent: SupervisorIntent): void {
  pending = intent
}

/** Write the recorded intent (default 'quit') to the file the supervisor reads.
 *  Synchronous + best-effort: any failure must not block the app from exiting. */
export function flushSupervisorIntent(): void {
  const intent: SupervisorIntent = pending ?? 'quit'
  try {
    const dir = join(homedir(), '.cloxde')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'supervisor-intent'), intent, 'utf-8')
  } catch (e) {
    console.error('[supervisor-intent] write failed:', e)
  }
}
