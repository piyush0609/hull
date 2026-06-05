-- Per-share opt-in for comments (Story 1). Default off: a share has comments
-- only if the owner explicitly enables them. D1/SQLite: ADD COLUMN with a
-- constant DEFAULT is allowed; no IF NOT EXISTS (unsupported, and migrations
-- are tracked/run-once by wrangler).
ALTER TABLE artifacts ADD COLUMN comments_enabled INTEGER NOT NULL DEFAULT 0;
