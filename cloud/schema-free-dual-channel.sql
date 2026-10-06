-- DeepSeek Worker 0.7.0 free dual-channel orchestration.
-- Keeps 0.6.0 tables for compatibility, but active routing uses v2 config and Chat Bridge state.
-- No OpenAI API key or paid Responses API path is required.

CREATE TABLE IF NOT EXISTS project_orchestration_config_v2 (
  project_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'auto'
    CHECK(mode IN ('auto','native','bridge')),
  native_grace_ms INTEGER NOT NULL DEFAULT 30000,
  updated_at TEXT NOT NULL
);

-- Migrate old 0.6.0 choices conservatively:
-- native remains native; cloud/auto become auto because paid cloud execution is retired.
INSERT OR IGNORE INTO project_orchestration_config_v2 (project_id, mode, native_grace_ms, updated_at)
SELECT
  project_id,
  CASE WHEN mode = 'native' THEN 'native' ELSE 'auto' END,
  native_grace_ms,
  updated_at
FROM project_orchestration_config;

CREATE TABLE IF NOT EXISTS worker_bridge_state (
  worker_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0,
  state TEXT,
  last_event_id TEXT,
  last_sent_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_worker_bridge_state_owner
  ON worker_bridge_state(owner, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_bridge_deliveries (
  delivery_id TEXT PRIMARY KEY,
  message_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  event_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_name TEXT NOT NULL
    CHECK(event_name IN ('task.completed','task.failed')),
  project_revision INTEGER NOT NULL,
  fallback_reason TEXT,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','sent','failed','acknowledged')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  acknowledged_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_bridge_event_once
  ON chat_bridge_deliveries(project_id, event_id);

CREATE INDEX IF NOT EXISTS idx_chat_bridge_pending
  ON chat_bridge_deliveries(owner, state, created_at);

-- 0.6.0 legacy tables such as cloud_orchestrator_runs remain untouched so
-- old diagnostics/history can still be inspected. 0.7.0 must not insert new rows
-- into those tables and must not call the OpenAI Responses API.
