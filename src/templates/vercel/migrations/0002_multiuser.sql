CREATE TABLE IF NOT EXISTS users (
  token_hash TEXT PRIMARY KEY,
  label TEXT,
  created_at INTEGER,
  is_admin INTEGER DEFAULT 0
);
