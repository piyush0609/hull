-- Each comment thread is authored against a version; the default view filters to
-- artifacts.current_version_id so a new version hides prior comments (retained, not
-- deleted). NULL = thread created before versioning existed -> treated as belonging
-- to the artifact's first version. D1: ADD COLUMN cannot be NOT NULL without a default.
ALTER TABLE comment_threads ADD COLUMN version_id TEXT;

CREATE INDEX IF NOT EXISTS idx_comment_threads_version
  ON comment_threads(artifact_id, page_path, version_id, created_at DESC);
