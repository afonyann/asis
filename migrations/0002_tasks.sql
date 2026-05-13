-- Tasks: a simple to-do list separate from time-based reminders and long-term goals.
-- daily  → due_date is a YYYY-MM-DD (the day the task is for)
-- weekly → due_date is YYYY-MM-DD of the Monday of the ISO week
-- someday → due_date may be null
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('daily', 'weekly', 'someday')),
  due_date    TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled')),
  done_at     INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_user_scope_date ON tasks(user_id, scope, due_date);
