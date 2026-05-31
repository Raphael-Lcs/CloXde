import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  AgentKind,
  AgentProfile,
  AssistantActivity,
  AssistantMemory,
  AssistantReport,
  AssistantTurn,
  Conversation,
  ConversationView,
  DirEntry,
  GitStatus,
  IpcResult,
  Message,
  PresenceActivity,
  Project,
  Schedule,
  ScheduleTrigger,
  Side
} from '../shared/types'

type Unsubscribe = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api = {
  platform: process.platform as NodeJS.Platform,
  app: {
    getVersion: (): Promise<IpcResult<string>> => ipcRenderer.invoke(IPC.AppGetVersion)
  },
  dialog: {
    pickDir: (opts?: {
      defaultPath?: string
      title?: string
    }): Promise<IpcResult<string | null>> => ipcRenderer.invoke(IPC.PickDir, opts ?? {})
  },
  projects: {
    list: (): Promise<IpcResult<Project[]>> => ipcRenderer.invoke(IPC.ProjectsList),
    listArchived: (): Promise<IpcResult<Project[]>> =>
      ipcRenderer.invoke(IPC.ProjectsListArchived),
    pickDir: (): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke(IPC.ProjectsPickDir),
    create: (rootDir: string): Promise<IpcResult<Project>> =>
      ipcRenderer.invoke(IPC.ProjectsCreate, rootDir),
    open: (id: string): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(IPC.ProjectsOpen, id),
    archive: (id: string): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(IPC.ProjectsArchive, id),
    unarchive: (id: string): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(IPC.ProjectsUnarchive, id),
    delete: (id: string): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(IPC.ProjectsDelete, id)
  },
  profiles: {
    listByProject: (projectId: string): Promise<IpcResult<AgentProfile[]>> =>
      ipcRenderer.invoke(IPC.ProfilesListByProject, projectId),
    upsert: (input: {
      projectId: string
      kind: AgentKind
      name?: string
      command?: string | null
      args?: string[]
      env?: Record<string, string>
    }): Promise<IpcResult<AgentProfile>> =>
      ipcRenderer.invoke(IPC.ProfilesUpsert, input)
  },
  conversations: {
    listByProject: (projectId: string): Promise<IpcResult<Conversation[]>> =>
      ipcRenderer.invoke(IPC.ConversationsListByProject, projectId),
    listArchivedByProject: (projectId: string): Promise<IpcResult<Conversation[]>> =>
      ipcRenderer.invoke(IPC.ConversationsListArchivedByProject, projectId),
    create: (input: {
      projectId: string
      title?: string
      withPm?: boolean
      pmKind?: AgentKind
      architectKind?: AgentKind
      executorKind?: AgentKind
      parentIds?: string[]
      summaryOverride?: string
    }): Promise<IpcResult<ConversationView>> =>
      ipcRenderer.invoke(IPC.ConversationsCreate, input),
    previewInheritedSummary: (parentIds: string[]): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(IPC.ConversationsPreviewInheritedSummary, parentIds),
    get: (id: string): Promise<IpcResult<ConversationView | null>> =>
      ipcRenderer.invoke(IPC.ConversationsGet, id),
    delete: (id: string): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(IPC.ConversationsDelete, id),
    archive: (id: string): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(IPC.ConversationsArchive, id),
    unarchive: (id: string): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(IPC.ConversationsUnarchive, id),
    sendUserMessage: (
      conversationId: string,
      text: string,
      target?: Side,
      attachments?: { data: string; mimeType: string }[]
    ): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(
        IPC.ConversationsSendUserMessage,
        conversationId,
        text,
        target,
        attachments
      ),
    cancel: (id: string): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(IPC.ConversationsCancel, id),
    setAutopilot: (id: string, value: boolean): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(IPC.ConversationsSetAutopilot, id, value),
    setPrimarySide: (id: string, side: Side): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(IPC.ConversationsSetPrimarySide, id, side),

    onUpdated: (cb: (view: ConversationView) => void): Unsubscribe =>
      on<ConversationView>(IPC.ConversationUpdatedEvent, cb),
    onMessageAppended: (
      cb: (payload: { conversationId: string; message: Message }) => void
    ): Unsubscribe =>
      on<{ conversationId: string; message: Message }>(
        IPC.MessageAppendedEvent,
        cb
      ),
    onMessagePatched: (
      cb: (payload: {
        conversationId: string
        messageId: string
        patch: Partial<Message>
      }) => void
    ): Unsubscribe =>
      on<{ conversationId: string; messageId: string; patch: Partial<Message> }>(
        IPC.MessagePatchedEvent,
        cb
      )
  },
  /** Timed automation — interval/cron schedules that inject a prompt into an
   *  existing conversation (same path as a user message → PM). */
  schedules: {
    listByConversation: (conversationId: string): Promise<IpcResult<Schedule[]>> =>
      ipcRenderer.invoke(IPC.SchedulesListByConversation, conversationId),
    create: (input: {
      conversationId: string
      name?: string
      trigger: ScheduleTrigger
      prompt: string
      enabled?: boolean
    }): Promise<IpcResult<Schedule>> =>
      ipcRenderer.invoke(IPC.SchedulesCreate, input),
    update: (
      id: string,
      patch: {
        name?: string
        trigger?: ScheduleTrigger
        prompt?: string
        enabled?: boolean
      }
    ): Promise<IpcResult<true>> => ipcRenderer.invoke(IPC.SchedulesUpdate, id, patch),
    delete: (id: string): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(IPC.SchedulesDelete, id)
  },
  /** Cross-client presence — used by the desktop renderer to know when a
   *  paired tablet is also touching the same conversation, and vice versa. */
  presence: {
    onActivity: (cb: (rec: PresenceActivity) => void): Unsubscribe =>
      on<PresenceActivity>(IPC.PresenceActivityEvent, cb)
  },
  /** The assistant layer — the user-scoped delegator above the team. */
  assistant: {
    sendMessage: (
      text: string,
      attachments?: { data: string; mimeType: string }[]
    ): Promise<IpcResult<AssistantTurn>> =>
      ipcRenderer.invoke(IPC.AssistantSendMessage, text, attachments),
    resetSession: (): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(IPC.AssistantResetSession),
    cancel: (): Promise<IpcResult<true>> => ipcRenderer.invoke(IPC.AssistantCancel),
    listMemories: (limit?: number): Promise<IpcResult<AssistantMemory[]>> =>
      ipcRenderer.invoke(IPC.AssistantListMemories, limit),
    onReport: (cb: (report: AssistantReport) => void): Unsubscribe =>
      on<AssistantReport>(IPC.AssistantReportEvent, cb),
    onActivity: (cb: (activity: AssistantActivity) => void): Unsubscribe =>
      on<AssistantActivity>(IPC.AssistantActivityEvent, cb)
  },
  fs: {
    listDir: (projectId: string, relPath: string): Promise<IpcResult<DirEntry[]>> =>
      ipcRenderer.invoke(IPC.FsListDir, projectId, relPath),
    listFiles: (projectId: string): Promise<IpcResult<string[]>> =>
      ipcRenderer.invoke(IPC.FsListFiles, projectId),
    openPath: (projectId: string, relPath: string): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(IPC.FsOpenPath, projectId, relPath),
    gitStatus: (projectId: string): Promise<IpcResult<GitStatus>> =>
      ipcRenderer.invoke(IPC.FsGitStatus, projectId),
    gitDiff: (projectId: string, relPath: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(IPC.FsGitDiff, projectId, relPath),
    onChanged: (cb: (payload: { projectId: string }) => void): Unsubscribe =>
      on<{ projectId: string }>(IPC.FsChangedEvent, cb)
  },
  /** Deep links via `cloxde://...` URLs. Main parses, validates, and
   *  forwards them through the `deeplink` channel. */
  deeplink: {
    on: (
      cb: (link:
        | { action: 'open-project'; projectId: string }
        | { action: 'open-conversation'; projectId: string; conversationId: string }
        | { action: 'fork-conversation'; projectId: string; parentId: string }
      ) => void
    ): Unsubscribe => on('deeplink', cb)
  },
  /** LAN companion server (the Android tablet talks to this). */
  server: {
    getStatus: (): Promise<
      IpcResult<{
        running: boolean
        port: number
        addresses: string[]
        primary: string
        pin: string
        error: string | null
      }>
    > => ipcRenderer.invoke(IPC.ServerGetStatus),
    rotatePin: (): Promise<IpcResult<string>> => ipcRenderer.invoke(IPC.ServerRotatePin),
    listDevices: (): Promise<
      IpcResult<{ token: string; label: string; createdAt: number }[]>
    > => ipcRenderer.invoke(IPC.ServerListDevices),
    revokeDevice: (token: string): Promise<IpcResult<true>> =>
      ipcRenderer.invoke(IPC.ServerRevokeDevice, token),
    revokeAll: (): Promise<IpcResult<true>> => ipcRenderer.invoke(IPC.ServerRevokeAllDevices)
  }
}

export type CloXdeApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = api
}
