CREATE TABLE IF NOT EXISTS exercises (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  date        TEXT NOT NULL,
  name        TEXT NOT NULL,
  reps        INTEGER NOT NULL DEFAULT 0,
  step        INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_exercises_user_date ON exercises(user_id, date, sort_order);
