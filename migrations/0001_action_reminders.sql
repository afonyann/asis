-- Action-triggered reminders: fire when user says/does X, not at a fixed time.
-- Example: trigger="пойду гулять", message="купи молоко".
CREATE TABLE IF NOT EXISTS action_reminders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  trigger_text  TEXT NOT NULL,                  -- short phrase / event description
  message       TEXT NOT NULL,                  -- what to remind about
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'fired', 'cancelled')),
  fired_at      INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_action_reminders_user_status
  ON action_reminders(user_id, status);
