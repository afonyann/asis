import type { Env, Goal, Habit, Reminder, ActionReminder, Task, Exercise, Memory, Message, UserRow, SubStatus } from './types';
import { nowSec, dateInTz } from './time';

const TRIAL_DAYS = 14;

export async function ensureUser(env: Env, userId: number, firstName?: string, username?: string): Promise<UserRow> {
  const existing = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<UserRow>();
  if (existing) {
    // Update first_name/username if changed (helps with /grant @username matching)
    if ((firstName && firstName !== existing.first_name) || (username && username !== existing.username)) {
      await env.DB.prepare(
        'UPDATE users SET first_name = COALESCE(?, first_name), username = COALESCE(?, username), updated_at = unixepoch() WHERE id = ?'
      ).bind(firstName ?? null, username ?? null, userId).run();
    }
    return existing;
  }
  const ownerId = Number(env.TG_OWNER_ID);
  const isOwner = userId === ownerId;
  const now = Math.floor(Date.now() / 1000);
  const subStatus: SubStatus = isOwner ? 'owner' : 'trial';
  const subUntil: number | null = isOwner ? null : now + TRIAL_DAYS * 86400;
  await env.DB.prepare(
    `INSERT INTO users (id, first_name, username, timezone, sub_status, sub_until, sub_started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(userId, firstName ?? null, username ?? null, env.DEFAULT_TIMEZONE, subStatus, subUntil, now).run();
  return (await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<UserRow>())!;
}

/** Effective access check. Returns 'allowed' or a denial reason string. */
export function effectiveAccess(user: UserRow): { allowed: true } | { allowed: false; reason: string; expired: boolean } {
  if (user.sub_status === 'owner' || user.sub_status === 'granted') return { allowed: true };
  const now = Math.floor(Date.now() / 1000);
  if ((user.sub_status === 'trial' || user.sub_status === 'active') && user.sub_until && user.sub_until > now) {
    return { allowed: true };
  }
  // expired
  return {
    allowed: false,
    expired: true,
    reason: user.sub_status === 'trial'
      ? 'Триал закончился. Оформи подписку командой /subscribe — 99 ⭐ за месяц.'
      : 'Подписка истекла. Продли командой /subscribe — 99 ⭐ за месяц.',
  };
}

export async function setSubscription(env: Env, userId: number, status: SubStatus, until: number | null): Promise<void> {
  await env.DB.prepare(
    'UPDATE users SET sub_status = ?, sub_until = ?, updated_at = unixepoch() WHERE id = ?'
  ).bind(status, until, userId).run();
}

export async function extendSubscription(env: Env, userId: number, addDays: number): Promise<{ until: number }> {
  const u = await getUser(env, userId);
  const now = Math.floor(Date.now() / 1000);
  const base = u && u.sub_until && u.sub_until > now ? u.sub_until : now;
  const until = base + addDays * 86400;
  await env.DB.prepare(
    "UPDATE users SET sub_status = 'active', sub_until = ?, updated_at = unixepoch() WHERE id = ?"
  ).bind(until, userId).run();
  return { until };
}

export async function findUserByUsername(env: Env, username: string): Promise<UserRow | null> {
  const u = username.replace(/^@/, '');
  return await env.DB.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').bind(u).first<UserRow>();
}

export async function listAllUsers(env: Env): Promise<UserRow[]> {
  const r = await env.DB.prepare('SELECT * FROM users ORDER BY created_at DESC').all<UserRow>();
  return r.results || [];
}

export async function recordPayment(env: Env, userId: number, chargeId: string, amountXtr: number, payload: string, addedDays: number): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO payments (user_id, charge_id, amount_xtr, payload, added_days) VALUES (?, ?, ?, ?, ?)'
  ).bind(userId, chargeId, amountXtr, payload, addedDays).run();
}

export async function getUser(env: Env, userId: number): Promise<UserRow | null> {
  return await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<UserRow>();
}

export async function updateUserProfile(env: Env, userId: number, patch: Record<string, unknown>): Promise<void> {
  const user = await getUser(env, userId);
  if (!user) return;
  const profile = { ...JSON.parse(user.profile_json || '{}'), ...patch };
  await env.DB.prepare(
    'UPDATE users SET profile_json = ?, updated_at = unixepoch() WHERE id = ?'
  ).bind(JSON.stringify(profile), userId).run();
}

// ------- Messages / short-term memory -------

export async function saveMessage(env: Env, userId: number, role: Message['role'], content: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)`
  ).bind(userId, role, content).run();
}

export async function recentMessages(env: Env, userId: number, limit = 20): Promise<Message[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?`
  ).bind(userId, limit).all<Message>();
  return (res.results || []).reverse();
}

// ------- Long-term memory -------

export async function saveMemory(env: Env, userId: number, category: string, content: string): Promise<Memory> {
  const { meta } = await env.DB.prepare(
    `INSERT INTO memories (user_id, category, content) VALUES (?, ?, ?)`
  ).bind(userId, category, content).run();
  return {
    id: meta.last_row_id as number,
    user_id: userId, category, content, created_at: nowSec(),
  };
}

export async function listMemories(env: Env, userId: number, category?: string): Promise<Memory[]> {
  const q = category
    ? env.DB.prepare('SELECT * FROM memories WHERE user_id = ? AND category = ? ORDER BY id DESC').bind(userId, category)
    : env.DB.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY id DESC').bind(userId);
  const res = await q.all<Memory>();
  return res.results || [];
}

export async function deleteMemory(env: Env, userId: number, id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').bind(id, userId).run();
}

// ------- Goals -------

export async function createGoal(env: Env, userId: number, data: {
  title: string; description?: string; horizon: Goal['horizon']; target_date?: string;
}): Promise<Goal> {
  const { meta } = await env.DB.prepare(
    `INSERT INTO goals (user_id, title, description, horizon, target_date) VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, data.title, data.description ?? null, data.horizon, data.target_date ?? null).run();
  return (await env.DB.prepare('SELECT * FROM goals WHERE id = ?').bind(meta.last_row_id).first<Goal>())!;
}

export async function updateGoal(env: Env, userId: number, id: number, patch: Partial<Pick<Goal, 'status' | 'progress' | 'description' | 'title' | 'target_date'>>): Promise<Goal | null> {
  const fields: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    binds.push(v);
  }
  if (fields.length === 0) {
    return await env.DB.prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?').bind(id, userId).first<Goal>();
  }
  fields.push('updated_at = unixepoch()');
  binds.push(id, userId);
  await env.DB.prepare(
    `UPDATE goals SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`
  ).bind(...binds).run();
  return await env.DB.prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?').bind(id, userId).first<Goal>();
}

export async function listGoals(env: Env, userId: number, status: Goal['status'] | 'all' = 'active'): Promise<Goal[]> {
  const q = status === 'all'
    ? env.DB.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY id DESC').bind(userId)
    : env.DB.prepare('SELECT * FROM goals WHERE user_id = ? AND status = ? ORDER BY id DESC').bind(userId, status);
  const res = await q.all<Goal>();
  return res.results || [];
}

// ------- Reminders -------

export async function createReminder(env: Env, userId: number, text: string, fireAt: number, repeatRule?: string): Promise<Reminder> {
  const { meta } = await env.DB.prepare(
    `INSERT INTO reminders (user_id, text, fire_at, repeat_rule) VALUES (?, ?, ?, ?)`
  ).bind(userId, text, fireAt, repeatRule ?? null).run();
  return (await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(meta.last_row_id).first<Reminder>())!;
}

/** Returns existing reminder if same text + fire_at within ±5 min already pending (used to dedup). */
export async function findDuplicateReminder(
  env: Env, userId: number, text: string, fireAt: number,
): Promise<Reminder | null> {
  const tol = 300;
  return await env.DB.prepare(
    `SELECT * FROM reminders WHERE user_id = ? AND status = 'pending' AND text = ?
       AND fire_at BETWEEN ? AND ? LIMIT 1`,
  ).bind(userId, text, fireAt - tol, fireAt + tol).first<Reminder>();
}

export async function listReminders(env: Env, userId: number, status: 'pending' | 'all' = 'pending'): Promise<Reminder[]> {
  const q = status === 'all'
    ? env.DB.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY fire_at ASC LIMIT 50').bind(userId)
    : env.DB.prepare("SELECT * FROM reminders WHERE user_id = ? AND status = 'pending' ORDER BY fire_at ASC LIMIT 50").bind(userId);
  const res = await q.all<Reminder>();
  return res.results || [];
}

export async function cancelReminder(env: Env, userId: number, id: number): Promise<void> {
  await env.DB.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND user_id = ?").bind(id, userId).run();
}

export async function duePendingReminders(env: Env, beforeSec: number): Promise<Reminder[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM reminders WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at ASC LIMIT 50`
  ).bind(beforeSec).all<Reminder>();
  return res.results || [];
}

export async function markReminderFired(env: Env, id: number, nextFireAt: number | null): Promise<void> {
  if (nextFireAt) {
    await env.DB.prepare(
      `UPDATE reminders SET fired_at = unixepoch(), fire_at = ? WHERE id = ?`
    ).bind(nextFireAt, id).run();
  } else {
    await env.DB.prepare(
      `UPDATE reminders SET fired_at = unixepoch(), status = 'done' WHERE id = ?`
    ).bind(id).run();
  }
}

// ------- Tasks (daily / weekly to-do list) -------

export async function createTask(
  env: Env, userId: number, title: string,
  scope: Task['scope'], dueDate: string | null,
  insertAfterId?: number | null,
): Promise<Task> {
  // Compute sort_order
  let sortOrder: number;
  if (insertAfterId) {
    const after = await env.DB.prepare(
      `SELECT sort_order FROM tasks WHERE id = ? AND user_id = ? AND scope = ?`
    ).bind(insertAfterId, userId, scope).first<{ sort_order: number }>();
    if (after) {
      // Shift everything after this position
      await env.DB.prepare(
        `UPDATE tasks SET sort_order = sort_order + 1 WHERE user_id = ? AND scope = ? AND sort_order > ?`
      ).bind(userId, scope, after.sort_order).run();
      sortOrder = after.sort_order + 1;
    } else {
      sortOrder = (await env.DB.prepare(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS nx FROM tasks WHERE user_id = ? AND scope = ?`
      ).bind(userId, scope).first<{ nx: number }>())!.nx;
    }
  } else {
    sortOrder = (await env.DB.prepare(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS nx FROM tasks WHERE user_id = ? AND scope = ?`
    ).bind(userId, scope).first<{ nx: number }>())!.nx;
  }
  const { meta } = await env.DB.prepare(
    `INSERT INTO tasks (user_id, title, scope, due_date, sort_order) VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, title, scope, dueDate, sortOrder).run();
  return (await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(meta.last_row_id).first<Task>())!;
}

export async function updateTaskTitle(env: Env, userId: number, id: number, title: string): Promise<void> {
  await env.DB.prepare(`UPDATE tasks SET title = ? WHERE id = ? AND user_id = ?`).bind(title, id, userId).run();
}

export async function reorderTasks(env: Env, userId: number, scope: Task['scope'], orderedIds: number[]): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    await env.DB.prepare(
      `UPDATE tasks SET sort_order = ? WHERE id = ? AND user_id = ? AND scope = ?`
    ).bind(i, orderedIds[i], userId, scope).run();
  }
}

export async function listTasks(
  env: Env, userId: number,
  opts: { scope?: Task['scope']; status?: Task['status'] | 'all'; dueDate?: string } = {},
): Promise<Task[]> {
  const where: string[] = ['user_id = ?'];
  const params: unknown[] = [userId];
  if (opts.scope) { where.push('scope = ?'); params.push(opts.scope); }
  if (opts.status && opts.status !== 'all') { where.push('status = ?'); params.push(opts.status); }
  else if (!opts.status) { where.push("status IN ('pending', 'done')"); }
  if (opts.dueDate) { where.push('due_date = ?'); params.push(opts.dueDate); }
  const sql = `SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY status ASC, sort_order ASC, id ASC LIMIT 200`;
  const res = await env.DB.prepare(sql).bind(...params).all<Task>();
  return res.results || [];
}

export async function findTask(env: Env, userId: number, id: number): Promise<Task | null> {
  return await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').bind(id, userId).first<Task>();
}

export async function completeTask(env: Env, userId: number, id: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE tasks SET status = 'done', done_at = unixepoch() WHERE id = ? AND user_id = ? AND status != 'cancelled'`
  ).bind(id, userId).run();
}

export async function uncompleteTask(env: Env, userId: number, id: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE tasks SET status = 'pending', done_at = NULL WHERE id = ? AND user_id = ?`
  ).bind(id, userId).run();
}

export async function cancelTask(env: Env, userId: number, id: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE tasks SET status = 'cancelled' WHERE id = ? AND user_id = ?`
  ).bind(id, userId).run();
}

// ------- Action-triggered reminders -------

export async function createActionReminder(env: Env, userId: number, triggerText: string, message: string): Promise<ActionReminder> {
  const { meta } = await env.DB.prepare(
    `INSERT INTO action_reminders (user_id, trigger_text, message) VALUES (?, ?, ?)`
  ).bind(userId, triggerText, message).run();
  return (await env.DB.prepare('SELECT * FROM action_reminders WHERE id = ?').bind(meta.last_row_id).first<ActionReminder>())!;
}

export async function listActionReminders(env: Env, userId: number, status: ActionReminder['status'] | 'all' = 'active'): Promise<ActionReminder[]> {
  const q = status === 'all'
    ? env.DB.prepare('SELECT * FROM action_reminders WHERE user_id = ? ORDER BY id DESC LIMIT 100').bind(userId)
    : env.DB.prepare('SELECT * FROM action_reminders WHERE user_id = ? AND status = ? ORDER BY id DESC LIMIT 100').bind(userId, status);
  const res = await q.all<ActionReminder>();
  return res.results || [];
}

export async function fireActionReminder(env: Env, userId: number, id: number): Promise<ActionReminder | null> {
  const r = await env.DB.prepare('SELECT * FROM action_reminders WHERE id = ? AND user_id = ?').bind(id, userId).first<ActionReminder>();
  if (!r || r.status !== 'active') return r;
  await env.DB.prepare(
    `UPDATE action_reminders SET status = 'fired', fired_at = unixepoch() WHERE id = ? AND user_id = ?`
  ).bind(id, userId).run();
  return { ...r, status: 'fired', fired_at: nowSec() };
}

export async function cancelActionReminder(env: Env, userId: number, id: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE action_reminders SET status = 'cancelled' WHERE id = ? AND user_id = ?`
  ).bind(id, userId).run();
}

// ------- Habits -------

export async function createHabit(env: Env, userId: number, data: {
  name: string; description?: string; frequency?: string; target_per_week?: number;
}): Promise<Habit> {
  const { meta } = await env.DB.prepare(
    `INSERT INTO habits (user_id, name, description, frequency, target_per_week) VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, data.name, data.description ?? null, data.frequency ?? 'daily', data.target_per_week ?? 7).run();
  return (await env.DB.prepare('SELECT * FROM habits WHERE id = ?').bind(meta.last_row_id).first<Habit>())!;
}

export async function listHabits(env: Env, userId: number): Promise<Habit[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM habits WHERE user_id = ? AND status = 'active' ORDER BY id ASC`
  ).bind(userId).all<Habit>();
  return res.results || [];
}

export async function archiveHabit(env: Env, userId: number, id: number): Promise<void> {
  await env.DB.prepare("UPDATE habits SET status = 'archived' WHERE id = ? AND user_id = ?").bind(id, userId).run();
}

export async function findHabit(env: Env, userId: number, query: string | number): Promise<Habit | null> {
  if (typeof query === 'number') {
    return await env.DB.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?').bind(query, userId).first<Habit>();
  }
  return await env.DB.prepare(
    "SELECT * FROM habits WHERE user_id = ? AND status = 'active' AND lower(name) LIKE ?"
  ).bind(userId, `%${query.toLowerCase()}%`).first<Habit>();
}

export async function logHabit(env: Env, userId: number, habitId: number, doneDate: string, note?: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO habit_logs (habit_id, user_id, done_date, note) VALUES (?, ?, ?, ?)`
  ).bind(habitId, userId, doneDate, note ?? null).run();
}

export async function unlogHabit(env: Env, userId: number, habitId: number, doneDate: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM habit_logs WHERE user_id = ? AND habit_id = ? AND done_date = ?`
  ).bind(userId, habitId, doneDate).run();
}

export async function isHabitDone(env: Env, userId: number, habitId: number, doneDate: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `SELECT 1 FROM habit_logs WHERE user_id = ? AND habit_id = ? AND done_date = ? LIMIT 1`
  ).bind(userId, habitId, doneDate).first();
  return !!r;
}

/** Returns habit log dates within the last `days` days (inclusive of today). */
export async function habitLastNDays(env: Env, userId: number, habitId: number, tz: string, days: number): Promise<string[]> {
  const today = dateInTz(nowSec(), tz);
  const res = await env.DB.prepare(
    `SELECT done_date FROM habit_logs WHERE user_id = ? AND habit_id = ? AND done_date >= date(?, '-' || ? || ' days') ORDER BY done_date ASC`
  ).bind(userId, habitId, today, days - 1).all<{ done_date: string }>();
  return (res.results || []).map(r => r.done_date);
}

export async function habitLast7Days(env: Env, userId: number, habitId: number, tz: string): Promise<string[]> {
  const today = dateInTz(nowSec(), tz);
  const res = await env.DB.prepare(
    `SELECT done_date FROM habit_logs WHERE user_id = ? AND habit_id = ? AND done_date >= date(?, '-6 days') ORDER BY done_date ASC`
  ).bind(userId, habitId, today).all<{ done_date: string }>();
  return (res.results || []).map(r => r.done_date);
}

// ------- Exercises (daily routine tracker) -------

export async function listExercises(env: Env, userId: number, date: string): Promise<Exercise[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM exercises WHERE user_id = ? AND date = ? ORDER BY sort_order ASC, id ASC`
  ).bind(userId, date).all<Exercise>();
  return res.results || [];
}

export async function findExerciseByName(env: Env, userId: number, date: string, name: string): Promise<Exercise | null> {
  return await env.DB.prepare(
    `SELECT * FROM exercises WHERE user_id = ? AND date = ? AND lower(name) = lower(?) LIMIT 1`
  ).bind(userId, date, name).first<Exercise>();
}

export async function createExercise(
  env: Env, userId: number, date: string, name: string, step: number, sortOrder?: number,
): Promise<Exercise> {
  const order = sortOrder ?? (await env.DB.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS nx FROM exercises WHERE user_id = ? AND date = ?`
  ).bind(userId, date).first<{ nx: number }>())!.nx;
  const { meta } = await env.DB.prepare(
    `INSERT INTO exercises (user_id, date, name, reps, step, sort_order) VALUES (?, ?, ?, 0, ?, ?)`
  ).bind(userId, date, name, step, order).run();
  return (await env.DB.prepare('SELECT * FROM exercises WHERE id = ?').bind(meta.last_row_id).first<Exercise>())!;
}

export async function updateExercise(
  env: Env, userId: number, id: number, fields: { name?: string; reps?: number; step?: number; sort_order?: number },
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (fields.name !== undefined) { sets.push('name = ?'); args.push(fields.name); }
  if (fields.reps !== undefined) { sets.push('reps = ?'); args.push(fields.reps); }
  if (fields.step !== undefined) { sets.push('step = ?'); args.push(fields.step); }
  if (fields.sort_order !== undefined) { sets.push('sort_order = ?'); args.push(fields.sort_order); }
  if (!sets.length) return;
  args.push(id, userId);
  await env.DB.prepare(`UPDATE exercises SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...args).run();
}

export async function deleteExercise(env: Env, userId: number, id: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM exercises WHERE id = ? AND user_id = ?`).bind(id, userId).run();
}

/** Copy yesterday's (or last day with exercises before given date) routine into target date with reps=0. */
export async function copyExercisesFromPrevDay(env: Env, userId: number, toDate: string): Promise<number> {
  const last = await env.DB.prepare(
    `SELECT date FROM exercises WHERE user_id = ? AND date < ? ORDER BY date DESC LIMIT 1`
  ).bind(userId, toDate).first<{ date: string }>();
  if (!last) return 0;
  const exs = await env.DB.prepare(
    `SELECT name, step, sort_order FROM exercises WHERE user_id = ? AND date = ? ORDER BY sort_order ASC, id ASC`
  ).bind(userId, last.date).all<{ name: string; step: number; sort_order: number }>();
  const rows = exs.results || [];
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT INTO exercises (user_id, date, name, reps, step, sort_order) VALUES (?, ?, ?, 0, ?, ?)`
    ).bind(userId, toDate, r.name, r.step, r.sort_order).run();
  }
  return rows.length;
}

// ------- Workouts -------

export async function logWorkout(env: Env, userId: number, date: string, summary: string, details?: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workouts (user_id, date, summary, details_json) VALUES (?, ?, ?, ?)`
  ).bind(userId, date, summary, JSON.stringify(details ?? {})).run();
}

export async function recentWorkouts(env: Env, userId: number, days = 7): Promise<Array<{ id: number; date: string; summary: string }>> {
  const res = await env.DB.prepare(
    `SELECT id, date, summary FROM workouts WHERE user_id = ? AND date >= date('now', '-' || ? || ' days') ORDER BY date DESC, id DESC`
  ).bind(userId, days).all<{ id: number; date: string; summary: string }>();
  return res.results || [];
}

export async function deleteWorkout(env: Env, userId: number, id: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM workouts WHERE id = ? AND user_id = ?`).bind(id, userId).run();
}

// ------- Meals -------

export async function logMeal(env: Env, userId: number, date: string, description: string, macros?: {
  kcal?: number; protein_g?: number; fat_g?: number; carbs_g?: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO meals (user_id, date, description, kcal, protein_g, fat_g, carbs_g) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    userId, date, description,
    macros?.kcal ?? null, macros?.protein_g ?? null,
    macros?.fat_g ?? null, macros?.carbs_g ?? null,
  ).run();
}

export async function mealsForDate(env: Env, userId: number, date: string): Promise<Array<{
  id: number; description: string; kcal: number | null; protein_g: number | null; fat_g: number | null; carbs_g: number | null;
}>> {
  const res = await env.DB.prepare(
    `SELECT id, description, kcal, protein_g, fat_g, carbs_g FROM meals WHERE user_id = ? AND date = ? ORDER BY id ASC`
  ).bind(userId, date).all();
  return (res.results || []) as Array<{ id: number; description: string; kcal: number | null; protein_g: number | null; fat_g: number | null; carbs_g: number | null }>;
}

export async function createMeal(env: Env, userId: number, date: string, description: string, macros?: {
  kcal?: number; protein_g?: number; fat_g?: number; carbs_g?: number;
}): Promise<number> {
  const { meta } = await env.DB.prepare(
    `INSERT INTO meals (user_id, date, description, kcal, protein_g, fat_g, carbs_g) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    userId, date, description,
    macros?.kcal ?? null, macros?.protein_g ?? null,
    macros?.fat_g ?? null, macros?.carbs_g ?? null,
  ).run();
  return Number(meta.last_row_id);
}

export async function updateMeal(env: Env, userId: number, id: number, fields: {
  description?: string; kcal?: number | null; protein_g?: number | null; fat_g?: number | null; carbs_g?: number | null;
}): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (fields.description !== undefined) { sets.push('description = ?'); args.push(fields.description); }
  if (fields.kcal !== undefined) { sets.push('kcal = ?'); args.push(fields.kcal); }
  if (fields.protein_g !== undefined) { sets.push('protein_g = ?'); args.push(fields.protein_g); }
  if (fields.fat_g !== undefined) { sets.push('fat_g = ?'); args.push(fields.fat_g); }
  if (fields.carbs_g !== undefined) { sets.push('carbs_g = ?'); args.push(fields.carbs_g); }
  if (!sets.length) return;
  args.push(id, userId);
  await env.DB.prepare(`UPDATE meals SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...args).run();
}

export async function deleteMeal(env: Env, userId: number, id: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM meals WHERE id = ? AND user_id = ?`).bind(id, userId).run();
}

// ------- Daily notes -------

export async function saveDailyNote(env: Env, userId: number, date: string, kind: string, content: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO daily_notes (user_id, date, kind, content) VALUES (?, ?, ?, ?)`
  ).bind(userId, date, kind, content).run();
}

export async function getDailyNote(env: Env, userId: number, date: string, kind: string): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT content FROM daily_notes WHERE user_id = ? AND date = ? AND kind = ? ORDER BY id DESC LIMIT 1`
  ).bind(userId, date, kind).first<{ content: string }>();
  return r?.content ?? null;
}

export async function recentDailyNotes(env: Env, userId: number, days = 7): Promise<Array<{ date: string; kind: string; content: string }>> {
  const res = await env.DB.prepare(
    `SELECT date, kind, content FROM daily_notes WHERE user_id = ? AND date >= date('now', '-' || ? || ' days') ORDER BY date DESC, id DESC`
  ).bind(userId, days).all<{ date: string; kind: string; content: string }>();
  return res.results || [];
}

// ------- KV (scheduler state) -------

export async function kvGet(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function kvSet(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
  ).bind(key, value).run();
}
