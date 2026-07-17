-- Message-level review type. The migration runner replays all files, so keep
-- the constraint inline with the idempotent column addition.
ALTER TABLE comment_messages
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'note'
  CHECK (kind IN ('note', 'blocker', 'concern', 'question', 'action', 'nit', 'resolution'));
