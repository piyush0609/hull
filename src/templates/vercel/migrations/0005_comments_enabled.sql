-- Per-share opt-in for comments (Story 1). Default off: a share has comments
-- only if the owner explicitly enables them. Postgres: migrate.js re-runs every
-- file on each deploy, so this must be idempotent (single statement, IF NOT
-- EXISTS). INTEGER 0/1 (not BOOLEAN) to keep the worker and vercel code identical.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS comments_enabled INTEGER NOT NULL DEFAULT 0;
