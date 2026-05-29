import Database from 'better-sqlite3'
import type { Database as DBType } from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  AgentKind,
  AgentProfile,
  Conversation,
  ConversationStatus,
  Message,
  MessageBlock,
  MessageRole,
  MessageSide,
  PlanStep,
  Project,
  Role,
  Side,
  Task,
  TaskStatus
} from '@shared/types'
import { getDbPath, ensureCloxdeDir } from '../paths'
import { runMigrations } from './migrations'

let db: DBType | null = null

export function initStorage(): DBType {
  if (db) return db
  ensureCloxdeDir()
  const instance = new Database(getDbPath())
  instance.pragma('journal_mode = WAL')
  instance.pragma('foreign_keys = ON')
  runMigrations(instance)
  db = instance
  return instance
}

export function getDb(): DBType {
  if (!db) throw new Error('Storage not initialized — call initStorage() first')
  return db
}

export function closeStorage(): void {
  db?.close()
  db = null
}

// --- Projects ---------------------------------------------------------------

interface ProjectRow {
  id: string
  name: string
  root_dir: string
  default_architect: string
  default_executor: string
  created_at: number
  last_opened_at: number
  archived_at: number | null
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootDir: row.root_dir,
    defaultArchitect: row.default_architect as AgentKind,
    defaultExecutor: row.default_executor as AgentKind,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    archivedAt: row.archived_at ?? undefined
  }
}

const PROJECT_COLUMNS = `id, name, root_dir, default_architect, default_executor,
  created_at, last_opened_at, archived_at`

export const projectRepo = {
  /** Active projects (archived_at IS NULL) — the default sidebar list. */
  list(): Project[] {
    return (
      getDb()
        .prepare(
          `SELECT ${PROJECT_COLUMNS}
           FROM projects WHERE archived_at IS NULL
           ORDER BY last_opened_at DESC`
        )
        .all() as ProjectRow[]
    ).map(rowToProject)
  },
  /** Archived projects, most recently archived first. */
  listArchived(): Project[] {
    return (
      getDb()
        .prepare(
          `SELECT ${PROJECT_COLUMNS}
           FROM projects WHERE archived_at IS NOT NULL
           ORDER BY archived_at DESC`
        )
        .all() as ProjectRow[]
    ).map(rowToProject)
  },
  get(id: string): Project | null {
    const row = getDb()
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`)
      .get(id) as ProjectRow | undefined
    return row ? rowToProject(row) : null
  },
  findByRoot(rootDir: string): Project | null {
    const row = getDb()
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE root_dir = ?`)
      .get(rootDir) as ProjectRow | undefined
    return row ? rowToProject(row) : null
  },
  upsertByRoot(input: { name: string; rootDir: string }): Project {
    const existing = this.findByRoot(input.rootDir)
    const now = Date.now()
    if (existing) {
      // Opening an archived project re-activates it — matches the intuition
      // that re-picking a folder means "I'm coming back to this".
      getDb()
        .prepare(
          'UPDATE projects SET last_opened_at = ?, archived_at = NULL WHERE id = ?'
        )
        .run(now, existing.id)
      return { ...existing, lastOpenedAt: now, archivedAt: undefined }
    }
    const id = randomUUID()
    getDb()
      .prepare(
        `INSERT INTO projects
           (id, name, root_dir, default_architect, default_executor,
            created_at, last_opened_at)
         VALUES (?, ?, ?, 'claude', 'codex', ?, ?)`
      )
      .run(id, input.name, input.rootDir, now, now)
    return {
      id,
      name: input.name,
      rootDir: input.rootDir,
      defaultArchitect: 'claude',
      defaultExecutor: 'codex',
      createdAt: now,
      lastOpenedAt: now
    }
  },
  touch(id: string): void {
    getDb()
      .prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?')
      .run(Date.now(), id)
  },
  /** Soft archive. Caller is responsible for cascading to conversations
   *  inside the project — that lives in the IPC handler so it can refuse
   *  the operation when a turn is in flight. */
  archive(id: string): void {
    getDb()
      .prepare('UPDATE projects SET archived_at = ? WHERE id = ?')
      .run(Date.now(), id)
  },
  unarchive(id: string): void {
    getDb()
      .prepare('UPDATE projects SET archived_at = NULL WHERE id = ?')
      .run(id)
  },
  delete(id: string): void {
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
}

// --- Agent profiles --------------------------------------------------------

interface AgentProfileRow {
  id: string
  project_id: string
  kind: string
  name: string
  command: string | null
  args_json: string
  env_json: string
  created_at: number
  updated_at: number
}

function rowToProfile(row: AgentProfileRow): AgentProfile {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as AgentKind,
    name: row.name,
    command: row.command,
    args: JSON.parse(row.args_json) as string[],
    env: JSON.parse(row.env_json) as Record<string, string>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export const profileRepo = {
  listByProject(projectId: string): AgentProfile[] {
    return (
      getDb()
        .prepare(
          `SELECT id, project_id, kind, name, command, args_json, env_json,
                  created_at, updated_at
           FROM agent_profiles WHERE project_id = ? ORDER BY kind ASC`
        )
        .all(projectId) as AgentProfileRow[]
    ).map(rowToProfile)
  },
  get(id: string): AgentProfile | null {
    const row = getDb()
      .prepare(
        `SELECT id, project_id, kind, name, command, args_json, env_json,
                created_at, updated_at
         FROM agent_profiles WHERE id = ?`
      )
      .get(id) as AgentProfileRow | undefined
    return row ? rowToProfile(row) : null
  },
  findByKind(projectId: string, kind: AgentKind): AgentProfile | null {
    const row = getDb()
      .prepare(
        `SELECT id, project_id, kind, name, command, args_json, env_json,
                created_at, updated_at
         FROM agent_profiles WHERE project_id = ? AND kind = ?`
      )
      .get(projectId, kind) as AgentProfileRow | undefined
    return row ? rowToProfile(row) : null
  },
  upsert(input: {
    projectId: string
    kind: AgentKind
    name?: string
    command?: string | null
    args?: string[]
    env?: Record<string, string>
  }): AgentProfile {
    const existing = this.findByKind(input.projectId, input.kind)
    const now = Date.now()
    if (existing) {
      const merged: AgentProfile = {
        ...existing,
        name: input.name ?? existing.name,
        command: input.command === undefined ? existing.command : input.command,
        args: input.args ?? existing.args,
        env: input.env ?? existing.env,
        updatedAt: now
      }
      getDb()
        .prepare(
          `UPDATE agent_profiles
             SET name = ?, command = ?, args_json = ?, env_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          merged.name,
          merged.command,
          JSON.stringify(merged.args),
          JSON.stringify(merged.env),
          now,
          existing.id
        )
      return merged
    }
    const id = randomUUID()
    const profile: AgentProfile = {
      id,
      projectId: input.projectId,
      kind: input.kind,
      name: input.name ?? input.kind,
      command: input.command ?? null,
      args: input.args ?? [],
      env: input.env ?? {},
      createdAt: now,
      updatedAt: now
    }
    getDb()
      .prepare(
        `INSERT INTO agent_profiles
           (id, project_id, kind, name, command, args_json, env_json,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profile.id,
        profile.projectId,
        profile.kind,
        profile.name,
        profile.command,
        JSON.stringify(profile.args),
        JSON.stringify(profile.env),
        now,
        now
      )
    return profile
  },
  /** Ensure default profiles exist for a project. Claude + Codex are the
   *  baseline pair (engineering team). Hermes is added when present — it's
   *  the recommended local "管家" PM, but only if the user has it installed. */
  ensureDefaults(projectId: string): void {
    const DEFAULT_NAMES: Record<AgentKind, string> = {
      claude: 'Claude Code',
      codex: 'Codex',
      hermes: 'Hermes'
    }
    for (const kind of ['claude', 'codex', 'hermes'] as AgentKind[]) {
      if (!this.findByKind(projectId, kind)) {
        this.upsert({ projectId, kind, name: DEFAULT_NAMES[kind] })
      }
    }
  }
}

// --- Conversations ---------------------------------------------------------

interface ConversationRow {
  id: string
  project_id: string
  title: string | null
  pm_profile_id: string | null
  architect_profile_id: string
  executor_profile_id: string
  primary_side: string
  status: string
  autopilot: number
  max_auto_turns: number
  auto_turns_used: number
  pm_acp_session_id: string | null
  architect_acp_session_id: string | null
  executor_acp_session_id: string | null
  inherited_summary: string | null
  active_task_id: string | null
  created_at: number
  ended_at: number | null
  archived_at: number | null
}

function rowToConversation(row: ConversationRow, parentIds: string[]): Conversation {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title ?? undefined,
    pmProfileId: row.pm_profile_id ?? undefined,
    architectProfileId: row.architect_profile_id,
    executorProfileId: row.executor_profile_id,
    primarySide: row.primary_side as Side,
    status: row.status as ConversationStatus,
    autopilot: row.autopilot !== 0,
    maxAutoTurns: row.max_auto_turns,
    autoTurnsUsed: row.auto_turns_used,
    pmAcpSessionId: row.pm_acp_session_id ?? undefined,
    architectAcpSessionId: row.architect_acp_session_id ?? undefined,
    executorAcpSessionId: row.executor_acp_session_id ?? undefined,
    parentIds,
    inheritedSummary: row.inherited_summary ?? undefined,
    activeTaskId: row.active_task_id ?? undefined,
    createdAt: row.created_at,
    endedAt: row.ended_at ?? undefined,
    archivedAt: row.archived_at ?? undefined
  }
}

const CONVERSATION_COLUMNS = `id, project_id, title, pm_profile_id,
  architect_profile_id, executor_profile_id,
  primary_side, status, autopilot, max_auto_turns, auto_turns_used,
  pm_acp_session_id, architect_acp_session_id, executor_acp_session_id,
  inherited_summary, active_task_id, created_at, ended_at, archived_at`

/** Bulk-load parent ids for a set of conversations, ordered by `ord` then
 *  insertion. Returns a map (childId -> parentId[]). */
function loadParentIds(childIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (childIds.length === 0) return map
  const placeholders = childIds.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT child_id, parent_id FROM conversation_parents
       WHERE child_id IN (${placeholders})
       ORDER BY ord ASC, created_at ASC`
    )
    .all(...childIds) as { child_id: string; parent_id: string }[]
  for (const r of rows) {
    const arr = map.get(r.child_id) ?? []
    arr.push(r.parent_id)
    map.set(r.child_id, arr)
  }
  return map
}

export const conversationRepo = {
  listByProject(projectId: string): Conversation[] {
    const rows = getDb()
      .prepare(
        `SELECT ${CONVERSATION_COLUMNS}
         FROM conversations
         WHERE project_id = ? AND archived_at IS NULL
         ORDER BY created_at DESC`
      )
      .all(projectId) as ConversationRow[]
    const parents = loadParentIds(rows.map((r) => r.id))
    return rows.map((r) => rowToConversation(r, parents.get(r.id) ?? []))
  },
  listArchivedByProject(projectId: string): Conversation[] {
    const rows = getDb()
      .prepare(
        `SELECT ${CONVERSATION_COLUMNS}
         FROM conversations
         WHERE project_id = ? AND archived_at IS NOT NULL
         ORDER BY archived_at DESC`
      )
      .all(projectId) as ConversationRow[]
    const parents = loadParentIds(rows.map((r) => r.id))
    return rows.map((r) => rowToConversation(r, parents.get(r.id) ?? []))
  },
  get(id: string): Conversation | null {
    const row = getDb()
      .prepare(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ?`
      )
      .get(id) as ConversationRow | undefined
    if (!row) return null
    const parents = loadParentIds([id]).get(id) ?? []
    return rowToConversation(row, parents)
  },
  create(input: {
    projectId: string
    title?: string
    pmProfileId?: string
    architectProfileId: string
    executorProfileId: string
    primarySide?: Side
    autopilot?: boolean
    maxAutoTurns?: number
    /** Parent conversations to inherit from. */
    parentIds?: string[]
    /** Pre-rendered inheritance summary (markdown). */
    inheritedSummary?: string
  }): Conversation {
    const id = randomUUID()
    const now = Date.now()
    const parentIds = input.parentIds ?? []
    const c: Conversation = {
      id,
      projectId: input.projectId,
      title: input.title,
      pmProfileId: input.pmProfileId,
      architectProfileId: input.architectProfileId,
      executorProfileId: input.executorProfileId,
      primarySide: input.primarySide ?? 'architect',
      status: 'idle',
      autopilot: input.autopilot ?? true,
      maxAutoTurns: input.maxAutoTurns ?? 200,
      autoTurnsUsed: 0,
      parentIds,
      inheritedSummary: input.inheritedSummary,
      createdAt: now
    }
    const db = getDb()
    const insertConv = db.prepare(
      `INSERT INTO conversations
         (id, project_id, title, pm_profile_id,
          architect_profile_id, executor_profile_id,
          primary_side, status, autopilot, max_auto_turns, auto_turns_used,
          inherited_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, 0, ?, ?)`
    )
    const insertParent = db.prepare(
      `INSERT INTO conversation_parents (child_id, parent_id, ord, created_at)
       VALUES (?, ?, ?, ?)`
    )
    db.transaction(() => {
      insertConv.run(
        c.id,
        c.projectId,
        c.title ?? null,
        c.pmProfileId ?? null,
        c.architectProfileId,
        c.executorProfileId,
        c.primarySide,
        c.autopilot ? 1 : 0,
        c.maxAutoTurns,
        c.inheritedSummary ?? null,
        now
      )
      parentIds.forEach((pid, i) => insertParent.run(c.id, pid, i, now))
    })()
    return c
  },
  patch(
    id: string,
    patch: {
      title?: string
      status?: ConversationStatus
      primarySide?: Side
      autopilot?: boolean
      autoTurnsUsed?: number
      pmAcpSessionId?: string | null
      architectAcpSessionId?: string | null
      executorAcpSessionId?: string | null
      activeTaskId?: string | null
      endedAt?: number | null
    }
  ): void {
    const fields: string[] = []
    const values: unknown[] = []
    if (patch.title !== undefined) { fields.push('title = ?'); values.push(patch.title) }
    if (patch.status !== undefined) { fields.push('status = ?'); values.push(patch.status) }
    if (patch.primarySide !== undefined) { fields.push('primary_side = ?'); values.push(patch.primarySide) }
    if (patch.autopilot !== undefined) { fields.push('autopilot = ?'); values.push(patch.autopilot ? 1 : 0) }
    if (patch.autoTurnsUsed !== undefined) { fields.push('auto_turns_used = ?'); values.push(patch.autoTurnsUsed) }
    if (patch.pmAcpSessionId !== undefined) { fields.push('pm_acp_session_id = ?'); values.push(patch.pmAcpSessionId) }
    if (patch.architectAcpSessionId !== undefined) { fields.push('architect_acp_session_id = ?'); values.push(patch.architectAcpSessionId) }
    if (patch.executorAcpSessionId !== undefined) { fields.push('executor_acp_session_id = ?'); values.push(patch.executorAcpSessionId) }
    if (patch.activeTaskId !== undefined) { fields.push('active_task_id = ?'); values.push(patch.activeTaskId) }
    if (patch.endedAt !== undefined) { fields.push('ended_at = ?'); values.push(patch.endedAt) }
    if (fields.length === 0) return
    values.push(id)
    getDb().prepare(`UPDATE conversations SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  },
  delete(id: string): void {
    getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id)
  },
  archive(id: string): void {
    getDb()
      .prepare('UPDATE conversations SET archived_at = ? WHERE id = ?')
      .run(Date.now(), id)
  },
  unarchive(id: string): void {
    getDb()
      .prepare('UPDATE conversations SET archived_at = NULL WHERE id = ?')
      .run(id)
  },
  /** Bulk archive every active conversation in a project. Used by the
   *  project-archive cascade — caller has already verified there's nothing
   *  in flight. Idempotent: already-archived rows aren't touched. */
  archiveAllByProject(projectId: string, ts: number = Date.now()): number {
    const info = getDb()
      .prepare(
        `UPDATE conversations SET archived_at = ?
         WHERE project_id = ? AND archived_at IS NULL`
      )
      .run(ts, projectId)
    return info.changes
  },
  /** Bulk unarchive — paired with `archiveAllByProject` for project unarchive.
   *  Returns the number of rows flipped back to active. */
  unarchiveAllByProject(projectId: string): number {
    const info = getDb()
      .prepare(
        `UPDATE conversations SET archived_at = NULL
         WHERE project_id = ? AND archived_at IS NOT NULL`
      )
      .run(projectId)
    return info.changes
  },
  /** Reverse of `archiveAllByProject(ts)` — only unarchive convs that were
   *  swept up by the project-archive cascade at exactly that timestamp.
   *  Convs the user had archived earlier (different ts) stay archived. */
  unarchiveAllByProjectAt(projectId: string, ts: number): number {
    const info = getDb()
      .prepare(
        `UPDATE conversations SET archived_at = NULL
         WHERE project_id = ? AND archived_at = ?`
      )
      .run(projectId, ts)
    return info.changes
  },
  /** Used by the project archive guard: any conversation in this project
   *  currently mid-turn (engine has a running ACP prompt)? */
  hasThinkingInProject(projectId: string): boolean {
    const row = getDb()
      .prepare(
        `SELECT 1 FROM conversations
         WHERE project_id = ? AND status = 'thinking'
         LIMIT 1`
      )
      .get(projectId) as { 1: number } | undefined
    return !!row
  }
}

// --- Messages --------------------------------------------------------------

interface MessageRow {
  id: string
  conversation_id: string
  side: string
  role: string
  blocks_json: string
  forwarded_from_message_id: string | null
  stop_reason: string | null
  ts: number
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    side: row.side as MessageSide,
    role: row.role as MessageRole,
    blocks: JSON.parse(row.blocks_json) as MessageBlock[],
    forwardedFromMessageId: row.forwarded_from_message_id ?? undefined,
    stopReason: (row.stop_reason ?? undefined) as Message['stopReason'],
    ts: row.ts
  }
}

export const messageRepo = {
  listByConversation(conversationId: string): Message[] {
    return (
      getDb()
        .prepare(
          `SELECT id, conversation_id, side, role, blocks_json,
                  forwarded_from_message_id, stop_reason, ts
           FROM messages WHERE conversation_id = ? ORDER BY ts ASC, rowid ASC`
        )
        .all(conversationId) as MessageRow[]
    ).map(rowToMessage)
  },
  /** The most recent `limit` messages, returned in ascending order so callers
   *  that reverse-scan for recent artifacts behave identically to the full
   *  list — without loading + JSON-parsing the entire history of a long
   *  conversation. */
  listRecentByConversation(conversationId: string, limit: number): Message[] {
    const rows = getDb()
      .prepare(
        `SELECT id, conversation_id, side, role, blocks_json,
                forwarded_from_message_id, stop_reason, ts
         FROM messages WHERE conversation_id = ?
         ORDER BY ts DESC, rowid DESC LIMIT ?`
      )
      .all(conversationId, limit) as MessageRow[]
    return rows.reverse().map(rowToMessage)
  },
  create(input: {
    id?: string
    conversationId: string
    side: MessageSide
    role: MessageRole
    blocks: MessageBlock[]
    forwardedFromMessageId?: string
    stopReason?: Message['stopReason']
    ts?: number
  }): Message {
    const id = input.id ?? randomUUID()
    const ts = input.ts ?? Date.now()
    getDb()
      .prepare(
        `INSERT INTO messages
           (id, conversation_id, side, role, blocks_json,
            forwarded_from_message_id, stop_reason, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.conversationId,
        input.side,
        input.role,
        JSON.stringify(input.blocks),
        input.forwardedFromMessageId ?? null,
        input.stopReason ?? null,
        ts
      )
    return {
      id,
      conversationId: input.conversationId,
      side: input.side,
      role: input.role,
      blocks: input.blocks,
      forwardedFromMessageId: input.forwardedFromMessageId,
      stopReason: input.stopReason,
      ts
    }
  },
  patch(
    id: string,
    patch: { blocks?: MessageBlock[]; stopReason?: Message['stopReason'] }
  ): void {
    const fields: string[] = []
    const values: unknown[] = []
    if (patch.blocks !== undefined) {
      fields.push('blocks_json = ?')
      values.push(JSON.stringify(patch.blocks))
    }
    if (patch.stopReason !== undefined) {
      fields.push('stop_reason = ?')
      values.push(patch.stopReason)
    }
    if (fields.length === 0) return
    values.push(id)
    getDb().prepare(`UPDATE messages SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }
}

// --- Tasks (path-C state-machine harness) ----------------------------------

interface TaskRow {
  id: string
  conversation_id: string
  brief: string
  status: string
  owner: string
  plan_json: string | null
  result_text: string | null
  failure_reason: string | null
  created_at: number
  updated_at: number
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    brief: row.brief,
    status: row.status as TaskStatus,
    owner: row.owner as Role,
    plan: row.plan_json ? (JSON.parse(row.plan_json) as PlanStep[]) : undefined,
    result: row.result_text ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

const TASK_COLUMNS = `id, conversation_id, brief, status, owner, plan_json,
  result_text, failure_reason, created_at, updated_at`

export const taskRepo = {
  get(id: string): Task | null {
    const row = getDb()
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
      .get(id) as TaskRow | undefined
    return row ? rowToTask(row) : null
  },
  /** All tasks ever created in a conversation, oldest first. The "active"
   *  one is identified by conversations.active_task_id; this lister is
   *  for history / debugging UI. */
  listByConversation(conversationId: string): Task[] {
    const rows = getDb()
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks
         WHERE conversation_id = ?
         ORDER BY created_at ASC`
      )
      .all(conversationId) as TaskRow[]
    return rows.map(rowToTask)
  },
  create(input: {
    conversationId: string
    brief: string
    status?: TaskStatus
    owner?: Role
  }): Task {
    const id = randomUUID()
    const now = Date.now()
    const task: Task = {
      id,
      conversationId: input.conversationId,
      brief: input.brief,
      status: input.status ?? 'briefing',
      owner: input.owner ?? 'pm',
      createdAt: now,
      updatedAt: now
    }
    getDb()
      .prepare(
        `INSERT INTO tasks (id, conversation_id, brief, status, owner,
                            plan_json, result_text, failure_reason,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
      )
      .run(task.id, task.conversationId, task.brief, task.status, task.owner, now, now)
    return task
  },
  /** Partial update — pass only what's changing. `updated_at` is always
   *  set automatically. Plan/result are JSON-encoded if provided. */
  patch(
    id: string,
    patch: {
      status?: TaskStatus
      owner?: Role
      brief?: string
      plan?: PlanStep[] | null
      result?: string | null
      failureReason?: string | null
    }
  ): void {
    const fields: string[] = []
    const values: unknown[] = []
    if (patch.status !== undefined) { fields.push('status = ?'); values.push(patch.status) }
    if (patch.owner !== undefined) { fields.push('owner = ?'); values.push(patch.owner) }
    if (patch.brief !== undefined) { fields.push('brief = ?'); values.push(patch.brief) }
    if (patch.plan !== undefined) {
      fields.push('plan_json = ?')
      values.push(patch.plan === null ? null : JSON.stringify(patch.plan))
    }
    if (patch.result !== undefined) { fields.push('result_text = ?'); values.push(patch.result) }
    if (patch.failureReason !== undefined) { fields.push('failure_reason = ?'); values.push(patch.failureReason) }
    if (fields.length === 0) return
    fields.push('updated_at = ?')
    values.push(Date.now())
    values.push(id)
    getDb().prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }
}
