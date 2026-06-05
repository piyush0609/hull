-- Password session epoch (mirror of worker 0008). Postgres + migrate.js re-runs
-- every deploy, so this must be idempotent.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS password_epoch INTEGER NOT NULL DEFAULT 0;
