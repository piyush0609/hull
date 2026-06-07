-- Append-only immutable version records (Option A). One row per share/re-share
-- where content changed (or --force was used); rows are never updated after insert.
-- content_hash is change-detection metadata, NOT identity (intentionally not unique
-- per artifact — a --force re-share can repeat identical content as a new row).
-- The live pointer is artifacts.current_version_id. D1: no IF NOT EXISTS for columns;
-- NOT NULL needs a default, so current_version_id is nullable (NULL until first mint).
CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_versions_seq ON artifact_versions(artifact_id, seq);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact ON artifact_versions(artifact_id, seq DESC);

ALTER TABLE artifacts ADD COLUMN current_version_id TEXT;
