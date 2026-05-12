ALTER TABLE comment_threads ADD COLUMN IF NOT EXISTS page_path TEXT NOT NULL DEFAULT 'index.html';

CREATE INDEX IF NOT EXISTS idx_comment_threads_artifact_page
  ON comment_threads(artifact_id, page_path, created_at DESC);
