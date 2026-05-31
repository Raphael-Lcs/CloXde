import type { Database as DBType } from 'better-sqlite3'

// Append-only, additive migration chain. Each schema change adds a new
// `{version, name, up}` entry; runMigrations applies (idempotently, in order)
// only the versions a given DB hasn't run yet. A fresh DB runs v1→latest (==
// building the final schema); an existing DB just back-fills the gap.
//
// Pre-1.0 note: we may still squash this whole chain into a single init
// migration at the next breaking schema change (when resetting local DBs is
// acceptable anyway). Until then, never edit a shipped migration in place —
// add a new version.

interface Migration {
  version: number
  name: string
  up: (db: DBType) => void
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'v0.6-init',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_dir TEXT NOT NULL UNIQUE,
          default_architect TEXT NOT NULL DEFAULT 'claude',
          default_executor  TEXT NOT NULL DEFAULT 'codex',
          created_at INTEGER NOT NULL,
          last_opened_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_profiles (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          command TEXT,
          args_json TEXT NOT NULL DEFAULT '[]',
          env_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(project_id, kind)
        );

        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT,
          architect_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
          executor_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
          primary_side TEXT NOT NULL DEFAULT 'architect',
          status TEXT NOT NULL DEFAULT 'idle',
          autopilot INTEGER NOT NULL DEFAULT 1,
          max_auto_turns INTEGER NOT NULL DEFAULT 8,
          auto_turns_used INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          ended_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          side TEXT NOT NULL,
          role TEXT NOT NULL,
          blocks_json TEXT NOT NULL,
          forwarded_from_message_id TEXT,
          stop_reason TEXT,
          ts INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, ts);
      `)
    }
  },
  {
    version: 2,
    name: 'persist-acp-session-ids',
    up(db) {
      // We keep the per-side ACP session ids so that when CloXde reopens
      // we can call `session/load` on the adapter and recover the agent's
      // own conversation context (instead of starting a blank session that
      // doesn't remember the user's history).
      db.exec(`
        ALTER TABLE conversations ADD COLUMN architect_acp_session_id TEXT;
        ALTER TABLE conversations ADD COLUMN executor_acp_session_id TEXT;
      `)
    }
  },
  {
    version: 3,
    name: 'raise-max-auto-turns',
    up(db) {
      // The original 8-turn cap was too aggressive — legitimate A2A sessions
      // can easily hit it on multi-file refactors. Bump existing rows and
      // change the default (in code) to 200.
      db.exec(`
        UPDATE conversations
        SET max_auto_turns = 200
        WHERE max_auto_turns < 50;
      `)
    }
  },
  {
    version: 4,
    name: 'conversations-archived-at',
    up(db) {
      // Soft-archive: sidebar X button stashes a conversation here instead of
      // deleting it. Conversations with archived_at != NULL are hidden from
      // the active list and appear under a collapsible "已归档" section.
      db.exec(`
        ALTER TABLE conversations ADD COLUMN archived_at INTEGER;
      `)
    }
  },
  {
    version: 5,
    name: 'conversations-pm-profile',
    up(db) {
      // Optional Product Manager layer. When pm_profile_id is set, the
      // engine runs a 3-agent flow: user ↔ PM ↔ {architect, executor}.
      // NULL means legacy 2-agent mode where user talks directly to
      // architect (preserved for old conversations).
      db.exec(`
        ALTER TABLE conversations
          ADD COLUMN pm_profile_id TEXT REFERENCES agent_profiles(id);
        ALTER TABLE conversations
          ADD COLUMN pm_acp_session_id TEXT;
      `)
    }
  },
  {
    version: 6,
    name: 'projects-archived-at',
    up(db) {
      // Same soft-archive pattern as conversations: hide from main sidebar
      // without losing data. UX-level cascade (project archive → archive all
      // contained conversations) is enforced in the IPC handler, not via a
      // trigger, so the application can refuse the operation when a turn is
      // mid-flight.
      db.exec(`
        ALTER TABLE projects ADD COLUMN archived_at INTEGER;
      `)
    }
  },
  {
    version: 7,
    name: 'conversation-parents',
    up(db) {
      // Many-to-many "继承自" links. A new conversation can declare zero or
      // more parent conversations; CloXde injects a generated summary of
      // each parent as the new conversation's seed so the agents have
      // context without us having to do ACP session forking. The rendered
      // summary is cached on the child row to avoid re-extracting on every
      // open.
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_parents (
          child_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          parent_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          /* Display order — small int so the user can pick "this parent
             matters more, list it first" if we ever expose reordering. */
          ord INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (child_id, parent_id)
        );
        CREATE INDEX IF NOT EXISTS idx_conv_parents_child
          ON conversation_parents(child_id);
        CREATE INDEX IF NOT EXISTS idx_conv_parents_parent
          ON conversation_parents(parent_id);

        ALTER TABLE conversations ADD COLUMN inherited_summary TEXT;
      `)
    }
  },
  {
    version: 8,
    name: 'tasks-state-machine',
    up(db) {
      // Path-C state machine. Each conversation now drives exactly one
      // ACTIVE task at a time. The task carries the canonical (status,
      // owner) the engine routes by — turn dispatch is no longer "scan
      // last assistant message for tags" but "consult the active task,
      // wake the owner". Permission gating is enforced per (status, role).
      //
      // We keep the column nullable so legacy conversations (created before
      // v8) can keep running on the old tag-based flow with no task
      // attached; the engine treats null-active-task as "free-form mode"
      // for backwards compat.
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          brief TEXT NOT NULL DEFAULT '',
          /* 'briefing' | 'planning' | 'executing' | 'review' | 'done' | 'failed' */
          status TEXT NOT NULL DEFAULT 'briefing',
          /* 'pm' | 'architect' | 'executor' */
          owner TEXT NOT NULL DEFAULT 'pm',
          plan_json TEXT,        /* nullable; populated once architect PLANs */
          result_text TEXT,      /* nullable; populated once executor REPORTs */
          failure_reason TEXT,   /* nullable; populated on 'failed' */
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_conv ON tasks(conversation_id);

        ALTER TABLE conversations
          ADD COLUMN active_task_id TEXT REFERENCES tasks(id);
      `)
    }
  },
  {
    version: 9,
    name: 'messages-metrics',
    up(db) {
      // Per-turn observability: tokens + wall-clock elapsed, captured from the
      // ACP PromptResponse.usage (experimental) and engine timing. Stored as a
      // JSON blob so we can add fields without further migrations. Nullable —
      // user/system rows and adapters that don't report usage leave it NULL.
      db.exec(`
        ALTER TABLE messages ADD COLUMN metrics_json TEXT;
      `)
    }
  },
  {
    version: 10,
    name: 'schedules',
    up(db) {
      // Timed automation: a schedule fires on a timer and injects a canned
      // prompt into an existing conversation (sent to PM, same path as a user
      // message). trigger_json holds the discriminated union (interval | cron);
      // next_fire_at is the precomputed epoch-ms the ticker compares against.
      db.exec(`
        CREATE TABLE IF NOT EXISTS schedules (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          name TEXT NOT NULL DEFAULT '',
          trigger_json TEXT NOT NULL,
          prompt TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          next_fire_at INTEGER NOT NULL,
          last_fired_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_schedules_conv ON schedules(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(enabled, next_fire_at);
      `)
    }
  },
  {
    version: 11,
    name: 'assistant-memory',
    up(db) {
      // The assistant's long-term, user-scoped memory — separate from
      // per-conversation history. The assistant distills these autonomously
      // (the user does not hand-feed them) and recalls them by semantic
      // similarity at decision time.
      //
      // Two coupled tables:
      //  - assistant_memories: the structured record. INTEGER PK so its rowid
      //    is stable; we also carry a uuid for external (IPC) references to
      //    match the rest of the app's string-id convention.
      //  - vec_assistant_memories: sqlite-vec vec0 virtual table holding the
      //    embedding, keyed by rowid == assistant_memories.id. vec0 rowids
      //    MUST be bound as BigInt from better-sqlite3 (plain JS integers are
      //    rejected with "Only integers are allowed for primary key").
      //
      // Embedding dimension is fixed at the local embedder's output (384 for
      // a MiniLM-class model). Changing embedder => new migration.
      db.exec(`
        CREATE TABLE IF NOT EXISTS assistant_memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          /* 'preference' | 'fact' | 'project' | 'person' | 'pattern' | 'episodic' | 'skill' */
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          /* provenance, e.g. 'distilled:<conversationId>' | 'manual' | 'observed' */
          source TEXT,
          confidence REAL NOT NULL DEFAULT 0.5,
          /* user-pinned memories are never auto-pruned by the decay pass */
          pinned INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          /* bumped on recall; drives decay/pruning of stale, low-confidence rows */
          last_used_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_assistant_memories_kind
          ON assistant_memories(kind);

        CREATE VIRTUAL TABLE IF NOT EXISTS vec_assistant_memories USING vec0(
          embedding float[384]
        );
      `)
    }
  },
  {
    version: 12,
    name: 'assistant-messages',
    up(db) {
      // The assistant's own conversation thread — the user-scoped管家's chat with
      // the user, plus its proactive reports. Separate from team `messages`
      // (per-conversation): there is exactly one assistant, and its history must
      // survive an app restart so the panel isn't blank every launch.
      //
      // role: 'user' | 'assistant' | 'system' | 'report'. project_id/
      // conversation_id are set on report / dispatch / continue rows so the UI
      // can link straight to the team. `read` only matters for 'report' rows —
      // it backs the titlebar unread badge (0 = unseen).
      db.exec(`
        CREATE TABLE IF NOT EXISTS assistant_messages (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          project_id TEXT,
          conversation_id TEXT,
          read INTEGER NOT NULL DEFAULT 1,
          ts INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_assistant_messages_ts ON assistant_messages(ts);
        CREATE INDEX IF NOT EXISTS idx_assistant_messages_unread
          ON assistant_messages(role, read);
      `)
    }
  },
  {
    version: 13,
    name: 'assistant-messages-fts',
    up(db) {
      // Full-text index over the assistant's own thread, so the brain can surface
      // relevant OLD messages beyond the ~60 it hydrates / the compacted window —
      // exact-term / proper-noun lookups that vector recall (memories only) can't.
      //
      // Tokenizer = trigram: the only built-in tokenizer that handles Chinese
      // (unicode61 doesn't segment CJK). External-content table (content=…) so we
      // don't duplicate the message text; triggers keep it in sync, incl. the
      // per-row deletes that trimToLast / clear fire.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS assistant_messages_fts USING fts5(
          text,
          content='assistant_messages',
          content_rowid='rowid',
          tokenize='trigram'
        );

        CREATE TRIGGER IF NOT EXISTS assistant_messages_ai
        AFTER INSERT ON assistant_messages BEGIN
          INSERT INTO assistant_messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END;

        CREATE TRIGGER IF NOT EXISTS assistant_messages_ad
        AFTER DELETE ON assistant_messages BEGIN
          INSERT INTO assistant_messages_fts(assistant_messages_fts, rowid, text)
            VALUES ('delete', old.rowid, old.text);
        END;

        CREATE TRIGGER IF NOT EXISTS assistant_messages_au
        AFTER UPDATE ON assistant_messages BEGIN
          INSERT INTO assistant_messages_fts(assistant_messages_fts, rowid, text)
            VALUES ('delete', old.rowid, old.text);
          INSERT INTO assistant_messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END;
      `)
      // Backfill any rows that predate this migration.
      db.exec(`
        INSERT INTO assistant_messages_fts(rowid, text)
          SELECT rowid, text FROM assistant_messages;
      `)
    }
  },
  {
    version: 14,
    name: 'assistant-reminders',
    up(db) {
      // The brain's own wake-ups. Unlike `schedules` (which inject a prompt into a
      // team CONVERSATION), a reminder wakes the ASSISTANT itself: the review loop
      // fires due rows as a 'cron' signal carrying `note`. One-shot rows (cron
      // NULL) are deleted after firing; recurring rows recompute fire_at.
      db.exec(`
        CREATE TABLE IF NOT EXISTS assistant_reminders (
          id TEXT PRIMARY KEY,
          fire_at INTEGER NOT NULL,
          note TEXT NOT NULL,
          cron TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_assistant_reminders_fire
          ON assistant_reminders(fire_at);
      `)
    }
  }
]

export function runMigrations(db: DBType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)
  const applied = new Set<number>(
    (db.prepare('SELECT version FROM _migrations').all() as { version: number }[])
      .map((r) => r.version)
  )
  const insert = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)'
  )
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    db.transaction(() => {
      m.up(db)
      insert.run(m.version, m.name, Date.now())
    })()
  }
}
