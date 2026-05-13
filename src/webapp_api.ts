// Mini App API endpoints. All require Telegram WebApp initData
// (passed as X-Telegram-Init-Data header). User id is taken from there.
import type { Env } from './types';
import { verifyInitData } from './webapp_auth';
import {
  ensureUser, getUser, updateUserProfile, effectiveAccess,
  listReminders, cancelReminder,
  listActionReminders, cancelActionReminder,
  listTasks, completeTask, uncompleteTask, cancelTask, findTask, updateTaskTitle, reorderTasks,
  listHabits, habitLast7Days, habitLastNDays, logHabit, unlogHabit, isHabitDone, findHabit, archiveHabit,
  listGoals,
  listExercises, createExercise, updateExercise, deleteExercise, copyExercisesFromPrevDay,
  recentWorkouts, deleteWorkout,
  mealsForDate, createMeal, updateMeal, deleteMeal,
} from './db';
import { dateInTz, nowSec, mondayOfWeek } from './time';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function authedUserId(env: Env, request: Request): Promise<{ userId: number; firstName?: string; username?: string } | null> {
  const initData = request.headers.get('X-Telegram-Init-Data') || '';
  const verified = await verifyInitData(env, initData);
  if (!verified) return null;
  return {
    userId: verified.user.id,
    firstName: verified.user.first_name,
    username: verified.user.username,
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function handleApi(env: Env, request: Request, path: string): Promise<Response> {
  const auth = await authedUserId(env, request);
  if (!auth) return json({ error: 'unauthorized' }, 401);
  const userId = auth.userId;

  // Auto-create on first dashboard hit so users land on a clean trial.
  const user = await ensureUser(env, userId, auth.firstName, auth.username);
  const tz = user.timezone;
  const today = dateInTz(nowSec(), tz);

  // Subscription gate: read endpoints stay open so the user can see what they
  // already have, but writes require active access.
  const access = effectiveAccess(user);
  if (!access.allowed && request.method !== 'GET') {
    return json({ error: 'subscription_required', reason: access.reason }, 402);
  }

  if (request.method === 'GET' && path === '/api/today') {
    const monday = mondayOfWeek(nowSec(), tz);
    const [reminders, actionReminders, dailyTasks, weeklyTasks, habits, meals] = await Promise.all([
      listReminders(env, userId, 'pending'),
      listActionReminders(env, userId, 'active'),
      listTasks(env, userId, { scope: 'daily', dueDate: today }),
      listTasks(env, userId, { scope: 'weekly', dueDate: monday }),
      listHabits(env, userId),
      mealsForDate(env, userId, today),
    ]);
    const habitsToday = await Promise.all(habits.map(async h => {
      const last7 = await habitLastNDays(env, userId, h.id, tz, 7);
      const last30 = await habitLastNDays(env, userId, h.id, tz, 30);
      return {
        id: h.id, name: h.name,
        last_7_done: last7.length,
        streak: computeStreak(last30, today),
        done_today: last7.includes(today),
      };
    }));
    const total = meals.reduce((acc, m) => ({
      kcal: acc.kcal + (m.kcal ?? 0),
      p: acc.p + (m.protein_g ?? 0),
      f: acc.f + (m.fat_g ?? 0),
      c: acc.c + (m.carbs_g ?? 0),
    }), { kcal: 0, p: 0, f: 0, c: 0 });

    const mapTask = (t: { id: number; title: string; status: string; due_date: string | null; scope: string }) => ({
      id: t.id, title: t.title, status: t.status, due_date: t.due_date, scope: t.scope,
    });
    return json({
      today,
      week_start: monday,
      daily_tasks: dailyTasks.map(mapTask),
      weekly_tasks: weeklyTasks.map(mapTask),
      reminders: reminders.map(r => ({
        id: r.id, text: r.text,
        fires_at: localShort(r.fire_at, tz),
        repeat: r.repeat_rule,
      })),
      action_reminders: actionReminders.map(r => ({
        id: r.id, trigger: r.trigger_text, message: r.message,
      })),
      habits: habitsToday,
      meals_total: total,
    });
  }

  if (request.method === 'GET' && path === '/api/tasks') {
    const monday = mondayOfWeek(nowSec(), tz);
    const [daily, weekly, someday, goals] = await Promise.all([
      listTasks(env, userId, { scope: 'daily', dueDate: today }),
      listTasks(env, userId, { scope: 'weekly', dueDate: monday }),
      listTasks(env, userId, { scope: 'someday' }),
      listGoals(env, userId, 'active'),
    ]);
    const mapTask = (t: { id: number; title: string; status: string; due_date: string | null; scope: string }) => ({
      id: t.id, title: t.title, status: t.status, due_date: t.due_date, scope: t.scope,
    });
    return json({
      today, week_start: monday,
      daily: daily.map(mapTask),
      weekly: weekly.map(mapTask),
      someday: someday.map(mapTask),
      goals,
    });
  }

  if (request.method === 'POST' && path === '/api/tasks/toggle') {
    const body = await readJson(request);
    const id = Number(body.id);
    if (!id) return json({ error: 'id required' }, 400);
    const t = await findTask(env, userId, id);
    if (!t) return json({ error: 'not found' }, 404);
    if (t.status === 'done') {
      await uncompleteTask(env, userId, id);
      return json({ ok: true, status: 'pending' });
    } else {
      await completeTask(env, userId, id);
      return json({ ok: true, status: 'done' });
    }
  }

  if (request.method === 'POST' && path === '/api/tasks/cancel') {
    const body = await readJson(request);
    const id = Number(body.id);
    if (!id) return json({ error: 'id required' }, 400);
    await cancelTask(env, userId, id);
    return json({ ok: true });
  }

  if (request.method === 'POST' && path === '/api/tasks/update') {
    const body = await readJson(request);
    const id = Number(body.id);
    if (!id) return json({ error: 'id required' }, 400);
    if (typeof body.title === 'string') {
      const title = body.title.trim();
      if (title) await updateTaskTitle(env, userId, id, title);
    }
    return json({ ok: true });
  }

  if (request.method === 'POST' && path === '/api/tasks/reorder') {
    const body = await readJson(request);
    const scope = String(body.scope) as 'daily' | 'weekly' | 'someday';
    const ids: number[] = Array.isArray(body.ordered_ids) ? body.ordered_ids.map(Number).filter((n: number) => Number.isFinite(n)) : [];
    if (!['daily', 'weekly', 'someday'].includes(scope)) return json({ error: 'bad scope' }, 400);
    if (!ids.length) return json({ error: 'ordered_ids required' }, 400);
    await reorderTasks(env, userId, scope, ids);
    return json({ ok: true });
  }

  if (request.method === 'GET' && path === '/api/habits') {
    const habits = await listHabits(env, userId);
    const monday = mondayOfWeek(nowSec(), tz);
    const weekDates = nextNDates(monday, 7); // Mon..Sun
    const out = await Promise.all(habits.map(async h => {
      const last30 = await habitLastNDays(env, userId, h.id, tz, 30);
      const set = new Set(last30);
      const week_done = weekDates.filter(d => set.has(d));
      const streak = computeStreak(last30, today);
      return {
        id: h.id, name: h.name, frequency: h.frequency,
        week_done,
        last_30_count: last30.length,
        streak,
        done_today: set.has(today),
      };
    }));
    return json({ today, week_start: monday, week_dates: weekDates, habits: out });
  }

  if (request.method === 'GET' && path === '/api/goals') {
    const goals = await listGoals(env, userId, 'active');
    return json({ goals });
  }

  if (request.method === 'GET' && path === '/api/workouts') {
    const url = new URL(request.url);
    const days = parseInt(url.searchParams.get('days') || '7', 10);
    const workouts = await recentWorkouts(env, userId, days);
    return json({ workouts });
  }

  if (request.method === 'POST' && path === '/api/workouts/delete') {
    const body = await readJson(request);
    const id = Number(body.id);
    if (!id) return json({ error: 'id required' }, 400);
    await deleteWorkout(env, userId, id);
    return json({ ok: true });
  }

  if (request.method === 'GET' && path === '/api/exercises') {
    const url = new URL(request.url);
    const date = url.searchParams.get('date') || today;
    const exercises = await listExercises(env, userId, date);
    return json({ date, exercises });
  }

  if (request.method === 'POST' && path === '/api/exercises/create') {
    const body = await readJson(request);
    const name = String(body.name || '').trim();
    const step = Math.max(1, Math.min(1000, Number(body.step) || 1));
    const date = (body.date as string) || today;
    if (!name) return json({ error: 'name required' }, 400);
    const ex = await createExercise(env, userId, date, name, step);
    return json({ ok: true, exercise: ex });
  }

  if (request.method === 'POST' && path === '/api/exercises/update') {
    const body = await readJson(request);
    const id = Number(body.id);
    if (!id) return json({ error: 'id required' }, 400);
    const fields: { name?: string; reps?: number; step?: number; sort_order?: number } = {};
    if (typeof body.name === 'string') fields.name = body.name.trim();
    if (body.reps !== undefined) fields.reps = Math.max(0, Math.floor(Number(body.reps) || 0));
    if (body.step !== undefined) fields.step = Math.max(1, Math.min(1000, Math.floor(Number(body.step) || 1)));
    if (body.sort_order !== undefined) fields.sort_order = Math.floor(Number(body.sort_order));
    await updateExercise(env, userId, id, fields);
    return json({ ok: true });
  }

  if (request.method === 'POST' && path === '/api/exercises/delete') {
    const body = await readJson(request);
    const id = Number(body.id);
    if (!id) return json({ error: 'id required' }, 400);
    await deleteExercise(env, userId, id);
    return json({ ok: true });
  }

  if (request.method === 'POST' && path === '/api/exercises/copy_prev') {
    const body = await readJson(request);
    const date = (body.date as string) || today;
    const copied = await copyExercisesFromPrevDay(env, userId, date);
    return json({ ok: true, copied });
  }

  if (request.method === 'GET' && path === '/api/meals') {
    const url = new URL(request.url);
    const date = url.searchParams.get('date') || today;
    const meals = await mealsForDate(env, userId, date);
    const total = meals.reduce((acc, m) => ({
      kcal: acc.kcal + (m.kcal ?? 0),
      p: acc.p + (m.protein_g ?? 0),
      f: acc.f + (m.fat_g ?? 0),
      c: acc.c + (m.carbs_g ?? 0),
    }), { kcal: 0, p: 0, f: 0, c: 0 });
    return json({ date, meals, total });
  }

  if (request.method === 'POST' && path === '/api/meals/create') {
    const body = await readJson(request);
    const date = (body.date as string) || today;
    const description = String(body.description || '').trim();
    if (!description) return json({ error: 'description required' }, 400);
    const macros = {
      kcal: typeof body.kcal === 'number' ? body.kcal : undefined,
      protein_g: typeof body.protein_g === 'number' ? body.protein_g : undefined,
      fat_g: typeof body.fat_g === 'number' ? body.fat_g : undefined,
      carbs_g: typeof body.carbs_g === 'number' ? body.carbs_g : undefined,
    };
    const id = await createMeal(env, userId, date, description, macros);
    return json({ ok: true, id });
  }

  if (request.method === 'POST' && path === '/api/meals/update') {
    const body = await readJson(request);
    const id = Number(body.id);
    if (!id) return json({ error: 'id required' }, 400);
    const fields: Record<string, unknown> = {};
    if (typeof body.description === 'string') fields.description = body.description.trim();
    if (typeof body.kcal === 'number') fields.kcal = body.kcal;
    if (typeof body.protein_g === 'number') fields.protein_g = body.protein_g;
    if (typeof body.fat_g === 'number') fields.fat_g = body.fat_g;
    if (typeof body.carbs_g === 'number') fields.carbs_g = body.carbs_g;
    await updateMeal(env, userId, id, fields as Parameters<typeof updateMeal>[3]);
    return json({ ok: true });
  }

  if (request.method === 'POST' && path === '/api/meals/delete') {
    const body = await readJson(request);
    const id = Number(body.id);
    if (!id) return json({ error: 'id required' }, 400);
    await deleteMeal(env, userId, id);
    return json({ ok: true });
  }

  if (request.method === 'POST' && path === '/api/habits/log') {
    const body = await readJson(request);
    const habitId = Number(body.habit_id);
    if (!habitId) return json({ error: 'habit_id required' }, 400);
    const habit = await findHabit(env, userId, habitId);
    if (!habit) return json({ error: 'habit not found' }, 404);
    const date = (body.date as string) || today;
    const wasDone = await isHabitDone(env, userId, habit.id, date);
    if (wasDone) {
      await unlogHabit(env, userId, habit.id, date);
      return json({ ok: true, habit: habit.name, date, done: false });
    } else {
      await logHabit(env, userId, habit.id, date);
      return json({ ok: true, habit: habit.name, date, done: true });
    }
  }

  if (request.method === 'POST' && path === '/api/habits/delete') {
    const body = await readJson(request);
    const id = Number(body.habit_id);
    if (!id) return json({ error: 'habit_id required' }, 400);
    await archiveHabit(env, userId, id);
    return json({ ok: true });
  }

  if (request.method === 'POST' && path === '/api/reminders/cancel') {
    const body = await readJson(request);
    const id = Number(body.id);
    if (!id) return json({ error: 'id required' }, 400);
    await cancelReminder(env, userId, id);
    return json({ ok: true });
  }

  if (request.method === 'POST' && path === '/api/reminders/cancel_all') {
    const all = await listReminders(env, userId, 'pending');
    for (const r of all) await cancelReminder(env, userId, r.id);
    return json({ ok: true, cancelled: all.length });
  }

  if (request.method === 'POST' && path === '/api/action_reminders/cancel') {
    const body = await readJson(request);
    const id = Number(body.id);
    if (!id) return json({ error: 'id required' }, 400);
    await cancelActionReminder(env, userId, id);
    return json({ ok: true });
  }

  // -------- Settings: Groq API Key --------
  if (request.method === 'GET' && path === '/api/settings') {
    const u = await getUser(env, userId);
    const profile = JSON.parse(u?.profile_json || '{}');
    // Return masked key (show last 4 chars only)
    const raw = profile.groq_api_key || '';
    const masked = raw ? ('•'.repeat(Math.max(0, raw.length - 4)) + raw.slice(-4)) : '';
    return json({ groq_api_key_masked: masked, has_groq_key: !!raw });
  }

  if (request.method === 'POST' && path === '/api/settings') {
    const body = await readJson(request);
    if (typeof body.groq_api_key === 'string') {
      const key = body.groq_api_key.trim();
      await updateUserProfile(env, userId, { groq_api_key: key || null });
      return json({ ok: true, has_groq_key: !!key });
    }
    return json({ error: 'nothing to update' }, 400);
  }

  return json({ error: 'not found' }, 404);
}

function localShort(unixSec: number, tz: string): string {
  const d = new Date(unixSec * 1000);
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    day: '2-digit', month: '2-digit',
  };
  return new Intl.DateTimeFormat('ru-RU', opts).format(d);
}

function nextNDates(start: string, n: number): string[] {
  const out: string[] = [];
  const [y, m, d] = start.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  for (let i = 0; i < n; i++) {
    const d2 = new Date(base.getTime() + i * 86400000);
    const yy = d2.getUTCFullYear();
    const mm = String(d2.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d2.getUTCDate()).padStart(2, '0');
    out.push(`${yy}-${mm}-${dd}`);
  }
  return out;
}

function lastNDates(today: string, n: number): string[] {
  const out: string[] = [];
  const [y, m, d] = today.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  for (let i = n - 1; i >= 0; i--) {
    const d2 = new Date(base.getTime() - i * 86400000);
    const yy = d2.getUTCFullYear();
    const mm = String(d2.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d2.getUTCDate()).padStart(2, '0');
    out.push(`${yy}-${mm}-${dd}`);
  }
  return out;
}

/** Current streak: consecutive days up to today (or up to yesterday if today not done). */
function computeStreak(doneDates: string[], today: string): number {
  const set = new Set(doneDates);
  const [y, m, d] = today.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  let streak = 0;
  let started = set.has(today);
  if (!started) base.setUTCDate(base.getUTCDate() - 1);
  for (let i = 0; i < 365; i++) {
    const yy = base.getUTCFullYear();
    const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(base.getUTCDate()).padStart(2, '0');
    const key = `${yy}-${mm}-${dd}`;
    if (set.has(key)) { streak++; base.setUTCDate(base.getUTCDate() - 1); }
    else break;
  }
  return streak;
}
