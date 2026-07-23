-- One-time: invalidate pre-fix password sessions and comment grants by rolling
-- the epoch for every password-protected artifact. Applied once via
-- `wrangler d1 migrations apply` (D1 tracks applied migrations); not idempotent.
UPDATE artifacts SET password_epoch = password_epoch + 1 WHERE password_hash IS NOT NULL;
