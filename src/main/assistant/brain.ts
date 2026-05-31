// The assistant's brain: a single long-lived ACP session (default Claude Code)
// running with the 管家 system prompt. It is the judgment+action layer — it
// takes a *signal* (user message, team turn-end, capability gap, instability,
// cron), recalls relevant memory, thinks, and either acts directly with its own
// tools or delegates to a team.
//
// Capability model (revised 2026-05-31, user correction): like Hermes/openclaw,
// the brain is a FULL tool-capable agent — it can read, write, and run things
// itself. What distinguishes it is *team awareness*: it does small/direct work
// with its own hands, but dispatches substantial build/feature/fix work to a
// dedicated team (PM+architect+executor) via <<DISPATCH>>. Permissions are
// auto-approved (full autonomy) and the fs policy allows reads AND writes. The
// earlier "deny every tool" boundary was the wrong model — it made a tool-first
// agent spin on denials — and has been removed.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  SessionNotification,
  ContentBlock
} from '@agentclientprotocol/sdk'
import type { AgentProfile, AssistantTurn, MemoryHit } from '@shared/types'
import { AcpRuntime } from '../acp/runtime'
import { getWorkspaceDir, ensureWorkspaceDir } from '../paths'
import { getMemoryService } from './memory'
import * as actions from './actions'
import { ASSISTANT_SYSTEM_PROMPT } from './prompts'

/** A reason the brain is being woken. Free-form `text` is what the brain reads;
 *  `kind` lets callers (and future logic) reason about the trigger class. */
export interface Signal {
  kind:
    | 'user-message'
    | 'review'
    | 'capability-gap'
    | 'instability'
    | 'cron'
    | 'reflection'
  text: string
  /** Optional image/file attachments (base64 data + mimeType). */
  attachments?: { data: string; mimeType: string }[]
  /** Optional provenance for memory/report attribution. */
  projectId?: string
  conversationId?: string
}

/** What a single think() pass did, for logging/UI. */
export type ThinkResult = AssistantTurn

// The brain runs Claude Code as a normal ACP adapter, but with an empty
// projectId — it is user-scoped, not project-scoped. cwd is the assistant's
// workspace so any (read-only) discovery lands somewhere sensible.
function brainProfile(): AgentProfile {
  const now = Date.now()
  return {
    id: 'assistant-brain',
    projectId: '',
    kind: 'claude',
    name: 'CloXde Assistant',
    command: null,
    args: [],
    env: {},
    createdAt: now,
    updatedAt: now
  }
}

// Auto-approve EVERY tool-permission request — the brain has full autonomy and
// real hands. We still surface a 'tool' activity (from the update stream) so the
// user can watch what it's doing; the approval itself is silent.
const allowAllPermission = async (
  params: RequestPermissionRequest
): Promise<RequestPermissionResponse> => {
  const allow =
    params.options.find((o) => o.kind === 'allow_always') ??
    params.options.find((o) => o.kind === 'allow_once') ??
    params.options[0]
  return allow
    ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

// Full read/write filesystem access. Unlike a team (sandboxed to its project
// root), the 管家 may touch the workspace and beyond — it manages "life + work
// + machines", so we don't fence it to a single directory.
const readWriteFs = {
  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const text = await readFile(params.path, 'utf-8')
    if (params.limit || params.line) {
      const lines = text.split(/\r?\n/)
      const start = (params.line ?? 1) - 1
      const end = params.limit ? start + params.limit : lines.length
      return { content: lines.slice(start, end).join('\n') }
    }
    return { content: text }
  },
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    await mkdir(dirname(params.path), { recursive: true })
    await writeFile(params.path, params.content, 'utf-8')
    return {}
  }
}

/** Collect all `<<TAG>> body <</TAG>>` blocks for a tag (closing optional, body
 *  runs to the next tag or end — same lenient convention as the team parser). */
function extractAll(text: string, tag: string): string[] {
  const re = new RegExp(`<<${tag}>>([\\s\\S]*?)(?:<<\\/${tag}>>|(?=<<\\/?[A-Za-z])|$)`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const body = (m[1] ?? '').trim()
    if (body) out.push(body)
  }
  return out
}

/** Remove all directive tag blocks (DISPATCH/REMEMBER/REPORT) from the brain's
 *  output, leaving just the natural-language reply to show the user. */
function stripDirectives(text: string): string {
  return text
    .replace(/<<(DISPATCH|REMEMBER|REPORT)>>[\s\S]*?(?:<<\/\1>>|(?=<<\/?[A-Za-z])|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export class AssistantBrain {
  /** Upper bound on a single think() turn. The 管家 may do real tool work
   *  itself, so this is generous — substantial/long work is delegated to a
   *  team, so a turn past this is almost certainly wedged (a stuck tool). We
   *  cancel and surface an error instead of leaving the UI spinning forever. */
  private static readonly TURN_TIMEOUT_MS = 240_000
  private runtime: AcpRuntime | null = null
  private systemPromptSent = false
  private buffer = ''
  /** Serializes think() calls — one ACP session, one turn at a time. */
  private chain: Promise<unknown> = Promise.resolve()
  /** Count of think() calls not yet settled. The brain is a heavy local
   *  process; the review loop checks this so a proactive pass never piles up
   *  behind an active user conversation (which would drag the machine while the
   *  user is right there using it). */
  private inFlight = 0

  /** True while at least one think() turn is queued or running. */
  isBusy(): boolean {
    return this.inFlight > 0
  }

  private ensureRuntime(): AcpRuntime {
    if (this.runtime) return this.runtime
    // The brain spawns its adapter with cwd = the workspace dir. On Windows a
    // missing cwd makes spawn() fail with a misleading ENOENT (reported against
    // the command, surfacing to the UI as "write EPIPE"). The workspace is
    // otherwise only created lazily on first project dispatch, so create it
    // here before it's ever used as a spawn cwd.
    ensureWorkspaceDir()
    const rt = new AcpRuntime({
      profile: brainProfile(),
      cwd: getWorkspaceDir(),
      permission: allowAllPermission,
      fs: readWriteFs,
      // Keep the delegator identity correct across (re)connections. The brain
      // is one long-lived session, but an adapter crash respawns it: runtime
      // either restores the prior session (system prompt context intact) or
      // opens a fresh one (needs the prompt re-sent). Without this, a fresh
      // post-crash session would inherit systemPromptSent=true and silently
      // run as a plain assistant with no team awareness.
      onSessionReady: (_sessionId, restored) => {
        this.systemPromptSent = restored
      }
    })
    rt.on('update', (n: SessionNotification) => {
      const u = n.update
      if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
        this.buffer += u.content.text
      } else if (u.sessionUpdate === 'agent_thought_chunk' && u.content.type === 'text') {
        // The model's reasoning — the best liveness signal. Stream it as a
        // 'thought' activity so the UI proves the brain is working.
        actions.emitActivity({ phase: 'thought', text: u.content.text })
      } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        const title = u.title ?? u.kind ?? 'tool'
        actions.emitActivity({ phase: 'tool', text: title })
      }
    })
    rt.on('error', (err: Error) => console.error('[assistant-brain] error:', err.message))
    this.runtime = rt
    return rt
  }

  /** Wake the brain with a signal. Recalls memory, prompts the brain, parses
   *  and executes the directives it emits. Calls are serialized. */
  think(signal: Signal): Promise<ThinkResult> {
    this.inFlight++
    const run = this.chain.then(() => this.thinkOnce(signal))
    // Keep the chain alive regardless of this call's outcome.
    this.chain = run.catch(() => undefined)
    return run.finally(() => {
      this.inFlight--
    })
  }

  private async thinkOnce(signal: Signal): Promise<ThinkResult> {
    const memory = getMemoryService()
    const hits = await memory.recall(signal.text, { k: 6 })

    const rt = this.ensureRuntime()
    this.buffer = ''
    actions.emitActivity({ phase: 'start' })
    try {
      // Bring the session up FIRST so onSessionReady has run and
      // systemPromptSent reflects the real session state (fresh vs restored).
      // Deciding includeSystem before this would race a post-crash respawn: a
      // fresh session could be left without the delegator prompt. start() is
      // idempotent — the prompt() below reuses the now-live session.
      await rt.start()
      // Don't mark the prompt delivered until prompt() actually succeeds —
      // otherwise a failed turn (e.g. adapter spawn error) would burn the flag
      // and every later turn would run with no delegator identity.
      const includeSystem = !this.systemPromptSent
      const promptText = this.buildPrompt(signal, hits, includeSystem)

      // Build content blocks: text prompt + any image/file attachments the user
      // sent. The adapter (Claude Code) supports multimodal input.
      const blocks: ContentBlock[] = [{ type: 'text', text: promptText }]
      if (signal.attachments) {
        for (const att of signal.attachments) {
          blocks.push({ type: 'image', data: att.data, mimeType: att.mimeType })
        }
      }

      await this.promptWithTimeout(rt, blocks)
      if (includeSystem) this.systemPromptSent = true
    } catch (e) {
      actions.emitActivity({ phase: 'error', text: (e as Error).message })
      throw e
    }
    const raw = this.buffer.trim()

    // executeDirectives can do real, slow work (a DISPATCH kicks off a team
    // turn). Keep the turn "live" through it and emit 'done' only once the
    // directives have actually run, so the UI reflects the whole turn.
    const result = await this.executeDirectives(raw, signal)
    actions.emitActivity({ phase: 'done' })
    return result
  }

  /** Race the ACP turn against TURN_TIMEOUT_MS. On timeout we cancel the
   *  in-flight turn (so the adapter stops working) and throw, breaking an
   *  otherwise-infinite "thinking…" stall. */
  private async promptWithTimeout(rt: AcpRuntime, blocks: ContentBlock[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void rt.cancel()
        reject(new Error('助理这一轮超时了（可能在反复尝试被拦截的操作），已中断'))
      }, AssistantBrain.TURN_TIMEOUT_MS)
    })
    try {
      await Promise.race([rt.prompt(blocks), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Interrupt the in-flight turn (if any). The serialized think() chain settles
   *  on its own once prompt() rejects/resolves. */
  async cancel(): Promise<void> {
    if (this.runtime) await this.runtime.cancel()
  }

  private buildPrompt(signal: Signal, hits: MemoryHit[], includeSystem: boolean): string {
    const parts: string[] = []
    if (includeSystem) {
      parts.push(ASSISTANT_SYSTEM_PROMPT)
    }
    if (hits.length > 0) {
      const lines = hits.map((h) => `- (${h.kind}) ${h.content}`).join('\n')
      parts.push(`[记忆]\n${lines}`)
    } else {
      parts.push('[记忆]\n（无相关记忆）')
    }
    parts.push(`[信号] (${signal.kind})\n${signal.text}`)
    return parts.join('\n\n')
  }

  private async executeDirectives(raw: string, signal: Signal): Promise<ThinkResult> {
    // `raw` mixes the brain's natural reply with directive tag blocks. Strip the
    // tags so what we surface as the assistant's message is just the prose; the
    // tags are consumed below as actions.
    const reply = stripDirectives(raw)
    const result: ThinkResult = { raw: reply, dispatched: [], remembered: 0, reports: [] }

    // REMEMBER first so a memory the brain just formed is stored before any
    // report references it.
    for (const body of extractAll(raw, 'REMEMBER')) {
      const parsed = safeJson<{ kind?: string; content?: string }>(body)
      if (!parsed?.content) continue
      const kind = isMemoryKind(parsed.kind) ? parsed.kind : 'fact'
      actions.emitActivity({ phase: 'tool', text: '记下记忆' })
      await actions.remember({ kind, content: parsed.content, source: signal.kind })
      result.remembered++
    }

    for (const body of extractAll(raw, 'DISPATCH')) {
      const parsed = safeJson<{ name?: string; brief?: string }>(body)
      if (!parsed?.name || !parsed?.brief) continue
      try {
        actions.emitActivity({ phase: 'tool', text: `派出团队「${parsed.name}」` })
        const { project, conversation } = await actions.dispatchProject({
          name: parsed.name,
          brief: parsed.brief
        })
        result.dispatched.push({
          name: project.name,
          projectId: project.id,
          conversationId: conversation.id
        })
      } catch (e) {
        console.error('[assistant-brain] dispatch failed:', (e as Error).message)
      }
    }

    for (const body of extractAll(raw, 'REPORT')) {
      actions.reportToUser({
        message: body,
        projectId: signal.projectId,
        conversationId: signal.conversationId
      })
      result.reports.push(body)
    }

    return result
  }

  async dispose(): Promise<void> {
    if (this.runtime) {
      await this.runtime.dispose()
      this.runtime = null
    }
    this.systemPromptSent = false
  }
}

function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

const MEMORY_KINDS = ['preference', 'fact', 'project', 'person', 'pattern', 'episodic']
function isMemoryKind(s: unknown): s is import('@shared/types').MemoryKind {
  return typeof s === 'string' && MEMORY_KINDS.includes(s)
}

let singleton: AssistantBrain | null = null
export function getAssistantBrain(): AssistantBrain {
  if (!singleton) singleton = new AssistantBrain()
  return singleton
}
