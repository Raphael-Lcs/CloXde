// The assistant's brain: a single long-lived ACP session (default Claude Code)
// running with the delegator system prompt. It is the judgment layer — it takes
// a *signal* (user message, team turn-end, capability gap, instability, cron),
// recalls relevant memory, thinks, and emits tagged directives. The main
// process parses those directives and performs the actual actions (dispatch a
// team, write memory, report to the user) via the actions module.
//
// The "assistant never writes code" boundary is enforced HERE at the runtime
// level, not just by the prompt: the brain's permission policy denies every
// tool call, and its fs policy refuses all writes. Reads are allowed so the
// brain can do read-only discovery if it ever needs to, but it cannot touch a
// single file. All building/editing happens in the teams it dispatches.

import { readFile } from 'node:fs/promises'
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
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

// Deny EVERY tool-permission request. The brain has no hands; if the model ever
// asks to run/edit something, we reject so it falls back to emitting directives.
const denyAllPermission = async (
  params: RequestPermissionRequest
): Promise<RequestPermissionResponse> => {
  const reject =
    params.options.find((o) => o.kind === 'reject_once') ??
    params.options.find((o) => o.kind === 'reject_always')
  return reject
    ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

// Reads allowed (read-only discovery can't violate the boundary); writes always
// refused — this is the filesystem half of the "assistant never edits" rule.
const readonlyFs = {
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
  async writeTextFile(_params: WriteTextFileRequest): Promise<never> {
    throw new Error('assistant is read-only — file changes must be delegated to a team')
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

export class AssistantBrain {
  private runtime: AcpRuntime | null = null
  private systemPromptSent = false
  private buffer = ''
  /** Serializes think() calls — one ACP session, one turn at a time. */
  private chain: Promise<unknown> = Promise.resolve()

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
      permission: denyAllPermission,
      fs: readonlyFs
    })
    rt.on('update', (n: SessionNotification) => {
      if (
        n.update.sessionUpdate === 'agent_message_chunk' &&
        n.update.content.type === 'text'
      ) {
        this.buffer += n.update.content.text
      }
    })
    rt.on('error', (err: Error) => console.error('[assistant-brain] error:', err.message))
    this.runtime = rt
    return rt
  }

  /** Wake the brain with a signal. Recalls memory, prompts the brain, parses
   *  and executes the directives it emits. Calls are serialized. */
  think(signal: Signal): Promise<ThinkResult> {
    const run = this.chain.then(() => this.thinkOnce(signal))
    // Keep the chain alive regardless of this call's outcome.
    this.chain = run.catch(() => undefined)
    return run
  }

  private async thinkOnce(signal: Signal): Promise<ThinkResult> {
    const memory = getMemoryService()
    const hits = await memory.recall(signal.text, { k: 6 })
    // Decide up front whether THIS prompt carries the system prompt, but don't
    // mark it delivered until prompt() actually succeeds — otherwise a failed
    // first turn (e.g. adapter spawn error) would burn the flag and every later
    // turn would run with no delegator identity, reverting the brain to a plain
    // coding assistant.
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

    const rt = this.ensureRuntime()
    this.buffer = ''
    await rt.prompt(blocks)
    if (includeSystem) this.systemPromptSent = true
    const raw = this.buffer.trim()

    return this.executeDirectives(raw, signal)
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
    const result: ThinkResult = { raw, dispatched: [], remembered: 0, reports: [] }

    // REMEMBER first so a memory the brain just formed is stored before any
    // report references it.
    for (const body of extractAll(raw, 'REMEMBER')) {
      const parsed = safeJson<{ kind?: string; content?: string }>(body)
      if (!parsed?.content) continue
      const kind = isMemoryKind(parsed.kind) ? parsed.kind : 'fact'
      await actions.remember({ kind, content: parsed.content, source: signal.kind })
      result.remembered++
    }

    for (const body of extractAll(raw, 'DISPATCH')) {
      const parsed = safeJson<{ name?: string; brief?: string }>(body)
      if (!parsed?.name || !parsed?.brief) continue
      try {
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
