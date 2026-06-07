-- Mirror of worker 0009. migrate.js re-runs on every deploy and splits SQL on
-- semicolons, so each statement stays idempotent and this comment avoids inline
-- semicolons, apostrophes, and dollar-quote blocks that would break the splitter.
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
