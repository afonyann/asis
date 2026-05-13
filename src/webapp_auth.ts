// Telegram WebApp initData verification. Documented here:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// Algorithm:
//   secret_key      = HMAC_SHA256(key="WebAppData", message=bot_token)
//   data_check_str  = sort(initData minus 'hash')
//                       join with "\n" as "k=v"
//   expected_hash   = HMAC_SHA256(key=secret_key, message=data_check_str) hex
//   compare to the 'hash' field
//
// We also reject auth_date older than 24h.
import type { Env } from './types';

export interface TgWebAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface VerifiedInitData {
  user: TgWebAppUser;
  authDate: number;
  raw: URLSearchParams;
}

const MAX_AGE_SEC = 24 * 3600;

async function hmacSha256(keyData: ArrayBuffer | Uint8Array | string, message: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const keyBytes = typeof keyData === 'string' ? enc.encode(keyData)
    : keyData instanceof Uint8Array ? keyData
    : new Uint8Array(keyData);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
}

function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export async function verifyInitData(env: Env, initData: string): Promise<VerifiedInitData | null> {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const givenHash = params.get('hash');
  if (!givenHash) return null;

  const entries: [string, string][] = [];
  params.forEach((v, k) => {
    if (k !== 'hash') entries.push([k, v]);
  });
  entries.sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = await hmacSha256('WebAppData', env.TELEGRAM_BOT_TOKEN);
  const expected = bufToHex(await hmacSha256(secretKey, dataCheckString));

  if (expected !== givenHash) return null;

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SEC) return null;

  const userJson = params.get('user');
  if (!userJson) return null;
  let user: TgWebAppUser;
  try {
    user = JSON.parse(userJson);
  } catch {
    return null;
  }
  return { user, authDate, raw: params };
}
