// Cron-driven logic: fire due reminders, and trigger morning/evening/sunday prompts.
import type { Env } from './types';
import { sendMessage } from './telegram';
import {
  duePendingReminders, markReminderFired, ensureUser, kvGet, kvSet, getUser,
  listAllUsers, effectiveAccess,
} from './db';
import { dateInTz, timeInTz, dowInTz, nowSec } from './time';
import { systemPrompt } from './llm';

const MORNING_HM = '08:00';
const EVENING_HM = '22:00';
const SUNDAY_REVIEW_HM = '20:00';

export async function runCron(env: Env): Promise<void> {
  // Make sure owner exists in DB.
  const ownerId = Number(env.TG_OWNER_ID);
  await (async () => (await getUser(env, ownerId)) ?? (await ensureUser(env, ownerId)))();

  await fireDueReminders(env);

  // Per-user scheduled prompts (skip users whose subscription is expired).
  const users = await listAllUsers(env);
  for (const u of users) {
    const access = effectiveAccess(u);
    if (!access.allowed) continue;
    try { await maybeScheduledPrompt(env, u.id, u.timezone); }
    catch (e) { console.error('maybeScheduledPrompt failed for user', u.id, e); }
  }
}

async function fireDueReminders(env: Env): Promise<void> {
  const now = nowSec();
  const due = await duePendingReminders(env, now);
  for (const r of due) {
    try {
      await sendMessage(env, r.user_id, `⏰ Напоминание: ${r.text}`);
    } catch (e) {
      console.error('failed to send reminder', e);
    }
    const next = computeNextFireAt(r.fire_at, r.repeat_rule);
    await markReminderFired(env, r.id, next);
  }
}

function computeNextFireAt(prev: number, rule: string | null): number | null {
  if (!rule) return null;
  const day = 86400;
  switch (rule) {
    case 'daily': return prev + day;
    case 'weekly': return prev + 7 * day;
    case 'weekdays': {
      // advance 1 day, then skip sat/sun
      let next = prev + day;
      // use UTC dow here — approximate; repeat fires within a few hours so ok
      for (let i = 0; i < 3; i++) {
        const dow = new Date(next * 1000).getUTCDay();
        if (dow !== 0 && dow !== 6) return next;
        next += day;
      }
      return next;
    }
    default: return null;
  }
}

async function maybeScheduledPrompt(env: Env, userId: number, tz: string): Promise<void> {
  const now = nowSec();
  const localHm = timeInTz(now, tz);
  const localDate = dateInTz(now, tz);
  const dow = dowInTz(now, tz);

  // Only fire right at the exact minute
  if (localHm === MORNING_HM) {
    const key = `morning:${userId}:${localDate}`;
    if (!(await kvGet(env, key))) {
      await kvSet(env, key, '1');
      const text = await systemPrompt(env, userId, tz,
        `Доброе утро (08:00 по ${tz}). Напиши Игорю тёплое короткое сообщение, спроси какой план на день и 3 главные задачи. Если не приходит ответ — не напоминай снова сам, он увидит.`);
      if (text) await sendMessage(env, userId, text);
    }
  }

  if (localHm === EVENING_HM) {
    const key = `evening:${userId}:${localDate}`;
    if (!(await kvGet(env, key))) {
      await kvSet(env, key, '1');
      const text = await systemPrompt(env, userId, tz,
        `Вечер (22:00 по ${tz}). Сделай короткое вечернее ревью: спроси что сделал из утреннего плана, как тренировка/еда если что-то было, какое было настроение/энергия. Через read_context подтяни что он писал сегодня.`);
      if (text) await sendMessage(env, userId, text);
    }
  }

  // Sunday weekly review at 20:00 local
  if (dow === 0 && localHm === SUNDAY_REVIEW_HM) {
    const key = `weekly:${userId}:${localDate}`;
    if (!(await kvGet(env, key))) {
      await kvSet(env, key, '1');
      const text = await systemPrompt(env, userId, tz,
        `Воскресенье 20:00 по ${tz}. Проведи недельное ревью: через read_context подтяни за 7 дней (workouts, meals, notes, habits, goals). Выдай короткий анализ: что получилось, что просело, где видно обман самого себя, одно предложение что улучшить на следующей неделе. Спроси какие 3 главные приоритета на следующую неделю.`);
      if (text) await sendMessage(env, userId, text);
    }
  }
}
