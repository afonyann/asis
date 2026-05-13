-- Multi-user: subscription tier per user.
ALTER TABLE users ADD COLUMN sub_status TEXT NOT NULL DEFAULT 'trial';
ALTER TABLE users ADD COLUMN sub_until INTEGER;            -- unix seconds; null for owner/granted/trial-not-set
ALTER TABLE users ADD COLUMN sub_started_at INTEGER NOT NULL DEFAULT 0;

-- Backfill sub_started_at to created_at-equivalent (use 0 → app code will treat 0 as "use unixepoch()").
UPDATE users SET sub_started_at = COALESCE(created_at, unixepoch()) WHERE sub_started_at = 0;

-- Payments (telegram stars)
CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  charge_id       TEXT,
  amount_xtr      INTEGER NOT NULL,
  payload         TEXT,
  added_days      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);
