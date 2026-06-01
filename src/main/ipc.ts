import { app, BrowserWindow, dialog, ipcMain, webContents } from 'electron'
import { basename } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import type {
  AgentKind,
  AgentProfile,
  AssistantActivity,
  AssistantMemory,
  AssistantMessageRecord,
  AssistantReport,
  AssistantTurn,
  Conversation,
  ConversationView,
  DirEntry,
  GitStatus,
  IpcResult,
  Message,
  MemoryKind,
  Project,
  Schedule,
  ScheduleTrigger,
  Side
} from '@shared/types'
import { IPC } from '@shared/ipc-channels'
import { conversationRepo, getDb, messageRepo, profileRepo, projectRepo, scheduleRepo, assistantMessageRepo } from './storage/db'
import { conversationEngine } from './conversation/engine'
import { createSchedule, updateSchedule } from './conversation/scheduler'
import { getAssistantBrain } from './assistant/brain'
import { getMemoryService } from './assistant/memory'
import { assistantBus } from './assistant/actions'
import {
  persistErrorMessage,
  persistTurnOutputs,
  persistUserMessage
} from './assistant/turn-handler'
import { buildInheritedSummary } from './conversation/summarizer'
import { ensureWatch, listDir, listProjectFiles, openPath, stopWatch } from './fs/inspector'
import { gitDiffFile, gitStatus } from './fs/git'
import {
  broadcastWs,
  getServerStatus
} from './server/http-server'
import { listTokens, revokeAll, revokeToken, rotatePin } from './server/auth'
import { presence, type ActivityKind } from './server/presence'
import { getSoulPath, ensureCloxdeDir } from './paths'
import * as wechatChannel from './wechat/channel'

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function err(message: string): IpcResult<never> {
  return { ok: false, error: message }
}

function isAgentKind(v: unknown): v is AgentKind {
  return v === 'claude' || v === 'codex' || v === 'hermes'
}
function isSide(v: unknown): v is Side {
  return v === 'architect' || v === 'executor'
}
const MEMORY_KINDS: MemoryKind[] = ['preference', 'fact', 'project', 'person', 'pattern', 'episodic', 'skill']
function isMemoryKind(v: unknown): v is MemoryKind {
  return typeof v === 'string' && (MEMORY_KINDS as string[]).includes(v)
}

/** Validate an untrusted ScheduleTrigger from the renderer/IPC boundary.
 *  Returns the narrowed trigger or null. Bounds the interval to ≥1 minute so
 *  a typo can't spin the team every tick. */
function parseTrigger(v: unknown): ScheduleTrigger | null {
  if (!v || typeof v !== 'object') return null
  const t = v as { kind?: unknown; everyMs?: unknown; expr?: unknown }
  if (t.kind === 'interval') {
    if (typeof t.everyMs !== 'number' || !Number.isFinite(t.everyMs)) return null
    if (t.everyMs < 60_000) return null
    return { kind: 'interval', everyMs: Math.floor(t.everyMs) }
  }
  if (t.kind === 'cron') {
    if (typeof t.expr !== 'string' || !t.expr.trim()) return null
    return { kind: 'cron', expr: t.expr.trim() }
  }
  return null
}

function broadcast(channel: string, payload: unknown): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    wc.send(channel, payload)
  }
}

/** Record the desktop user as having just done something on a conversation,
 *  then broadcast the activity. Both LAN clients (via WS) and the desktop's
 *  own renderer (via the IPC channel) hear the same payload, which lets
 *  ChatScreen show "对方刚操作" banners regardless of who acted. */
function recordDesktopPresence(conversationId: string, kind: ActivityKind): void {
  const rec = presence.record(conversationId, { kind: 'desktop', label: 'desktop' }, kind)
  broadcastWs('presence:activity', rec)
  broadcast(IPC.PresenceActivityEvent, rec)
}

function buildConversationView(conversationId: string): ConversationView | null {
  // Delegate to the engine so busySide is populated for active conversations.
  return conversationEngine.snapshot(conversationId)
}

export function registerIpcHandlers(): void {
  // Wire engine events → renderer.
  conversationEngine.on('conversation-updated', (view: ConversationView) => {
    broadcast(IPC.ConversationUpdatedEvent, view)
  })
  conversationEngine.on(
    'message-appended',
    (payload: { conversationId: string; message: Message }) => {
      broadcast(IPC.MessageAppendedEvent, payload)
    }
  )
  conversationEngine.on(
    'message-patched',
    (payload: { conversationId: string; messageId: string; patch: Partial<Message> }) => {
      broadcast(IPC.MessagePatchedEvent, payload)
    }
  )

  // The assistant's proactive reports (from the review loop) → renderer.
  assistantBus.on('report', (report: AssistantReport) => {
    // Persist as an unread 'report' row so the thread survives restart and the
    // titlebar badge has something to count.
    try {
      assistantMessageRepo.insert({
        role: 'report',
        text: report.message,
        projectId: report.projectId,
        conversationId: report.conversationId,
        read: false
      })
    } catch (e) {
      console.error('[ipc] persist assistant report failed:', (e as Error).message)
    }
    broadcast(IPC.AssistantReportEvent, report)
  })

  // Live turn progress (thinking / tool / blocked / done) → renderer, so the
  // assistant panel can show the brain is working instead of a dead spinner.
  assistantBus.on('activity', (activity: AssistantActivity) => {
    broadcast(IPC.AssistantActivityEvent, activity)
  })

  // --- App ---------------------------------------------------------------
  ipcMain.handle(IPC.AppGetVersion, () => ok(app.getVersion()))

  // --- Dialogs -----------------------------------------------------------
  ipcMain.handle(IPC.ProjectsPickDir, async (e): Promise<IpcResult<string | null>> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: '选择项目文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return ok(null)
    return ok(result.filePaths[0])
  })

  ipcMain.handle(
    IPC.PickDir,
    async (e, opts: unknown): Promise<IpcResult<string | null>> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
      const o = (opts as { defaultPath?: string; title?: string } | undefined) ?? {}
      const result = await dialog.showOpenDialog(win!, {
        title: o.title ?? '选择文件夹',
        defaultPath: o.defaultPath,
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return ok(null)
      return ok(result.filePaths[0])
    }
  )

  // --- Projects ----------------------------------------------------------
  ipcMain.handle(IPC.ProjectsList, (): IpcResult<Project[]> => ok(projectRepo.list()))

  ipcMain.handle(
    IPC.ProjectsListArchived,
    (): IpcResult<Project[]> => ok(projectRepo.listArchived())
  )

  ipcMain.handle(IPC.ProjectsCreate, (_e, rootDir: unknown): IpcResult<Project> => {
    if (typeof rootDir !== 'string' || !rootDir) return err('invalid rootDir')
    if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
      return err(`不是一个文件夹：${rootDir}`)
    }
    const project = projectRepo.upsertByRoot({
      name: basename(rootDir) || rootDir,
      rootDir
    })
    // Make sure each project ships with the two default agent profiles.
    profileRepo.ensureDefaults(project.id)
    return ok(project)
  })

  ipcMain.handle(IPC.ProjectsOpen, (_e, id: unknown): IpcResult<true> => {
    if (typeof id !== 'string') return err('invalid id')
    projectRepo.touch(id)
    profileRepo.ensureDefaults(id)
    return ok(true)
  })

  ipcMain.handle(IPC.ProjectsArchive, (_e, id: unknown): IpcResult<true> => {
    if (typeof id !== 'string') return err('invalid id')
    const proj = projectRepo.get(id)
    if (!proj) return err(`项目不存在：${id}`)
    if (proj.archivedAt) return ok(true) // already archived — idempotent
    // Refuse if any conversation in this project is mid-turn — archiving
    // while the engine is streaming would orphan the in-flight ACP request.
    if (conversationRepo.hasThinkingInProject(id)) {
      return err('该项目下还有正在运行的会话，先暂停或等它结束再归档。')
    }
    // Cascade: archive the project AND all its active conversations using a
    // shared timestamp so unarchive can selectively bring back exactly that
    // batch (conversations the user archived earlier keep their state).
    const ts = Date.now()
    conversationRepo.archiveAllByProject(id, ts)
    projectRepo.archive(id)
    // Project rows store their own archivedAt, but projectRepo.archive uses
    // Date.now() internally; we want it to match `ts` for the unarchive
    // cascade to work, so set it explicitly here. (Two adjacent writes are
    // fine — the second is just a millisecond-precision adjustment.)
    getDb()
      .prepare('UPDATE projects SET archived_at = ? WHERE id = ?')
      .run(ts, id)
    stopWatch(id)
    return ok(true)
  })

  ipcMain.handle(IPC.ProjectsUnarchive, (_e, id: unknown): IpcResult<true> => {
    if (typeof id !== 'string') return err('invalid id')
    const proj = projectRepo.get(id)
    if (!proj) return err(`项目不存在：${id}`)
    if (!proj.archivedAt) return ok(true) // already active — idempotent
    // Reverse cascade: only unarchive conversations whose archivedAt matches
    // the project's — those are the ones our cascade put away. Convs the
    // user had archived manually before stay archived.
    conversationRepo.unarchiveAllByProjectAt(id, proj.archivedAt)
    projectRepo.unarchive(id)
    return ok(true)
  })

  ipcMain.handle(IPC.ProjectsDelete, (_e, id: unknown): IpcResult<true> => {
    if (typeof id !== 'string') return err('invalid id')
    projectRepo.delete(id)
    stopWatch(id)
    return ok(true)
  })

  // --- Agent profiles ----------------------------------------------------
  ipcMain.handle(
    IPC.ProfilesListByProject,
    (_e, projectId: unknown): IpcResult<AgentProfile[]> => {
      if (typeof projectId !== 'string') return err('invalid projectId')
      profileRepo.ensureDefaults(projectId)
      return ok(profileRepo.listByProject(projectId))
    }
  )

  ipcMain.handle(
    IPC.ProfilesUpsert,
    (
      _e,
      input: unknown
    ): IpcResult<AgentProfile> => {
      const i = input as {
        projectId: string
        kind: AgentKind
        name?: string
        command?: string | null
        args?: string[]
        env?: Record<string, string>
      }
      if (!i || typeof i.projectId !== 'string' || !isAgentKind(i.kind)) {
        return err('invalid profile payload')
      }
      return ok(profileRepo.upsert(i))
    }
  )

  // --- Conversations -----------------------------------------------------
  ipcMain.handle(
    IPC.ConversationsListByProject,
    (_e, projectId: unknown): IpcResult<Conversation[]> => {
      if (typeof projectId !== 'string') return err('invalid projectId')
      return ok(conversationRepo.listByProject(projectId))
    }
  )

  ipcMain.handle(
    IPC.ConversationsListArchivedByProject,
    (_e, projectId: unknown): IpcResult<Conversation[]> => {
      if (typeof projectId !== 'string') return err('invalid projectId')
      return ok(conversationRepo.listArchivedByProject(projectId))
    }
  )

  ipcMain.handle(
    IPC.ConversationsCreate,
    (
      _e,
      input: unknown
    ): IpcResult<ConversationView> => {
      const i = input as {
        projectId: string
        title?: string
        /** When true (default) create a 3-agent (PM + architect + executor)
         *  conversation. Set to false to create a legacy 2-agent one. */
        withPm?: boolean
        pmKind?: AgentKind
        architectKind?: AgentKind
        executorKind?: AgentKind
        /** Optional parent conversations to inherit context from. CloXde
         *  generates a mechanical markdown summary of these parents and
         *  seeds the new conversation with it as a system message. */
        parentIds?: string[]
        /** When provided, overrides the auto-generated summary (user has
         *  hand-edited it in the new-conversation dialog). */
        summaryOverride?: string
      }
      if (!i || typeof i.projectId !== 'string') return err('invalid input')
      const project = projectRepo.get(i.projectId)
      if (!project) return err(`项目不存在：${i.projectId}`)
      profileRepo.ensureDefaults(project.id)
      const architectKind = isAgentKind(i.architectKind)
        ? i.architectKind
        : project.defaultArchitect
      const executorKind = isAgentKind(i.executorKind)
        ? i.executorKind
        : project.defaultExecutor
      const architect = profileRepo.findByKind(project.id, architectKind)
      const executor = profileRepo.findByKind(project.id, executorKind)
      if (!architect || !executor) return err('agent profile 缺失')

      const withPm = i.withPm !== false
      let pmProfileId: string | undefined
      if (withPm) {
        // Default PM = Claude Code. Hermes is available as a selectable
        // option in Settings → Agent → Hermes, but until CloXde wires a
        // permission UI for Hermes' tool calls, defaulting to it gets the
        // user stuck on "OTHER 待执行" the moment Hermes tries to read a
        // file / search sessions / etc.
        const defaultPmKind: AgentKind = 'claude'
        const pmKind = isAgentKind(i.pmKind) ? i.pmKind : defaultPmKind
        const pm = profileRepo.findByKind(project.id, pmKind)
        if (!pm) return err('PM profile 缺失')
        pmProfileId = pm.id
      }

      // Filter parent ids: must belong to this project and not be self.
      // Drop unknowns silently — the picker UI shouldn't have offered them.
      const requestedParents = Array.isArray(i.parentIds) ? i.parentIds : []
      const validParentIds = requestedParents.filter((pid) => {
        if (typeof pid !== 'string') return false
        const parent = conversationRepo.get(pid)
        return !!parent && parent.projectId === project.id
      })

      // Generate the summary (or take the user's override).
      let inheritedSummary: string | undefined
      if (validParentIds.length > 0) {
        if (typeof i.summaryOverride === 'string' && i.summaryOverride.trim()) {
          inheritedSummary = i.summaryOverride.trim()
        } else {
          inheritedSummary = buildInheritedSummary(validParentIds) || undefined
        }
      }

      const conv = conversationRepo.create({
        projectId: project.id,
        title: i.title,
        pmProfileId,
        architectProfileId: architect.id,
        executorProfileId: executor.id,
        primarySide: 'architect',
        autopilot: true,
        parentIds: validParentIds,
        inheritedSummary
      })

      // Seed the new conversation with the rendered summary as a system
      // message dated just-before-now so it sorts above any future input.
      if (inheritedSummary) {
        messageRepo.create({
          conversationId: conv.id,
          side: 'system',
          role: 'system',
          blocks: [{ type: 'text', text: inheritedSummary }],
          ts: conv.createdAt - 1
        })
      }

      const view = buildConversationView(conv.id)
      if (!view) return err('failed to build conversation view')
      return ok(view)
    }
  )

  ipcMain.handle(
    IPC.ConversationsGet,
    (_e, id: unknown): IpcResult<ConversationView | null> => {
      if (typeof id !== 'string') return err('invalid id')
      return ok(buildConversationView(id))
    }
  )

  ipcMain.handle(
    IPC.ConversationsPreviewInheritedSummary,
    (_e, parentIds: unknown): IpcResult<string> => {
      if (!Array.isArray(parentIds)) return err('invalid parentIds')
      const ids = parentIds.filter((p): p is string => typeof p === 'string')
      return ok(buildInheritedSummary(ids))
    }
  )

  ipcMain.handle(
    IPC.ConversationsDelete,
    async (_e, id: unknown): Promise<IpcResult<true>> => {
      if (typeof id !== 'string') return err('invalid id')
      // Same hung-adapter resilience as archive: don't await dispose on the
      // critical path. The runtime tear-down is bounded by its own timeout
      // (see AcpRuntime.dispose) and runs in the background.
      conversationRepo.delete(id)
      void conversationEngine.dispose(id).catch((e) =>
        console.error('[delete] dispose failed for', id, e)
      )
      recordDesktopPresence(id, 'delete')
      return ok(true)
    }
  )

  ipcMain.handle(
    IPC.ConversationsArchive,
    async (_e, id: unknown): Promise<IpcResult<true>> => {
      if (typeof id !== 'string') return err('invalid id')
      // Persist the archive FIRST. Archiving is a pure DB flag flip — it
      // does not depend on the runtime being torn down. If we awaited
      // dispose here and the agent was stuck (e.g. Hermes hanging on a
      // permission request with no UI to grant), the renderer would just
      // see the archive button do nothing.
      conversationRepo.archive(id)
      // Best-effort runtime cleanup, fired-and-forgotten so a stuck adapter
      // can't block the UI. dispose() itself is bounded by a timeout now.
      void conversationEngine.dispose(id).catch((e) =>
        console.error('[archive] dispose failed for', id, e)
      )
      recordDesktopPresence(id, 'archive')
      return ok(true)
    }
  )

  ipcMain.handle(
    IPC.ConversationsUnarchive,
    (_e, id: unknown): IpcResult<true> => {
      if (typeof id !== 'string') return err('invalid id')
      conversationRepo.unarchive(id)
      recordDesktopPresence(id, 'unarchive')
      return ok(true)
    }
  )

  ipcMain.handle(
    IPC.ConversationsSendUserMessage,
    async (
      _e,
      conversationId: unknown,
      text: unknown,
      target: unknown,
      attachments: unknown
    ): Promise<IpcResult<true>> => {
      if (typeof conversationId !== 'string') return err('invalid conversationId')
      if (typeof text !== 'string') return err('invalid text')
      // Validate attachments: array of { data: base64, mimeType }. Drop
      // anything malformed silently so a stray paste doesn't bork the call.
      const cleanAttachments: { data: string; mimeType: string }[] = []
      if (Array.isArray(attachments)) {
        for (const a of attachments) {
          if (
            a &&
            typeof a === 'object' &&
            typeof (a as { data?: unknown }).data === 'string' &&
            typeof (a as { mimeType?: unknown }).mimeType === 'string'
          ) {
            cleanAttachments.push({
              data: (a as { data: string }).data,
              mimeType: (a as { mimeType: string }).mimeType
            })
          }
        }
      }
      // Either text or attachments — both empty is "nothing to send".
      if (!text.trim() && cleanAttachments.length === 0) return err('empty message')
      const side = isSide(target) ? target : undefined
      try {
        await conversationEngine.sendUserMessage(
          conversationId,
          text,
          side,
          cleanAttachments
        )
        recordDesktopPresence(conversationId, 'send-message')
        return ok(true)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  ipcMain.handle(
    IPC.ConversationsCancel,
    async (_e, id: unknown): Promise<IpcResult<true>> => {
      if (typeof id !== 'string') return err('invalid id')
      await conversationEngine.cancel(id)
      recordDesktopPresence(id, 'cancel')
      return ok(true)
    }
  )

  ipcMain.handle(
    IPC.ConversationsSetAutopilot,
    async (_e, id: unknown, value: unknown): Promise<IpcResult<true>> => {
      if (typeof id !== 'string') return err('invalid id')
      if (typeof value !== 'boolean') return err('invalid value')
      await conversationEngine.setAutopilot(id, value)
      recordDesktopPresence(id, 'autopilot')
      return ok(true)
    }
  )

  ipcMain.handle(
    IPC.ConversationsSetPrimarySide,
    async (_e, id: unknown, side: unknown): Promise<IpcResult<true>> => {
      if (typeof id !== 'string') return err('invalid id')
      if (!isSide(side)) return err('invalid side')
      await conversationEngine.setPrimarySide(id, side)
      recordDesktopPresence(id, 'primary-side')
      return ok(true)
    }
  )

  // --- Schedules (timed automation) --------------------------------------
  ipcMain.handle(
    IPC.SchedulesListByConversation,
    async (_e, conversationId: unknown): Promise<IpcResult<Schedule[]>> => {
      if (typeof conversationId !== 'string') return err('invalid conversationId')
      return ok(scheduleRepo.listByConversation(conversationId))
    }
  )

  ipcMain.handle(
    IPC.SchedulesCreate,
    async (_e, input: unknown): Promise<IpcResult<Schedule>> => {
      if (!input || typeof input !== 'object') return err('invalid input')
      const i = input as {
        conversationId?: unknown
        name?: unknown
        trigger?: unknown
        prompt?: unknown
      }
      if (typeof i.conversationId !== 'string') return err('invalid conversationId')
      if (!conversationRepo.get(i.conversationId)) return err('conversation not found')
      if (typeof i.prompt !== 'string' || !i.prompt.trim()) return err('empty prompt')
      const trigger = parseTrigger(i.trigger)
      if (!trigger) return err('invalid trigger (interval ≥ 60000ms or valid 5-field cron)')
      const name = typeof i.name === 'string' && i.name.trim() ? i.name.trim() : '定时任务'
      try {
        return ok(
          createSchedule({
            conversationId: i.conversationId,
            name,
            trigger,
            prompt: i.prompt.trim()
          })
        )
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  ipcMain.handle(
    IPC.SchedulesUpdate,
    async (_e, id: unknown, patch: unknown): Promise<IpcResult<true>> => {
      if (typeof id !== 'string') return err('invalid id')
      if (!patch || typeof patch !== 'object') return err('invalid patch')
      const p = patch as {
        name?: unknown
        trigger?: unknown
        prompt?: unknown
        enabled?: unknown
      }
      const clean: {
        name?: string
        trigger?: ScheduleTrigger
        prompt?: string
        enabled?: boolean
      } = {}
      if (p.name !== undefined) {
        if (typeof p.name !== 'string') return err('invalid name')
        clean.name = p.name.trim()
      }
      if (p.prompt !== undefined) {
        if (typeof p.prompt !== 'string' || !p.prompt.trim()) return err('empty prompt')
        clean.prompt = p.prompt.trim()
      }
      if (p.enabled !== undefined) {
        if (typeof p.enabled !== 'boolean') return err('invalid enabled')
        clean.enabled = p.enabled
      }
      if (p.trigger !== undefined) {
        const trigger = parseTrigger(p.trigger)
        if (!trigger) return err('invalid trigger')
        clean.trigger = trigger
      }
      try {
        updateSchedule(id, clean)
        return ok(true)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  ipcMain.handle(
    IPC.SchedulesDelete,
    async (_e, id: unknown): Promise<IpcResult<true>> => {
      if (typeof id !== 'string') return err('invalid id')
      scheduleRepo.delete(id)
      return ok(true)
    }
  )

  // --- Assistant ----------------------------------------------------------
  ipcMain.handle(
    IPC.AssistantSendMessage,
    async (
      _e,
      text: unknown,
      attachments: unknown
    ): Promise<IpcResult<AssistantTurn>> => {
      if (typeof text !== 'string' || !text.trim()) return err('empty message')
      // Validate at the boundary: only keep well-formed image attachments so a
      // malformed entry never reaches ACP as { data: undefined }.
      const atts = (Array.isArray(attachments) ? attachments : []).filter(
        (a): a is { data: string; mimeType: string } =>
          !!a &&
          typeof a === 'object' &&
          typeof (a as { data?: unknown }).data === 'string' &&
          typeof (a as { mimeType?: unknown }).mimeType === 'string'
      )
      const clean = text.trim()
      // Persist the user turn up front so it lands in the thread (and survives a
      // restart) the instant it's sent, ahead of the brain's reply. The brain's
      // own outputs are persisted below once the turn settles.
      persistUserMessage(assistantMessageRepo, clean)
      try {
        const turn = await getAssistantBrain().think({
          kind: 'user-message',
          text: clean,
          attachments: atts
        })
        // Persist the brain's visible outputs as the single writer. REPORTs are
        // already persisted by the assistantBus subscription (they fire mid-turn
        // through reportToUser), so we skip them here to avoid a double row.
        persistTurnOutputs(assistantMessageRepo, turn)
        return ok(turn)
      } catch (e) {
        const msg = (e as Error).message
        // Persist the failure too. The user row was already written up front, so
        // without this a failed turn leaves a dangling question across a restart
        // (the renderer shows the error live, but it's not in the saved thread).
        persistErrorMessage(assistantMessageRepo, msg)
        return err(`助理处理失败：${msg}`)
      }
    }
  )

  ipcMain.handle(
    IPC.AssistantResetSession,
    async (): Promise<IpcResult<true>> => {
      // /new — drop the brain's cached ACP session so the next turn respawns a
      // fresh adapter and re-sends the delegator system prompt. The singleton
      // brain otherwise keeps one long-lived session across mode toggles.
      try {
        await getAssistantBrain().dispose()
        // /new also wipes the persisted thread so the panel hydrates empty —
        // the visible history must reset alongside the brain's context.
        try {
          assistantMessageRepo.clear()
        } catch (e) {
          console.error('[ipc] clear assistant messages failed:', (e as Error).message)
        }
        return ok(true)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  ipcMain.handle(
    IPC.AssistantCancel,
    async (): Promise<IpcResult<true>> => {
      try {
        await getAssistantBrain().cancel()
        return ok(true)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  ipcMain.handle(
    IPC.AssistantListMemories,
    (_e, limit: unknown): IpcResult<AssistantMemory[]> => {
      const n = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 50
      return ok(getMemoryService().list({ limit: n }))
    }
  )

  ipcMain.handle(
    IPC.AssistantPinMemory,
    async (_e, id: unknown, pinned: unknown): Promise<IpcResult<true>> => {
      if (typeof id !== 'string') return err('invalid memory id')
      if (typeof pinned !== 'boolean') return err('invalid pinned flag')
      try {
        await getMemoryService().update(id, { pinned })
        return ok(true)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  ipcMain.handle(
    IPC.AssistantForgetMemory,
    (_e, id: unknown): IpcResult<true> => {
      if (typeof id !== 'string') return err('invalid memory id')
      try {
        getMemoryService().forget(id)
        return ok(true)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  ipcMain.handle(
    IPC.AssistantAddMemory,
    async (_e, kind: unknown, content: unknown): Promise<IpcResult<AssistantMemory>> => {
      const text = typeof content === 'string' ? content.trim() : ''
      if (!text) return err('empty memory content')
      if (!isMemoryKind(kind)) return err('invalid memory kind')
      try {
        // User-authored memories are pinned (never auto-pruned) and full
        // confidence — the user asserted them directly.
        const m = await getMemoryService().remember({
          kind,
          content: text,
          source: 'manual',
          confidence: 1,
          pinned: true
        })
        return ok(m)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  ipcMain.handle(
    IPC.AssistantListMessages,
    (_e, limit: unknown): IpcResult<AssistantMessageRecord[]> => {
      const n = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 500
      try {
        return ok(assistantMessageRepo.list(n))
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  ipcMain.handle(
    IPC.AssistantMarkReportsRead,
    (): IpcResult<true> => {
      try {
        assistantMessageRepo.markReportsRead()
        return ok(true)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  ipcMain.handle(
    IPC.AssistantCountUnreadReports,
    (): IpcResult<number> => {
      try {
        return ok(assistantMessageRepo.countUnreadReports())
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  // Editable persona (SOUL.md). The brain reads it fresh each turn; the UI lets
  // the user shape its tone/character. A missing file reads as '' (no persona).
  ipcMain.handle(
    IPC.AssistantGetSoul,
    async (): Promise<IpcResult<string>> => {
      try {
        return ok(await readFile(getSoulPath(), 'utf-8'))
      } catch {
        return ok('')
      }
    }
  )

  ipcMain.handle(
    IPC.AssistantSetSoul,
    async (_e, content: string): Promise<IpcResult<true>> => {
      try {
        ensureCloxdeDir()
        await writeFile(getSoulPath(), String(content ?? ''), 'utf-8')
        return ok(true)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  // --- WeChat Channel -----------------------------------------------------
  ipcMain.handle(
    IPC.WeChatStartLogin,
    async (): Promise<IpcResult<{ qrcodeUrl: string }>> => {
      try {
        const { qrcodeUrl, loginPromise } = await wechatChannel.startLogin()
        loginPromise.catch((e) => {
          console.error('[ipc] wechat login failed:', e)
        })
        return ok({ qrcodeUrl })
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  ipcMain.handle(
    IPC.WeChatGetStatus,
    (): IpcResult<{ loggedIn: boolean; accountId: string | null }> => {
      try {
        return ok(wechatChannel.getStatus())
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  ipcMain.handle(
    IPC.WeChatLogout,
    (): IpcResult<true> => {
      try {
        wechatChannel.logout()
        return ok(true)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  // --- Filesystem inspector ----------------------------------------------
  ipcMain.handle(
    IPC.FsListDir,
    async (
      _e,
      projectId: unknown,
      relPath: unknown
    ): Promise<IpcResult<DirEntry[]>> => {
      if (typeof projectId !== 'string') return err('invalid projectId')
      if (typeof relPath !== 'string') return err('invalid path')
      const project = projectRepo.get(projectId)
      if (!project) return err('project not found')
      // Start the watcher lazily on first list, so we don't spend resources
      // watching projects the user never inspects.
      ensureWatch(project.id, project.rootDir, () => {
        broadcast(IPC.FsChangedEvent, { projectId: project.id })
      })
      return listDir(project, relPath)
    }
  )

  ipcMain.handle(
    IPC.FsOpenPath,
    async (_e, projectId: unknown, relPath: unknown): Promise<IpcResult<true>> => {
      if (typeof projectId !== 'string') return err('invalid projectId')
      if (typeof relPath !== 'string') return err('invalid path')
      const project = projectRepo.get(projectId)
      if (!project) return err('project not found')
      return openPath(project, relPath)
    }
  )

  ipcMain.handle(
    IPC.FsListFiles,
    async (_e, projectId: unknown): Promise<IpcResult<string[]>> => {
      if (typeof projectId !== 'string') return err('invalid projectId')
      const project = projectRepo.get(projectId)
      if (!project) return err('project not found')
      return listProjectFiles(project)
    }
  )

  ipcMain.handle(
    IPC.FsGitStatus,
    async (_e, projectId: unknown): Promise<IpcResult<GitStatus>> => {
      if (typeof projectId !== 'string') return err('invalid projectId')
      const project = projectRepo.get(projectId)
      if (!project) return err('project not found')
      return gitStatus(project.rootDir)
    }
  )

  ipcMain.handle(
    IPC.FsGitDiff,
    async (_e, projectId: unknown, relPath: unknown): Promise<IpcResult<string>> => {
      if (typeof projectId !== 'string') return err('invalid projectId')
      if (typeof relPath !== 'string') return err('invalid path')
      const project = projectRepo.get(projectId)
      if (!project) return err('project not found')
      return gitDiffFile(project.rootDir, relPath)
    }
  )

  // --- LAN companion server ---------------------------------------------
  ipcMain.handle(IPC.ServerGetStatus, () => ok(getServerStatus()))
  ipcMain.handle(IPC.ServerRotatePin, () => ok(rotatePin()))
  ipcMain.handle(IPC.ServerListDevices, () => ok(listTokens()))
  ipcMain.handle(IPC.ServerRevokeDevice, (_e, token: unknown): IpcResult<true> => {
    if (typeof token !== 'string') return err('invalid token')
    revokeToken(token)
    return ok(true)
  })
  ipcMain.handle(IPC.ServerRevokeAllDevices, (): IpcResult<true> => {
    revokeAll()
    return ok(true)
  })
}
