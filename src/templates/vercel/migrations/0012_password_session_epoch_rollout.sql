-- One-time: invalidate pre-fix password sessions and comment grants by rolling
-- the epoch for every password-protected artifact. Plain `.sql` (a `pre` file);
-- the schema_migrations ledger ensures it runs exactly once, so it need not be
-- idempotent.
UPDATE artifacts SET password_epoch = password_epoch + 1 WHERE password_hash IS NOT NULL;
