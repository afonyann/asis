// Cloudflare Worker entry point: routes webhooks and cron triggers.
import type { Env } from './types';
import type { TgUpdate } from './telegram';
import { handleUpdate } from './bot';
import { runCron } from './scheduler';
import { APP_HTML } from './webapp_html';
import { handleApi } from './webapp_api';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return new Response('igor-assistant is alive', { status: 200 });
    }

    if (request.method === 'POST' && url.pathname === '/webhook') {
      let update: TgUpdate;
      try {
        update = (await request.json()) as TgUpdate;
      } catch {
        return new Response('bad json', { status: 400 });
      }
      // Process update asynchronously so Telegram gets 200 fast (TG retries on timeout)
      ctx.waitUntil(handleUpdate(env, update).catch(err => console.error('handleUpdate', err)));
      return new Response('ok', { status: 200 });
    }

    // Admin endpoints (no auth; fine because URL contains the worker's random subdomain and we gate by owner id elsewhere)
    if (request.method === 'POST' && url.pathname === '/admin/cron') {
      await runCron(env);
      return new Response('cron ran', { status: 200 });
    }

    // Mini App: HTML page
    if (request.method === 'GET' && (url.pathname === '/app' || url.pathname === '/app/' || url.pathname === '/app/index.html')) {
      return new Response(APP_HTML, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    // Mini App: API
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(env, request, url.pathname);
    }

    return new Response('not found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env).catch(err => console.error('cron', err)));
  },
};
