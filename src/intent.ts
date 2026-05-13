// Deterministic "fast path" intent parser.
//
// Many of Igor's commands are obvious and don't need an LLM at all:
//   "напомни через 15 минут попить воды"
//   "добавь задачу прибраться"
//   "новая привычка чистить зубы"
//   "добавь упражнение приседания 10 раз"
//
// We detect these locally, execute the action directly, and skip the LLM.
// This is faster, free, and 100% reliable — no risk of the model emitting "Окей."
// without a tool call.
//
// Anything we don't recognise falls through to the regular LLM chat flow.

import type { Env } from './types';
import {
  createReminder, findDuplicateReminder,
  createTask, createHabit, createExercise, findExerciseByName, updateExercise,
} from './db';
import { parseFireAt, formatLocal, dateInTz } from './time';

export interface FastPathResult {
  /** Reply text to send to the user. */
  reply: string;
  /** Original user input, normalised for the message log. */
  logText: string;
}

/** Try to parse and execute a deterministic command. Returns null if no fast-path matched. */
export async function tryFastPath(
  env: Env,
  userId: number,
  tz: string,
  input: string,
): Promise<FastPathResult | null> {
  const raw = input.trim();
  if (!raw) return null;
  // Strip leading filler like "Эй ассистент," / "Ассистент,"
  const cleaned = raw.replace(/^[\s,—\-]+/, '').replace(/[\s.!?…]+$/, '');

  // ---------- 1. Reminder by time ----------
  const verbRem = /^(?:напомн\S*|поставь\s+напоминан\S*|создай\s+напоминан\S*|поставь\s+таймер|таймер)/i;
  if (verbRem.test(cleaned)) {
    // Try in any order: time-then-text OR text-then-time.
    const head = cleaned.replace(verbRem, '').replace(/^[\s,:.—\-]+/, '');
    // Look for "через N (секунд|минут|час|дн|недел) [...]" anywhere in head
    const rel = head.match(/^через\s+(\d+)\s+(секунд\S*|минут\S*|час\S*|дн\S*|недел\S*)(?:[\s,]+(.+))?$/i)
      || head.match(/^(.+?)[\s,]+через\s+(\d+)\s+(секунд\S*|минут\S*|час\S*|дн\S*|недел\S*)$/i);
    if (rel) {
      let n: string, unit: string, text: string;
      if (rel.length === 4 && rel[1] && /^\d+$/.test(rel[1])) {
        // time-then-text form
        n = rel[1]; unit = rel[2]; text = (rel[3] || '').trim();
      } else {
        // text-then-time form
        text = rel[1].trim(); n = rel[2]; unit = rel[3];
      }
      const fireAtText = `через ${n} ${unit.toLowerCase()}`;
      return await createReminderFromMatch(env, userId, tz, text || 'Напоминание', fireAtText);
    }
    // "напомн* в HH[:MM] [TEXT]" / "напомн* сегодня|завтра в HH:MM [TEXT]"
    const at = head.match(/^(?:(сегодня|завтра|послезавтра)\s+)?(?:в\s+)?(\d{1,2})(?:[:.](\d{2}))?(?:[\s,]+(.+))?$/i)
      || head.match(/^(.+?)[\s,]+(?:(сегодня|завтра|послезавтра)\s+)?(?:в\s+)?(\d{1,2})[:.](\d{2})$/i);
    if (at) {
      let day = '', hh = 0, mm = 0, text = '';
      if (at.length === 5 && (at[2] !== undefined && /^\d+$/.test(at[2]))) {
        // "[сегодня|завтра]?[в]?HH[:MM] [TEXT]"
        day = (at[1] || '').toLowerCase();
        hh = parseInt(at[2], 10);
        mm = at[3] ? parseInt(at[3], 10) : 0;
        text = (at[4] || '').trim();
      } else {
        // "TEXT [сегодня|завтра]?[в]?HH:MM"
        text = at[1].trim();
        day = (at[2] || '').toLowerCase();
        hh = parseInt(at[3], 10);
        mm = parseInt(at[4], 10);
      }
      if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) {
        const fireAtText = day ? `${day} ${pad2(hh)}:${pad2(mm)}` : `в ${pad2(hh)}:${pad2(mm)}`;
        return await createReminderFromMatch(env, userId, tz, text || 'Напоминание', fireAtText);
      }
    }
    // didn't match a time format — let LLM handle it
  }

  // ---------- 2. Task ----------
  // "добавь задачу X" / "новая задача X" / "запиши задачу X" / "задача на сегодня X"
  const taskMatch = cleaned.match(
    /^(?:добав(?:ь|ить)\s+(?:новую\s+)?задач\S*|нов(?:ая|ой|ое)\s+задач\S*|запиши\s+(?:в\s+)?задач\S*)(?:\s+на\s+(сегодня|завтра|неделю|след(?:ующую)?\s+неделю|когда[\s-]?нибудь))?[\s:,—\-]+(.+)$/i,
  );
  if (taskMatch) {
    const scopeWord = (taskMatch[1] || '').toLowerCase();
    const scope: 'daily' | 'weekly' | 'someday' =
      scopeWord.startsWith('недел') || scopeWord.startsWith('след') ? 'weekly' :
      scopeWord.startsWith('когда') ? 'someday' : 'daily';
    const title = taskMatch[2].trim();
    if (title) {
      const t = await createTask(env, userId, title, scope, null, null);
      const scopeLabel = scope === 'daily' ? 'на сегодня' : scope === 'weekly' ? 'на неделю' : 'когда-нибудь';
      return { reply: `Задача «${t.title}» ${scopeLabel} #${t.id}`, logText: input };
    }
  }

  // ---------- 3. Habit ----------
  const habitMatch = cleaned.match(
    /^(?:добав(?:ь|ить)\s+(?:новую\s+)?привычк\S*|нов(?:ая|ой|ое)\s+привычк\S*|запиши\s+(?:в\s+)?привычк\S*)[\s:,—\-]+(.+)$/i,
  );
  if (habitMatch) {
    const name = habitMatch[1].trim();
    if (name) {
      const h = await createHabit(env, userId, { name, frequency: 'daily', target_per_week: 7 });
      return { reply: `Привычка «${h.name}» добавлена. Отмечай в дашборде или говори «сделал» чтобы залогать.`, logText: input };
    }
  }

  // ---------- 4. Exercise ----------
  // "добавь упражнение X (N раз)?" / "новое упражнение X N раз" / "упражнение X N штук"
  const exMatch = cleaned.match(
    /^(?:добав(?:ь|ить)\s+(?:новое\s+)?упражнен\S*|нов(?:ое|ого)\s+упражнен\S*|упражнен\S*)[\s:,—\-]+(.+?)(?:[\s,]+(\d+)\s*(?:раз\S*|штук\S*|повтор\S*))?$/i,
  );
  if (exMatch) {
    const name = exMatch[1].trim();
    const reps = exMatch[2] ? parseInt(exMatch[2], 10) : 0;
    if (name) {
      const today = dateInTz(Math.floor(Date.now() / 1000), tz);
      let ex = await findExerciseByName(env, userId, today, name);
      if (!ex) {
        ex = await createExercise(env, userId, today, name, 1);
      }
      if (reps > 0) {
        await updateExercise(env, userId, ex.id, { reps });
      }
      return {
        reply: reps > 0
          ? `Добавил "${ex.name}" (${reps}).`
          : `Добавил упражнение "${ex.name}".`,
        logText: input,
      };
    }
  }

  return null;
}

async function createReminderFromMatch(
  env: Env, userId: number, tz: string, text: string, fireAtText: string,
): Promise<FastPathResult> {
  const fireAt = parseFireAt(fireAtText, tz);
  if (!fireAt) {
    return { reply: `Не понял время "${fireAtText}". Скажи иначе — например «через 15 минут» или «в 19:40».`, logText: text };
  }
  // Cleanup the reminder text — strip trailing imperative fillers.
  const cleanText = text.replace(/^[,\s—\-:]+/, '').replace(/[.,!\s]+$/, '').trim() || 'Напоминание';
  const dup = await findDuplicateReminder(env, userId, cleanText, fireAt);
  if (dup) {
    return {
      reply: `Уже есть похожее напоминание #${dup.id} на ${formatLocal(dup.fire_at, tz)} — не дублирую.`,
      logText: text,
    };
  }
  const r = await createReminder(env, userId, cleanText, fireAt, undefined);
  return {
    reply: `Поставил: «${cleanText}» — ${formatLocal(r.fire_at, tz)}`,
    logText: text,
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
