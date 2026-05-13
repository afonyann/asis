-- Users: we really expect one user (the owner) but schema is general
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,          -- Telegram user id
  first_name    TEXT,
  username      TEXT,
  timezone      TEXT NOT NULL DEFAULT 'Europe/Moscow',
  profile_json  TEXT NOT NULL DEFAULT '{}',    -- arbitrary long-term context (age, height, weight, goals summary)
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Rolling conversation history (short-term memory)
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('user', 'model', 'system', 'tool')),
  content       TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_user_time ON messages(user_id, created_at DESC);

-- Persistent "memory facts" the bot has decided to remember long-term
CREATE TABLE IF NOT EXISTS memories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  category      TEXT NOT NULL,                 -- 'profile' | 'preference' | 'context' | 'fact'
  content       TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, category);

-- Goals (long-term / quarterly / weekly)
CREATE TABLE IF NOT EXISTS goals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  horizon       TEXT NOT NULL CHECK (horizon IN ('year', 'quarter', 'month', 'week')),
  target_date   TEXT,                          -- YYYY-MM-DD
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'dropped', 'paused')),
  progress      INTEGER NOT NULL DEFAULT 0,    -- 0..100
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_goals_user_status ON goals(user_id, status);

-- Reminders
CREATE TABLE IF NOT EXISTS reminders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  text          TEXT NOT NULL,
  fire_at       INTEGER NOT NULL,              -- unix ts (UTC)
  repeat_rule   TEXT,                          -- NULL | 'daily' | 'weekly' | 'weekdays' | 'mon,tue,...'
  fired_at      INTEGER,                       -- when last fired
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(status, fire_at);

-- Habit tracker
CREATE TABLE IF NOT EXISTS habits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  frequency     TEXT NOT NULL DEFAULT 'daily', -- 'daily' | 'weekly' | 'mon,tue,...'
  target_per_week INTEGER NOT NULL DEFAULT 7,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_habits_user_status ON habits(user_id, status);

CREATE TABLE IF NOT EXISTS habit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id      INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,
  done_date     TEXT NOT NULL,                 -- YYYY-MM-DD (user tz)
  note          TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (habit_id, done_date)
);
CREATE INDEX IF NOT EXISTS idx_habit_logs_user_date ON habit_logs(user_id, done_date DESC);

-- Workouts log
CREATE TABLE IF NOT EXISTS workouts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  date          TEXT NOT NULL,                 -- YYYY-MM-DD (user tz)
  summary       TEXT NOT NULL,                 -- freeform text description of what was done
  details_json  TEXT NOT NULL DEFAULT '{}',    -- structured: exercises[], total_volume, etc
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts(user_id, date DESC);

-- Food / nutrition log
CREATE TABLE IF NOT EXISTS meals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  date          TEXT NOT NULL,                 -- YYYY-MM-DD (user tz)
  description   TEXT NOT NULL,
  kcal          INTEGER,
  protein_g     INTEGER,
  fat_g         INTEGER,
  carbs_g       INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals(user_id, date DESC);

-- Daily notes (morning plan, evening review, freeform thoughts)
CREATE TABLE IF NOT EXISTS daily_notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  date          TEXT NOT NULL,                 -- YYYY-MM-DD (user tz)
  kind          TEXT NOT NULL CHECK (kind IN ('morning_plan', 'evening_review', 'thought', 'weekly_review')),
  content       TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_daily_notes_user_date ON daily_notes(user_id, date DESC, kind);

-- Simple key-value store for scheduler state (so we don't double-fire morning prompts etc)
CREATE TABLE IF NOT EXISTS kv (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
