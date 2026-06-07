-- Mirror of worker 0009. Postgres + migrate.js re-runs every deploy and splits on
-- ';', so every statement must be idempotent and free of DO $$ blocks.
CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_versions_seq ON artifact_versions(artifact_id, seq);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact ON artifact_versions(artifact_id, seq DESC);

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS current_version_id TEXT;
