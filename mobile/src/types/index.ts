// Shared domain types — kept in sync with CloXde desktop's `src/shared/types.ts`.
// IMPORTANT: when you change the desktop schema, mirror the change here.
//
// We don't symlink/import from the desktop source because the RN bundler
// doesn't follow path-aliases that live in a sibling tsconfig, and the
// upstream file uses `@shared/...` imports we don't want to resolve here.

export type AgentKind = 'claude' | 'codex' | 'hermes'

/** A role within a conversation. */
export type Role = 'pm' | 'architect' | 'executor'

/** Legacy alias for "architect or executor" specifically. */
export type Side = 'architect' | 'executor'

export interface Project {
  id: string
  name: string
  rootDir: string
  defaultArchitect: AgentKind
  defaultExecutor: AgentKind
  createdAt: number
  lastOpenedAt: number
  archivedAt?: number
}

export interface AgentProfile {
  id: string
  projectId: string
  kind: AgentKind
  name: string
  command: string | null
  args: string[]
  env: Record<string, string>
  createdAt: number
  updatedAt: number
}

export type TaskStatus =
  | 'briefing'
  | 'planning'
  | 'executing'
  | 'review'
  | 'done'
  | 'failed'

export interface PlanStep {
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'skipped'
}

export interface Task {
  id: string
  conversationId: string
  brief: string
  status: TaskStatus
  owner: Role
  plan?: PlanStep[]
  result?: string
  failureReason?: string
  createdAt: number
  updatedAt: number
}

export type ConversationStatus =
  | 'idle'
  | 'thinking'
  | 'awaiting-user'
  | 'paused'
  | 'ended'

export interface Conversation {
  id: string
  projectId: string
  title?: string
  pmProfileId?: string
  architectProfileId: string
  executorProfileId: string
  primarySide: Side
  status: ConversationStatus
  autopilot: boolean
  maxAutoTurns: number
  autoTurnsUsed: number
  pmAcpSessionId?: string
  architectAcpSessionId?: string
  executorAcpSessionId?: string
  parentIds: string[]
  inheritedSummary?: string
  activeTaskId?: string
  createdAt: number
  endedAt?: number
  archivedAt?: number
}

export interface PlanEntry {
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
  content: string
}

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | {
      type: 'tool_call'
      toolCallId: string
      title: string
      kind: string
      status: ToolCallStatus
      locations?: string[]
      rawInput?: unknown
      output?: string
    }
  | { type: 'plan'; entries: PlanEntry[] }
  | {
      type: 'permission_request'
      toolCallId: string
      title: string
      options: { id: string; label: string; kind: 'allow' | 'reject' }[]
      chosenOptionId?: string
    }
  | {
      type: 'image'
      data: string
      mimeType: string
    }

export type MessageSide = 'user' | 'system' | Role
export type MessageRole = 'user' | 'assistant' | 'system'

export interface Message {
  id: string
  conversationId: string
  side: MessageSide
  role: MessageRole
  blocks: MessageBlock[]
  forwardedFromMessageId?: string
  stopReason?:
    | 'end_turn'
    | 'cancelled'
    | 'max_tokens'
    | 'refusal'
    | 'max_turn_requests'
    | 'unknown'
  ts: number
}

export interface ConversationView extends Conversation {
  pm?: AgentProfile
  architect: AgentProfile
  executor: AgentProfile
  messages: Message[]
  busySide?: Role | null
  activeTask?: Task
}

export interface IpcOk<T> { ok: true; data: T }
export interface IpcErr { ok: false; error: string }
export type IpcResult<T> = IpcOk<T> | IpcErr

export interface DirEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size?: number
  mtime?: number
}

/** In-app file preview (tablet doesn't shell-open files on the desktop). */
export interface FilePreview {
  path: string
  size: number
  mtime: number
  kind: 'text' | 'binary' | 'image'
  text?: string
  truncated?: boolean
  truncatedAt?: number
  image?: { data: string; mimeType: string }
}

/** One entry in the project's git working-tree status. Repo-relative paths. */
export interface GitChange {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  oldPath?: string
}

/** Result of inspecting a project's git state for the changes panel. */
export interface GitStatus {
  isRepo: boolean
  changes: GitChange[]
}

// --- Cross-client presence ------------------------------------------------

export interface PresenceClientId {
  kind: 'desktop' | 'tablet'
  label: string
}
export type PresenceActivityKind =
  | 'send-message'
  | 'cancel'
  | 'autopilot'
  | 'primary-side'
  | 'archive'
  | 'unarchive'
  | 'delete'
  | 'create'
export interface PresenceActivity {
  conversationId: string
  client: PresenceClientId
  kind: PresenceActivityKind
  ts: number
}

// --- Mobile-specific connection state -------------------------------------

export interface ServerConnection {
  /** http://192.168.1.10:7878 */
  baseUrl: string
  /** Bearer token issued at pairing time. */
  token: string
  /** Friendly label the user picked when pairing. */
  label: string
  /** Last known reachability state. */
  lastSeenAt?: number
}
