// Renderer-side ambient declarations.
// Mirror the surface of src/preload/index.ts structurally so the renderer's
// tsconfig (web) doesn't need to include the preload sources (node).

import type {
  AgentKind,
  AgentProfile,
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
} from '@shared/types'

type Unsubscribe = () => void

interface CloXdeApi {
  platform: 'win32' | 'darwin' | 'linux' | string
  app: {
    getVersion: () => Promise<IpcResult<string>>
  }
  dialog: {
    pickDir: (opts?: {
      defaultPath?: string
      title?: string
    }) => Promise<IpcResult<string | null>>
  }
  projects: {
    list: () => Promise<IpcResult<Project[]>>
    listArchived: () => Promise<IpcResult<Project[]>>
    pickDir: () => Promise<IpcResult<string | null>>
    create: (rootDir: string) => Promise<IpcResult<Project>>
    open: (id: string) => Promise<IpcResult<true>>
    archive: (id: string) => Promise<IpcResult<true>>
    unarchive: (id: string) => Promise<IpcResult<true>>
    delete: (id: string) => Promise<IpcResult<true>>
  }
  profiles: {
    listByProject: (projectId: string) => Promise<IpcResult<AgentProfile[]>>
    upsert: (input: {
      projectId: string
      kind: AgentKind
      name?: string
      command?: string | null
      args?: string[]
      env?: Record<string, string>
    }) => Promise<IpcResult<AgentProfile>>
  }
  conversations: {
    listByProject: (projectId: string) => Promise<IpcResult<Conversation[]>>
    listArchivedByProject: (projectId: string) => Promise<IpcResult<Conversation[]>>
    create: (input: {
      projectId: string
      title?: string
      withPm?: boolean
      pmKind?: AgentKind
      architectKind?: AgentKind
      executorKind?: AgentKind
      parentIds?: string[]
      summaryOverride?: string
    }) => Promise<IpcResult<ConversationView>>
    previewInheritedSummary: (parentIds: string[]) => Promise<IpcResult<string>>
    get: (id: string) => Promise<IpcResult<ConversationView | null>>
    delete: (id: string) => Promise<IpcResult<true>>
    archive: (id: string) => Promise<IpcResult<true>>
    unarchive: (id: string) => Promise<IpcResult<true>>
    sendUserMessage: (
      conversationId: string,
      text: string,
      target?: Side,
      attachments?: { data: string; mimeType: string }[]
    ) => Promise<IpcResult<true>>
    cancel: (id: string) => Promise<IpcResult<true>>
    setAutopilot: (id: string, value: boolean) => Promise<IpcResult<true>>
    setPrimarySide: (id: string, side: Side) => Promise<IpcResult<true>>
    onUpdated: (cb: (view: ConversationView) => void) => Unsubscribe
    onMessageAppended: (
      cb: (payload: { conversationId: string; message: Message }) => void
    ) => Unsubscribe
    onMessagePatched: (
      cb: (payload: {
        conversationId: string
        messageId: string
        patch: Partial<Message>
      }) => void
    ) => Unsubscribe
  }
  fs: {
    listDir: (projectId: string, relPath: string) => Promise<IpcResult<DirEntry[]>>
    listFiles: (projectId: string) => Promise<IpcResult<string[]>>
    openPath: (projectId: string, relPath: string) => Promise<IpcResult<true>>
    gitStatus: (projectId: string) => Promise<IpcResult<GitStatus>>
    gitDiff: (projectId: string, relPath: string) => Promise<IpcResult<string>>
    onChanged: (cb: (payload: { projectId: string }) => void) => Unsubscribe
  }
  presence: {
    onActivity: (cb: (rec: PresenceActivity) => void) => Unsubscribe
  }
  assistant: {
    sendMessage: (
      text: string,
      attachments?: { data: string; mimeType: string }[]
    ) => Promise<IpcResult<AssistantTurn>>
    resetSession: () => Promise<IpcResult<true>>
    listMemories: (limit?: number) => Promise<IpcResult<AssistantMemory[]>>
    onReport: (cb: (report: AssistantReport) => void) => Unsubscribe
  }
  schedules: {
    listByConversation: (conversationId: string) => Promise<IpcResult<Schedule[]>>
    create: (input: {
      conversationId: string
      name?: string
      trigger: ScheduleTrigger
      prompt: string
      enabled?: boolean
    }) => Promise<IpcResult<Schedule>>
    update: (
      id: string,
      patch: {
        name?: string
        trigger?: ScheduleTrigger
        prompt?: string
        enabled?: boolean
      }
    ) => Promise<IpcResult<true>>
    delete: (id: string) => Promise<IpcResult<true>>
  }
  deeplink: {
    on: (
      cb: (link:
        | { action: 'open-project'; projectId: string }
        | { action: 'open-conversation'; projectId: string; conversationId: string }
        | { action: 'fork-conversation'; projectId: string; parentId: string }
      ) => void
    ) => Unsubscribe
  }
  server: {
    getStatus: () => Promise<
      IpcResult<{
        running: boolean
        port: number
        addresses: string[]
        primary: string
        pin: string
        error: string | null
      }>
    >
    rotatePin: () => Promise<IpcResult<string>>
    listDevices: () => Promise<
      IpcResult<{ token: string; label: string; createdAt: number }[]>
    >
    revokeDevice: (token: string) => Promise<IpcResult<true>>
    revokeAll: () => Promise<IpcResult<true>>
  }
}

declare global {
  interface Window {
    api: CloXdeApi
  }
}

export {}
