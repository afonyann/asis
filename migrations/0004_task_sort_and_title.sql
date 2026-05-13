ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_tasks_user_scope_sort ON tasks(user_id, scope, sort_order);
