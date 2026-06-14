-- 修复 conversations 表：移除旧的 profile_id 列

BEGIN TRANSACTION;

-- 1. 创建新表（只包含 kind 列，不包含 profile_id 列）
CREATE TABLE conversations_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT,
  pm_kind TEXT,
  architect_kind TEXT NOT NULL,
  executor_kind TEXT NOT NULL,
  primary_side TEXT NOT NULL,
  status TEXT NOT NULL,
  autopilot INTEGER NOT NULL,
  max_auto_turns INTEGER NOT NULL,
  auto_turns_used INTEGER NOT NULL,
  pm_acp_session_id TEXT,
  architect_acp_session_id TEXT,
  executor_acp_session_id TEXT,
  inherited_summary TEXT,
  active_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  assistant_nudge_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  archived_at INTEGER
);

-- 2. 复制数据（只复制新列）
INSERT INTO conversations_new SELECT
  id, project_id, title, pm_kind, architect_kind, executor_kind,
  primary_side, status, autopilot, max_auto_turns, auto_turns_used,
  pm_acp_session_id, architect_acp_session_id, executor_acp_session_id,
  inherited_summary, active_task_id, assistant_nudge_count,
  created_at, ended_at, archived_at
FROM conversations;

-- 3. 删除旧表
DROP TABLE conversations;

-- 4. 重命名新表
ALTER TABLE conversations_new RENAME TO conversations;

-- 5. 重建索引
CREATE INDEX idx_conversations_project ON conversations(project_id);
CREATE INDEX idx_conversations_status ON conversations(status);

COMMIT;
