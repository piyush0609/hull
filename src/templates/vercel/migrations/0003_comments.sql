CREATE TABLE IF NOT EXISTS comment_threads (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  created_by_token_hash TEXT NOT NULL,
  created_by_label TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  anchor_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by_token_hash TEXT,
  resolved_by_label TEXT,
  resolved_at INTEGER,
  deleted_at INTEGER,
  deleted_by_token_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comment_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  author_token_hash TEXT NOT NULL,
  author_label TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_by_token_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_comment_threads_artifact ON comment_threads(artifact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comment_messages_thread ON comment_messages(thread_id, created_at ASC);
