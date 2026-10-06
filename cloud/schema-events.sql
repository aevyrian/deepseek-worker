-- DeepSeek Worker 0.5.x event-driven orchestration schema.
-- Intended for the production Site D1 database. Existing task/worker tables remain unchanged.

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_owner
  ON projects(owner_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_tasks (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_project_tasks_status
  ON project_tasks(project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_events (
  event_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  name TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  result_available INTEGER NOT NULL DEFAULT 0,
  project_revision INTEGER NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_events_pending
  ON project_events(project_id, acknowledged, occurred_at);

CREATE TABLE IF NOT EXISTS mcp_event_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  event_name TEXT NOT NULL,
  arguments_canonical TEXT NOT NULL,
  project_id TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  refresh_before TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_key, event_name, arguments_canonical, callback_url)
);

CREATE INDEX IF NOT EXISTS idx_mcp_event_subscriptions_project
  ON mcp_event_subscriptions(project_id, event_name, active, refresh_before);

CREATE TABLE IF NOT EXISTS mcp_event_deliveries (
  event_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  next_attempt_at TEXT NOT NULL,
  delivered_at TEXT,
  dead_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(event_id, subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_event_deliveries_due
  ON mcp_event_deliveries(state, next_attempt_at);

CREATE TABLE IF NOT EXISTS project_orchestrator_leases (
  project_id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS callback_verifications (
  owner_key TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  verified_until TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_key, callback_url)
);
