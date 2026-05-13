// Minimal Telegram Bot API client (we avoid grammy to keep bundle small on Workers)
import type { Env } from './types';

const MAX_MSG = 4000;

async function tg(env: Env, method: string, body: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error(`TG ${method} error:`, data);
  }
  return data;
}

export async function sendMessage(env: Env, chatId: number, text: string): Promise<void> {
  const chunks: string[] = [];
  let s = text;
  while (s.length > MAX_MSG) {
    let cut = s.lastIndexOf('\n', MAX_MSG);
    if (cut < MAX_MSG / 2) cut = MAX_MSG;
    chunks.push(s.slice(0, cut));
    s = s.slice(cut);
  }
  chunks.push(s);
  for (const chunk of chunks) {
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
  }
}

export async function sendMessageWithWebApp(env: Env, chatId: number, text: string, buttonText: string, webAppUrl: string): Promise<void> {
  await tg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        { text: buttonText, web_app: { url: webAppUrl } },
      ]],
    },
  });
}

export async function setChatMenuButton(env: Env, chatId: number, text: string, webAppUrl: string): Promise<unknown> {
  return await tg(env, 'setChatMenuButton', {
    chat_id: chatId,
    menu_button: { type: 'web_app', text, web_app: { url: webAppUrl } },
  });
}

export async function setBotCommands(env: Env, commands: Array<{ command: string; description: string }>): Promise<unknown> {
  return await tg(env, 'setMyCommands', { commands });
}

export async function sendChatAction(env: Env, chatId: number, action: string): Promise<void> {
  await tg(env, 'sendChatAction', { chat_id: chatId, action });
}

export interface TgFilePath { file_path: string; }

export async function getFile(env: Env, fileId: string): Promise<TgFilePath | null> {
  const resp = await tg(env, 'getFile', { file_id: fileId }) as { ok?: boolean; result?: TgFilePath };
  if (!resp.ok || !resp.result) return null;
  return resp.result;
}

export async function downloadFile(env: Env, filePath: string): Promise<ArrayBuffer> {
  const resp = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!resp.ok) throw new Error(`TG file download failed: ${resp.status}`);
  return await resp.arrayBuffer();
}

export async function setWebhook(env: Env, url: string, secret?: string): Promise<unknown> {
  return await tg(env, 'setWebhook', {
    url,
    allowed_updates: ['message', 'edited_message', 'pre_checkout_query'],
    secret_token: secret,
  });
}

// ---------- Update types (subset we care about) ----------

export interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
  is_bot?: boolean;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgVoice {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgSuccessfulPayment {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
  provider_payment_charge_id?: string;
}

export interface TgPreCheckoutQuery {
  id: string;
  from: TgUser;
  currency: string;
  total_amount: number;
  invoice_payload: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  voice?: TgVoice;
  audio?: { file_id: string; mime_type?: string };
  photo?: TgPhotoSize[];
  entities?: Array<{ type: string; offset: number; length: number }>;
  successful_payment?: TgSuccessfulPayment;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  pre_checkout_query?: TgPreCheckoutQuery;
}

export async function sendInvoice(
  env: Env,
  chatId: number,
  title: string,
  description: string,
  payload: string,
  amountXtr: number,
): Promise<void> {
  await tg(env, 'sendInvoice', {
    chat_id: chatId,
    title,
    description,
    payload,
    currency: 'XTR',
    prices: [{ label: title, amount: amountXtr }],
  });
}

export async function answerPreCheckoutQuery(env: Env, queryId: string, ok: boolean, errorMessage?: string): Promise<void> {
  await tg(env, 'answerPreCheckoutQuery', {
    pre_checkout_query_id: queryId,
    ok,
    error_message: errorMessage,
  });
}

export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
