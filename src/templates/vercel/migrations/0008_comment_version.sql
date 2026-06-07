-- Mirror of worker 0010. Idempotent for migrate.js re-runs.
ALTER TABLE comment_threads ADD COLUMN IF NOT EXISTS version_id TEXT;

CREATE INDEX IF NOT EXISTS idx_comment_threads_version
  ON comment_threads(artifact_id, page_path, version_id, created_at DESC);
