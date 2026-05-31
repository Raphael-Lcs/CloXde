// ACP runtime: spawns one agent adapter process, owns the ClientSideConnection,
// exposes a small surface our Conversation engine actually uses.
//
// One AcpRuntime instance = one adapter process = one ACP session.
//
// Threading model:
//   • The adapter is a child process. We talk to it over stdio (nd-JSON-RPC).
//   • Our `Client` handler receives streaming `session/update` notifications
//     and fan them out as EventEmitter events for the renderer to consume.
//   • Permission requests are answered by an injected policy function so the
//     conversation engine can plug per-project rules in.

import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client
} from '@agentclientprotocol/sdk'
// All schema types are re-exported by the SDK root.
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  SessionNotification,
  ContentBlock,
  PromptResponse
} from '@agentclientprotocol/sdk'
import type { AgentKind, AgentProfile } from '@shared/types'

// Minimal ANSI / VT escape stripper — adapters dump colored stack traces to
// stderr and we don't want to log raw control chars to the console.
const ANSI_RE = /\[[0-?]*[ -/]*[@-~]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// child.kill() on Windows terminates ONLY the adapter process — the
// grandchildren it spawns (sandboxed exec helpers: codex, python, ffmpeg, …)
// get reparented and orphaned. Across many app launches these accumulate
// until the machine runs out of desktop/handle resources and Windows can no
// longer spawn ANY process — at which point the desktop shortcut silently
// fails (WScript: "insufficient resources") and the app "won't open". So on
// Windows kill the whole tree by PID via taskkill /T; on other platforms a
// direct kill is enough.
function killTree(child: ChildProcess): void {
  if (child.killed) return
  if (process.platform === 'win32' && child.pid != null) {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true
      })
      return
    } catch {
      // taskkill unavailable/blocked — fall through to a direct kill so we at
      // least take the adapter itself down.
    }
  }
  try {
    child.kill()
  } catch {
    // already exited
  }
}

// Built-in adapter packages we ship. Resolved at spawn time relative to the
// app's node_modules so packagers can swap them out.
function defaultAdapterEntry(kind: AgentKind): string {
  switch (kind) {
    case 'claude':
      return require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')
    case 'codex':
      return require.resolve('@zed-industries/codex-acp/bin/codex-acp.js')
    case 'hermes':
      // Hermes is not a JS adapter — it's a standalone Python binary. The
      // spawn logic below detects this and skips ELECTRON_RUN_AS_NODE.
      return defaultHermesPath()
  }
}

/**
 * Best-effort default path to the user's local Hermes CLI:
 *   • Windows: %LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe
 *   • macOS/Linux: rely on PATH (`hermes`)
 *
 * Users with a non-standard install can override by setting `command` in the
 * profile (Settings → Agent → Hermes → 启动命令).
 */
export function defaultHermesPath(): string {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local) {
      return path.join(local, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe')
    }
  }
  return 'hermes'
}

/** True when the adapter is a JS file that needs Electron-as-Node to run. */
function isJsAdapter(profile: AgentProfile): boolean {
  // User-supplied custom commands are treated as standalone binaries.
  if (profile.command) return false
  // Built-in defaults: claude/codex are JS, hermes is a binary.
  return profile.kind === 'claude' || profile.kind === 'codex'
}

export interface PermissionPolicy {
  (params: RequestPermissionRequest): Promise<RequestPermissionResponse>
}

export interface FsPolicy {
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>
}

export interface AcpRuntimeOptions {
  profile: AgentProfile
  cwd: string
  permission: PermissionPolicy
  fs: FsPolicy
  /** If set, AcpRuntime tries `session/load` first and only falls back to
   *  `session/new` on failure or when the agent lacks the capability. */
  savedSessionId?: string
  /** Fired once we have a session id, with `restored` indicating whether it
   *  came from `loadSession` (true) or a fresh `newSession` (false). */
  onSessionReady?: (sessionId: string, restored: boolean) => void
}

export interface AcpRuntimeEvents {
  update: (notification: SessionNotification) => void
  exit: (info: { code: number | null; signal: string | null }) => void
  error: (err: Error) => void
}

export class AcpRuntime extends EventEmitter {
  /** Upper bound on the spawn→initialize→session handshake. Generous on
   *  purpose: only meant to break a permanently-wedged adapter. */
  private static readonly INIT_TIMEOUT_MS = 60_000
  private process: ChildProcess | null = null
  private conn: ClientSideConnection | null = null
  private sessionId: string | null = null
  private starting: Promise<void> | null = null
  /** Reject fn for the turn currently awaiting `prompt()`, if any. Lets the
   *  exit/dispose paths unblock a caller instead of leaving it waiting on a
   *  stream that will never answer (e.g. the adapter crashed mid-turn). */
  private pendingPromptReject: ((err: Error) => void) | null = null
  /** When true, we suppress `update` events — used to silently drink the
   *  history replay that `loadSession` streams back. */
  private suppressUpdates = false
  /** Set by restartFresh(): forces the next bringUp() to open a brand-new
   *  session instead of resuming the saved one. Cleared once consumed. */
  private forceFresh = false

  constructor(private readonly opts: AcpRuntimeOptions) {
    super()
  }

  /** Idempotent: spawn + initialize + create session. Returns sessionId. */
  async start(): Promise<string> {
    if (this.sessionId) return this.sessionId
    if (!this.starting) {
      // A failed bring-up must NOT poison future retries. If we leave the
      // rejected promise cached in `this.starting`, every later start() just
      // re-awaits the same rejection and the side is bricked until the app
      // restarts. Clear it on failure so the next call re-attempts spawn+init.
      this.starting = this.bringUp().catch((err) => {
        this.starting = null
        throw err
      })
    }
    await this.starting
    if (!this.sessionId) throw new Error('ACP runtime failed to obtain session id')
    return this.sessionId
  }

  private async bringUp(): Promise<void> {
    const { profile, cwd, permission, fs } = this.opts

    // Resolve {command, args} for this profile. Three cases:
    //   • profile.command set    → use it verbatim (custom binary)
    //   • kind=claude/codex      → Electron-as-Node + bundled JS adapter
    //   • kind=hermes (default)  → standalone Hermes CLI + `acp --accept-hooks`
    let command: string
    let args: string[]
    if (profile.command) {
      command = profile.command
      args = profile.args
    } else if (profile.kind === 'hermes') {
      command = defaultHermesPath()
      args = ['acp', '--accept-hooks', ...profile.args]
    } else {
      command = process.execPath
      args = [defaultAdapterEntry(profile.kind), ...profile.args]
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...profile.env
    }
    // Only flip Electron into Node mode when we're actually launching a JS
    // adapter via process.execPath. Hermes is its own Python executable —
    // leaking this var into a non-Electron child can mis-configure tools it
    // spawns downstream.
    if (isJsAdapter(profile)) {
      env.ELECTRON_RUN_AS_NODE = '1'
    }

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.process = child

    child.on('error', (err) => this.emit('error', err))
    child.on('exit', (code, signal) => {
      this.emit('exit', { code, signal })
      // dispose() removes our listeners before it kills the process, so a
      // handler running here means the adapter exited on its own — a crash,
      // OOM, or the adapter bailing. The `=== child` guard ignores a late
      // 'exit' from a previous process after we've already respawned.
      if (this.process === child) {
        // Drop the now-dead connection/session so the NEXT prompt() routes
        // through start() and respawns a fresh process instead of writing
        // into a closed stream forever.
        this.process = null
        this.conn = null
        this.sessionId = null
        this.starting = null
        // If a turn was in flight, the adapter just died under it. Reject the
        // pending prompt so the engine's turn loop recovers (→ awaiting-user)
        // instead of hanging on a request the dead adapter can never answer.
        this.rejectPending(
          new Error(`adapter exited mid-turn (code=${code}, signal=${signal ?? 'null'})`)
        )
      }
    })
    // Adapters are chatty — codex-acp in particular spews verbose runtime
    // errors (e.g. Windows sandbox spawn failures) to stderr. We log them
    // to the main-process console for debugging but don't surface them as
    // user-visible system messages: they're noise, not actionable signal,
    // and would flood the conversation view if mirrored.
    child.stderr?.on('data', (buf: Buffer) => {
      const text = stripAnsi(buf.toString('utf8')).trimEnd()
      if (text) console.error(`[${profile.kind} adapter]`, text)
    })

    if (!child.stdin || !child.stdout) {
      throw new Error('Failed to attach to adapter stdio')
    }

    const toAgent = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>
    const fromAgent = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    const stream = ndJsonStream(toAgent, fromAgent)

    const client: Client = {
      requestPermission: permission,
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        if (this.suppressUpdates) return
        this.emit('update', params)
      },
      readTextFile: fs.readTextFile.bind(fs),
      writeTextFile: fs.writeTextFile.bind(fs),
      // Optional capabilities — the SDK calls these only when the agent uses them.
      // Terminals: we don't expose them in v0.6, the agent will fall back.
      createTerminal: async () => {
        throw new Error('terminal/create is not supported by this client yet')
      }
    }

    const conn = new ClientSideConnection(() => client, stream)
    this.conn = conn

    // Guard the JSON-RPC handshake with a timeout. A spawned-but-wedged adapter
    // (hung Python binary, a build that never answers `initialize`) would
    // otherwise leave `start()` awaiting forever — and since `prompt()` awaits
    // `start()`, the side's turn hangs and the conversation is stuck "thinking"
    // with no recovery. On timeout we throw so start() clears `this.starting`
    // and the engine surfaces an error (→ awaiting-user); the child is killed
    // in the catch so it doesn't linger as a zombie.
    try {
      await this.withInitTimeout(this.handshake(conn, cwd))
    } catch (err) {
      if (this.process === child) killTree(child)
      throw err
    }
  }

  /** initialize → resume-or-create-session. Split out of bringUp so the whole
   *  handshake can be raced against a single timeout. */
  private async handshake(conn: ClientSideConnection, cwd: string): Promise<void> {
    const initResult = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true }
      }
    })

    // Try to resume a previous session if we have one and the agent supports
    // it. Failure (or missing capability) falls through to `newSession`.
    // `forceFresh` (set by restartFresh for context-compaction) skips the
    // resume entirely so we get a clean, empty session.
    let restored = false
    const consumedForceFresh = this.forceFresh
    this.forceFresh = false
    if (
      !consumedForceFresh &&
      this.opts.savedSessionId &&
      initResult.agentCapabilities?.loadSession
    ) {
      try {
        this.suppressUpdates = true
        await conn.loadSession({
          sessionId: this.opts.savedSessionId,
          cwd,
          mcpServers: []
        })
        this.sessionId = this.opts.savedSessionId
        restored = true
      } catch {
        // Saved session is no longer valid agent-side — fall back below.
        this.sessionId = null
      } finally {
        this.suppressUpdates = false
      }
    }

    if (!this.sessionId) {
      const session = await conn.newSession({ cwd, mcpServers: [] })
      this.sessionId = session.sessionId
    }

    // Remember the live session id so a *later* respawn (adapter crash) tries
    // to resume the most recent session rather than a stale saved one. Safe
    // to mutate — `readonly` guards the binding, not the object's fields.
    this.opts.savedSessionId = this.sessionId

    this.opts.onSessionReady?.(this.sessionId, restored)
  }

  /** Race a handshake promise against a generous timeout. The window is wide
   *  (cold-start spawns + first-run model downloads are legitimately slow) — it
   *  exists only to break a truly wedged adapter, not to police latency. */
  private withInitTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('adapter did not complete ACP handshake in time')),
        AcpRuntime.INIT_TIMEOUT_MS
      )
    })
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
  }

  /** Send a user prompt and wait for the turn to settle. */
  async prompt(blocks: ContentBlock[]): Promise<PromptResponse> {
    if (!this.conn || !this.sessionId) await this.start()
    if (!this.conn || !this.sessionId) throw new Error('runtime not started')
    const conn = this.conn
    const sessionId = this.sessionId
    // Wrap the SDK call so `rejectPending` (driven by exit/dispose) can settle
    // this promise if the adapter dies before it answers. The turn loop runs
    // one prompt per side at a time, so a single pending slot is enough.
    return new Promise<PromptResponse>((resolve, reject) => {
      this.pendingPromptReject = reject
      const clear = (): void => {
        if (this.pendingPromptReject === reject) this.pendingPromptReject = null
      }
      conn.prompt({ sessionId, prompt: blocks }).then(
        (r) => {
          clear()
          resolve(r)
        },
        (e) => {
          clear()
          reject(e as Error)
        }
      )
    })
  }

  /** Settle the in-flight prompt (if any) with an error. Idempotent. */
  private rejectPending(err: Error): void {
    const reject = this.pendingPromptReject
    if (!reject) return
    this.pendingPromptReject = null
    reject(err)
  }

  /** Cancel the in-flight turn (if any). */
  async cancel(): Promise<void> {
    if (!this.conn || !this.sessionId) return
    try {
      await this.conn.cancel({ sessionId: this.sessionId })
    } catch {
      /* ignore — adapter may already be idle */
    }
  }

  /** Abandon the current process + ACP session and force a brand-new session
   *  on the next prompt(). Used for context-compaction: when the adapter's
   *  session history grows past the model's limit, we throw it away and
   *  reseed a fresh session with a CloXde-built summary instead of the full
   *  transcript. Unlike dispose(), this KEEPS our event listeners wired so
   *  the engine keeps receiving updates from the respawned process. */
  async restartFresh(): Promise<void> {
    const old = this.process
    // Null our refs BEFORE killing so the child's 'exit' handler sees
    // `this.process !== child` and skips its state-clobbering / rejectPending
    // branch (we're tearing down deliberately, not crashing).
    this.process = null
    this.conn = null
    this.sessionId = null
    this.starting = null
    this.forceFresh = true
    if (old) {
      // Detach our handlers from the abandoned child BEFORE killing it. We've
      // already nulled `this.process`, so the exit handler's `=== child` guard
      // would skip its body anyway — but the stderr/exit/error listeners would
      // otherwise stay bound to the dying process until it fully exits, and a
      // late stderr flush would still log noise for a process we've moved on
      // from. Dropping them now lets the old child + its closures be collected.
      old.removeAllListeners()
      old.stderr?.removeAllListeners()
      killTree(old)
    }
  }

  /** Tear everything down. The graceful `cancel()` is raced against a short
   *  timeout — some adapters (e.g. Hermes waiting on a permission request
   *  with no UI to grant it) never respond to cancel, and we must NOT let
   *  that block the caller. After the timeout we hard-kill the process. */
  async dispose(): Promise<void> {
    try {
      if (this.conn && this.sessionId) {
        await Promise.race([
          this.conn
            .cancel({ sessionId: this.sessionId })
            .catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 1500))
        ])
      }
    } finally {
      this.conn = null
      this.sessionId = null
      this.starting = null
      if (this.process && !this.process.killed) {
        killTree(this.process)
      }
      this.process = null
      // Unblock any caller still awaiting prompt() — we're tearing down, and
      // the cancel() above may not settle it (a wedged adapter never acks).
      this.rejectPending(new Error('runtime disposed'))
      // Detach every engine-side listener. The process is dead; a late
      // 'exit'/'error' must not fire handlers bound to a now-disposed
      // conversation, and dropping them lets the runtime + its captured
      // closures be collected.
      this.removeAllListeners()
    }
  }
}
