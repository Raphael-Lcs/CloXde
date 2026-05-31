// Gate runner for self-modification: before a self-mod branch is allowed to
// merge back into the running app, it must pass a fixed sequence of gates,
// each run INSIDE the worktree (never the live tree):
//
//   1. install    — provision deps (pnpm); a fresh worktree has no node_modules
//   2. typecheck  — `pnpm typecheck`
//   3. test       — `pnpm test`
//   4. build      — `pnpm build` (produces out/, also proves the bundle compiles)
//   5. smoke      — boot the built app once and confirm it survives N seconds
//                   without crashing (index.ts honors CLOXDE_SMOKE_MS by booting
//                   normally then exiting 0 after the window)
//
// Each gate returns { passed, detail }; we stop at the first failure (a failing
// typecheck makes test/build/smoke meaningless) and report which gate broke.
// The aggregation verdict (allGatesPassed) is a pure function so it can be
// unit-tested without spawning anything.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface GateResult {
  gate: string
  passed: boolean
  /** Captured tail of stdout/stderr or a one-line reason. */
  detail: string
}

export interface GateRunOptions {
  /** The worktree directory the gates run in. */
  cwd: string
  /** Milliseconds the smoke-boot must survive to count as healthy. */
  smokeMs?: number
  /** Per-command timeout (install/build can be slow). */
  cmdTimeoutMs?: number
  /** Streamed progress callback so the caller can surface live gate status. */
  onProgress?: (gate: string, phase: 'start' | 'pass' | 'fail') => void
}

const DEFAULT_SMOKE_MS = 8000
const DEFAULT_CMD_TIMEOUT_MS = 10 * 60 * 1000 // 10 min — install/build headroom
const TAIL_BYTES = 4000

/** Overall verdict: every gate present must have passed. Pure — no I/O — so the
 *  promotion decision is trivially testable. An empty list is NOT a pass (we
 *  never promote on "no gates ran"). */
export function allGatesPassed(results: GateResult[]): boolean {
  return results.length > 0 && results.every((r) => r.passed)
}

/** The first failing gate, or null when all passed. Used for the audit/report
 *  so the assistant can tell the team exactly what to fix. */
export function firstFailure(results: GateResult[]): GateResult | null {
  return results.find((r) => !r.passed) ?? null
}

function tail(s: string): string {
  const t = s.trimEnd()
  return t.length <= TAIL_BYTES ? t : '…' + t.slice(-TAIL_BYTES)
}

interface CmdOutcome {
  code: number | null
  out: string
  timedOut: boolean
}

/** Run a command in `cwd`, capturing combined output. Resolves (never rejects)
 *  with the exit code. On win32 we go through the shell so `pnpm` resolves to
 *  pnpm.cmd; args are all static literals here so there's no injection surface. */
function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv?: NodeJS.ProcessEnv
): Promise<CmdOutcome> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: { ...process.env, ...extraEnv }
    })
    let out = ''
    let timedOut = false
    const cap = (chunk: Buffer): void => {
      out += chunk.toString()
      if (out.length > TAIL_BYTES * 4) out = out.slice(-TAIL_BYTES * 4)
    }
    child.stdout?.on('data', cap)
    child.stderr?.on('data', cap)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 127, out: out + '\n' + (e as Error).message, timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, timedOut })
    })
  })
}

async function commandGate(
  gate: string,
  cmd: string,
  args: string[],
  opts: GateRunOptions
): Promise<GateResult> {
  opts.onProgress?.(gate, 'start')
  const r = await runCmd(cmd, args, opts.cwd, opts.cmdTimeoutMs ?? DEFAULT_CMD_TIMEOUT_MS)
  const passed = r.code === 0 && !r.timedOut
  opts.onProgress?.(gate, passed ? 'pass' : 'fail')
  const reason = r.timedOut ? `超时（>${opts.cmdTimeoutMs ?? DEFAULT_CMD_TIMEOUT_MS}ms）\n` : ''
  return { gate, passed, detail: reason + tail(r.out) }
}

/** Boot the freshly-built app once and confirm it survives `smokeMs` without
 *  crashing. index.ts reads CLOXDE_SMOKE_MS: when set it boots the full normal
 *  path (storage, IPC, LAN server) then exits 0 after the window — so a clean
 *  smoke means "the new code actually starts up". A non-zero/early exit, or a
 *  spawn error, fails the gate. We never let it run unbounded: a hard kill
 *  backstops the in-app self-exit. */
async function smokeGate(opts: GateRunOptions): Promise<GateResult> {
  const gate = 'smoke'
  opts.onProgress?.(gate, 'start')
  const smokeMs = opts.smokeMs ?? DEFAULT_SMOKE_MS
  // `pnpm start` === electron-vite preview, which runs electron on the built
  // out/ dir — the closest thing to a production boot.
  const r = await runCmd('pnpm', ['start'], opts.cwd, smokeMs + 20000, {
    CLOXDE_SMOKE_MS: String(smokeMs)
  })
  // Clean smoke: the in-app hook exits 0 after the window. Any non-zero exit (or
  // crash before the hook fires) fails. A timeout-kill (code null) means the app
  // hung past its self-exit — also a failure.
  const passed = r.code === 0 && !r.timedOut
  opts.onProgress?.(gate, passed ? 'pass' : 'fail')
  return { gate, passed, detail: tail(r.out) }
}

/**
 * Run every gate in order, stopping at the first failure. Returns the results
 * collected so far (so the caller sees exactly where it broke). The worktree
 * must already exist; install provisions its deps.
 */
export async function runGates(opts: GateRunOptions): Promise<GateResult[]> {
  const results: GateResult[] = []
  if (!existsSync(join(opts.cwd, 'package.json'))) {
    return [{ gate: 'precheck', passed: false, detail: `worktree 缺少 package.json：${opts.cwd}` }]
  }

  // Install deps. --frozen-lockfile keeps the run honest: the team must update
  // the lockfile if they change deps, rather than silently resolving new ones.
  const steps: Array<() => Promise<GateResult>> = [
    () => commandGate('install', 'pnpm', ['install', '--frozen-lockfile'], opts),
    () => commandGate('typecheck', 'pnpm', ['typecheck'], opts),
    () => commandGate('test', 'pnpm', ['test'], opts),
    () => commandGate('build', 'pnpm', ['build'], opts),
    () => smokeGate(opts)
  ]

  for (const step of steps) {
    const res = await step()
    results.push(res)
    if (!res.passed) break
  }
  return results
}
