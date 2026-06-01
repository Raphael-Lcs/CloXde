// CloXde supervisor (daemon) — the system-level guardian that owns the app's
// lifecycle so a double-click launch is robust and self-restart is instant.
//
// Why this exists (Plan B, chosen by the user over fixing the .bat watchdog):
//   • Windows batch is a syntax minefield (CRLF, redirect quirks, no JSON) and
//     proved too fragile for the crash-loop / rollback logic.
//   • In agent mode the app must be able to RESTART ITSELF directly (not "quit
//     then the user reopens"). A long-lived parent process makes that a sub-
//     second respawn.
//
// What it does, in a loop:
//   1. spawn `electron-vite dev` (the app), streaming its output to launcher.log
//   2. wait for it to exit, then read the app's INTENT FILE (written just before
//      exit) to decide what the exit MEANT — electron-vite doesn't reliably pass
//      the child's exit code through, so the intent file is authoritative:
//        'restart' → re-spawn immediately (self-mod promotion, or tray "重启")
//        'quit'    → stop supervising (user quit via tray)
//        absent    → treat as a CRASH
//   3. on crashes: count them in a rolling window; if we hit a crash-loop AND the
//      current HEAD is a self-mod promoted commit, conservatively roll back to the
//      last-good commit (never touches plain user changes), then respawn.
//   4. track last-good: any run that stayed up past STABLE_UPTIME promotes the
//      current HEAD to last-good (persisted across supervisor restarts).
//
// Run directly: `node scripts/supervisor.mjs`. cloxde-launcher.bat is a thin
// wrapper around exactly this.

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

const isWin = process.platform === 'win32'
const HOME = homedir()
const CLOXDE_DIR = join(HOME, '.cloxde')
// Logs live under LOCALAPPDATA on Windows (matches the old launcher), ~/.cloxde
// elsewhere. The intent + audit files always live under ~/.cloxde to match the
// app (paths.ts / supervisor-intent.ts / selfmod-audit.ts).
const LOG_DIR = isWin && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'CloXde') : CLOXDE_DIR
const LOG_FILE = join(LOG_DIR, 'launcher.log')
const STATE_FILE = join(LOG_DIR, 'watchdog-state.txt') // last-good commit
const INTENT_FILE = join(CLOXDE_DIR, 'supervisor-intent')
const AUDIT_FILE = join(CLOXDE_DIR, 'selfmod-audit.jsonl')

const CRASH_THRESHOLD = 3 // crashes within the window that trip rollback
const CRASH_WINDOW_MS = 60_000
const STABLE_UPTIME_MS = 120_000 // a run this long proves the code is good
const RESTART_DELAY_MS = 1_000 // small breather between crash respawns

mkdirSync(LOG_DIR, { recursive: true })
mkdirSync(CLOXDE_DIR, { recursive: true })

// Fresh log per supervisor session, then append across respawns.
const logFd = openSync(LOG_FILE, 'w')
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    writeSync(logFd, line)
  } catch {
    /* ignore */
  }
  process.stdout.write(line)
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8' }).trim()
  } catch (e) {
    log(`git ${args.join(' ')} failed: ${e.message ?? e}`)
    return null
  }
}

function readHead() {
  return git(['rev-parse', 'HEAD'])
}

// Read + consume the intent file the app wrote just before exiting. Deleting it
// is critical: a stale intent would misclassify the NEXT exit.
function consumeIntent() {
  if (!existsSync(INTENT_FILE)) return null
  let val = null
  try {
    val = readFileSync(INTENT_FILE, 'utf-8').trim()
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(INTENT_FILE)
  } catch {
    /* ignore */
  }
  return val === 'restart' || val === 'quit' ? val : null
}

// Is the current HEAD a self-mod *promoted* commit? Only then will we roll back —
// we must never discard a user's own hand-made commits on a crash-loop.
function headIsSelfMod(head) {
  if (!head || !existsSync(AUDIT_FILE)) return false
  try {
    const lines = readFileSync(AUDIT_FILE, 'utf-8').split('\n')
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        const o = JSON.parse(t)
        if (o.phase === 'promoted' && o.resultCommit === head) return true
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* ignore */
  }
  return false
}

function recordRollback(toCommit) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      phase: 'rolled-back',
      runId: 'supervisor',
      detail: `crash-loop detected; rolled back to ${toCommit}`
    }
    writeFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', { flag: 'a' })
  } catch (e) {
    log(`audit write failed: ${e.message ?? e}`)
  }
}

// --- last-good commit -------------------------------------------------------
let lastGood = null
if (existsSync(STATE_FILE)) {
  try {
    lastGood = readFileSync(STATE_FILE, 'utf-8').trim() || null
  } catch {
    /* ignore */
  }
}
if (!lastGood) {
  lastGood = readHead()
  if (lastGood) writeFileSync(STATE_FILE, lastGood)
}
function promoteLastGood() {
  const head = readHead()
  if (head && head !== lastGood) {
    lastGood = head
    try {
      writeFileSync(STATE_FILE, head)
    } catch {
      /* ignore */
    }
    log(`stable run; last-good updated to ${head}`)
  }
}

// --- child process ----------------------------------------------------------
function spawnApp() {
  const bin = isWin
    ? join(REPO_ROOT, 'node_modules', '.bin', 'electron-vite.cmd')
    : join(REPO_ROOT, 'node_modules', '.bin', 'electron-vite')
  // Electron must boot as Electron, not plain Node.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  log(`--- starting app (${bin} dev) ---`)
  return spawn(bin, ['dev'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', logFd, logFd],
    shell: isWin, // .cmd shim needs a shell on Windows
    windowsHide: false
  })
}

function waitExit(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', (err) => {
      log(`spawn error: ${err.message}`)
      resolve({ code: -1, signal: null })
    })
  })
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// --- main loop --------------------------------------------------------------
let crashTimes = []
let current = null

async function loop() {
  log(`CloXde supervisor starting. repo=${REPO_ROOT} last-good=${lastGood}`)
  if (!existsSync(isWin ? join(REPO_ROOT, 'node_modules', '.bin', 'electron-vite.cmd') : join(REPO_ROOT, 'node_modules', '.bin', 'electron-vite'))) {
    log('node_modules not found. Run "pnpm install" once first.')
    closeSync(logFd)
    process.exit(1)
  }

  // Clear any stale intent from a previous (crashed) session so it can't
  // misclassify this run's first exit.
  consumeIntent()

  for (;;) {
    const startedAt = Date.now()
    current = spawnApp()
    const { code, signal } = await waitExit(current)
    current = null
    const uptime = Date.now() - startedAt
    const intent = consumeIntent()
    log(`app exited: code=${code} signal=${signal ?? '-'} uptime=${Math.round(uptime / 1000)}s intent=${intent ?? 'none'}`)

    // A run that stayed up long enough is trustworthy regardless of how it ends.
    if (uptime >= STABLE_UPTIME_MS) promoteLastGood()

    if (intent === 'quit') {
      log('intent=quit; stopping supervisor.')
      break
    }
    if (intent === 'restart') {
      log('intent=restart; respawning onto current code.')
      crashTimes = [] // an intentional restart is not a crash
      continue
    }

    // No intent file → this was a crash (or an unexpected clean exit). If the
    // child exited 0 with no intent, treat it as a graceful stop (e.g. someone
    // killed electron-vite from a terminal) rather than crash-looping.
    if (code === 0) {
      log('exit 0 with no intent; treating as clean stop. stopping supervisor.')
      break
    }

    // Crash path: record + prune the rolling window.
    const now = Date.now()
    crashTimes.push(now)
    crashTimes = crashTimes.filter((t) => t >= now - CRASH_WINDOW_MS)
    log(`crash count in last ${CRASH_WINDOW_MS / 1000}s: ${crashTimes.length}`)

    if (crashTimes.length >= CRASH_THRESHOLD) {
      log('crash-loop detected.')
      const head = readHead()
      if (headIsSelfMod(head)) {
        if (lastGood) {
          log(`HEAD is a self-mod commit; rolling back to ${lastGood}`)
          git(['reset', '--hard', lastGood])
          recordRollback(lastGood)
          crashTimes = []
          continue // respawn onto the rolled-back code
        }
        log('no last-good commit recorded; cannot roll back. stopping.')
        break
      }
      log('HEAD is not a self-mod commit; refusing to roll back user changes. stopping.')
      break
    }

    await delay(RESTART_DELAY_MS)
  }

  closeSync(logFd)
  process.exit(0)
}

// Forward termination to the child so we don't orphan electron-vite. On Windows
// the tracked child is the cmd.exe shell wrapping electron-vite → node → electron;
// child.kill() would only reap the shell and orphan electron.exe (which then keeps
// the single-instance lock + port 7878, blocking the next launch). taskkill /T
// kills the whole descendant tree.
function killChild() {
  if (!current || current.pid == null) return
  try {
    if (isWin) {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(current.pid)], { stdio: 'ignore' })
    } else {
      current.kill()
    }
  } catch {
    /* ignore */
  }
}

function shutdown(sig) {
  log(`supervisor received ${sig}; terminating child and exiting.`)
  killChild()
  try {
    closeSync(logFd)
  } catch {
    /* ignore */
  }
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

loop().catch((e) => {
  log(`supervisor fatal: ${e?.stack ?? e}`)
  try {
    closeSync(logFd)
  } catch {
    /* ignore */
  }
  process.exit(1)
})
