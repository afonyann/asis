// Gemini LLM client with function-calling support.
// We use the raw REST endpoint to avoid SDK bloat on Workers.

import type { Env, Message } from './types';
import { toolDeclarations, execTool, type ToolContext } from './tools';
import { recentMessages, saveMessage, listMemories, listGoals, listHabits, habitLast7Days, listActionReminders, listTasks, getUser } from './db';
import { dateInTz, timeInTz, dowInTz, nowSec, mondayOfWeek } from './time';
import { callGroqChat } from './groq';
import type { GeminiContent, GeminiPart, GeminiResponse } from './llm_types';

export type { GeminiContent, GeminiPart, GeminiResponse } from './llm_types';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'];

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function hasImage(contents: GeminiContent[]): boolean {
  return contents.some(c => c.parts.some(p => p.inlineData?.mimeType?.startsWith('image/')));
}

/**
 * Provider router. Default order:
 *   - Groq Llama 3.3 70B Versatile (fast, good function calling, 30 RPM free)
 *   - Gemini (handles images natively; also acts as fallback when Groq 429s)
 * If the conversation includes an image, we go to Gemini directly because
 * Llama 3.3 is text-only.
 */
async function callLlm(env: Env, contents: GeminiContent[], systemInstruction: string, userGroqKey?: string | null): Promise<GeminiResponse> {
  if (hasImage(contents)) {
    return await callGemini(env, contents, systemInstruction);
  }
  const groqKey = userGroqKey || env.GROQ_API_KEY;
  if (groqKey) {
    const groq = await callGroqChat(env, contents, systemInstruction, groqKey);
    if (groq.candidates && groq.candidates.length > 0 && !groq.error) return groq;
    console.warn('Groq failed, falling back to Gemini:', groq.error?.message?.slice(0, 200));
  }
  return await callGemini(env, contents, systemInstruction);
}

/** Try the primary model, fall back to lite on quota/429, retry once on 5xx. */
async function callGemini(env: Env, contents: GeminiContent[], systemInstruction: string): Promise<GeminiResponse> {
  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemInstruction }] },
    tools: [{ functionDeclarations: toolDeclarations }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  // Build ordered model list: configured primary first, then fallbacks (dedup).
  const models = [env.GEMINI_MODEL, ...FALLBACK_MODELS].filter((v, i, a) => v && a.indexOf(v) === i);

  let lastJson: GeminiResponse = {};
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await resp.json()) as GeminiResponse;
      lastJson = json;

      if (resp.ok && !json.error) {
        if (attempt > 0 || model !== env.GEMINI_MODEL) {
          console.log(`Gemini: recovered via ${model} (attempt ${attempt + 1})`);
        }
        return json;
      }

      const code = json.error?.code ?? resp.status;
      console.error(`Gemini ${model} attempt ${attempt + 1} error ${code}:`, json.error?.message?.slice(0, 200));

      // 429 / quota → fall through to next model immediately
      if (code === 429) break;
      // 5xx → retry same model once after brief wait
      if (code >= 500 && code < 600 && attempt === 0) {
        await sleep(500);
        continue;
      }
      // Other errors (400/401/403) — don't retry this model, try next
      break;
    }
  }
  return lastJson;
}

export async function buildSystemInstruction(env: Env, userId: number, tz: string): Promise<string> {
  const now = nowSec();
  const today = dateInTz(now, tz);
  const nowHm = timeInTz(now, tz);
  const weekday = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'][
    dowInTz(now, tz)
  ];
  const memories = await listMemories(env, userId);
  const goals = await listGoals(env, userId, 'active');
  const habits = await listHabits(env, userId);
  const habitsWithStreaks = await Promise.all(
    habits.map(async h => ({
      name: h.name,
      last_7: (await habitLast7Days(env, userId, h.id, tz)).length,
    }))
  );
  const actionReminders = await listActionReminders(env, userId, 'active');
  const monday = mondayOfWeek(now, tz);
  const dailyTasks = await listTasks(env, userId, { scope: 'daily', dueDate: today });
  const weeklyTasks = await listTasks(env, userId, { scope: 'weekly', dueDate: monday });

  const memLines = memories.length
    ? memories.map(m => `- [${m.category}#${m.id}] ${m.content}`).join('\n')
    : '(пока ничего не запомнил)';
  const goalLines = goals.length
    ? goals.map(g => `- #${g.id} [${g.horizon}] ${g.title} — ${g.status}, ${g.progress}%${g.target_date ? ` (до ${g.target_date})` : ''}`).join('\n')
    : '(целей нет)';
  const habitLines = habitsWithStreaks.length
    ? habitsWithStreaks.map(h => `- ${h.name}: ${h.last_7}/7 за неделю`).join('\n')
    : '(привычек нет)';
  const actionLines = actionReminders.length
    ? actionReminders.map(r => `- #${r.id} КОГДА «${r.trigger_text}» → НАПОМНИТЬ «${r.message}»`).join('\n')
    : '(нет)';
  const fmtTask = (t: { id: number; title: string; status: string }) =>
    `- #${t.id} ${t.status === 'done' ? '[x]' : '[ ]'} ${t.title}`;
  const dailyLines = dailyTasks.length ? dailyTasks.map(fmtTask).join('\n') : '(пусто)';
  const weeklyLines = weeklyTasks.length ? weeklyTasks.map(fmtTask).join('\n') : '(пусто)';

  return `
Ты — личный ассистент Игоря. Игорь — студент из России, подрабатывает курьером, хочет расти личностно/профессионально/физически.

ВАЖНО ПРО ТВОИ ВОЗМОЖНОСТИ:
- Ты МОЖЕШЬ слушать и понимать голосовые сообщения (audio/ogg) — Игорь часто присылает их вместо текста. Никогда не говори "я не могу обработать голосовые" — ты умеешь это по умолчанию, воспринимай audio как обычное сообщение от Игоря.
- Ты МОЖЕШЬ смотреть на фото и разбирать что на них изображено.
- Ты МОЖЕШЬ создавать напоминания, цели, привычки, логировать тренировки и еду через доступные функции. Всегда используй функции сам — не отвечай "я не могу" если есть подходящий tool.

Твоя роль:
1. Коуч и thinking partner — помогать ставить цели, разбирать что мешает, давать честную обратную связь
2. Менеджер задач — вести напоминания, привычки, дневные планы и ревью
3. Трекер — фиксировать тренировки, еду, заметки
4. Долгосрочная память — запоминать важные факты через save_memory и использовать их в будущих разговорах

Как общаться:
- По-русски, живо, как старший друг (не как робот)
- Кратко и по делу, без воды. Короткий ответ лучше длинного.
- Не льсти и не соглашайся автоматически, если видишь что Игорь себя обманывает — мягко укажи
- Не используй эмодзи и markdown-форматирование
- Если Игорь упоминает что-то важное для будущего (планы, цели, предпочтения, факты о себе) — сохрани через save_memory
- ВАЖНО различай три инструмента:
  • set_reminder — НАПОМИНАНИЕ ПО ВРЕМЕНИ. Только если Игорь явно просит «напомни в HH:MM», «напомни через N минут», «каждый день в 7». Без явного времени НЕ создавай напоминаний. По умолчанию repeat_rule НЕ передавай — это разовое. Передавай repeat ТОЛЬКО если Игорь буквально сказал «каждый день / каждую неделю / по будням».
  • create_action_reminder — НАПОМИНАНИЕ ПО СОБЫТИЮ. «Напомни КОГДА я пойду гулять / приду домой / проснусь». Тут времени нет, есть триггер-событие.
  • create_task — ЗАДАЧА В TODO-ЛИСТЕ (без времени, просто чек-пункт). Когда Игорь перечисляет «задачки на сегодня», «дела на неделю», «нужно сделать X, Y, Z», «добавь ещё задачу/цель X» — это задачи. НЕ ставь им времена и НЕ дёргай set_reminder. Используй scope=daily для дневных, scope=weekly для недельных. Если перечислено несколько — вызывай create_task несколько раз подряд (по одной на каждую задачу).
- ЖЕЛЕЗНОЕ ПРАВИЛО (нарушение = баг). Если в сообщении Игоря есть хоть какой-то action-триггер (см. ниже) — твой ответ ОБЯЗАН содержать tool-call в этом же ходе. ОТВЕТ БЕЗ TOOL-CALL ЗАПРЕЩЁН. Слова «окей», «ок», «готово», «хорошо», «поставил», «добавил», «записал», «отметил» БЕЗ tool-call приравниваются ко лжи.
  Action-триггеры:
    • «напомни …», «напоминание …», «поставь напоминание» → set_reminder (если есть время) или create_action_reminder (если есть событие)
    • «когда я пойду / приду / проснусь / закончу / зайду» → create_action_reminder
    • «добавь задачу / цель / привычку / упражнение» → create_task / create_goal / create_habit / add_exercise
    • «удали / убери / сними / отмени» → соответствующий cancel_*/delete_*/complete_task
    • «съел / выпил / поел / пробежал / сделал N (отжиманий)» → log_meal / log_workout / set_exercise_reps
    • «я пошёл … / иду … / выхожу … / пришёл … / вернулся … / дома … / проснулся» при наличии активного action-триггера → fire_action_reminder
  Если ты не понял время («через скоко?», нет числа) — ВЫЗОВИ tool с тем что есть И верни честную короткую ошибку («не понял время, уточни»). НЕ говори «окей» вместо tool-call никогда.
- Упражнения с количеством (отжимания/приседания/подтягивания N штук) — это add_exercise + set_exercise_reps/bump_exercise, НЕ log_workout. log_workout — только для общих описаний сессий («сделал спину 45 минут»).
- Когда Игорь говорит «добавь привычку X» — ОБЯЗАТЕЛЬНО вызови create_habit, не отвечай голым «окей». То же самое для «добавь тренировку», «запиши еду», «добавь задачу», «добавь цель».
- Перед матчингом триггеров event-напоминаний будь шире по смыслу: «пойду за продуктами» = «пошёл за едой» = «пошёл в магазин» = «иду в магаз» = «вышел в маг» = «пошёл закупаться» (всё это про поход за продуктами/едой). Сравнивай по СМЫСЛУ, а не по дословным словам.
- ЗАПРЕЩЕНО создавать дубли напоминаний. Перед set_reminder сверяйся со списком активных напоминаний — если уже есть похожее на то же время, не создавай ещё одно.
- Если только что сработало напоминание (видишь в чате «⏰ Напоминание: …») и Игорь после этого просто благодарит / реагирует («ай спасибо», «ок», «понял») — НЕ создавай новых напоминаний на ту же тему. Просто ответь по-человечески.
- Если Игорь говорит «удали все напоминалки» / «убери дубли» — вызови cancel_reminders_bulk со списком id всех соответствующих напоминаний.
- Если set_reminder вернул ошибку парсинга времени — попробуй переформулировать: например конвертируй в абсолютное «HH:MM» опираясь на текущее время.
- Перед каждым своим ответом проверь список Active action reminders ниже. Если текущее сообщение Игоря (или то что ты слышишь в его голосовом) указывает что одно из событий-триггеров наступило (он сказал «пошёл гулять» при триггере «пойду гулять», «дома я» при триггере «приду домой» и т.п.) — обязательно вызови fire_action_reminder с соответствующим id, и в своём ответе передай Игорю сам текст напоминания. Будь толерантен к формулировкам: «выхожу гулять» = «пошёл гулять» = «иду гулять», «вернулся» = «пришёл» = «дома».
- Если Игорь говорит что «сделал/сходил/забрал/закончил X» и в списке задач есть совпадающая — вызови complete_task с её id. Будь толерантен к формулировкам.
- Если Игорь логит тренировку/еду/привычку — сразу фиксируй через log_*, не уточняй ничего лишнего
- Для еды без макросов — оцени сам калории/БЖУ по описанию и передай в log_meal
- В конце дня и недели проактивно предлагай ревью, если Игорь не просит сам

Техническое:
- Сейчас: ${today} (${weekday}), ${nowHm} по ${tz}
- Все даты в YYYY-MM-DD, все времена в локальном tz Игоря
- Tool-вызовы делай сразу, не описывай «щас поставлю» — ставь и отчитывайся кратко
- Если Игорь говорит из какого он города/региона — сразу обнови таймзону через set_timezone (не только save_memory). Например «Новосибирск» → Asia/Novosibirsk, «Екатеринбург» → Asia/Yekaterinburg, «Москва» → Europe/Moscow.

Долговременная память об Игоре:
${memLines}

Активные цели:
${goalLines}

Привычки и стрики:
${habitLines}

Active action reminders (триггеры которые ждут наступления события):
${actionLines}

Задачи на сегодня (${today}):
${dailyLines}

Задачи на эту неделю (с ${monday}):
${weeklyLines}
`.trim();
}

/** Convert D1 stored messages to Gemini contents. Skips tool/system roles for chat history. */
function messagesToContents(msgs: Message[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of msgs) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'model') {
      out.push({ role: 'model', parts: [{ text: m.content }] });
    }
    // tool/system stored separately, not injected as chat turns
  }
  return out;
}

/**
 * One-shot chat: takes user message (text and/or inline media), runs a function-calling loop,
 * returns the final text reply. Saves to DB as side-effect.
 */
export async function chat(
  env: Env,
  userId: number,
  tz: string,
  userParts: GeminiPart[],
  userTextForLog: string,
): Promise<string> {
  await saveMessage(env, userId, 'user', userTextForLog);

  // Retrieve per-user Groq key from profile if available
  const userRow = await getUser(env, userId);
  const userProfile = JSON.parse(userRow?.profile_json || '{}');
  const userGroqKey: string | null = userProfile.groq_api_key || null;

  const history = await recentMessages(env, userId, 20);
  // drop the just-saved user message from history and push it fresh as the latest turn
  const historyContents = messagesToContents(history.slice(0, -1));
  const contents: GeminiContent[] = [
    ...historyContents,
    { role: 'user', parts: userParts },
  ];

  const system = await buildSystemInstruction(env, userId, tz);
  const toolCtx: ToolContext = { env, userId, tz };

  let finalText = '';
  let anyToolCalled = false;
  let guardRetried = false;
  for (let step = 0; step < 8; step++) {
    const resp = await callLlm(env, contents, system, userGroqKey);
    if (resp.error) {
      const code = resp.error.code;
      if (code === 429) return 'Лимит LLM исчерпан на минуту, подожди немного и повтори.';
      return 'Что-то пошло не так с моделью. Попробуй ещё раз через полминуты.';
    }
    const cand = resp.candidates?.[0];
    if (!cand?.content) {
      return 'Пустой ответ от модели. Попробуй ещё раз.';
    }
    const parts = cand.content.parts || [];
    const fnCalls = parts.filter(p => p.functionCall).map(p => p.functionCall!);
    const textPart = parts.map(p => p.text).filter(Boolean).join('\n').trim();

    if (fnCalls.length > 0) {
      anyToolCalled = true;
      // append model turn
      contents.push({ role: 'model', parts });
      // execute each tool and collect responses
      const toolResponses: GeminiPart[] = [];
      for (const call of fnCalls) {
        const result = await execTool(toolCtx, call.name, call.args || {});
        console.log(`[tool] ${call.name} ${JSON.stringify(call.args)} → ${result.slice(0, 200)}`);
        toolResponses.push({
          functionResponse: { name: call.name, response: { content: result } },
        });
      }
      contents.push({ role: 'user', parts: toolResponses });
      if (textPart) finalText = textPart;
      continue;
    }

    finalText = textPart;

    // GUARDRAIL: model gave a bare ack ("окей" etc) without ever calling a tool,
    // but the user's last message looks like an actionable request. Force a re-prompt
    // so the model either calls the right tool or honestly explains why it can't.
    if (!anyToolCalled && !guardRetried && looksLikeAcknowledgment(finalText) && looksLikeActionRequest(userTextForLog)) {
      guardRetried = true;
      contents.push({ role: 'model', parts: [{ text: finalText }] });
      contents.push({
        role: 'user',
        parts: [{
          text:
            '[СИСТЕМНАЯ ПРОВЕРКА] Ты только что ответил «' + finalText + '» но НЕ вызвал ни одного tool. ' +
            'Пользователь просил действие (напоминание / задача / привычка / упражнение / событие-триггер / удалить / запись еды). ' +
            'Сейчас же ВЫЗОВИ нужный tool. Если в принципе не получается — НЕ говори «окей», а честно объясни одной фразой что именно не вышло (например: «не понял время», «не знаю что отметить», «такого нет в списке»). Никаких пустых подтверждений.',
        }],
      });
      finalText = '';
      continue;
    }

    break;
  }

  if (!finalText) finalText = 'Окей.';
  await saveMessage(env, userId, 'model', finalText);
  return finalText;
}

function looksLikeAcknowledgment(text: string): boolean {
  const t = text.toLowerCase().trim().replace(/[.!,?…\s]+$/g, '');
  if (t.length === 0) return true;
  if (t.length > 60) return false;
  return /^(ок(ей|)|ok|okay|готово|хорошо|конечно|есть|принято|ясно|понял|поняла|записал|записала|отметил|отметила|поставил|поставила|добавил|добавила|сделал|сделала|создал|создала|удалил|удалила|записываю|отмечаю|поставлю)$/.test(t)
    || /^(окей|ок|готово|сделал|добавил|записал|поставил|отметил)[\s,].{0,40}$/.test(t);
}

function looksLikeActionRequest(text: string): boolean {
  const t = (text || '').toLowerCase();
  // Reminder / action-trigger.
  // We deliberately use stems (no \b after) so Whisper's grammatical normalisation
  // doesn't slip through ("напомни" -> "напомню", "напомнить" -> "напоминание" etc.)
  if (/(напомн|напоминан|поставь напоминан|когда\s+(я\s+)?(пойд|приду|вернус|проснус|зайд|выйд|сяд|закончу|допишу)|как\s+только)/.test(t)) return true;
  // Bare time expressions strongly suggest a scheduled action
  if (/(через\s+\d+\s+(секунд|минут|час|дн|недел))/.test(t)) return true;
  if (/\bв\s+\d{1,2}[:.]\d{2}\b/.test(t) || /\b\d{1,2}[:.]\d{2}\b/.test(t)) return true;
  // Task / habit / goal / exercise commands
  if (/(добав|создай|новая\s+(задача|привычка|цель)|новое\s+упражнение|поставь|запиши|занеси|отметь|сними\s+галочк|удали|вычеркни|перенеси|вставь|перемести)/.test(t)) return true;
  // Workout / meal / quantity logging
  if (/(сделал\s+\d|съел|выпил|пробежал|пошёл\s+тренир)/.test(t)) return true;
  return false;
}

/** Special "system-initiated" generation for scheduled prompts (morning/evening/sunday).
 *  The prompt is injected as a system hint; we still run the same function loop. */
export async function systemPrompt(
  env: Env,
  userId: number,
  tz: string,
  prompt: string,
): Promise<string> {
  // Retrieve per-user Groq key from profile if available
  const userRow = await getUser(env, userId);
  const userProfile = JSON.parse(userRow?.profile_json || '{}');
  const userGroqKey: string | null = userProfile.groq_api_key || null;

  const history = await recentMessages(env, userId, 10);
  const historyContents = messagesToContents(history);
  const contents: GeminiContent[] = [
    ...historyContents,
    { role: 'user', parts: [{ text: `[СИСТЕМНАЯ ПОДСКАЗКА — не Игорь, а планировщик:]\n${prompt}\n\nНапиши сообщение Игорю.` }] },
  ];

  const system = await buildSystemInstruction(env, userId, tz);
  const toolCtx: ToolContext = { env, userId, tz };

  let finalText = '';
  for (let step = 0; step < 6; step++) {
    const resp = await callLlm(env, contents, system, userGroqKey);
    if (resp.error) return '';
    const cand = resp.candidates?.[0];
    if (!cand?.content) break;
    const parts = cand.content.parts || [];
    const fnCalls = parts.filter(p => p.functionCall).map(p => p.functionCall!);
    const textPart = parts.map(p => p.text).filter(Boolean).join('\n').trim();

    if (fnCalls.length > 0) {
      contents.push({ role: 'model', parts });
      const toolResponses: GeminiPart[] = [];
      for (const call of fnCalls) {
        const result = await execTool(toolCtx, call.name, call.args || {});
        toolResponses.push({ functionResponse: { name: call.name, response: { content: result } } });
      }
      contents.push({ role: 'user', parts: toolResponses });
      if (textPart) finalText = textPart;
      continue;
    }
    finalText = textPart;
    break;
  }

  if (finalText) await saveMessage(env, userId, 'model', finalText);
  return finalText;
}
