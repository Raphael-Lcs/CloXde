// Conversation engine: owns the pair of AcpRuntimes for a conversation, turns
// agent updates into Messages, and drives the autopilot loop (A → B → A → …).
//
// Hand-off protocol (v0.6.1, the architect-decides design):
//
//   • CloXde injects a *system prompt* into each side on first prompt. The
//     prompt tells them their role and the tag protocol below.
//   • Architect drives. It decides — turn by turn — whether to hand work off:
//        <<DELEGATE>>...<</DELEGATE>>  → CloXde extracts this and forwards
//                                         it (and ONLY it) to the executor.
//        <<DONE>>                       → architect declares the whole task
//                                         finished; engine stops auto-loop.
//        (neither)                       → architect is still chatting with
//                                         the user (clarifying, replying to
//                                         "hi", asking for spec). Engine
//                                         does NOT forward to the executor.
//   • Executor always reports back to architect after a turn. Its full reply
//     is wrapped as `[执行者回报] … [结束回报]` and posted to architect as a
//     user message, who then decides DELEGATE/DONE/chat.

import { EventEmitter } from 'node:events'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  SessionNotification,
  PromptResponse
} from '@agentclientprotocol/sdk'
import type {
  Conversation,
  ConversationView,
  Message,
  MessageBlock,
  Role,
  Side,
  Task,
  TaskStatus,
  TurnMetrics
} from '@shared/types'
import {
  conversationRepo,
  messageRepo,
  profileRepo,
  projectRepo,
  taskRepo
} from '../storage/db'
import { AcpRuntime } from '../acp/runtime'
import { ensureUnder } from '../fs/inspector'
import {
  allowedTags,
  classifyTool,
  describeForbidden,
  extractAction,
  formatTaskPreamble,
  isToolAllowed,
  parsePlanSteps,
  transition,
  type TaskAction
} from './state-machine'
import { buildFirstTurnPrompt } from './prompts'
import {
  blocksToPlainText,
  condenseError,
  extractDelegate,
  extractHandoff,
  hasDone,
  isAdapterNoise,
  isContextOverflow,
  wrapDelegate,
  wrapExecutorReport,
  wrapTeamReport
} from './transcript'
import { applyUpdate } from './update-reducer'

/** Fold an ACP PromptResponse + engine-measured wall-clock into our
 *  TurnMetrics shape. `usage` is an experimental ACP field — absent on
 *  adapters that don't report it, in which case we still keep durationMs.
 *  Returns undefined only if there is genuinely nothing to record. */
function buildTurnMetrics(
  response: PromptResponse,
  durationMs: number
): TurnMetrics | undefined {
  const usage = response.usage
  const metrics: TurnMetrics = { durationMs }
  if (usage) {
    if (typeof usage.inputTokens === 'number') metrics.inputTokens = usage.inputTokens
    if (typeof usage.outputTokens === 'number') metrics.outputTokens = usage.outputTokens
    if (typeof usage.totalTokens === 'number') metrics.totalTokens = usage.totalTokens
    if (typeof usage.cachedReadTokens === 'number') {
      metrics.cachedTokens = usage.cachedReadTokens
    }
  }
  return metrics
}

// --- Engine internals ------------------------------------------------------

export interface EngineEvents {
  'conversation-updated': (view: ConversationView) => void
  'message-appended': (payload: { conversationId: string; message: Message }) => void
  'message-patched': (payload: {
    conversationId: string
    messageId: string
    patch: Partial<Pick<Message, 'blocks' | 'stopReason' | 'metrics'>>
  }) => void
}

interface SideRuntime {
  side: Role
  runtime: AcpRuntime
  toolBlockIndex: Map<string, number>
  streamingMessageId: string | null
  /** In-memory mirror of the assistant message currently being streamed.
   *  We mutate it on every chunk and persist via messageRepo.patch — much
   *  cheaper than re-querying messageRepo.listByConversation() on each
   *  ACP update (a long conversation has thousands of messages). Stays
   *  in sync because only handleUpdate() writes to it during a turn. */
  streamingMessage: Message | null
  systemPromptSent: boolean
  /** Per-side promise chain. Concurrent prompts on the same side wait their
   *  turn; concurrent prompts across sides run in parallel. This is what
   *  lets the user chat with PM while the team is still grinding. */
  inFlight: Promise<void>
  /** Queue for serializing handleUpdate operations. Prevents concurrent
   *  updates from racing when multiple ACP notifications arrive rapidly. */
  updateInFlight: Promise<void>
}

interface ActiveConversation {
  conversation: Conversation
  /** Present iff conversation.pmProfileId is set (3-agent mode). */
  pm: SideRuntime | null
  architect: SideRuntime
  executor: SideRuntime
  /** How many times in a row the engine has auto-nudged a side without
   *  the agent making real progress (PLAN→PLAN, no-tag→no-tag, …). When
   *  this hits 2 we stop nudging and idle, so a stuck agent can't burn
   *  through the autoTurns cap on its own. Reset on any forward transition. */
  stallNudges: number
  /** Set when we've already re-prompted the PM once because it returned an
   *  empty turn in response to a DONE/FAIL [团队反馈]. Bounds the forced
   *  wrap-up to a single retry so an idle PM can't loop. */
  pmReportRetried: boolean
}

/** One adapter-instability occurrence the assistant review loop can drain.
 *  `exhausted` distinguishes a recovered hiccup (retry succeeded, false) from a
 *  give-up (retries spent, the turn actually failed over, true). */
export interface InstabilityEvent {
  ts: number
  conversationId: string
  projectId: string
  side: Role
  /** True when auto-retry was exhausted (the turn failed), false for a transient
   *  crash that a retry recovered from. */
  exhausted: boolean
  /** Condensed adapter error message, for the report. */
  detail: string
}

export class ConversationEngine extends EventEmitter {
  private active = new Map<string, ActiveConversation>()
  /** Concurrent startIfNeeded() calls on the same conversation must NOT
   *  spawn two adapter sets — the second runs while the first is still
   *  awaiting newSession, sees `active.get(id) === undefined`, and races.
   *  We dedupe via this in-flight promise map. */
  private starting = new Map<string, Promise<ActiveConversation>>()
  /** Adapter-instability events (a side's ACP process crashed/disconnected and
   *  auto-retry kicked in or was exhausted), buffered for the assistant review
   *  loop to drain. This is the底座抖动 case — distinct from a team that "got
   *  stuck" via a protocol slip (which surfaces as autopilot → awaiting-user).
   *  Bounded so a crash-loop can't grow it without limit; oldest dropped first. */
  private instabilityEvents: InstabilityEvent[] = []
  private static readonly MAX_INSTABILITY_EVENTS = 50

  // --- Public API --------------------------------------------------------

  async startIfNeeded(conversationId: string): Promise<ActiveConversation> {
    const existing = this.active.get(conversationId)
    if (existing) return existing
    const inflight = this.starting.get(conversationId)
    if (inflight) return inflight
    const p = this.startInternal(conversationId).finally(() => {
      this.starting.delete(conversationId)
    })
    this.starting.set(conversationId, p)
    return p
  }

  private async startInternal(conversationId: string): Promise<ActiveConversation> {
    // Re-check inside the lock — caller might have populated `active` while
    // we were queuing.
    const already = this.active.get(conversationId)
    if (already) return already

    const conv = conversationRepo.get(conversationId)
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`)
    const project = projectRepo.get(conv.projectId)
    if (!project) throw new Error(`Project not found: ${conv.projectId}`)
    const architectProfile = profileRepo.get(conv.architectProfileId)
    const executorProfile = profileRepo.get(conv.executorProfileId)
    if (!architectProfile || !executorProfile) {
      throw new Error('Conversation references a missing agent profile')
    }

    const projectRoot = project.rootDir

    const makeFs = (): {
      readTextFile: (p: ReadTextFileRequest) => Promise<ReadTextFileResponse>
      writeTextFile: (p: WriteTextFileRequest) => Promise<WriteTextFileResponse>
    } => ({
      async readTextFile(params) {
        if (!ensureUnder(projectRoot, params.path)) {
          throw new Error(`refused read outside project root: ${params.path}`)
        }
        const text = await readFile(params.path, 'utf-8')
        if (params.limit || params.line) {
          const lines = text.split(/\r?\n/)
          const start = (params.line ?? 1) - 1
          const end = params.limit ? start + params.limit : lines.length
          return { content: lines.slice(start, end).join('\n') }
        }
        return { content: text }
      },
      async writeTextFile(params) {
        if (!ensureUnder(projectRoot, params.path)) {
          throw new Error(`refused write outside project root: ${params.path}`)
        }
        await mkdir(dirname(params.path), { recursive: true })
        await writeFile(params.path, params.content, 'utf-8')
        return {}
      }
    })

    const makePermission = (
      role: Role
    ): ((params: RequestPermissionRequest) => Promise<RequestPermissionResponse>) =>
      async (params): Promise<RequestPermissionResponse> => {
        // Path-C gating: consult the active task. The agent's tool call
        // category (read / write / execute) is matched against the
        // current (status, role) — if it isn't allowed, we deny with a
        // human-readable reason so the agent can learn the protocol.
        const live = this.active.get(conv.id)
        const taskId = live?.conversation.activeTaskId
        const task = taskId ? taskRepo.get(taskId) : null
        if (task) {
          // Extract the tool category from the request. ACP requestPermission
          // doesn't ship tool kind directly — we infer from toolCall.kind
          // when present, else default to 'other'.
          const toolKind =
            (params as { toolCall?: { kind?: string } }).toolCall?.kind
          const category = classifyTool(toolKind)
          if (!isToolAllowed(task.status, role, category)) {
            const reason = describeForbidden(task.status, role)
            this.recordSystemMessage(
              live!,
              `[${role}] 工具调用被拒（${category}）：${reason}`
            )
            const reject =
              params.options.find((o) => o.kind === 'reject_once') ??
              params.options.find((o) => o.kind === 'reject_always')
            if (reject) {
              return {
                outcome: { outcome: 'selected', optionId: reject.optionId }
              }
            }
            return { outcome: { outcome: 'cancelled' } }
          }
        }
        // Default: allow. Mirrors pre-path-C behavior for legacy convs.
        const allow =
          params.options.find((o) => o.kind === 'allow_once') ??
          params.options.find((o) => o.kind === 'allow_always') ??
          params.options[0]
        if (!allow) return { outcome: { outcome: 'cancelled' } }
        return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      }

    const architectRuntime = new AcpRuntime({
      profile: architectProfile,
      cwd: projectRoot,
      permission: makePermission('architect'),
      fs: makeFs(),
      savedSessionId: conv.architectAcpSessionId,
      onSessionReady: (sessionId, restored) => {
        if (conv.architectAcpSessionId !== sessionId) {
          conversationRepo.patch(conv.id, { architectAcpSessionId: sessionId })
        }
        const s = this.active.get(conv.id)
        if (!s) return
        // Refresh slot.conversation after session ID update
        const fresh = conversationRepo.get(conv.id)
        if (fresh) s.conversation = fresh
        if (restored) {
          // Agent re-loaded its own context, including any previously sent
          // system prompt — skip re-injection.
          s.architect.systemPromptSent = true
          this.recordSystemMessage(s, '架构师上下文已从历史会话恢复。')
        }
      }
    })
    const executorRuntime = new AcpRuntime({
      profile: executorProfile,
      cwd: projectRoot,
      permission: makePermission('executor'),
      fs: makeFs(),
      savedSessionId: conv.executorAcpSessionId,
      onSessionReady: (sessionId, restored) => {
        if (conv.executorAcpSessionId !== sessionId) {
          conversationRepo.patch(conv.id, { executorAcpSessionId: sessionId })
        }
        const s = this.active.get(conv.id)
        if (!s) return
        // Refresh slot.conversation after session ID update
        const fresh = conversationRepo.get(conv.id)
        if (fresh) s.conversation = fresh
        if (restored) {
          s.executor.systemPromptSent = true
          this.recordSystemMessage(s, '执行者上下文已从历史会话恢复。')
        }
      }
    })

    // Optional PM runtime (3-agent mode).
    let pmRuntime: AcpRuntime | null = null
    const pmProfile = conv.pmProfileId ? profileRepo.get(conv.pmProfileId) : null
    if (pmProfile) {
      pmRuntime = new AcpRuntime({
        profile: pmProfile,
        cwd: projectRoot,
        permission: makePermission('pm'),
        fs: makeFs(),
        savedSessionId: conv.pmAcpSessionId,
        onSessionReady: (sessionId, restored) => {
          if (conv.pmAcpSessionId !== sessionId) {
            conversationRepo.patch(conv.id, { pmAcpSessionId: sessionId })
          }
          const s = this.active.get(conv.id)
          if (!s || !s.pm) return
          // Refresh slot.conversation after session ID update
          const fresh = conversationRepo.get(conv.id)
          if (fresh) s.conversation = fresh
          if (restored) {
            s.pm.systemPromptSent = true
            this.recordSystemMessage(s, '产品经理上下文已从历史会话恢复。')
          }
        }
      })
    }

    const slot: ActiveConversation = {
      conversation: conv,
      pm: pmRuntime
        ? {
            side: 'pm',
            runtime: pmRuntime,
            toolBlockIndex: new Map(),
            streamingMessageId: null,
            streamingMessage: null,
            systemPromptSent: false,
            inFlight: Promise.resolve(),
            updateInFlight: Promise.resolve()
          }
        : null,
      architect: {
        side: 'architect',
        runtime: architectRuntime,
        toolBlockIndex: new Map(),
        streamingMessageId: null,
        streamingMessage: null,
        systemPromptSent: false,
        inFlight: Promise.resolve(),
        updateInFlight: Promise.resolve()
      },
      executor: {
        side: 'executor',
        runtime: executorRuntime,
        toolBlockIndex: new Map(),
        streamingMessageId: null,
        streamingMessage: null,
        systemPromptSent: false,
        inFlight: Promise.resolve(),
        updateInFlight: Promise.resolve()
      },
      stallNudges: 0,
      pmReportRetried: false
    }
    this.active.set(conv.id, slot)

    if (slot.pm) this.wireSide(slot, slot.pm)
    this.wireSide(slot, slot.architect)
    this.wireSide(slot, slot.executor)

    if (pmRuntime) {
      void pmRuntime
        .start()
        .catch((err: Error) =>
          this.recordSystemMessage(slot, `产品经理 启动失败：${err.message}`)
        )
    }
    void architectRuntime
      .start()
      .catch((err: Error) =>
        this.recordSystemMessage(slot, `architect 启动失败：${err.message}`)
      )
    void executorRuntime
      .start()
      .catch((err: Error) =>
        this.recordSystemMessage(slot, `executor 启动失败：${err.message}`)
      )

    return slot
  }

  /** User sent a message. In 3-agent mode it always goes to PM. In legacy
   *  2-agent mode it goes to `target` (defaults to primarySide).
   *
   *  CRITICAL: this only preempts the *destination* side. If the engineering
   *  team is mid-task and the user types something to PM, the team keeps
   *  working. PM observes the new user message and decides how to react
   *  (extend the brief, send a new HANDOFF, just chat). */
  async sendUserMessage(
    conversationId: string,
    text: string,
    target?: Side,
    attachments?: { data: string; mimeType: string }[],
    opts?: {
      /** When false, do NOT interrupt the target side's in-flight turn —
       *  queue this message behind it instead. Used by timed automation so a
       *  scheduled prompt firing mid-turn doesn't cut off the live PM/team
       *  conversation; it lands at the tail of the side's promise chain and
       *  runs once the current cascade settles. Defaults to true (real user
       *  input preempts, matching the "I typed this, act now" expectation). */
      preempt?: boolean
    }
  ): Promise<void> {
    const preempt = opts?.preempt !== false
    const slot = await this.startIfNeeded(conversationId)
    const initialSide: Role = slot.pm
      ? 'pm'
      : target ?? slot.conversation.primarySide
    const sr = this.getSide(slot, initialSide)
    if (!sr) return

    // Preempt only the side we're sending to — team work is independent.
    // Scheduled injections (preempt=false) skip this so they queue behind any
    // in-flight turn rather than cancelling it.
    if (preempt && sr.streamingMessageId) {
      try {
        await sr.runtime.cancel()
      } catch {
        /* ignore — adapter may already be idle */
      }
      if (sr.streamingMessageId) {
        this.patchMessage(slot.conversation.id, sr.streamingMessageId, {
          stopReason: 'cancelled'
        })
        sr.streamingMessageId = null
        sr.streamingMessage = null
        sr.toolBlockIndex.clear()
      }
    }
    // Drop any queued follow-ups on this side (e.g. a stale team-report that
    // hasn't reached PM yet) so the user message takes precedence. The team
    // can still emit fresh reports once their current cascade completes.
    // A queued scheduled injection (preempt=false) must NOT do this — clearing
    // inFlight would let it jump ahead of the very turn it's meant to follow.
    if (preempt) sr.inFlight = Promise.resolve()

    // User intervention breaks any stall — the next agent turn gets a
    // fresh budget of nudges before we idle on it again.
    slot.stallNudges = 0
    slot.pmReportRetried = false

    // NOTE: we deliberately do NOT reset autoTurnsUsed here. The cap exists
    // to bound a single autopilot cascade — a chatty user shouldn't be able
    // to silently uncap it. The counter resets when a new task is created
    // (HANDOFF in driveStateMachine).
    this.emitSnapshot(slot)

    void this.runTurn(slot, initialSide, text, {
      origin: 'user',
      isUserInput: true,
      attachments
    }).catch((err: Error) => {
      this.recordSystemMessage(slot, `[${initialSide}] ${err.message}`)
    })
  }

  async cancel(conversationId: string): Promise<void> {
    const slot = this.active.get(conversationId)
    if (!slot) return
    // Full stop — user explicitly hit Cancel run. Cancel all sides.
    await this.cancelInternal(slot, 'user-cancel')
    this.updateConversation(slot, { status: 'awaiting-user' })
  }

  async setAutopilot(conversationId: string, autopilot: boolean): Promise<void> {
    const slot = await this.startIfNeeded(conversationId)
    this.updateConversation(slot, { autopilot })
  }

  async setPrimarySide(conversationId: string, primarySide: Side): Promise<void> {
    const slot = await this.startIfNeeded(conversationId)
    this.updateConversation(slot, { primarySide })
  }

  /** Whether any side of an *active* conversation is mid-turn. Reads the live
   *  in-memory runtime (a streaming message id) rather than the persisted
   *  status, which can be stale (e.g. stuck on 'thinking' after a crash). A
   *  conversation that isn't loaded into a slot has no work in flight, so it's
   *  not busy. Used by the scheduler to SKIP a fire instead of queueing it,
   *  preventing pile-up when a turn runs longer than the cron interval. */
  isBusy(conversationId: string): boolean {
    const slot = this.active.get(conversationId)
    if (!slot) return false
    return this.allSides(slot).some((sr) => sr.streamingMessageId || sr.inFlight !== Promise.resolve())
  }

  /** True when ANY loaded conversation has a side mid-turn. The assistant's
   *  proactive review pass gates on this: the brain is a heavy local process,
   *  so it only wakes during a quiet window (no team working) to avoid dragging
   *  machine performance, even though it wouldn't block the team. */
  anyBusy(): boolean {
    for (const slot of this.active.values()) {
      if (this.allSides(slot).some((sr) => sr.streamingMessageId || sr.inFlight !== Promise.resolve())) {
        return true
      }
    }
    return false
  }

  /** Record an adapter-instability event (called from promptWithRetry). Bounded
   *  ring: once past the cap, drop the oldest. */
  private recordInstability(ev: InstabilityEvent): void {
    this.instabilityEvents.push(ev)
    const overflow = this.instabilityEvents.length - ConversationEngine.MAX_INSTABILITY_EVENTS
    if (overflow > 0) this.instabilityEvents.splice(0, overflow)
  }

  /** Drain buffered adapter-instability events (read-and-clear) so the assistant
   *  review loop reports each occurrence at most once. */
  drainInstabilityEvents(): InstabilityEvent[] {
    const out = this.instabilityEvents
    this.instabilityEvents = []
    return out
  }

  async dispose(conversationId: string): Promise<void> {
    const slot = this.active.get(conversationId)
    if (!slot) return
    // First, drain all inFlight queues to avoid orphaned tasks.
    const drains = this.allSides(slot).map((sr) => sr.inFlight.catch(() => undefined))
    if (drains.length > 0) {
      // Cap the wait — queued tasks may be slow or stuck.
      await Promise.race([
        Promise.all(drains).then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 3000))
      ])
    }
    // Tear down every side even if one throws — a rejected dispose() must not
    // leave the other runtimes' child processes alive, nor skip the `active`
    // cleanup below (which would strand the conversation as "active" forever).
    await Promise.allSettled(this.allSides(slot).map((sr) => sr.runtime.dispose()))
    this.active.delete(conversationId)
  }

  async disposeAll(): Promise<void> {
    // Parallel, not serial: each runtime.dispose() can wait up to ~1.5s for a
    // wedged adapter to ack a cancel. Awaiting conversations one-by-one would
    // make app shutdown take (conversations × sides × 1.5s); racing them keeps
    // total teardown bounded to a single timeout regardless of how many are
    // active. allSettled so one rejecting dispose() can't abort the rest.
    await Promise.allSettled([...this.active.keys()].map((id) => this.dispose(id)))
  }

  /** Build a ConversationView. `withMessages` defaults to true so the
   *  `conversations.get` paths return full history; pass false for the
   *  high-frequency tick emits (status / busySide changes) where consumers
   *  ignore the message array anyway — loading + JSON-parsing the entire
   *  history on every tick is the single biggest avoidable DB cost here. */
  snapshot(
    conversationId: string,
    opts: { withMessages?: boolean } = {}
  ): ConversationView | null {
    const { withMessages = true } = opts
    const conv = conversationRepo.get(conversationId)
    if (!conv) return null
    const architect = profileRepo.get(conv.architectProfileId)
    const executor = profileRepo.get(conv.executorProfileId)
    if (!architect || !executor) return null
    const pm = conv.pmProfileId ? profileRepo.get(conv.pmProfileId) ?? undefined : undefined
    const active = this.active.get(conversationId)
    // Derive busySide from actual runtime streaming state — multiple sides
    // can be busy at once (user chatting with PM while team is running).
    // Priority: PM > architect > executor, since PM is what the user is
    // looking at most of the time.
    let busySide: Role | null = null
    if (active) {
      if (active.pm?.streamingMessageId) busySide = 'pm'
      else if (active.architect.streamingMessageId) busySide = 'architect'
      else if (active.executor.streamingMessageId) busySide = 'executor'
    }
    return {
      ...conv,
      pm,
      architect,
      executor,
      messages: withMessages ? messageRepo.listByConversation(conversationId) : [],
      busySide,
      activeTask: conv.activeTaskId ? taskRepo.get(conv.activeTaskId) ?? undefined : undefined
    }
  }

  // --- Internals ---------------------------------------------------------

  private getSide(slot: ActiveConversation, role: Role): SideRuntime | null {
    if (role === 'pm') return slot.pm
    if (role === 'architect') return slot.architect
    return slot.executor
  }

  private allSides(slot: ActiveConversation): SideRuntime[] {
    return slot.pm ? [slot.pm, slot.architect, slot.executor] : [slot.architect, slot.executor]
  }

  private async cancelInternal(slot: ActiveConversation, _reason: string): Promise<void> {
    void _reason
    const promises: Promise<void>[] = []
    for (const sr of this.allSides(slot)) promises.push(sr.runtime.cancel())
    await Promise.all(promises.map((p) => p.catch(() => undefined)))
    for (const sr of this.allSides(slot)) {
      if (sr.streamingMessageId) {
        this.patchMessage(slot.conversation.id, sr.streamingMessageId, {
          stopReason: 'cancelled'
        })
        sr.streamingMessageId = null
        sr.streamingMessage = null
        sr.toolBlockIndex.clear()
      }
      sr.inFlight = Promise.resolve()
    }
    this.emitSnapshot(slot)
  }

  private wireSide(slot: ActiveConversation, sr: SideRuntime): void {
    sr.runtime.on('update', (notification: SessionNotification) => {
      sr.updateInFlight = sr.updateInFlight.then(() => {
        this.handleUpdate(slot, sr, notification)
      }).catch((err: unknown) => {
        console.error('[engine] handleUpdate error:', err)
      })
    })
    sr.runtime.on('error', (err: Error) => {
      if (isAdapterNoise(err.message)) {
        console.error(`[${sr.side}] runtime noise suppressed:`, err.message)
        return
      }
      this.recordSystemMessage(slot, `[${sr.side}] ${condenseError(err.message)}`)
    })
    sr.runtime.on(
      'exit',
      ({ code, signal }: { code: number | null; signal: string | null }) => {
        // A clean exit (code 0) on cancellation isn't worth reporting.
        if (code === 0 || code === null) return
        this.recordSystemMessage(
          slot,
          `[${sr.side}] adapter 退出 (code=${code}, signal=${signal ?? 'null'})`
        )
      }
    )
  }

  /** Public runTurn — chains work onto the side's per-side queue so two
   *  callers (e.g. user message and team-report) can both target PM and
   *  execute in order without conflicting over the ACP session. */
  private runTurn(
    slot: ActiveConversation,
    side: Role,
    payloadText: string,
    opts: {
      origin: 'user' | 'peer-delegate' | 'peer-report' | 'pm-handoff' | 'team-report'
      isUserInput: boolean
      forwardedFromMessageId?: string
      /** Image attachments, base64 + mimeType. Only populated for direct
       *  user input — internal handoffs / cascades never have them. */
      attachments?: { data: string; mimeType: string }[]
    }
  ): Promise<void> {
    const sr = this.getSide(slot, side)
    if (!sr) {
      this.recordSystemMessage(slot, `运行配置错误：缺少 ${side} runtime`)
      this.settleStatus(slot)
      return Promise.resolve()
    }
    const next = sr.inFlight.then(() =>
      this.runTurnImpl(slot, sr, side, payloadText, opts)
    )
    // Swallow errors in the chain so a single failed turn doesn't poison
    // the queue. The original caller still sees them via the returned promise.
    sr.inFlight = next.catch(() => undefined)
    return next
  }

  /**
   * `payloadText` is the *raw* content the user/peer side wants to convey.
   * The engine attaches the system prompt on the FIRST prompt of each side.
   * If the conversation declares an `inheritedSummary` (i.e. user picked
   * parent conversations in the new-conv dialog), we splice it in BETWEEN
   * the system prompt and the user payload — that way the agent sees the
   * inherited memory before its first actual user instruction, exactly as
   * if a prior turn had laid it out.
   *
   * Image attachments are passed straight through as ACP `image` blocks
   * (separate from the text payload).
   */
  /**
   * Call the side's ACP runtime, auto-retrying when the adapter dies under us.
   *
   * The runtime resets its conn/session to null on a mid-turn adapter exit, so
   * the next prompt() respawns a fresh process (restoring context via
   * loadSession when the agent supports it). We lean on that here: a transient
   * crash / stream disconnect becomes a silent retry instead of dumping the
   * whole autopilot cascade to `awaiting-user`. This is the core of "全自动" —
   * the user shouldn't have to re-send a turn because a socket hiccuped.
   *
   * We DON'T retry when:
   *   • we no longer own the side (a newer turn replaced us — preemption)
   *   • the conversation was disposed mid-flight
   *   • the error is a dispose signal
   *   • we've exhausted MAX_PROMPT_RETRIES
   * — in those cases we rethrow and the caller's catch handles it as before.
   *
   * Before each retry we wipe the in-flight assistant bubble back to empty so
   * the respawned adapter streams into a clean slate rather than appending
   * after the crashed attempt's partial blocks.
   */
  private async promptWithRetry(
    slot: ActiveConversation,
    sr: SideRuntime,
    side: Role,
    blocks: ContentBlock[],
    assistantMessageId: string,
    /** Build a fresh-session prompt (system + compaction summary + payload)
     *  used to recover from a context-overflow exactly once. */
    onCompact: () => ContentBlock[]
  ): Promise<PromptResponse> {
    const MAX_PROMPT_RETRIES = 2
    let attempt = 0
    let compacted = false
    let currentBlocks = blocks
    for (;;) {
      try {
        const r = await sr.runtime.prompt(currentBlocks)
        // A successful compacted turn means the fresh session has now
        // received the system prompt — record that so the next turn doesn't
        // needlessly re-inject it.
        if (compacted) sr.systemPromptSent = true
        return r
      } catch (err) {
        const msg = (err as Error).message
        const stillOwnsSide = sr.streamingMessageId === assistantMessageId
        const convGone = !this.active.has(slot.conversation.id)

        // Context overflow: the adapter's session history is past the model's
        // limit. Retrying the same prompt is hopeless — instead abandon the
        // session and reseed a FRESH one with a CloXde-built summary, then try
        // once more. Bounded to a single compaction per turn so a pathological
        // summary can't loop. This is what lets "全自动" survive long runs
        // without the user having to open a new conversation.
        if (isContextOverflow(msg)) {
          if (compacted || !stillOwnsSide || convGone) throw err
          compacted = true
          await sr.runtime.restartFresh()
          currentBlocks = onCompact()
          sr.toolBlockIndex.clear()
          if (sr.streamingMessage) {
            sr.streamingMessage = { ...sr.streamingMessage, blocks: [] }
          }
          this.patchMessage(slot.conversation.id, assistantMessageId, { blocks: [] })
          this.recordSystemMessage(
            slot,
            `[${side}] 上下文超出模型上限，已自动压缩历史并在新会话中续跑。`
          )
          continue
        }

        const exhausted = attempt >= MAX_PROMPT_RETRIES
        const fatal = exhausted || !stillOwnsSide || convGone || /disposed/i.test(msg)
        if (fatal) {
          // Only retry-exhaustion is "instability" worth surfacing: preemption,
          // dispose, and conv-gone are normal lifecycle, not the底座 failing.
          if (exhausted && stillOwnsSide && !convGone) {
            this.recordInstability({
              ts: Date.now(),
              conversationId: slot.conversation.id,
              projectId: slot.conversation.projectId,
              side,
              exhausted: true,
              detail: condenseError(msg)
            })
          }
          throw err
        }
        attempt += 1
        // A crash we're about to retry — buffer it as a (recovered-or-not yet)
        // instability so a flaky run is visible even if the retry succeeds.
        this.recordInstability({
          ts: Date.now(),
          conversationId: slot.conversation.id,
          projectId: slot.conversation.projectId,
          side,
          exhausted: false,
          detail: condenseError(msg)
        })
        // Reset the assistant bubble to a clean slate for the retry.
        sr.toolBlockIndex.clear()
        if (sr.streamingMessage) {
          sr.streamingMessage = { ...sr.streamingMessage, blocks: [] }
        }
        this.patchMessage(slot.conversation.id, assistantMessageId, { blocks: [] })
        this.recordSystemMessage(
          slot,
          `[${side}] 适配器中断（${condenseError(msg)}），正在自动重试（${attempt}/${MAX_PROMPT_RETRIES}）…`
        )
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
      }
    }
  }

  /** Build a plain-text summary of one side's history for context compaction.
   *  The agent's own ACP session has overflowed, so rather than replay the
   *  full (too-long) transcript into a fresh session we hand it this digest,
   *  sourced entirely from CloXde's DB — task state + the side's most recent
   *  turns, char-budgeted newest-first. No model call, so it always succeeds. */
  private buildCompactionSummary(slot: ActiveConversation, side: Role): string {
    const conv = slot.conversation
    const lines: string[] = [
      '**CloXde 上下文压缩摘要**',
      '（此前会话历史过长，已被自动压缩。以下是摘要——请据此继续，不要假设还能看到更早的原文。）'
    ]

    if (conv.inheritedSummary && conv.inheritedSummary.trim()) {
      lines.push('', '[继承上下文]', conv.inheritedSummary.trim().slice(0, 2000))
    }

    const task = conv.activeTaskId ? taskRepo.get(conv.activeTaskId) : null
    if (task) {
      lines.push('', '[当前任务]', `状态: ${task.status}`)
      if (task.brief?.trim()) lines.push(`brief: ${task.brief.trim().slice(0, 1500)}`)
      if (task.plan && task.plan.length > 0) {
        lines.push('计划:')
        for (const s of task.plan) lines.push(`  - [${s.status}] ${s.description}`)
      }
      if (task.result?.trim()) lines.push(`最近结果: ${task.result.trim().slice(0, 1500)}`)
      if (task.failureReason?.trim()) {
        lines.push(`失败原因: ${task.failureReason.trim().slice(0, 1000)}`)
      }
    }

    // Most recent turns on THIS side, oldest-first in the output but selected
    // newest-first against a char budget so we keep the freshest context.
    // Use listRecentByConversation to avoid loading the entire conversation
    // history — for a long conversation (thousands of messages), loading all
    // messages just to filter and reverse-scan is a performance bottleneck.
    const mine = messageRepo
      .listRecentByConversation(conv.id, 100)
      .filter((m) => m.side === side && (m.role === 'user' || m.role === 'assistant'))
    const recent: string[] = []
    let budget = 6000
    for (let i = mine.length - 1; i >= 0 && budget > 0; i--) {
      const text = blocksToPlainText(mine[i].blocks)
      if (!text.trim()) continue
      const who = mine[i].role === 'user' ? '收到' : side
      let chunk = `${who}: ${text.trim()}`
      if (chunk.length > 1000) chunk = chunk.slice(0, 1000) + '…'
      budget -= chunk.length
      recent.unshift(chunk)
    }
    if (recent.length > 0) lines.push('', '[最近若干轮要点]', ...recent)

    return lines.join('\n')
  }



  private async runTurnImpl(
    slot: ActiveConversation,
    sr: SideRuntime,
    side: Role,
    payloadText: string,
    opts: {
      origin: 'user' | 'peer-delegate' | 'peer-report' | 'pm-handoff' | 'team-report'
      isUserInput: boolean
      forwardedFromMessageId?: string
      attachments?: { data: string; mimeType: string }[]
    }
  ): Promise<void> {
    // Path-C: prepend a CLOXDE-TASK preamble so the agent sees its current
    // status + allowed actions before every turn (not just first). This is
    // belt-and-suspenders with the permission gate — the gate enforces, the
    // preamble teaches. Skip the preamble for terminal tasks so a stale
    // activeTaskId (defensive — should be cleared by driveStateMachine)
    // doesn't confuse PM with a "status=done" header on free-form chat.
    const activeTask = slot.conversation.activeTaskId
      ? taskRepo.get(slot.conversation.activeTaskId)
      : null
    const taskActive: boolean =
      activeTask !== null &&
      activeTask.status !== 'done' &&
      activeTask.status !== 'failed'
    const preamble =
      taskActive && activeTask ? formatTaskPreamble(activeTask, side) + '\n\n---\n\n' : ''

    const isFirstTurn = !sr.systemPromptSent
    const promptText = isFirstTurn
      ? buildFirstTurnPrompt(side, slot.conversation.inheritedSummary, preamble + payloadText)
      : preamble + payloadText
    // NOTE: don't flip systemPromptSent yet — if prompt() rejects (adapter
    // crashed, channel closed) the system prompt was never actually
    // delivered. Flipping prematurely would mean the next retry sees the
    // agent without its role / protocol context. We set the flag only
    // after a successful prompt resolution below.
    // ACP `prompt` accepts a sequence of content blocks. Text first, then
    // any image attachments — agents process them in order so the image is
    // contextualized by the text that mentions it.
    const blocks: ContentBlock[] = [{ type: 'text', text: promptText }]
    const attachments = opts.attachments ?? []
    for (const a of attachments) {
      blocks.push({ type: 'image', data: a.data, mimeType: a.mimeType })
    }

    // Mirror the same blocks into the DB record so the UI replays them
    // verbatim — text payload + each image as its own MessageBlock.
    const persistedBlocks: MessageBlock[] = [
      { type: 'text', text: payloadText }
    ]
    for (const a of attachments) {
      persistedBlocks.push({ type: 'image', data: a.data, mimeType: a.mimeType })
    }
    const userMessage = messageRepo.create({
      conversationId: slot.conversation.id,
      side,
      role: 'user',
      blocks: persistedBlocks,
      forwardedFromMessageId: opts.forwardedFromMessageId
    })
    this.emit('message-appended', {
      conversationId: slot.conversation.id,
      message: userMessage
    })

    const assistantMessage = messageRepo.create({
      conversationId: slot.conversation.id,
      side,
      role: 'assistant',
      blocks: []
    })
    sr.streamingMessageId = assistantMessage.id
    sr.streamingMessage = assistantMessage
    sr.toolBlockIndex.clear()
    this.emit('message-appended', {
      conversationId: slot.conversation.id,
      message: assistantMessage
    })

    this.updateConversation(slot, { status: 'thinking' })
    this.emitSnapshot(slot)

    const startedAt = Date.now()
    try {
      // On context overflow promptWithRetry abandons the adapter session and
      // reseeds a fresh one. The fresh session has NO history, so the recovery
      // prompt must re-inject the system prompt + a CloXde-built summary in
      // place of the (too-long) inherited summary, then the same payload.
      const onCompact = (): ContentBlock[] => {
        const text = buildFirstTurnPrompt(
          side,
          this.buildCompactionSummary(slot, side),
          preamble + payloadText
        )
        const out: ContentBlock[] = [{ type: 'text', text }]
        for (const a of attachments) {
          out.push({ type: 'image', data: a.data, mimeType: a.mimeType })
        }
        return out
      }
      const response = await this.promptWithRetry(
        slot,
        sr,
        side,
        blocks,
        assistantMessage.id,
        onCompact
      )
      // Prompt round-tripped successfully — system prompt has been
      // received by the adapter. Flip the flag now so we don't re-send
      // it on the next turn. (If we flipped before await and the prompt
      // rejected, the next retry would talk to a context-less agent.)
      if (isFirstTurn) sr.systemPromptSent = true
      // Preemption guard: if cancelTeamRuntimes / sendUserMessage reset
      // sr.streamingMessageId out from under us (because a NEW turn already
      // started on this side), we MUST NOT touch sr's per-side state — that
      // would nuke the new turn's streamingMessageId / toolBlockIndex and
      // its updates would silently stop reaching the UI. The new turn owns
      // the side now; we just finalize our own message and bail.
      const stillOwnsSide = sr.streamingMessageId === assistantMessage.id
      // Snapshot the final blocks BEFORE we clear the streaming mirror
      // — we need them for finalText below, and re-querying messageRepo
      // here would defeat the F5 optimization (one O(N) hit per turn).
      const finalBlocks = sr.streamingMessage?.blocks ?? assistantMessage.blocks
      this.patchMessage(slot.conversation.id, assistantMessage.id, {
        stopReason: response.stopReason,
        metrics: buildTurnMetrics(response, Date.now() - startedAt)
      })
      if (stillOwnsSide) {
        sr.streamingMessageId = null
        sr.streamingMessage = null
        sr.toolBlockIndex.clear()
      }
      this.emitSnapshot(slot)

      if (response.stopReason === 'cancelled' || !stillOwnsSide) {
        // Preempted (either by explicit cancel or by a side-replacing
        // dispatch). Don't run driveStateMachine — the task state has
        // moved on without us, and applying a stale transition would
        // corrupt it.
        if (stillOwnsSide) {
          this.settleStatus(slot)
        }
        return
      }

      const finalText = blocksToPlainText(finalBlocks)
      const conv = conversationRepo.get(slot.conversation.id)
      if (!conv) return
      slot.conversation = conv

      if (!conv.autopilot) {
        this.settleStatus(slot)
        return
      }

      const overCap = (): boolean => {
        // Read live — driveStateMachine / startFreshTask reset
        // autoTurnsUsed mid-flight on HANDOFF, and capturing the value
        // we saw at the start of this turn would make us double-count.
        const c = slot.conversation
        if (c.autoTurnsUsed < c.maxAutoTurns) return false
        this.recordSystemMessage(
          slot,
          `已达到自动接力上限（${c.maxAutoTurns}），暂停。请用户介入。`
        )
        this.settleStatus(slot)
        return true
      }
      const bump = (): void => {
        // Same reason as overCap — read the post-reset count, not the
        // snapshot we took before the prompt landed.
        this.updateConversation(slot, {
          autoTurnsUsed: slot.conversation.autoTurnsUsed + 1
        })
      }
      // Helper to fire-and-forget the next turn in the cascade. We don't
      // await here: each side has its own queue, so cascaded turns run
      // independently of the originating call. That's what lets the user
      // chat with PM while the team is still mid-task.
      const dispatch = (
        toSide: Role,
        body: string,
        nextOrigin: 'pm-handoff' | 'team-report' | 'peer-delegate' | 'peer-report'
      ): void => {
        void this.runTurn(slot, toSide, body, {
          origin: nextOrigin,
          isUserInput: false,
          forwardedFromMessageId: assistantMessage.id
        }).catch((err: Error) => {
          this.recordSystemMessage(slot, `[${toSide}] ${condenseError(err.message)}`)
        })
      }

      // -------------------------------------------------------------------
      // Path-C: drive the cascade off the task state machine.
      //
      // We branch on whether this conversation has an active task. If it
      // does (3-agent path-C mode), we parse the agent's output against
      // the actions allowed for (current status, current owner), apply
      // the transition, and wake the next owner. Legacy free-form mode
      // (no task) falls back to the old tag scan for backwards compat.
      // -------------------------------------------------------------------
      const activeTask = slot.conversation.activeTaskId
        ? taskRepo.get(slot.conversation.activeTaskId)
        : null

      if (slot.pm && activeTask) {
        await this.driveStateMachine({
          slot,
          task: activeTask,
          side,
          finalText,
          bump,
          overCap,
          dispatch
        })
        return
      }

      // ---------- Legacy path (no active task) ---------------------------
      if (side === 'pm') {
        // 3-agent PM but no active task yet — first HANDOFF kicks one off.
        // Same path also fires after a previous task hit DONE/FAIL (we
        // clear activeTaskId on terminal transitions).
        const handoff = extractHandoff(finalText)
        if (!handoff) {
          // PM produced no further HANDOFF. Normally a clean stop — PM wrote
          // its reply / wrap-up, then idles. BUT if the PM was just handed a
          // DONE/FAIL [团队反馈] (origin='team-report') and returned an EMPTY
          // turn, it "空转": the architect's conclusion is sitting in the
          // forwarded [团队反馈] block, yet the PM emits no 收尾汇报 of its
          // own, so the run looks dead ("架构师完成后就没下文"). Force one
          // wrap-up turn; if that's also empty, surface a fallback system
          // message so the conclusion is never silently swallowed.
          if (opts.origin === 'team-report' && !finalText.trim()) {
            if (!slot.pmReportRetried) {
              slot.pmReportRetried = true
              if (overCap()) return
              bump()
              dispatch(
                'pm',
                '请基于上面的[团队反馈]，面向用户写一段收尾说明：本轮完成或卡在了什么、当前结论、以及用户接下来需要做什么。不要只字未回。',
                'team-report'
              )
              return
            }
            slot.pmReportRetried = false
            this.recordSystemMessage(
              slot,
              '团队已结束本轮任务（结论见上方[团队反馈]），但产品经理连续两轮未给出收尾说明。'
            )
            this.settleStatus(slot)
            return
          }
          slot.pmReportRetried = false
          this.settleStatus(slot)
          return
        }
        slot.pmReportRetried = false
        if (overCap()) return
        const newTask = taskRepo.create({
          conversationId: slot.conversation.id,
          brief: handoff,
          status: 'planning',
          owner: 'architect'
        })
        conversationRepo.patch(slot.conversation.id, {
          activeTaskId: newTask.id,
          autoTurnsUsed: 0
        })
        slot.conversation = conversationRepo.get(slot.conversation.id) ?? slot.conversation
        slot.stallNudges = 0
        bump()
        dispatch('architect', handoff, 'pm-handoff')
        this.emitSnapshot(slot)
        return
      }

      if (side === 'architect') {
        if (hasDone(finalText)) {
          if (slot.pm) {
            if (overCap()) return
            bump()
            dispatch('pm', wrapTeamReport(finalText), 'team-report')
            return
          }
          this.recordSystemMessage(slot, '架构师宣告任务完成（<<DONE>>）。')
          this.updateConversation(slot, { status: 'ended', endedAt: Date.now() })
          return
        }
        const delegated = extractDelegate(finalText)
        if (!delegated) {
          if (slot.pm) {
            if (overCap()) return
            bump()
            dispatch('pm', wrapTeamReport(finalText), 'team-report')
            return
          }
          this.settleStatus(slot)
          return
        }
        if (overCap()) return
        bump()
        dispatch('executor', wrapDelegate(delegated), 'peer-delegate')
        return
      }

      // side === 'executor' — always reports to architect.
      if (overCap()) return
      if (!finalText.trim()) {
        this.settleStatus(slot)
        return
      }
      bump()
      dispatch('architect', wrapExecutorReport(finalText), 'peer-report')
    } catch (err) {
      const errMsg = (err as Error).message
      console.error(`[${side}] prompt rejected:`, errMsg)
      const stillOwnsSide = sr.streamingMessageId === assistantMessage.id
      this.patchMessage(slot.conversation.id, assistantMessage.id, {
        stopReason: 'cancelled'
      })
      if (stillOwnsSide) {
        sr.streamingMessageId = null
        sr.streamingMessage = null
        sr.toolBlockIndex.clear()
      }
      this.emitSnapshot(slot)
      if (!isAdapterNoise(errMsg) && stillOwnsSide) {
        // Don't surface errors from a preempted turn — the new turn is
        // already what the user is watching.
        if (isContextOverflow(errMsg)) {
          this.recordSystemMessage(
            slot,
            `[${side}] 上下文已超出模型上限，本轮无法继续。该 agent 会话历史过长——建议新开一个会话（可在新建时勾选继承摘要），或精简任务范围后重试。`
          )
        } else {
          this.recordSystemMessage(slot, `[${side}] ${condenseError(errMsg)}`)
        }
      }
      if (stillOwnsSide) {
        this.settleStatus(slot)
      }
    }
  }

  /**
   * Path-C state-machine driver. Called after an agent's turn finalizes
   * when the conversation has an active task. We:
   *
   *   1. Look up the actions allowed for this task's (status, side)
   *   2. Extract the LAST allowed tag in the agent's output
   *   3. Apply the transition (status + owner shift)
   *   4. Persist any side-effects (plan, result, brief) on the task row
   *   5. Wake the next owner with the relevant body
   *
   * Quirks worth knowing:
   *   • PM HANDOFF on a terminal task → start a *new* task, archiving the
   *     old activeTaskId rather than failing the transition.
   *   • DONE / FAIL → clear conversation.activeTaskId so the next free-form
   *     PM turn doesn't carry a stale [CLOXDE-TASK status=done] preamble.
   *   • Empty bodies on HANDOFF/DELEGATE/REPORT/DONE → don't dispatch a
   *     blank prompt to the next owner (waste of tokens). Record a system
   *     nudge instead and idle.
   *   • "Agent emitted no recognized tag" → first miss auto-pings the same
   *     side once with a reminder; second miss in a row idles. Counter
   *     resets on any forward transition.
   */
  private async driveStateMachine(ctx: {
    slot: ActiveConversation
    task: Task
    side: Role
    finalText: string
    bump: () => void
    overCap: () => boolean
    dispatch: (
      toSide: Role,
      body: string,
      nextOrigin: 'pm-handoff' | 'team-report' | 'peer-delegate' | 'peer-report'
    ) => void
  }): Promise<void> {
    const { slot, task, side, finalText, bump, overCap, dispatch } = ctx
    const allowed = allowedTags(task.status, side)
    if (allowed.length === 0) {
      // This side wasn't supposed to be acting at all — stale turn fired
      // after a state change. Don't escalate the stall counter; just idle.
      this.settleStatus(slot)
      return
    }
    const found = extractAction(finalText, allowed)
    if (!found) {
      this.handleNoTag(slot, side, allowed, dispatch, bump, overCap)
      return
    }

    const next = transition(task, found.action)
    if (!next) {
      // Tag found but not legal in this state. Most common case is the
      // PM emitting HANDOFF on a terminal task — handle that as "open a
      // new task" instead of bailing.
      if (
        found.action === 'HANDOFF' &&
        side === 'pm' &&
        (task.status === 'done' || task.status === 'failed')
      ) {
        await this.startFreshTask(slot, found.body, dispatch, bump, overCap)
        return
      }
      this.nudgeProtocolSlip(
        slot,
        side,
        `上一轮的 <<${found.action}>> 在当前阶段（status=${task.status}）不合法。允许的动作：${allowed
          .map((a) => `<<${a}>>`)
          .join(' / ')}。请改用其中之一在本轮**末尾**收尾。`,
        `[${side}] <<${found.action}>> 在 status=${task.status} 连续不合法，引擎暂停等待用户介入。`,
        dispatch,
        bump,
        overCap
      )
      return
    }

    // Reject empty payloads early so we don't dispatch a blank prompt to
    // the next owner. Skip for FAIL/PLAN — those are valid info-only turns.
    if (
      (found.action === 'HANDOFF' ||
        found.action === 'DELEGATE' ||
        found.action === 'REPORT') &&
      !found.body.trim()
    ) {
      this.nudgeProtocolSlip(
        slot,
        side,
        `上一轮的 <<${found.action}>> 正文为空，无法转交给下一棒。请补全 <<${found.action}>>……<</${found.action}>> 之间的内容后，在本轮**末尾**重发。`,
        `[${side}] <<${found.action}>> 连续内容为空，引擎暂停等待用户介入。`,
        dispatch,
        bump,
        overCap
      )
      return
    }

    // -- Persist side-effects on the task row before transitioning -------
    const patches: Parameters<typeof taskRepo.patch>[1] = {
      status: next.nextStatus,
      owner: next.nextOwner
    }

    // Update iteration counters based on transition flags
    if (next.incrementPlanIterations) {
      patches.planIterations = task.planIterations + 1
    }
    if (next.incrementReviewCycles) {
      patches.reviewCycles = task.reviewCycles + 1
    }
    if (next.resetPlanIterations) {
      patches.planIterations = 0
    }
    if (next.resetReviewCycles) {
      patches.reviewCycles = 0
    }

    switch (found.action) {
      case 'PLAN':
        patches.plan = parsePlanSteps(found.body)
        break
      case 'DELEGATE': {
        // The architect frequently emits PLAN AND DELEGATE in the same
        // turn ("here's the plan, do step 1"). extractAction picks the
        // LAST tag (DELEGATE) so PLAN would otherwise be lost. Scrape
        // it back out and persist if found.
        const planMatch = /<<PLAN>>([\s\S]*?)(?:<<\/PLAN>>|(?=<<\/?[A-Za-z])|$)/i.exec(finalText)
        if (planMatch) {
          const steps = parsePlanSteps(planMatch[1].trim())
          if (steps.length > 0) patches.plan = steps
        }
        break
      }
      case 'REPORT':
        patches.result = found.body
        break
      case 'DONE':
        patches.result = found.body || task.result
        break
      case 'FAIL':
        patches.failureReason = found.body
        break
      case 'HANDOFF':
        patches.brief = found.body || task.brief
        break
    }
    taskRepo.patch(task.id, patches)

    // If the transition returned a warning, inject it as a system message
    // to alert the agent about the loop condition.
    if (next.warning) {
      this.recordSystemMessage(slot, next.warning)
    }

    // Forward transition → reset stall counter.
    slot.stallNudges = 0

    // Terminal transitions clear the active task pointer so subsequent
    // free-form PM chat doesn't carry a "status=done" preamble. The task
    // row is preserved for history / TaskInspector.
    if (next.nextStatus === 'done' || next.nextStatus === 'failed') {
      conversationRepo.patch(slot.conversation.id, { activeTaskId: null })
      slot.conversation =
        conversationRepo.get(slot.conversation.id) ?? slot.conversation
    }

    // -- Decide what to forward & to whom --------------------------------
    if (overCap()) return

    switch (found.action) {
      case 'HANDOFF':
        // PM mid-task pivot. Cancel any in-flight team work so the new
        // brief doesn't race the old one — await so the next prompt()
        // doesn't collide on the same ACP session.
        await this.cancelTeamRuntimes(slot)
        this.updateConversation(slot, { autoTurnsUsed: 0 })
        bump()
        dispatch('architect', found.body, 'pm-handoff')
        break
      case 'PLAN':
        // Architect committed a plan but hasn't delegated. Re-ping it
        // with a reminder. Counts as a stall nudge — if architect plans
        // again instead of delegating we'll idle on the second strike.
        slot.stallNudges += 1
        if (slot.stallNudges > 1) {
          this.recordSystemMessage(
            slot,
            '架构师连续 PLAN 未派单，引擎暂停等待用户介入。'
          )
          this.settleStatus(slot)
          break
        }
        bump()
        dispatch(
          'architect',
          '已记录你的 <<PLAN>>。请在下一轮发出 <<DELEGATE>>……<</DELEGATE>>，把第一步交给执行者。',
          'pm-handoff'
        )
        break
      case 'DELEGATE':
        bump()
        dispatch('executor', found.body, 'peer-delegate')
        break
      case 'REPORT':
        bump()
        dispatch('architect', wrapExecutorReport(found.body), 'peer-report')
        break
      case 'DONE':
        if (slot.pm) {
          bump()
          // Forward the architect's conclusion. Prefer the tag body, but
          // fall back to the full turn text: the DONE close-tag is OPTIONAL
          // (see TAG_PATTERNS), so a bare `<<DONE>>` with the conclusion
          // written *after* it yields an empty `found.body` — without this
          // fallback the PM would receive an empty [团队反馈] and have nothing
          // to wrap up. Mirrors the legacy path which forwards finalText.
          dispatch('pm', wrapTeamReport(found.body || finalText), 'team-report')
        } else {
          this.recordSystemMessage(slot, '架构师宣告任务完成（<<DONE>>）。')
          this.updateConversation(slot, { status: 'ended', endedAt: Date.now() })
        }
        break
      case 'FAIL':
        // driveStateMachine is only entered under `slot.pm && activeTask`
        // (see runTurnImpl), so the PM always exists here. Hand the failure
        // up to the PM and bias it toward an automatic retry: the PM is the
        // decision-maker, so rather than mechanically replanning we let it
        // judge retryability — but we tell it that retrying is on the table so
        // it doesn't reflexively stop and ask the user. The engine itself
        // doesn't halt on FAIL; whether the cascade continues is the PM's call.
        bump()
        dispatch(
          'pm',
          [
            '[团队反馈]',
            `任务失败：${found.body || finalText}`,
            '',
            '如果你判断换一种思路有机会解决，直接发 <<HANDOFF>>……<</HANDOFF>> 重新派活继续推进；',
            '只有在确实卡住、需要用户决策时才停下来向用户说明。'
          ].join('\n'),
          'team-report'
        )
        break
    }
    this.emitSnapshot(slot)
  }

  /** PM emitted HANDOFF on a terminal task → archive the activeTaskId and
   *  open a fresh (planning, architect) task with the new brief. */
  private async startFreshTask(
    slot: ActiveConversation,
    brief: string,
    dispatch: (
      toSide: Role,
      body: string,
      nextOrigin: 'pm-handoff' | 'team-report' | 'peer-delegate' | 'peer-report'
    ) => void,
    bump: () => void,
    overCap: () => boolean
  ): Promise<void> {
    if (!brief.trim()) {
      this.recordSystemMessage(slot, '[pm] <<HANDOFF>> 内容为空，已忽略。')
      this.settleStatus(slot)
      return
    }
    if (overCap()) return
    // Cancel old team runtimes BEFORE creating the new task so any in-flight
    // turn from the old task can't race the new activeTaskId update.
    await this.cancelTeamRuntimes(slot)
    const newTask = taskRepo.create({
      conversationId: slot.conversation.id,
      brief,
      status: 'planning',
      owner: 'architect'
    })
    conversationRepo.patch(slot.conversation.id, {
      activeTaskId: newTask.id,
      autoTurnsUsed: 0
    })
    slot.conversation =
      conversationRepo.get(slot.conversation.id) ?? slot.conversation
    slot.stallNudges = 0
    bump()
    dispatch('architect', brief, 'pm-handoff')
    this.emitSnapshot(slot)
  }

  /** Stop any in-flight architect / executor runs and clear their queues.
   *  Used when PM hands off mid-task — old work would race the new brief.
   *  Awaits the ACP cancel so the next prompt() doesn't collide with the
   *  in-flight one on the same session (some adapters serialize prompts
   *  per-session and behave badly under concurrent dispatch). */
  private async cancelTeamRuntimes(slot: ActiveConversation): Promise<void> {
    const cancels: Promise<void>[] = []
    const drains: Promise<void>[] = []
    for (const teamSide of [slot.architect, slot.executor]) {
      if (teamSide.streamingMessageId) {
        cancels.push(teamSide.runtime.cancel().catch(() => undefined))
        this.patchMessage(slot.conversation.id, teamSide.streamingMessageId, {
          stopReason: 'cancelled'
        })
        teamSide.streamingMessageId = null
        teamSide.streamingMessage = null
        teamSide.toolBlockIndex.clear()
      }
      // Drain the queue: save current inFlight, immediately set to resolved
      // to block new tasks, then wait for the old queue to finish.
      const oldQueue = teamSide.inFlight
      teamSide.inFlight = Promise.resolve()
      drains.push(oldQueue.catch(() => undefined))
    }
    const allWaits = [...cancels, ...drains]
    if (allWaits.length > 0) {
      // Cap the wait — Hermes adapters occasionally never ack cancel,
      // and queued tasks may be slow.
      await Promise.race([
        Promise.all(allWaits).then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1500))
      ])
    }
  }

  /** A team agent produced a recognizable but unusable turn — a tag that's
   *  illegal in the current state, or a tag whose payload is empty. Rather
   *  than halting on the first slip, re-ping the SAME side once with a
   *  corrective reminder and idle only if it slips again. Shares the
   *  stallNudges budget with handleNoTag, so a side that alternates between
   *  different kinds of slips still can't loop forever. PM slips just idle —
   *  PM is allowed to free-chat, so there's nothing to correct. */
  private nudgeProtocolSlip(
    slot: ActiveConversation,
    side: Role,
    reminder: string,
    haltMessage: string,
    dispatch: (
      toSide: Role,
      body: string,
      nextOrigin: 'pm-handoff' | 'team-report' | 'peer-delegate' | 'peer-report'
    ) => void,
    bump: () => void,
    overCap: () => boolean
  ): void {
    if (side === 'pm') {
      this.recordSystemMessage(slot, haltMessage)
      this.settleStatus(slot)
      return
    }
    slot.stallNudges += 1
    if (slot.stallNudges > 1) {
      this.recordSystemMessage(slot, haltMessage)
      this.settleStatus(slot)
      return
    }
    if (overCap()) return
    bump()
    dispatch(
      side === 'architect' ? 'architect' : 'executor',
      reminder,
      side === 'architect' ? 'pm-handoff' : 'peer-delegate'
    )
  }

  /** Agent's turn produced no tag the state machine recognizes. PM is
   *  allowed to free-chat (no nudge needed). For team sides we re-ping
   *  once with a reminder; if they miss again we idle. */
  private handleNoTag(
    slot: ActiveConversation,
    side: Role,
    allowed: TaskAction[],
    dispatch: (
      toSide: Role,
      body: string,
      nextOrigin: 'pm-handoff' | 'team-report' | 'peer-delegate' | 'peer-report'
    ) => void,
    bump: () => void,
    overCap: () => boolean
  ): void {
    if (side === 'pm') {
      this.settleStatus(slot)
      return
    }
    slot.stallNudges += 1
    if (slot.stallNudges > 1) {
      this.recordSystemMessage(
        slot,
        `[${side}] 连续两轮未发出允许的动作（${allowed
          .map((a) => `<<${a}>>`)
          .join(' / ')}），引擎暂停等待用户介入。`
      )
      this.settleStatus(slot)
      return
    }
    if (overCap()) return
    bump()
    const reminder = `上一轮没有按协议给出动作标签。允许的动作：${allowed
      .map((a) => `<<${a}>>`)
      .join(' / ')}。请在下一轮**末尾**用其中一个标签收尾。`
    dispatch(
      side === 'architect' ? 'architect' : 'executor',
      reminder,
      side === 'architect' ? 'pm-handoff' : 'peer-delegate'
    )
  }

  private handleUpdate(
    slot: ActiveConversation,
    sr: SideRuntime,
    notification: SessionNotification
  ): void {
    const messageId = sr.streamingMessageId
    if (!messageId) return
    // Use the in-memory streaming mirror — re-fetching via
    // messageRepo.listByConversation() once per chunk is O(N) on
    // every flush, which on a multi-thousand-message conversation
    // visibly stalls the JS thread.
    const message = sr.streamingMessage
    if (!message || message.id !== messageId) return

    const blocks = [...message.blocks]
    const changed = applyUpdate(blocks, notification.update, sr.toolBlockIndex)

    if (changed) {
      messageRepo.patch(messageId, { blocks })
      // Keep the streaming mirror in sync — next chunk reads from it.
      sr.streamingMessage = { ...message, blocks }
      this.emit('message-patched', {
        conversationId: slot.conversation.id,
        messageId,
        patch: { blocks }
      })
    }
  }

  private patchMessage(
    conversationId: string,
    messageId: string,
    patch: Partial<Pick<Message, 'blocks' | 'stopReason' | 'metrics'>>
  ): void {
    messageRepo.patch(messageId, patch)
    this.emit('message-patched', { conversationId, messageId, patch })
  }

  private recordSystemMessage(slot: ActiveConversation, text: string): void {
    const msg = messageRepo.create({
      conversationId: slot.conversation.id,
      side: 'system',
      role: 'system',
      blocks: [{ type: 'text', text }]
    })
    this.emit('message-appended', { conversationId: slot.conversation.id, message: msg })
  }

  private updateConversation(
    slot: ActiveConversation,
    patch: Parameters<typeof conversationRepo.patch>[1]
  ): void {
    conversationRepo.patch(slot.conversation.id, patch)
    const fresh = conversationRepo.get(slot.conversation.id)
    if (fresh) slot.conversation = fresh
    this.emitSnapshot(slot)
  }

  /** Settle the conversation status after one side goes idle. A conversation
   *  has a single `status` but up to three concurrent sides (PM / architect /
   *  executor): the PM can be free-chatting while the team cascade is still
   *  streaming, and vice versa. Blindly writing `awaiting-user` whenever any
   *  one side finishes would falsely mark the whole conversation idle while
   *  another side is mid-turn. So check every side first: stay `thinking` as
   *  long as anyone still owns a streaming message, and only fall to
   *  `awaiting-user` once they're all quiet. The just-finished side has already
   *  cleared its own streamingMessageId before reaching any settle site, so it
   *  never counts itself as busy here. */
  private settleStatus(slot: ActiveConversation): void {
    const busy = this.allSides(slot).some((sr) => sr.streamingMessageId)
    this.updateConversation(slot, { status: busy ? 'thinking' : 'awaiting-user' })
  }

  /** Re-emit a ConversationView snapshot — picks up busySide for the renderer
   *  even when there's nothing to write to the DB. */
  private emitSnapshot(slot: ActiveConversation): void {
    // Tick emits carry conversation-level state only (status, busySide,
    // autopilot, activeTask). Both consumers — the renderer IPC bridge and
    // the WS bridge — discard the message array on update and rely on the
    // dedicated message-appended / message-patched deltas, so skip the
    // full-history read entirely here.
    const view = this.snapshot(slot.conversation.id, { withMessages: false })
    if (view) this.emit('conversation-updated', view)
  }
}

export const conversationEngine = new ConversationEngine()
