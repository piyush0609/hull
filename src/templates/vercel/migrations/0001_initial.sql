CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE,
  name TEXT,
  size_bytes INTEGER,
  created_at INTEGER,
  expires_at INTEGER,
  token_hash TEXT,
  password_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_artifacts_token ON artifacts(token_hash);
CREATE INDEX IF NOT EXISTS idx_artifacts_slug ON artifacts(slug);
