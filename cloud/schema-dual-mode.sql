-- DeepSeek Worker 0.5.x dual-mode orchestration additions.
-- Apply after cloud/schema-events.sql. Existing tables remain unchanged.

CREATE TABLE IF NOT EXISTS project_orchestration_config (
  project_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'auto'
    CHECK(mode IN ('auto','native','cloud')),
  native_grace_ms INTEGER NOT NULL DEFAULT 30000,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_orchestrator_runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  selected_path TEXT NOT NULL,
  fallback_reason TEXT,
  status TEXT NOT NULL,
  model TEXT,
  response_id TEXT,
  input_event_ids_json TEXT NOT NULL DEFAULT '[]',
  created_task_ids_json TEXT NOT NULL DEFAULT '[]',
  error_summary TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cloud_orchestrator_runs_project
  ON cloud_orchestrator_runs(project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS project_user_decisions (
  decision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  question TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','resolved','cancelled')),
  answer TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_project_user_decisions_pending
  ON project_user_decisions(project_id, state, created_at);

-- Optional operational state used by get_event_diagnostics / orchestration diagnostics.
CREATE TABLE IF NOT EXISTS native_subscription_health (
  project_id TEXT PRIMARY KEY,
  active_subscription_count INTEGER NOT NULL DEFAULT 0,
  callback_verified INTEGER NOT NULL DEFAULT 0,
  latest_delivery_state TEXT,
  latest_delivery_at TEXT,
  latest_delivery_http_status INTEGER,
  consecutive_delivery_failures INTEGER NOT NULL DEFAULT 0,
  subscription_refresh_before TEXT,
  updated_at TEXT NOT NULL
);
