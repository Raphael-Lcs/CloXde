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
import type {
  AgentProfile,
  AssistantMemory,
  AssistantMessageRecord,
  AssistantTurn,
  MemoryHit
} from '@shared/types'
import { AcpRuntime } from '../acp/runtime'
import { getWorkspaceDir, ensureWorkspaceDir, getSoulPath } from '../paths'
import { assistantMessageRepo } from '../storage/db'
import { nextCronFire } from '../conversation/cron'
import { getMemoryService } from './memory'
import * as actions from './actions'
import { extractAll, stripDirectives } from './directives'
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

export class AssistantBrain {
  /** Upper bound on a single think() turn. The 管家 may do real tool work
   *  itself, so this is generous — substantial/long work is delegated to a
   *  team, so a turn past this is almost certainly wedged (a stuck tool). We
   *  cancel and surface an error instead of leaving the UI spinning forever. */
  private static readonly TURN_TIMEOUT_MS = 240_000
  /** After this many turns on one ACP session, compact: drop the session and
   *  reseed a fresh one with the system prompt + a short transcript summary.
   *  The brain is long-lived, so without this its session history grows until
   *  it overflows the model's context and the adapter errors. Durable facts
   *  live in vector memory (recalled every turn), so dropping raw history is
   *  safe — only the recent conversational thread needs carrying over. */
  private static readonly COMPACT_AFTER_TURNS = 30
  /** How many recent exchanges to carry across a compaction. */
  private static readonly TRANSCRIPT_KEEP = 6
  /** Per-side char clamp on a remembered exchange line. */
  private static readonly TRANSCRIPT_CHARS = 600
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
  /** Turns run on the CURRENT ACP session (reset on compaction / dispose). */
  private turnsSinceFresh = 0
  /** Rolling tail of recent exchanges, carried across a compaction so the
   *  reseeded session still has the immediate conversational thread. */
  private transcript: { user: string; assistant: string }[] = []
  /** Monotonic count of completed USER turns over the brain's whole lifetime
   *  (NOT reset on compaction; background review/reflection/cron turns don't
   *  count). The reflection loop snapshots this to tell whether the user
   *  actually talked since its last pass — so it never burns a turn (and tokens)
   *  distilling an unchanged conversation, and reflection turns can't
   *  self-perpetuate. */
  private turnsTotal = 0
  /** Whether we've tried to reload the recent thread from the persisted DB into
   *  the transcript. Done once, lazily, on the first turn of a process: the
   *  brain singleton is fresh on restart (blank transcript, no ACP session
   *  restore), so without this it has amnesia even though the panel shows the
   *  full history. Seeding the transcript carries the recent dialog into the
   *  first prompt so the brain's context matches what the user sees. */
  private hydrated = false

  /** Rebuild the recent user↔assistant thread from the persisted DB so a process
   *  restart doesn't reset the brain's working memory. Idempotent — runs once.
   *  Returns a transcript summary to seed the first prompt with (empty when
   *  there's nothing to carry, or already hydrated). */
  private hydrateTranscript(): string {
    if (this.hydrated) return ''
    this.hydrated = true
    try {
      const recs = assistantMessageRepo.list(60) // oldest → newest
      const pairs: { user: string; assistant: string }[] = []
      let pendingUser: string | null = null
      for (const r of recs) {
        if (r.role === 'user') {
          // Two user rows in a row (no reply between) — keep the latest.
          if (pendingUser !== null) pairs.push({ user: pendingUser, assistant: '' })
          pendingUser = r.text
        } else if (r.role === 'assistant' || r.role === 'report') {
          if (pendingUser !== null) {
            pairs.push({ user: pendingUser, assistant: r.text })
            pendingUser = null
          }
        }
        // 'system' rows (dispatch/continue notes) aren't part of the dialog.
      }
      if (pendingUser !== null) pairs.push({ user: pendingUser, assistant: '' })
      this.transcript = pairs.slice(-AssistantBrain.TRANSCRIPT_KEEP).map((p) => ({
        user: clampLine(p.user, AssistantBrain.TRANSCRIPT_CHARS),
        assistant: clampLine(p.assistant, AssistantBrain.TRANSCRIPT_CHARS)
      }))
      return this.transcript.length > 0 ? this.buildTranscriptSummary() : ''
    } catch (e) {
      console.error('[assistant-brain] hydrate transcript failed:', (e as Error).message)
      return ''
    }
  }

  /** True while at least one think() turn is queued or running. */
  isBusy(): boolean {
    return this.inFlight > 0
  }

  /** Lifetime count of completed USER turns — used by the reflection loop to
   *  detect new user activity since its last pass. */
  turnCount(): number {
    return this.turnsTotal
  }

  private recordExchange(user: string, assistant: string): void {
    this.transcript.push({
      user: clampLine(user, AssistantBrain.TRANSCRIPT_CHARS),
      assistant: clampLine(assistant, AssistantBrain.TRANSCRIPT_CHARS)
    })
    const overflow = this.transcript.length - AssistantBrain.TRANSCRIPT_KEEP
    if (overflow > 0) this.transcript.splice(0, overflow)
  }

  private buildTranscriptSummary(): string {
    return this.transcript
      .map((e, i) => `${i + 1}. 用户：${e.user}\n   你：${e.assistant || '（无文字回复）'}`)
      .join('\n')
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
    // Reflection's signal text is a fixed instruction prompt, not a query, so
    // embedding it and recalling returns semantic noise — and the reflection pass
    // already injects its own dedup context. Skip recall for it; recall normally
    // for conversational / team-activity signals.
    const hits = signal.kind === 'reflection' ? [] : await memory.recall(signal.text, { k: 6 })

    // The always-on profile (pinned + standing preferences) goes in EVERY prompt,
    // not just on a semantic hit — a recall miss must never drop "用中文" and the
    // like. Reflection already lists everything it knows, so skip there. Dedup
    // against recalled hits so a memory isn't shown twice.
    const profile = signal.kind === 'reflection' ? [] : memory.coreProfile()
    const profileIds = new Set(profile.map((m) => m.id))
    const recalled = hits.filter((h) => !profileIds.has(h.id))

    // Give every shown memory a short per-turn handle ([M1], [M2]…) so the brain
    // can point at one to retract it via <<FORGET>>. Profile first, then recalled
    // (the render order). The maps are turn-local: refs are meaningless across
    // turns, so we never persist them. UUIDs would bloat the prompt and tempt the
    // model to hallucinate ids — a tiny ordinal is unambiguous and cheap.
    const referable = [...profile, ...recalled]
    const refById = new Map<string, string>()
    const idByRef = new Map<string, string>()
    referable.forEach((m, i) => {
      const ref = `M${i + 1}`
      refById.set(m.id, ref)
      idByRef.set(ref, m.id)
    })

    // Full-text search the brain's OWN past thread for the user's question —
    // surfaces older exact-term context beyond the ~60 turns it hydrates and the
    // memories vector-recall covers. Only for a real user question; background
    // passes don't pose one. searchHistory already excludes the recent window so
    // we don't re-inject what's already in context.
    let history: AssistantMessageRecord[] = []
    if (signal.kind === 'user-message') {
      try {
        history = assistantMessageRepo.searchHistory(signal.text)
      } catch (e) {
        console.error('[assistant-brain] history search failed:', (e as Error).message)
      }
    }

    // The user-editable persona (SOUL.md). Read every turn so an edit takes effect
    // on the next turn — same liveness as [关于用户]. Empty when the file is
    // absent, in which case the brain just runs on its base prompt.
    const soul = await this.loadSoul()

    const rt = this.ensureRuntime()

    // First turn of the process: pull the recent thread out of the DB so the
    // brain resumes with the context the panel already shows (it otherwise
    // starts blank — no ACP session is restored across a restart). The seed is
    // injected as a [对话摘要] on the first prompt, same channel compaction uses.
    const restartSeed = this.hydrateTranscript()

    // Context compaction: once the session has run enough turns, drop it and
    // reseed a fresh one carrying only the system prompt + a short transcript
    // summary. Must happen BEFORE start() so restartFresh's forceFresh is
    // consumed by the upcoming handshake.
    let compactSummary = ''
    if (this.turnsSinceFresh >= AssistantBrain.COMPACT_AFTER_TURNS) {
      actions.emitActivity({ phase: 'tool', text: '压缩上下文' })
      compactSummary = this.buildTranscriptSummary()
      await rt.restartFresh()
      this.systemPromptSent = false
      this.turnsSinceFresh = 0
    }
    // No compaction this turn, but we just restarted the process and have prior
    // dialog to carry — seed the first prompt with it.
    if (!compactSummary && restartSeed) compactSummary = restartSeed

    this.buffer = ''
    actions.emitActivity({ phase: 'start' })
    let reply = ''
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
      const promptText = this.buildPrompt(
        signal,
        recalled,
        includeSystem,
        compactSummary,
        profile,
        history,
        refById,
        soul
      )

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
      // Every turn (incl. background review/reflection) grows the ACP session,
      // so all count toward compaction.
      this.turnsSinceFresh++
      // …but only a real user exchange counts as "new conversation" — otherwise
      // the reflection gate (turnCount delta) would be satisfied by review and
      // reflection turns themselves, making reflection self-perpetuate every
      // interval with no actual user activity.
      if (signal.kind === 'user-message') this.turnsTotal++
    } catch (e) {
      actions.emitActivity({ phase: 'error', text: (e as Error).message })
      throw e
    }
    const raw = this.buffer.trim()

    // executeDirectives can do real, slow work (a DISPATCH kicks off a team
    // turn). Keep the turn "live" through it and emit 'done' only once the
    // directives have actually run, so the UI reflects the whole turn.
    const result = await this.executeDirectives(raw, signal, idByRef)
    reply = result.raw
    // The transcript is the USER conversation thread carried across a
    // compaction. Background passes (review/reflection/cron) aren't part of that
    // dialog — recording them would reseed a compacted session with "团队最新进展…"
    // noise instead of the actual chat.
    if (signal.kind === 'user-message') this.recordExchange(signal.text, reply)
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

  private buildPrompt(
    signal: Signal,
    hits: MemoryHit[],
    includeSystem: boolean,
    compactSummary?: string,
    profile: AssistantMemory[] = [],
    history: AssistantMessageRecord[] = [],
    refById: Map<string, string> = new Map(),
    soul = ''
  ): string {
    const parts: string[] = []
    const tag = (id: string): string => {
      const r = refById.get(id)
      return r ? `[${r}] ` : ''
    }
    if (includeSystem) {
      parts.push(ASSISTANT_SYSTEM_PROMPT)
    }
    // The user-authored persona, right after identity. Subordinate to the system
    // prompt (it shapes tone/character/boundaries, it doesn't override the
    // delegator role). Injected every turn so edits are live.
    if (soul) {
      parts.push(
        `[人格]（用户为你设定的性格、语气与边界；在不违背上面职责的前提下，照此与用户相处）\n${soul}`
      )
    }
    if (compactSummary) {
      parts.push(
        `[对话摘要] 这是你与用户之前对话的浓缩回顾（完整历史已压缩，长期事实见[记忆]）：\n${compactSummary}`
      )
    }
    if (profile.length > 0) {
      const lines = profile.map((m) => `- ${tag(m.id)}(${m.kind}) ${m.content}`).join('\n')
      parts.push(`[关于用户]（始终适用，务必遵守）\n${lines}`)
    }
    if (history.length > 0) {
      const lines = history
        .map((m) => {
          const who = m.role === 'user' ? '用户' : '你'
          const when = new Date(m.ts).toLocaleDateString('zh-CN')
          return `- [${when}] ${who}：${clampLine(m.text, 200)}`
        })
        .join('\n')
      parts.push(`[历史片段]（更早的相关对话，供参考，可能与当前无关）\n${lines}`)
    }
    if (hits.length > 0) {
      const lines = hits.map((h) => `- ${tag(h.id)}(${h.kind}) ${h.content}`).join('\n')
      parts.push(`[记忆]\n${lines}`)
    } else {
      parts.push('[记忆]\n（无相关记忆）')
    }
    parts.push(`[信号] (${signal.kind})\n${signal.text}`)
    return parts.join('\n\n')
  }

  /** Read the user-editable persona file (~/.cloxde/SOUL.md). Best-effort: a
   *  missing or unreadable file yields '' so the brain just runs on its base
   *  prompt. Read fresh each turn so edits apply on the next turn. */
  private async loadSoul(): Promise<string> {
    try {
      return (await readFile(getSoulPath(), 'utf-8')).trim()
    } catch {
      return ''
    }
  }

  private async executeDirectives(
    raw: string,
    signal: Signal,
    idByRef: Map<string, string> = new Map()
  ): Promise<ThinkResult> {
    // `raw` mixes the brain's natural reply with directive tag blocks. Strip the
    // tags so what we surface as the assistant's message is just the prose; the
    // tags are consumed below as actions.
    const reply = stripDirectives(raw)
    const result: ThinkResult = {
      raw: reply,
      dispatched: [],
      continued: [],
      remembered: 0,
      forgotten: 0,
      updated: 0,
      scheduled: 0,
      reports: []
    }

    // FORGET before REMEMBER: a correction is "drop the stale one, store the new
    // one"; retracting first means a freshly-restated fact can't be the thing we
    // delete. Refs ([M#]) are resolved against this turn's shown memories only.
    for (const body of extractAll(raw, 'FORGET')) {
      const parsed = safeJson<{ ref?: string }>(body)
      if (!parsed?.ref) continue
      const id = idByRef.get(`M${String(parsed.ref).replace(/\D/g, '')}`)
      if (!id) continue
      try {
        actions.emitActivity({ phase: 'tool', text: '撤回旧记忆' })
        actions.forget(id)
        result.forgotten++
      } catch (e) {
        console.error('[assistant-brain] forget failed:', (e as Error).message)
      }
    }

    // UPDATE — rewrite an existing memory in place (by [M#] ref), re-embedding it.
    // This is "improve a skill in use": when the brain reused a stored skill and
    // found a better way, it refines THAT row instead of emitting a fresh
    // <<REMEMBER>> that the dedup heuristic won't fold (an improvement is, by
    // design, different enough from the original to dodge the near-dup guard).
    for (const body of extractAll(raw, 'UPDATE')) {
      const parsed = safeJson<{ ref?: string; content?: string }>(body)
      if (!parsed?.ref || !parsed?.content) continue
      const id = idByRef.get(`M${String(parsed.ref).replace(/\D/g, '')}`)
      if (!id) continue
      try {
        actions.emitActivity({ phase: 'tool', text: '改进已有记忆' })
        await actions.updateMemory(id, parsed.content)
        result.updated++
      } catch (e) {
        console.error('[assistant-brain] update failed:', (e as Error).message)
      }
    }

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

    // SCHEDULE — the brain sets a wake-up for ITSELF. `inMinutes` → one-shot
    // relative; `cron` (5-field) → recurring. The review loop fires due reminders
    // as a 'cron' signal. We compute the first fire time here so a bad cron expr
    // is dropped at the source rather than wedging the ticker.
    for (const body of extractAll(raw, 'SCHEDULE')) {
      const parsed = safeJson<{ inMinutes?: number; cron?: string; note?: string }>(body)
      if (!parsed) continue
      const note = (parsed.note ?? '').trim() || '到点了，回来看看有没有要处理的。'
      const now = Date.now()
      let fireAt: number | null = null
      let cron: string | undefined
      if (typeof parsed.cron === 'string' && parsed.cron.trim()) {
        try {
          fireAt = nextCronFire(parsed.cron.trim(), now)
        } catch {
          fireAt = null
        }
        if (fireAt !== null) cron = parsed.cron.trim()
      } else if (typeof parsed.inMinutes === 'number' && parsed.inMinutes > 0) {
        fireAt = now + Math.round(parsed.inMinutes * 60_000)
      }
      if (fireAt === null) continue
      try {
        actions.emitActivity({ phase: 'tool', text: '设定提醒' })
        actions.scheduleReminder({ fireAt, note, cron })
        result.scheduled++
      } catch (e) {
        console.error('[assistant-brain] schedule failed:', (e as Error).message)
      }
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

    // SELFMOD — dispatch a self-improvement run (Milestone 2). The brain treats
    // "improve CloXde itself" as a special project: the team works in an isolated
    // git worktree on a dedicated branch. Once the team settles, the brain runs
    // gates (typecheck/test/build/smoke) and, if all pass, merges the branch back
    // and restarts onto the new code. Only available in dev (isSelfModAvailable).
    for (const body of extractAll(raw, 'SELFMOD')) {
      const parsed = safeJson<{ name?: string; brief?: string }>(body)
      if (!parsed?.name || !parsed?.brief) continue
      try {
        actions.emitActivity({ phase: 'tool', text: `启动自我改进「${parsed.name}」` })
        const handle = await actions.dispatchSelfImprovement({
          name: parsed.name,
          brief: parsed.brief
        })
        result.dispatched.push({
          name: handle.project.name,
          projectId: handle.project.id,
          conversationId: handle.conversation.id
        })
        // Store the handle so the review loop can promote it once the team settles.
        // We attach it to the project record as a transient field (not persisted).
        ;(handle.project as any)._selfModHandle = handle
      } catch (e) {
        console.error('[assistant-brain] selfmod dispatch failed:', (e as Error).message)
      }
    }

    // CONTINUE — send a follow-up into an EXISTING team conversation (nudge,
    // re-brief, answer) instead of creating a new project. Used heavily by the
    // review loop to push a team that's already running forward.
    for (const body of extractAll(raw, 'CONTINUE')) {
      const parsed = safeJson<{ conversationId?: string; projectId?: string; message?: string }>(
        body
      )
      if (!parsed?.message || (!parsed.conversationId && !parsed.projectId)) continue
      try {
        actions.emitActivity({ phase: 'tool', text: '续派已有团队' })
        const c = await actions.continueTeam({
          conversationId: parsed.conversationId,
          projectId: parsed.projectId,
          message: parsed.message
        })
        result.continued.push(c)
      } catch (e) {
        console.error('[assistant-brain] continue failed:', (e as Error).message)
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
    this.turnsSinceFresh = 0
    this.transcript = []
  }
}

/** Collapse whitespace and clamp a string to `max` chars for a transcript line —
 *  keeps the carried-over summary compact so a compaction doesn't reseed a huge
 *  prompt. */
function clampLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

const MEMORY_KINDS = ['preference', 'fact', 'project', 'person', 'pattern', 'episodic', 'skill']
function isMemoryKind(s: unknown): s is import('@shared/types').MemoryKind {
  return typeof s === 'string' && MEMORY_KINDS.includes(s)
}

let singleton: AssistantBrain | null = null
export function getAssistantBrain(): AssistantBrain {
  if (!singleton) singleton = new AssistantBrain()
  return singleton
}
