-- Password session epoch: bumped whenever the view password changes, so a
-- comment grant minted under the old password (which embeds the epoch) stops
-- validating. SQLite/D1: no IF NOT EXISTS for columns; NOT NULL needs a default.
ALTER TABLE artifacts ADD COLUMN password_epoch INTEGER NOT NULL DEFAULT 0;
