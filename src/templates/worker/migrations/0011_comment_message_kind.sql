-- Review type is message-level so replies and resolution records retain their
-- meaning independently. Existing rows remain backward compatible as notes.
ALTER TABLE comment_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'
  CHECK (kind IN ('note', 'blocker', 'concern', 'question', 'action', 'nit', 'resolution'));
