// Handle a single Telegram update — parse the message, route commands, call LLM, reply.
import type { Env } from './types';
import type { TgUpdate, TgMessage } from './telegram';
import {
  sendMessage, sendMessageWithWebApp, sendChatAction,
  getFile, downloadFile, bufferToBase64,
  sendInvoice, answerPreCheckoutQuery,
} from './telegram';
import {
  ensureUser, getUser, saveMessage,
  listGoals, listHabits, habitLast7Days, listReminders,
  effectiveAccess, setSubscription, extendSubscription,
  findUserByUsername, listAllUsers, recordPayment,
} from './db';
import { chat } from './llm';
import type { GeminiPart } from './llm';
import { groqTranscribe } from './groq';
import { tryFastPath } from './intent';
import { formatLocal, nowSec } from './time';

const SUB_AMOUNT_XTR = 99;
const SUB_DAYS = 30;

function fmtDate(unix: number | null | undefined): string {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  return d.toISOString().slice(0, 10);
}

function isOwner(env: Env, userId: number): boolean {
  return userId === Number(env.TG_OWNER_ID);
}

export async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  // ---- Telegram Stars: pre-checkout (we accept) ----
  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;
    // Accept anything that's a known payload pattern.
    const ok = /^sub:\d+$/.test(q.invoice_payload);
    await answerPreCheckoutQuery(env, q.id, ok, ok ? undefined : 'Неизвестный счёт.');
    return;
  }

  const msg = update.message ?? update.edited_message;
  if (!msg || !msg.from) return;

  // ---- Telegram Stars: successful_payment ----
  if (msg.successful_payment) {
    const pay = msg.successful_payment;
    const m = pay.invoice_payload.match(/^sub:(\d+)$/);
    const days = m ? Number(m[1]) : SUB_DAYS;
    await ensureUser(env, msg.from.id, msg.from.first_name, msg.from.username);
    const { until } = await extendSubscription(env, msg.from.id, days);
    await recordPayment(env, msg.from.id, pay.telegram_payment_charge_id, pay.total_amount, pay.invoice_payload, days);
    await sendMessage(env, msg.chat.id,
      `Спасибо! Подписка активна до ${fmtDate(until)}.`);
    return;
  }

  const user = await ensureUser(env, msg.from.id, msg.from.first_name, msg.from.username);
  const tz = user.timezone;

  await sendChatAction(env, msg.chat.id, 'typing');

  // ---- slash commands ----
  // /start, /help, /subscribe, /grant, /revoke, /users, /tz, /clear, /ping, /app
  // are reachable even when subscription is expired (so a user can fix it).
  const rawText = msg.text ?? msg.caption ?? '';
  if (rawText.startsWith('/')) {
    const handled = await handleCommand(env, msg, rawText, tz);
    if (handled) return;
  }

  // ---- subscription / access gate ----
  const access = effectiveAccess(user);
  if (!access.allowed) {
    // Offer to subscribe right away.
    await sendInvoice(
      env, msg.chat.id,
      'Подписка на ассистента',
      access.reason + '\n\nКнопка ниже — оплата ' + SUB_AMOUNT_XTR + ' Stars / ' + SUB_DAYS + ' дней.',
      `sub:${SUB_DAYS}`,
      SUB_AMOUNT_XTR,
    );
    return;
  }

  // ---- assemble LLM input parts ----
  const parts: GeminiPart[] = [];
  let logText = rawText;

  if (msg.voice || msg.audio) {
    const voice = msg.voice || msg.audio!;
    const file = await getFile(env, voice.file_id);
    if (file?.file_path) {
      const buf = await downloadFile(env, file.file_path);
      const mime = voice.mime_type || 'audio/ogg';

      // Prefer Groq Whisper for voice (much better Russian recognition).
      // If Groq is unavailable or fails, fall back to letting Gemini consume
      // the audio directly via inlineData.
      let transcript: string | null = null;
      if (env.GROQ_API_KEY) {
        try {
          transcript = await groqTranscribe(env, buf, mime);
        } catch (err) {
          console.error('groqTranscribe threw', err);
        }
      }

      if (transcript) {
        const text = rawText ? `${rawText}\n\n[голосовое:] ${transcript}` : transcript;
        parts.push({ text });
        logText = transcript;
      } else {
        if (rawText) parts.push({ text: rawText });
        parts.push({
          inlineData: { mimeType: mime, data: bufferToBase64(buf) },
        });
        logText = logText || '[голосовое сообщение]';
      }
    }
  }

  if (msg.photo && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1]; // biggest
    const file = await getFile(env, best.file_id);
    if (file?.file_path) {
      const buf = await downloadFile(env, file.file_path);
      parts.push({
        inlineData: { mimeType: 'image/jpeg', data: bufferToBase64(buf) },
      });
    }
    if (rawText) parts.push({ text: rawText });
    else parts.push({ text: '[фото от Игоря без подписи]' });
    logText = rawText || '[фото]';
  }

  if (parts.length === 0 && rawText) {
    parts.push({ text: rawText });
  }

  if (parts.length === 0) {
    await sendMessage(env, msg.chat.id, 'Пустое сообщение, не понял.');
    return;
  }

  // ---- fast path: deterministic intent parsing for obvious commands ----
  // We only try this for plain-text or transcribed-voice (no image attached),
  // because images need vision and shouldn't bypass the LLM.
  const hasInline = parts.some(p => p.inlineData);
  if (!hasInline && logText) {
    try {
      const fp = await tryFastPath(env, user.id, tz, logText);
      if (fp) {
        await saveMessage(env, user.id, 'user', fp.logText);
        await saveMessage(env, user.id, 'model', fp.reply);
        await sendMessage(env, msg.chat.id, fp.reply);
        return;
      }
    } catch (err) {
      console.error('fastPath error', err);
      // fall through to LLM
    }
  }

  try {
    const reply = await chat(env, user.id, tz, parts, logText);
    if (reply) await sendMessage(env, msg.chat.id, reply);
  } catch (e) {
    console.error('chat failed', e);
    const err = e instanceof Error ? e.message : String(e);
    await sendMessage(env, msg.chat.id, `Упал при обработке: ${err}`);
  }
}

async function handleCommand(env: Env, msg: TgMessage, raw: string, tz: string): Promise<boolean> {
  const [cmdRaw, ...rest] = raw.split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();
  const arg = rest.join(' ').trim();
  const userId = msg.from!.id;
  const chatId = msg.chat.id;

  switch (cmd) {
    case '/start':
    case '/help': {
      await sendMessage(env, chatId, [
        'Привет. Я твой личный ассистент.',
        '',
        'Пиши мне свободно: мысли, планы, голосовые, фото — всё разберу.',
        'Основные вещи которые делаю:',
        '• Напоминания по времени: «напомни в 18 позвонить маме» / «каждый будний день в 7 отжимания»',
        '• Напоминания по событию: «напомни когда пойду гулять купить молоко» — потом скажешь «пошёл гулять» и я напомню',
        '• Тренировки: просто пиши что делал, я запишу',
        '• Еда: пиши что ел, я посчитаю калории/БЖУ',
        '• Привычки: скажи «добавь привычку пить 2л воды», потом отмечай выполнение',
        '• Цели: «хочу пробежать 5км за 25 минут к июлю»',
        '• Дневные и недельные ревью — утром в 8:00 и вечером в 22:00 пишу сам; воскресенье 20:00 — недельный разбор',
        '',
        'Команды:',
        '/dashboard — открыть мини-апп с задачами/привычками/прогрессом',
        '/goals — цели',
        '/today — что сегодня',
        '/habits — привычки и стрики',
        '/reminders — активные напоминания',
        '/sub — статус подписки',
        '/subscribe — продлить подписку (Telegram Stars)',
        '/tz <Region/City> — сменить таймзону (сейчас: ' + tz + ')',
        '/clear — стереть историю чата (память о фактах не стирается)',
      ].join('\n'));
      return true;
    }

    case '/goals': {
      const goals = await listGoals(env, userId, 'active');
      if (goals.length === 0) {
        await sendMessage(env, chatId, 'Активных целей нет. Расскажи мне чего ты хочешь достичь — заведём.');
      } else {
        const lines = goals.map(g => `#${g.id} [${g.horizon}] ${g.title} — ${g.progress}%${g.target_date ? ` (до ${g.target_date})` : ''}${g.description ? `\n   ${g.description}` : ''}`);
        await sendMessage(env, chatId, 'Активные цели:\n\n' + lines.join('\n\n'));
      }
      return true;
    }

    case '/habits': {
      const habits = await listHabits(env, userId);
      if (habits.length === 0) {
        await sendMessage(env, chatId, 'Привычек нет. Скажи «добавь привычку ...» — заведу.');
        return true;
      }
      const lines: string[] = [];
      for (const h of habits) {
        const last7 = await habitLast7Days(env, userId, h.id, tz);
        lines.push(`#${h.id} ${h.name} — ${last7.length}/7 за неделю`);
      }
      await sendMessage(env, chatId, 'Привычки:\n\n' + lines.join('\n'));
      return true;
    }

    case '/reminders': {
      const rs = await listReminders(env, userId, 'pending');
      if (rs.length === 0) {
        await sendMessage(env, chatId, 'Активных напоминаний нет.');
        return true;
      }
      const lines = rs.map(r => `#${r.id} ${formatLocal(r.fire_at, tz)}${r.repeat_rule ? ` (${r.repeat_rule})` : ''} — ${r.text}`);
      await sendMessage(env, chatId, 'Напоминания:\n\n' + lines.join('\n'));
      return true;
    }

    case '/today': {
      // ask the LLM to summarize today. This uses the LLM path with a fake user message.
      const parts: GeminiPart[] = [{ text: 'Что у меня на сегодня? Подтяни через read_context план, напоминания и активные цели.' }];
      const reply = await chat(env, userId, tz, parts, '/today');
      if (reply) await sendMessage(env, chatId, reply);
      return true;
    }

    case '/tz': {
      if (!arg) {
        await sendMessage(env, chatId, `Текущая таймзона: ${tz}. Пришли «/tz Europe/Moscow» чтобы сменить.`);
        return true;
      }
      // crude validation
      try {
        new Intl.DateTimeFormat('en', { timeZone: arg });
      } catch {
        await sendMessage(env, chatId, `Непонятная таймзона. Пример: Europe/Moscow, Asia/Yekaterinburg.`);
        return true;
      }
      await env.DB.prepare('UPDATE users SET timezone = ?, updated_at = unixepoch() WHERE id = ?')
        .bind(arg, userId).run();
      await sendMessage(env, chatId, `Таймзона теперь ${arg}.`);
      return true;
    }

    case '/clear': {
      await env.DB.prepare('DELETE FROM messages WHERE user_id = ?').bind(userId).run();
      await sendMessage(env, chatId, 'Чат очищен. Факты о тебе (память, цели, привычки) остались.');
      return true;
    }

    case '/ping': {
      await sendMessage(env, chatId, `pong ${formatLocal(nowSec(), tz)}`);
      return true;
    }

    case '/app':
    case '/dashboard': {
      const url = `${env.WORKER_BASE_URL}/app`;
      await sendMessageWithWebApp(env, chatId, 'Открой дашборд:', '📊 Открыть', url);
      return true;
    }

    case '/status':
    case '/sub': {
      const u = await getUser(env, userId);
      if (!u) { await sendMessage(env, chatId, 'Не нашёл пользователя.'); return true; }
      const lines = [`Подписка: ${u.sub_status}`];
      if (u.sub_until) lines.push(`Действует до: ${fmtDate(u.sub_until)}`);
      if (u.sub_status === 'trial') lines.push('Это бесплатный пробный период.');
      if (u.sub_status === 'owner' || u.sub_status === 'granted') lines.push('Доступ без ограничений.');
      lines.push('', `Продлить: /subscribe (${SUB_AMOUNT_XTR} ⭐ за ${SUB_DAYS} дней).`);
      await sendMessage(env, chatId, lines.join('\n'));
      return true;
    }

    case '/subscribe':
    case '/buy': {
      await sendInvoice(env, chatId,
        'Подписка на ассистента',
        `Доступ ко всем фичам на ${SUB_DAYS} дней.`,
        `sub:${SUB_DAYS}`,
        SUB_AMOUNT_XTR,
      );
      return true;
    }

    case '/grant': {
      if (!isOwner(env, userId)) {
        await sendMessage(env, chatId, 'Команда только для владельца бота.');
        return true;
      }
      if (!arg) {
        await sendMessage(env, chatId, 'Пришли так: /grant @username  или  /grant <tg_id>');
        return true;
      }
      let target: { id: number; username: string | null; first_name: string | null } | null = null;
      if (/^@?\w+$/.test(arg) && !/^\d+$/.test(arg)) {
        const u = await findUserByUsername(env, arg);
        if (u) target = u;
        else {
          await sendMessage(env, chatId,
            `Пользователь @${arg.replace(/^@/, '')} ещё не писал боту. Попроси его сначала отправить /start, потом повтори /grant.`);
          return true;
        }
      } else if (/^\d+$/.test(arg)) {
        const u = await getUser(env, Number(arg));
        if (u) target = u;
        else {
          await sendMessage(env, chatId, `Пользователя с id ${arg} нет в базе.`);
          return true;
        }
      } else {
        await sendMessage(env, chatId, 'Не понял аргумент. Нужен @username или числовой tg_id.');
        return true;
      }
      await setSubscription(env, target.id, 'granted', null);
      await sendMessage(env, chatId,
        `Готово. ${target.username ? '@' + target.username : target.first_name || target.id} получил безлимитный бесплатный доступ.`);
      return true;
    }

    case '/revoke': {
      if (!isOwner(env, userId)) {
        await sendMessage(env, chatId, 'Команда только для владельца бота.');
        return true;
      }
      if (!arg) {
        await sendMessage(env, chatId, 'Пришли так: /revoke @username  или  /revoke <tg_id>');
        return true;
      }
      let target: { id: number } | null = null;
      if (/^@?\w+$/.test(arg) && !/^\d+$/.test(arg)) {
        const u = await findUserByUsername(env, arg);
        if (u) target = u;
      } else if (/^\d+$/.test(arg)) {
        const u = await getUser(env, Number(arg));
        if (u) target = u;
      }
      if (!target) {
        await sendMessage(env, chatId, 'Не нашёл такого пользователя.');
        return true;
      }
      await setSubscription(env, target.id, 'expired', Math.floor(Date.now() / 1000));
      await sendMessage(env, chatId, 'Готово. Доступ отозван.');
      return true;
    }

    case '/users': {
      if (!isOwner(env, userId)) {
        await sendMessage(env, chatId, 'Команда только для владельца бота.');
        return true;
      }
      const all = await listAllUsers(env);
      if (all.length === 0) { await sendMessage(env, chatId, 'Пользователей нет.'); return true; }
      const lines = all.slice(0, 50).map(u =>
        `#${u.id} ${u.username ? '@' + u.username : (u.first_name || '—')} · ${u.sub_status}` +
        (u.sub_until ? ` · до ${fmtDate(u.sub_until)}` : '')
      );
      await sendMessage(env, chatId, `Пользователи (${all.length}):\n\n` + lines.join('\n'));
      return true;
    }
  }
  return false;
}
