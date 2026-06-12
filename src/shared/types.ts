// Shared domain types between main and renderer.
// Keep this file pure (no Node / DOM imports) so it works on both sides.

export type AgentKind = 'claude' | 'codex' | 'hermes'

/** A role within a conversation. The legacy 2-agent mode only uses
 *  `architect` and `executor`; the 3-agent mode introduces `pm` as the
 *  user's stable conversational partner. */
export type Role = 'pm' | 'architect' | 'executor'

/** Legacy alias — `Side` used to be the only role concept. Keep it around
 *  for places that still mean "architect or executor" specifically (auto
 *  pair toggles, primarySide on legacy conversations, …). For new code
 *  prefer `Role`. */
export type Side = 'architect' | 'executor'

export interface Project {
  id: string
  name: string
  rootDir: string
  defaultArchitect: AgentKind
  defaultExecutor: AgentKind
  createdAt: number
  lastOpenedAt: number
  /** Soft-archive timestamp. Archived projects are hidden from the main
   *  sidebar and shown in a dedicated dialog. Same UX pattern as
   *  Conversation.archivedAt. */
  archivedAt?: number
}

// --- Agent profiles --------------------------------------------------------
//
// A project owns one AgentProfile per AgentKind (claude / codex). The profile
// is where ccswitch / API base url / model overrides live: anything that
// would otherwise need to be set in the shell environment.

export interface AgentProfile {
  id: string
  projectId: string
  kind: AgentKind
  /** Display name; defaults to the kind. */
  name: string
  /** Override the adapter command (default: bundled `npx` invocation). */
  command: string | null
  /** Extra args appended after defaults. */
  args: string[]
  /** Environment variables merged onto the Electron process env at spawn. */
  env: Record<string, string>
  createdAt: number
  updatedAt: number
}

// --- Task state machine (Path-C harness) -----------------------------------
//
// Each 3-agent conversation drives at most one ACTIVE task at a time. The
// engine routes turns based on the task's (status, owner) — not by scanning
// the last assistant message for tags. Permission gating is enforced per
// (status, role) so the architect can't bypass DELEGATE just by calling
// Edit/Write themselves: CloXde rejects the tool call at the ACP layer.
//
// Legacy 2-agent conversations have no active task; the engine still falls
// back to the old tag-based flow for them.

export type TaskStatus =
  | 'briefing'      // PM is gathering requirements from the user
  | 'planning'      // architect is analyzing (read-only)
  | 'executing'    // executor has full tool access, doing the work
  | 'review'       // architect is auditing the executor's report
  | 'done'         // PM summarizes back to user
  | 'failed'       // someone declared FAIL; PM tells user

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
  planIterations: number
  reviewCycles: number
}

// --- Conversations (A2A sessions) ------------------------------------------

export type ConversationStatus =
  | 'idle'
  | 'thinking' // some side is mid-turn
  | 'awaiting-user' // last turn ended, waiting for user / autopilot decision
  | 'paused'
  | 'ended'

export interface Conversation {
  id: string
  projectId: string
  title?: string
  /** When set, this conversation runs in 3-agent (PM) mode — the user talks
   *  to PM, who dispatches to the architect+executor team. NULL = legacy
   *  2-agent mode (user talks directly to architect). */
  pmProfileId?: string
  /** Which AgentProfile drives the architect side. */
  architectProfileId: string
  /** Which AgentProfile drives the executor side. */
  executorProfileId: string
  /** User input defaults to this side. In 3-agent mode this is ignored
   *  (input always goes to PM). */
  primarySide: Side
  status: ConversationStatus
  /** Auto-forward end_turn between sides until either disables it. */
  autopilot: boolean
  /** Cap to keep infinite ping-pongs in check. */
  maxAutoTurns: number
  /** Live counter of auto-forwarded turns since last user input. */
  autoTurnsUsed: number
  /** ACP session ids — persisted so we can call `session/load` on restart
   *  and recover the agent's own conversation context. */
  pmAcpSessionId?: string
  architectAcpSessionId?: string
  executorAcpSessionId?: string
  /** "继承自" — parent conversation ids whose summaries got injected as
   *  this conversation's seed. Many-to-many via `conversation_parents`. */
  parentIds: string[]
  /** Rendered summary that was injected as a system message when this
   *  conversation was created. Persisted so the UI can re-display the
   *  inheritance context without re-extracting it every time. Empty when
   *  the conversation has no parents. */
  inheritedSummary?: string
  /** Path-C: id of the currently active task driving this conversation,
   *  if any. NULL = legacy free-form mode (engine falls back to tag scan). */
  activeTaskId?: string
  /** How many times the assistant has sent CONTINUE to this stuck team. Reset when
   *  the team unsticks or the user intervenes. Used to avoid infinite retry loops. */
  assistantNudgeCount: number
  createdAt: number
  endedAt?: number
  archivedAt?: number
}

// --- Schedules (timed automation) ------------------------------------------
//
// A schedule fires on a timer and injects a canned message into an existing
// conversation (as if the user typed it), letting the team run autonomously
// on a cadence. Two trigger kinds:
//   • interval — every N milliseconds since the last fire
//   • cron     — a 5-field cron expression (min hour dom mon dow), local time
//
// The scheduler lives in the main process and survives restarts via the DB;
// nextFireAt is recomputed on load so a schedule that was due while the app
// was closed fires once on the next tick rather than backfilling every miss.

export type ScheduleTrigger =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'cron'; expr: string }

export interface Schedule {
  id: string
  conversationId: string
  /** Human label shown in the UI list. */
  name: string
  trigger: ScheduleTrigger
  /** The message injected into the conversation (sent to PM) when it fires. */
  prompt: string
  enabled: boolean
  /** Epoch ms of the next scheduled fire, recomputed after each fire/load. */
  nextFireAt: number
  /** Epoch ms of the last successful fire, null until first run. */
  lastFiredAt?: number
  createdAt: number
  updatedAt: number
}

// --- Assistant memory ------------------------------------------------------
//
// The assistant's long-term, user-scoped memory — distinct from per-
// conversation history. The assistant distills these autonomously (the user
// does not hand-feed them) and recalls them by semantic similarity at
// decision time. Stored in better-sqlite3 with embeddings in a sqlite-vec
// vec0 table; see migration v11.

export type MemoryKind =
  | 'preference' // how the user likes things done
  | 'fact' // stable truths about the user / their world
  | 'project' // ongoing initiatives, goals, deadlines
  | 'person' // people in the user's orbit
  | 'pattern' // recurring behaviours / routines worth anticipating
  | 'episodic' // notable one-off events, for later recall
  | 'skill' // procedural know-how: a reusable way to accomplish a task

export interface AssistantMemory {
  /** External (string) id used across IPC, matching the app's uuid style. */
  id: string
  kind: MemoryKind
  content: string
  /** Provenance, e.g. 'distilled:<conversationId>' | 'manual' | 'observed'. */
  source?: string
  /** 0..1 — how strongly the assistant trusts this; drives decay/pruning. */
  confidence: number
  /** User-pinned memories are never auto-pruned. */
  pinned: boolean
  createdAt: number
  updatedAt: number
  /** Epoch ms this memory was last recalled; null until first use. */
  lastUsedAt?: number
}

/** A memory returned from semantic recall, with its distance to the query. */
export interface MemoryHit extends AssistantMemory {
  /** vec0 L2 distance — smaller is closer. */
  distance: number
}

/** A proactive note the assistant surfaces to the user (e.g. a review-pass
 *  finding). Pushed over AssistantReportEvent. */
export interface AssistantReport {
  ts: number
  message: string
  projectId?: string
  conversationId?: string
}

export type AssistantMessageRole = 'user' | 'assistant' | 'system' | 'report'

/** A persisted line in the assistant's own conversation thread. Unlike team
 *  messages (per-conversation), these belong to the single user-scoped assistant
 *  and survive app restarts, so the管家's visible history isn't lost on quit.
 *  'report' rows carry the unread flag that drives the titlebar badge; system
 *  rows for a dispatch/continue carry the team's ids so the UI can link to it. */
export interface AssistantMessageRecord {
  id: string
  role: AssistantMessageRole
  text: string
  /** Set on report / dispatch / continue rows so the UI can jump to the team. */
  projectId?: string
  conversationId?: string
  /** Only meaningful for 'report' rows — false until the user has seen it. */
  read: boolean
  ts: number
}

/** Live progress of an in-flight assistant turn, streamed so the UI can show
 *  the brain is actually working (thinking / using a tool / blocked) instead of
 *  a dead "thinking…" spinner. Pushed over AssistantActivityEvent. */
export interface AssistantActivity {
  phase: 'start' | 'thought' | 'tool' | 'blocked' | 'done' | 'error'
  /** Human-readable detail for thought/tool/blocked/error phases. */
  text?: string
  ts: number
}

/** The outcome of one assistant turn (a user message handled by the brain):
 *  what it said and what it did. */
export interface AssistantTurn {
  /** The brain's full text reply (tags stripped of meaning, shown as-is). */
  raw: string
  /** Teams it dispatched this turn. */
  dispatched: { name: string; projectId: string; conversationId: string }[]
  /** Existing teams it sent a follow-up message to this turn. */
  continued: { name: string; projectId: string; conversationId: string }[]
  /** How many memories it wrote. */
  remembered: number
  /** How many memories it retracted (now-false / superseded). */
  forgotten: number
  /** How many memories it rewrote in place (e.g. a skill improved in use). */
  updated: number
  /** How many self-reminders it set this turn (wake-me-later / recurring). */
  scheduled: number
  /** Messages it addressed to the user. */
  reports: string[]
}

/** A reminder the assistant set FOR ITSELF — a future wake-up carrying a note it
 *  wrote. Distinct from a Schedule (which injects a prompt into a team
 *  conversation): a reminder wakes the BRAIN with a 'cron' signal. One-shot when
 *  `cron` is absent; recurring (and `fireAt` recomputed after each fire) when set. */
export interface AssistantReminder {
  id: string
  /** Epoch ms of the next fire. */
  fireAt: number
  /** What the brain told itself to do/check when this fires. */
  note: string
  /** 5-field cron expr for a recurring reminder; absent = fire once then delete. */
  cron?: string
  createdAt: number
}

// --- Messages --------------------------------------------------------------

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
      /** ACP tool kind: edit | read | execute | search | think | fetch | other */
      kind: string
      status: ToolCallStatus
      /** File paths the tool touched, for nicer UI hints. */
      locations?: string[]
      rawInput?: unknown
      /** Stringified output once done — kept short; full content in detail view. */
      output?: string
    }
  | { type: 'plan'; entries: PlanEntry[] }
  | {
      type: 'permission_request'
      toolCallId: string
      title: string
      options: { id: string; label: string; kind: 'allow' | 'reject' }[]
      /** Set once user (or auto-policy) responds. */
      chosenOptionId?: string
    }
  | {
      /** Inline image attachment — user-pasted screenshot, drag-dropped image,
       *  or future image output from an agent. `data` is base64 with no data:
       *  URL prefix; combine with `mimeType` to render or forward to ACP. */
      type: 'image'
      data: string
      mimeType: string
    }

/** Per-turn metrics, attached to an assistant message once its turn settles.
 *  Sourced from the ACP PromptResponse.usage (experimental — may be absent on
 *  adapters that don't report it) plus an engine-measured wall-clock duration.
 *  All fields optional: a turn may report time without tokens, or vice versa. */
export interface TurnMetrics {
  /** Wall-clock from prompt dispatch to turn settle, in milliseconds. */
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** Cache read tokens, if the adapter distinguishes them. */
  cachedTokens?: number
}

/** Where a message originated — user, system, or one of the three roles. */
export type MessageSide = 'user' | 'system' | Role

/** ACP-aligned role; we keep it close to what the protocol emits. */
export type MessageRole = 'user' | 'assistant' | 'system'

export interface Message {
  id: string
  conversationId: string
  side: MessageSide
  role: MessageRole
  blocks: MessageBlock[]
  /** When this message was auto-forwarded from another side's previous reply. */
  forwardedFromMessageId?: string
  stopReason?:
    | 'end_turn'
    | 'cancelled'
    | 'max_tokens'
    | 'refusal'
    | 'max_turn_requests'
    | 'unknown'
  /** Per-turn metrics (tokens, elapsed). Populated on assistant messages
   *  when the turn settles; absent on user/system rows and older messages. */
  metrics?: TurnMetrics
  ts: number
}

/** Snapshot returned by `conversations:get`. */
export interface ConversationView extends Conversation {
  /** Present only in 3-agent mode. */
  pm?: AgentProfile
  architect: AgentProfile
  executor: AgentProfile
  messages: Message[]
  /** Runtime-only: which role is currently mid-turn, if any. Not persisted. */
  busySide?: Role | null
  /** The currently active task driving this conversation (path-C). NULL
   *  for legacy free-form conversations. */
  activeTask?: Task
}

// --- IPC envelopes ---------------------------------------------------------

export interface IpcOk<T> { ok: true; data: T }
export interface IpcErr { ok: false; error: string }
export type IpcResult<T> = IpcOk<T> | IpcErr

// --- File system browsing (project workspace inspector) --------------------

export interface DirEntry {
  name: string
  /** Path relative to the project root, forward-slash separated. */
  path: string
  kind: 'file' | 'directory'
  size?: number
  /** Modification time in ms since epoch. */
  mtime?: number
}

/** Lightweight in-app file preview returned by /api/projects/:id/fs/read.
 *  Tablets call this to view a file inline rather than asking the desktop
 *  to shell-open it on someone else's screen. */
export interface FilePreview {
  path: string
  size: number
  mtime: number
  /** Best-effort guess at how to render. `text` → renderable; `binary` →
   *  show "cannot preview" + size; `image` → render via base64 data url. */
  kind: 'text' | 'binary' | 'image'
  /** Set when kind === 'text'. UTF-8 decoded; truncated past `truncatedAt`. */
  text?: string
  /** True when the file was longer than the server's preview cap and `text`
   *  is just the head. */
  truncated?: boolean
  /** Cap that was applied (bytes), so the UI can show "前 256 KB"。 */
  truncatedAt?: number
  /** Set when kind === 'image'. Base64-encoded payload + mimeType. */
  image?: { data: string; mimeType: string }
}

/** One entry in the project's git working-tree status. Backs the "改动"
 *  (changes) panel — the list of files the agents (or anyone) modified in the
 *  repo since the last commit. Paths are repo-relative, forward-slash. */
export interface GitChange {
  path: string
  /** Coarse kind, derived from the porcelain status code. */
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  /** Original path when status === 'renamed'. */
  oldPath?: string
}

/** Result of inspecting a project's git state for the changes panel.
 *  `isRepo` false means the project root isn't a git repository — the panel
 *  shows a hint instead of an empty list. */
export interface GitStatus {
  isRepo: boolean
  changes: GitChange[]
}

// --- Cross-client presence (desktop + tablets sharing one server) ----------

/** Identifies a connected client. The desktop always reports as 'desktop',
 *  paired devices as 'tablet' with a human label set during pairing. */
export interface PresenceClientId {
  kind: 'desktop' | 'tablet'
  label: string
}

/** What the user just did. UI doesn't switch on the kind today, but it's
 *  helpful in logs and lets the banner say "对方刚发了消息" vs just "在使用"。 */
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
