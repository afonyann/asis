// Tool (function-calling) definitions for Gemini and their executors.
// Gemini function-calling schema matches OpenAPI-style JSON schema subset.

import type { Env } from './types';
import {
  createReminder, listReminders, cancelReminder, findDuplicateReminder,
  createActionReminder, listActionReminders, fireActionReminder, cancelActionReminder,
  createTask, listTasks, completeTask, uncompleteTask, cancelTask, findTask, updateTaskTitle, reorderTasks,
  createGoal, updateGoal, listGoals,
  createHabit, listHabits, archiveHabit, findHabit, logHabit, habitLast7Days,
  logWorkout, recentWorkouts,
  listExercises, findExerciseByName, createExercise, updateExercise, deleteExercise,
  logMeal, mealsForDate,
  saveDailyNote, getDailyNote, recentDailyNotes,
  saveMemory, listMemories, deleteMemory,
  updateUserProfile, getUser,
} from './db';
import { dateInTz, nowSec, parseFireAt, formatLocal, mondayOfWeek } from './time';

export const toolDeclarations = [
  {
    name: 'set_reminder',
    description:
      'Создать напоминание ПО ВРЕМЕНИ. Используй ТОЛЬКО когда есть конкретное время (HH:MM, через N минут/часов и т.п.). НЕ используй для списков задач/дел.\n' +
      'fire_at_text форматы:\n' +
      '  • "HH:MM" — сегодня (или завтра если время уже прошло)\n' +
      '  • "через N минут/часов/дней/недель"\n' +
      '  • "через минуту/час/день/неделю" — 1 единица\n' +
      '  • "завтра HH:MM" / "сегодня HH:MM" / "послезавтра HH:MM"\n' +
      '  • "YYYY-MM-DD HH:MM"\n' +
      'repeat_rule: ОПУСКАЙ для разового напоминания (по умолчанию). Передавай "daily"/"weekly"/"weekdays" ТОЛЬКО если Игорь явно сказал «каждый день», «каждую неделю», «по будням» — НИКОГДА не добавляй repeat сам по себе. Простое «напомни в 15:30» — это РАЗОВОЕ, без repeat.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Текст напоминания' },
        fire_at_text: { type: 'string', description: 'Когда, в одном из поддерживаемых форматов' },
        repeat_rule: { type: 'string', enum: ['daily', 'weekly', 'weekdays'], description: 'ТОЛЬКО если явно сказано «каждый/каждую»' },
      },
      required: ['text', 'fire_at_text'],
    },
  },
  {
    name: 'list_reminders',
    description: 'Показать все активные напоминания',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_reminder',
    description: 'Отменить напоминание по id',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'id напоминания' } },
      required: ['id'],
    },
  },
  {
    name: 'cancel_reminders_bulk',
    description: 'Отменить несколько напоминаний разом по списку id. Используй когда Игорь говорит «удали все напоминалки», «отмени все из списка», «убери дубли».',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'integer' }, description: 'Список id напоминаний для отмены' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'create_action_reminder',
    description:
      'Создать напоминание привязанное к ДЕЙСТВИЮ/СОБЫТИЮ (а не ко времени). Используй когда Игорь говорит "напомни КОГДА я ..." / "напомни как только ..." — например "напомни когда пойду гулять купить молоко", "напомни когда приду домой полить цветы", "напомни когда проснусь принять таблетки". trigger_text — короткое описание события (как сам пользователь это назовёт), message — что напомнить.',
    parameters: {
      type: 'object',
      properties: {
        trigger_text: { type: 'string', description: 'Триггер-событие, напр. "пойду гулять", "приду домой", "проснусь"' },
        message: { type: 'string', description: 'Что напомнить когда событие произойдёт' },
      },
      required: ['trigger_text', 'message'],
    },
  },
  {
    name: 'list_action_reminders',
    description: 'Показать активные напоминания-по-событию (ещё не сработавшие)',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'fire_action_reminder',
    description:
      'ВЫЗВАТЬ срабатывание напоминания-по-событию. Используй когда Игорь только что сказал/сделал что-то что соответствует одному из активных триггеров (см. список Active action reminders в системном промпте). Например он написал "вышел гулять" — а у нас активный триггер "пойду гулять купить молоко" — вызови fire_action_reminder с этим id, и в своём ответе обязательно упомяни что нужно сделать (купить молоко). После вызова напоминание помечается как сработавшее и больше не сработает.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'id напоминания из списка активных триггеров' } },
      required: ['id'],
    },
  },
  {
    name: 'cancel_action_reminder',
    description: 'Отменить напоминание-по-событию (если Игорь передумал ждать триггер)',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
  },
  {
    name: 'create_task',
    description:
      'Добавить задачу (todo-пункт) в дневной или недельный список. ' +
      'Используй когда Игорь перечисляет ЗАДАЧИ/ДЕЛА на сегодня/неделю БЕЗ конкретного времени — типа ' +
      '"задачки на сегодня: сходить в вуз, забрать матрас, приготовить покушать", или "на этой неделе надо сделать X, Y, Z". ' +
      'НЕ используй set_reminder для таких списков — это просто чеклист, время не нужно. ' +
      'scope="daily" если задача на день, scope="weekly" если на неделю. ' +
      'Можешь вызвать несколько раз подряд если задач много.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Текст задачи' },
        scope: { type: 'string', enum: ['daily', 'weekly', 'someday'], description: 'daily — на конкретный день, weekly — на неделю, someday — без срока' },
        due_date: { type: 'string', description: 'YYYY-MM-DD. Для daily обычно сегодня, для weekly — понедельник этой недели. Опускай для someday.' },
      },
      required: ['title', 'scope'],
    },
  },
  {
    name: 'edit_task',
    description: 'Изменить текст задачи или вставить её на конкретную позицию в списке. Если insert_after_id указан — задача переместится сразу после задачи с этим id (так работает "вставь X между 2 и 3").',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'id задачи' },
        title: { type: 'string', description: 'новый текст (опц)' },
        insert_after_id: { type: 'integer', description: 'переместить эту задачу сразу после задачи с этим id' },
      },
      required: ['id'],
    },
  },
  {
    name: 'reorder_tasks',
    description: 'Изменить порядок задач в одном scope. Передай список id в нужном порядке. Используй когда Игорь говорит "поменяй местами 1 и 3", "перемести X наверх".',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['daily', 'weekly', 'someday'] },
        ordered_ids: { type: 'array', items: { type: 'integer' }, description: 'id всех задач этого scope в новом порядке' },
      },
      required: ['scope', 'ordered_ids'],
    },
  },
  {
    name: 'list_tasks',
    description: 'Показать активные задачи. По умолчанию — все pending. Можно фильтровать по scope.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['daily', 'weekly', 'someday'] },
        status: { type: 'string', enum: ['pending', 'done', 'all'] },
        due_date: { type: 'string', description: 'YYYY-MM-DD — только задачи на эту дату' },
      },
    },
  },
  {
    name: 'complete_task',
    description: 'Отметить задачу выполненной. Используй когда Игорь говорит "сделал X", "забрал матрас", "сходил в вуз", и это совпадает с одной из активных задач.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
  },
  {
    name: 'cancel_task',
    description: 'Отменить (убрать из списка) задачу',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
  },
  {
    name: 'create_goal',
    description: 'Создать цель (долгосрочную, квартальную, месячную или недельную)',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Короткое название цели' },
        description: { type: 'string', description: 'Детали, критерии успеха' },
        horizon: { type: 'string', enum: ['year', 'quarter', 'month', 'week'] },
        target_date: { type: 'string', description: 'YYYY-MM-DD, опционально' },
      },
      required: ['title', 'horizon'],
    },
  },
  {
    name: 'update_goal',
    description: 'Обновить цель: статус (active/done/paused/dropped), прогресс 0..100, описание',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: ['active', 'done', 'paused', 'dropped'] },
        progress: { type: 'integer', description: '0..100' },
        description: { type: 'string' },
        target_date: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_goals',
    description: 'Показать цели (по умолчанию активные)',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'done', 'paused', 'dropped', 'all'] },
      },
    },
  },
  {
    name: 'create_habit',
    description: 'Добавить привычку в трекер. frequency: "daily" (каждый день) или "weekly" или "mon,wed,fri"',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        frequency: { type: 'string' },
        target_per_week: { type: 'integer' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_habits',
    description: 'Показать все активные привычки со стриком за 7 дней',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'archive_habit',
    description: 'Убрать привычку из активных',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
  },
  {
    name: 'log_habit',
    description: 'Отметить привычку как выполненную. habit может быть id (число) или имя (подстрока). date YYYY-MM-DD, опустить = сегодня',
    parameters: {
      type: 'object',
      properties: {
        habit: { type: 'string', description: 'id или имя привычки' },
        date: { type: 'string', description: 'YYYY-MM-DD, опционально' },
        note: { type: 'string' },
      },
      required: ['habit'],
    },
  },
  {
    name: 'log_workout',
    description: 'Залогировать тренировку как свободный текст в дневник тренировок (общее описание сессии). НЕ использовать для отдельных упражнений с количеством — для них есть exercise_*.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD, опустить = сегодня' },
        summary: { type: 'string' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'add_exercise',
    description: 'Добавить упражнение в дневной список тренировок (например "отжимания", "приседания"). reps стартует с 0. step — шаг для +/- стрелок в дашборде (по умолчанию 1).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'название упражнения' },
        step: { type: 'number', description: 'шаг для кнопок +/- (по умолчанию 1, можно 5/10/25)' },
        date: { type: 'string', description: 'YYYY-MM-DD, опустить = сегодня' },
      },
      required: ['name'],
    },
  },
  {
    name: 'set_exercise_reps',
    description: 'Установить количество повторений упражнения на конкретную дату (или сегодня). exercise — название или id. Используй когда пользователь говорит "сделал 30 отжиманий" / "выставь 50".',
    parameters: {
      type: 'object',
      properties: {
        exercise: { type: 'string', description: 'имя или id упражнения' },
        reps: { type: 'number', description: 'итоговое количество' },
        date: { type: 'string', description: 'YYYY-MM-DD, опустить = сегодня' },
      },
      required: ['exercise', 'reps'],
    },
  },
  {
    name: 'bump_exercise',
    description: 'Прибавить (или убавить — отрицательное) к счётчику упражнения за сегодня. Использовать когда пользователь говорит "сделал ещё 10 отжиманий" — добавит к текущему значению.',
    parameters: {
      type: 'object',
      properties: {
        exercise: { type: 'string', description: 'имя или id упражнения' },
        delta: { type: 'number', description: 'на сколько прибавить (можно отрицательное)' },
      },
      required: ['exercise', 'delta'],
    },
  },
  {
    name: 'list_exercises',
    description: 'Показать упражнения за дату (по умолчанию сегодня) с их текущими счётчиками.',
    parameters: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
    },
  },
  {
    name: 'delete_exercise',
    description: 'Удалить упражнение из списка дня (по имени или id).',
    parameters: {
      type: 'object',
      properties: {
        exercise: { type: 'string' },
        date: { type: 'string' },
      },
      required: ['exercise'],
    },
  },
  {
    name: 'log_meal',
    description: 'Залогировать прием пищи. Если пользователь не указал макросы — оцени сам на основе описания и своих знаний о еде',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Что съел, граммовка. Напр. "овсянка 80г + банан 120г + кофе с молоком"' },
        date: { type: 'string', description: 'YYYY-MM-DD, опустить = сегодня' },
        kcal: { type: 'integer' },
        protein_g: { type: 'integer' },
        fat_g: { type: 'integer' },
        carbs_g: { type: 'integer' },
      },
      required: ['description'],
    },
  },
  {
    name: 'save_daily_note',
    description: 'Сохранить дневную заметку (утренний план, вечернее ревью, мысль, недельное ревью)',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['morning_plan', 'evening_review', 'thought', 'weekly_review'] },
        content: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD, опустить = сегодня' },
      },
      required: ['kind', 'content'],
    },
  },
  {
    name: 'save_memory',
    description:
      'Запомнить факт о пользователе на будущее. Категории: "profile" (личные данные — рост/вес/возраст/универ), "preference" (что любит/не любит), "context" (текущая ситуация — работа/учеба), "fact" (важный факт). ' +
      'Используй активно — если пользователь упомянул что-то важное что надо знать в будущих разговорах.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['profile', 'preference', 'context', 'fact'] },
        content: { type: 'string' },
      },
      required: ['category', 'content'],
    },
  },
  {
    name: 'forget_memory',
    description: 'Удалить факт из долгосрочной памяти по id',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
  },
  {
    name: 'set_timezone',
    description:
      'Изменить таймзону пользователя. Принимай IANA-имя (Europe/Moscow, Asia/Novosibirsk, Asia/Yekaterinburg, Asia/Krasnoyarsk, Asia/Irkutsk, Asia/Vladivostok и т.д.). Используй когда Игорь упомянул свой город/регион.',
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA timezone, напр. "Asia/Novosibirsk"' },
      },
      required: ['timezone'],
    },
  },
  {
    name: 'read_context',
    description:
      'Подтянуть свежий контекст: последние тренировки, еду, дневные заметки за N дней. Используй когда пользователь спрашивает "что я делал", "как тренировки на неделе", или перед недельным ревью.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'За сколько дней назад. По умолчанию 7' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['workouts', 'meals', 'notes', 'reminders', 'goals', 'habits'] },
        },
      },
    },
  },
] as const;

export interface ToolContext {
  env: Env;
  userId: number;
  tz: string;
}

export async function execTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<string> {
  const { env, userId, tz } = ctx;

  try {
    switch (name) {
      case 'set_reminder': {
        const text = String(args.text);
        const fireAtText = String(args.fire_at_text);
        const repeatRule = args.repeat_rule ? String(args.repeat_rule) : undefined;
        const fireAt = parseFireAt(fireAtText, tz);
        if (!fireAt) return JSON.stringify({ ok: false, error: `Не смог распарсить время: "${fireAtText}"` });
        const dup = await findDuplicateReminder(env, userId, text, fireAt);
        if (dup) {
          return JSON.stringify({
            ok: false, duplicate: true, existing_id: dup.id,
            error: `Уже есть такое напоминание #${dup.id} на ${formatLocal(dup.fire_at, tz)} — не создаю дубль.`,
          });
        }
        const r = await createReminder(env, userId, text, fireAt, repeatRule);
        return JSON.stringify({
          ok: true, id: r.id, fires_at: formatLocal(r.fire_at, tz), repeat: r.repeat_rule,
        });
      }

      case 'list_reminders': {
        const rs = await listReminders(env, userId, 'pending');
        return JSON.stringify({
          ok: true,
          reminders: rs.map(r => ({ id: r.id, text: r.text, fires_at: formatLocal(r.fire_at, tz), repeat: r.repeat_rule })),
        });
      }

      case 'cancel_reminder': {
        await cancelReminder(env, userId, Number(args.id));
        return JSON.stringify({ ok: true });
      }

      case 'cancel_reminders_bulk': {
        const ids = (args.ids as unknown[]).map(Number).filter(Number.isFinite);
        for (const id of ids) await cancelReminder(env, userId, id);
        return JSON.stringify({ ok: true, cancelled: ids.length });
      }

      case 'create_action_reminder': {
        const r = await createActionReminder(env, userId, String(args.trigger_text), String(args.message));
        return JSON.stringify({ ok: true, id: r.id, trigger: r.trigger_text, message: r.message });
      }

      case 'list_action_reminders': {
        const rs = await listActionReminders(env, userId, 'active');
        return JSON.stringify({
          ok: true,
          action_reminders: rs.map(r => ({ id: r.id, trigger: r.trigger_text, message: r.message })),
        });
      }

      case 'fire_action_reminder': {
        const id = Number(args.id);
        const r = await fireActionReminder(env, userId, id);
        if (!r) return JSON.stringify({ ok: false, error: 'not found' });
        if (r.status !== 'fired') return JSON.stringify({ ok: false, error: `status=${r.status}` });
        return JSON.stringify({ ok: true, id: r.id, trigger: r.trigger_text, message: r.message });
      }

      case 'cancel_action_reminder': {
        await cancelActionReminder(env, userId, Number(args.id));
        return JSON.stringify({ ok: true });
      }

      case 'create_task': {
        const scope = (args.scope as 'daily' | 'weekly' | 'someday') || 'daily';
        let due: string | null = args.due_date ? String(args.due_date) : null;
        if (!due && scope === 'daily') due = dateInTz(nowSec(), tz);
        if (!due && scope === 'weekly') due = mondayOfWeek(nowSec(), tz);
        const t = await createTask(env, userId, String(args.title), scope, due);
        return JSON.stringify({ ok: true, id: t.id, title: t.title, scope: t.scope, due_date: t.due_date });
      }

      case 'list_tasks': {
        const ts = await listTasks(env, userId, {
          scope: args.scope as 'daily' | 'weekly' | 'someday' | undefined,
          status: args.status as 'pending' | 'done' | 'all' | undefined,
          dueDate: args.due_date as string | undefined,
        });
        return JSON.stringify({
          ok: true,
          tasks: ts.map(t => ({ id: t.id, title: t.title, scope: t.scope, due_date: t.due_date, status: t.status })),
        });
      }

      case 'complete_task': {
        const t = await findTask(env, userId, Number(args.id));
        if (!t) return JSON.stringify({ ok: false, error: 'not found' });
        await completeTask(env, userId, t.id);
        return JSON.stringify({ ok: true, id: t.id, title: t.title });
      }

      case 'cancel_task': {
        await cancelTask(env, userId, Number(args.id));
        return JSON.stringify({ ok: true });
      }

      case 'edit_task': {
        const id = Number(args.id);
        const t = await findTask(env, userId, id);
        if (!t) return JSON.stringify({ ok: false, error: 'not found' });
        if (typeof args.title === 'string' && args.title.trim()) {
          await updateTaskTitle(env, userId, id, String(args.title).trim());
        }
        if (args.insert_after_id !== undefined && args.insert_after_id !== null) {
          // Reorder: place id immediately after insert_after_id within same scope
          const list = await listTasks(env, userId, { scope: t.scope });
          const filtered = list.filter(x => x.id !== id);
          const idx = filtered.findIndex(x => x.id === Number(args.insert_after_id));
          const reordered = [...filtered];
          reordered.splice(idx >= 0 ? idx + 1 : 0, 0, t);
          await reorderTasks(env, userId, t.scope, reordered.map(x => x.id));
        }
        return JSON.stringify({ ok: true, id });
      }

      case 'reorder_tasks': {
        const scope = String(args.scope) as 'daily' | 'weekly' | 'someday';
        const ids = Array.isArray(args.ordered_ids) ? (args.ordered_ids as number[]).map(n => Number(n)) : [];
        await reorderTasks(env, userId, scope, ids);
        return JSON.stringify({ ok: true });
      }

      case 'create_goal': {
        const g = await createGoal(env, userId, {
          title: String(args.title),
          description: args.description ? String(args.description) : undefined,
          horizon: args.horizon as 'year' | 'quarter' | 'month' | 'week',
          target_date: args.target_date ? String(args.target_date) : undefined,
        });
        return JSON.stringify({ ok: true, id: g.id, title: g.title });
      }

      case 'update_goal': {
        const id = Number(args.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['status', 'progress', 'description', 'title', 'target_date']) {
          if (k in args && args[k] !== undefined) patch[k] = args[k];
        }
        const g = await updateGoal(env, userId, id, patch);
        if (!g) return JSON.stringify({ ok: false, error: 'goal not found' });
        return JSON.stringify({ ok: true, goal: { id: g.id, title: g.title, status: g.status, progress: g.progress } });
      }

      case 'list_goals': {
        const status = (args.status as 'active' | 'done' | 'paused' | 'dropped' | 'all') || 'active';
        const gs = await listGoals(env, userId, status);
        return JSON.stringify({
          ok: true,
          goals: gs.map(g => ({
            id: g.id, title: g.title, horizon: g.horizon, status: g.status,
            progress: g.progress, target_date: g.target_date, description: g.description,
          })),
        });
      }

      case 'create_habit': {
        const h = await createHabit(env, userId, {
          name: String(args.name),
          description: args.description ? String(args.description) : undefined,
          frequency: args.frequency ? String(args.frequency) : undefined,
          target_per_week: args.target_per_week ? Number(args.target_per_week) : undefined,
        });
        return JSON.stringify({ ok: true, id: h.id, name: h.name });
      }

      case 'list_habits': {
        const hs = await listHabits(env, userId);
        const withStreaks = await Promise.all(hs.map(async h => {
          const last7 = await habitLast7Days(env, userId, h.id, tz);
          return { id: h.id, name: h.name, frequency: h.frequency, last_7_days_done: last7.length, last_dates: last7 };
        }));
        return JSON.stringify({ ok: true, habits: withStreaks });
      }

      case 'archive_habit': {
        await archiveHabit(env, userId, Number(args.id));
        return JSON.stringify({ ok: true });
      }

      case 'log_habit': {
        const q = args.habit;
        let habit = null;
        if (typeof q === 'number') habit = await findHabit(env, userId, q);
        else if (typeof q === 'string') {
          const asNum = Number(q);
          habit = Number.isFinite(asNum) && String(asNum) === q
            ? await findHabit(env, userId, asNum)
            : await findHabit(env, userId, q);
        }
        if (!habit) return JSON.stringify({ ok: false, error: `Привычка "${q}" не найдена. Сначала создай через create_habit.` });
        const date = args.date ? String(args.date) : dateInTz(nowSec(), tz);
        await logHabit(env, userId, habit.id, date, args.note ? String(args.note) : undefined);
        return JSON.stringify({ ok: true, habit: habit.name, date });
      }

      case 'log_workout': {
        const date = args.date ? String(args.date) : dateInTz(nowSec(), tz);
        await logWorkout(env, userId, date, String(args.summary));
        return JSON.stringify({ ok: true, date });
      }

      case 'add_exercise': {
        const date = args.date ? String(args.date) : dateInTz(nowSec(), tz);
        const name = String(args.name || '').trim();
        if (!name) return JSON.stringify({ ok: false, error: 'name required' });
        const step = args.step ? Math.max(1, Math.min(1000, Math.floor(Number(args.step)))) : 1;
        const existing = await findExerciseByName(env, userId, date, name);
        if (existing) return JSON.stringify({ ok: true, exercise: existing.name, already: true });
        const ex = await createExercise(env, userId, date, name, step);
        return JSON.stringify({ ok: true, id: ex.id, name: ex.name, step: ex.step });
      }

      case 'set_exercise_reps':
      case 'bump_exercise': {
        const date = args.date ? String(args.date) : dateInTz(nowSec(), tz);
        const q = String(args.exercise);
        const asNum = Number(q);
        let ex = null;
        if (Number.isFinite(asNum) && String(asNum) === q) {
          const all = await listExercises(env, userId, date);
          ex = all.find(e => e.id === asNum) || null;
        } else {
          ex = await findExerciseByName(env, userId, date, q);
        }
        if (!ex) {
          // Auto-create on bump if not exists
          if (name === 'bump_exercise') {
            ex = await createExercise(env, userId, date, q, 1);
          } else {
            return JSON.stringify({ ok: false, error: `Упражнение "${q}" не найдено за ${date}. Сначала добавь через add_exercise.` });
          }
        }
        const newReps = name === 'set_exercise_reps'
          ? Math.max(0, Math.floor(Number(args.reps)))
          : Math.max(0, ex.reps + Math.floor(Number(args.delta)));
        await updateExercise(env, userId, ex.id, { reps: newReps });
        return JSON.stringify({ ok: true, exercise: ex.name, reps: newReps, date });
      }

      case 'list_exercises': {
        const date = args.date ? String(args.date) : dateInTz(nowSec(), tz);
        const items = await listExercises(env, userId, date);
        return JSON.stringify({ date, exercises: items.map(e => ({ id: e.id, name: e.name, reps: e.reps, step: e.step })) });
      }

      case 'delete_exercise': {
        const date = args.date ? String(args.date) : dateInTz(nowSec(), tz);
        const q = String(args.exercise);
        const asNum = Number(q);
        let ex = null;
        if (Number.isFinite(asNum) && String(asNum) === q) {
          const all = await listExercises(env, userId, date);
          ex = all.find(e => e.id === asNum) || null;
        } else {
          ex = await findExerciseByName(env, userId, date, q);
        }
        if (!ex) return JSON.stringify({ ok: false, error: 'не найдено' });
        await deleteExercise(env, userId, ex.id);
        return JSON.stringify({ ok: true, deleted: ex.name });
      }

      case 'log_meal': {
        const date = args.date ? String(args.date) : dateInTz(nowSec(), tz);
        await logMeal(env, userId, date, String(args.description), {
          kcal: args.kcal ? Number(args.kcal) : undefined,
          protein_g: args.protein_g ? Number(args.protein_g) : undefined,
          fat_g: args.fat_g ? Number(args.fat_g) : undefined,
          carbs_g: args.carbs_g ? Number(args.carbs_g) : undefined,
        });
        const all = await mealsForDate(env, userId, date);
        const total = all.reduce((acc, m) => ({
          kcal: acc.kcal + (m.kcal ?? 0),
          p: acc.p + (m.protein_g ?? 0),
          f: acc.f + (m.fat_g ?? 0),
          c: acc.c + (m.carbs_g ?? 0),
        }), { kcal: 0, p: 0, f: 0, c: 0 });
        return JSON.stringify({ ok: true, date, total_today: total });
      }

      case 'save_daily_note': {
        const date = args.date ? String(args.date) : dateInTz(nowSec(), tz);
        await saveDailyNote(env, userId, date, String(args.kind), String(args.content));
        return JSON.stringify({ ok: true, date, kind: args.kind });
      }

      case 'save_memory': {
        const m = await saveMemory(env, userId, String(args.category), String(args.content));
        return JSON.stringify({ ok: true, id: m.id });
      }

      case 'forget_memory': {
        await deleteMemory(env, userId, Number(args.id));
        return JSON.stringify({ ok: true });
      }

      case 'set_timezone': {
        const newTz = String(args.timezone);
        try {
          new Intl.DateTimeFormat('en', { timeZone: newTz });
        } catch {
          return JSON.stringify({ ok: false, error: `invalid timezone: ${newTz}` });
        }
        await env.DB.prepare('UPDATE users SET timezone = ?, updated_at = unixepoch() WHERE id = ?')
          .bind(newTz, userId).run();
        return JSON.stringify({ ok: true, timezone: newTz });
      }

      case 'read_context': {
        const days = args.days ? Number(args.days) : 7;
        const include = (args.include as string[]) || ['workouts', 'meals', 'notes', 'reminders', 'goals', 'habits'];
        const out: Record<string, unknown> = {};
        if (include.includes('workouts')) out.workouts = await recentWorkouts(env, userId, days);
        if (include.includes('notes')) out.notes = await recentDailyNotes(env, userId, days);
        if (include.includes('reminders')) out.reminders = await listReminders(env, userId, 'pending');
        if (include.includes('goals')) out.goals = await listGoals(env, userId, 'active');
        if (include.includes('habits')) {
          const hs = await listHabits(env, userId);
          out.habits = await Promise.all(hs.map(async h => ({
            id: h.id, name: h.name, last_7_days_done: (await habitLast7Days(env, userId, h.id, tz)).length,
          })));
        }
        if (include.includes('meals')) {
          const today = dateInTz(nowSec(), tz);
          out.meals_today = await mealsForDate(env, userId, today);
        }
        return JSON.stringify({ ok: true, context: out });
      }

      default:
        return JSON.stringify({ ok: false, error: `unknown tool: ${name}` });
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return JSON.stringify({ ok: false, error: err });
  }
}
