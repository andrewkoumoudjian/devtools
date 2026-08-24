PRAGMA foreign_keys = ON;

ALTER TABLE repositories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repositories ADD COLUMN website TEXT NOT NULL DEFAULT '';

CREATE TABLE repo_settings (
  repo_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  issues_enabled INTEGER NOT NULL DEFAULT 1,
  pulls_enabled INTEGER NOT NULL DEFAULT 1,
  actions_enabled INTEGER NOT NULL DEFAULT 1,
  releases_enabled INTEGER NOT NULL DEFAULT 1,
  merge_method TEXT NOT NULL DEFAULT 'squash' CHECK (merge_method IN ('merge', 'squash', 'rebase')),
  delete_head_on_merge INTEGER NOT NULL DEFAULT 1,
  agent_context_enabled INTEGER NOT NULL DEFAULT 1,
  agent_write_enabled INTEGER NOT NULL DEFAULT 1,
  context_recent_commits INTEGER NOT NULL DEFAULT 20,
  context_recent_events INTEGER NOT NULL DEFAULT 50,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '0969da',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo_id, name)
);

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  due_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo_id, number)
);

CREATE TABLE issue_labels (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY(issue_id, label_id)
);

CREATE TABLE pull_labels (
  pull_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY(pull_id, label_id)
);

CREATE TABLE issue_milestones (
  issue_id TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE
);

CREATE TABLE pull_milestones (
  pull_id TEXT PRIMARY KEY REFERENCES pull_requests(id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE
);

CREATE TABLE pull_review_requests (
  pull_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(pull_id, reviewer)
);

CREATE TABLE pull_conversation (
  id TEXT PRIMARY KEY,
  pull_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'review', 'inline_comment', 'system')),
  author TEXT NOT NULL DEFAULT 'system',
  body TEXT NOT NULL DEFAULT '',
  review_state TEXT CHECK (review_state IN ('commented', 'approved', 'changes_requested')),
  path TEXT,
  line INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  tag_name TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  draft INTEGER NOT NULL DEFAULT 0,
  prerelease INTEGER NOT NULL DEFAULT 0,
  author TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  UNIQUE(repo_id, tag_name)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  target_kind TEXT,
  target_number INTEGER,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ci_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ci_runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  exit_code INTEGER,
  stdout_key TEXT,
  stderr_key TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE(run_id, name)
);

CREATE TABLE repo_context_events (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref TEXT,
  sha TEXT,
  target_kind TEXT,
  target_number INTEGER,
  actor TEXT NOT NULL DEFAULT 'system',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL DEFAULT 'agent',
  ref TEXT NOT NULL,
  target_kind TEXT,
  target_number INTEGER,
  workspace_id TEXT,
  access_mode TEXT NOT NULL DEFAULT 'write-capable' CHECK (access_mode IN ('read-only', 'write-capable')),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX labels_repo_name ON labels(repo_id, name);
CREATE INDEX milestones_repo_state ON milestones(repo_id, state, number DESC);
CREATE INDEX releases_repo_created ON releases(repo_id, created_at DESC);
CREATE INDEX notifications_repo_created ON notifications(repo_id, read_at, created_at DESC);
CREATE INDEX ci_steps_run ON ci_steps(run_id, started_at);
CREATE INDEX context_events_repo_created ON repo_context_events(repo_id, created_at DESC);
CREATE INDEX agent_sessions_repo_seen ON agent_sessions(repo_id, last_seen_at DESC);
