// Groq API client. Two purposes:
//   (1) Transcribe Telegram voice messages (whisper-large-v3-turbo).
//   (2) Chat completions with tool-calling using Llama 3.3 70B Versatile.
//
// We expose a Gemini-shaped chat API so the rest of the codebase can stay
// provider-agnostic — convert OpenAI-style requests/responses internally.

import type { Env } from './types';
import type { GeminiContent, GeminiPart, GeminiResponse } from './llm_types';
import { toolDeclarations } from './tools';

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const CHAT_MODEL = 'llama-3.3-70b-versatile';
const WHISPER_MODEL = 'whisper-large-v3-turbo';

// ---------- Whisper transcription ----------

export async function groqTranscribe(env: Env, audio: ArrayBuffer, mimeType: string): Promise<string | null> {
  if (!env.GROQ_API_KEY) return null;
  const fd = new FormData();
  fd.append('file', new Blob([audio], { type: mimeType }), 'audio.ogg');
  fd.append('model', WHISPER_MODEL);
  fd.append('response_format', 'json');
  // language hint helps the model — Igor speaks Russian primarily.
  fd.append('language', 'ru');

  const resp = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: fd,
  });
  const json = (await resp.json()) as { text?: string; error?: { message?: string } };
  if (!resp.ok || json.error) {
    console.error('Groq transcribe error:', resp.status, json.error?.message);
    return null;
  }
  return (json.text || '').trim() || null;
}

// ---------- Chat completion (OpenAI shape) ----------

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAiResponse {
  choices?: Array<{
    message?: OpenAiMessage;
    finish_reason?: string;
  }>;
  error?: { message?: string; code?: string | number };
}

function geminiToOpenAi(contents: GeminiContent[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  let counter = 0;
  // We need stable ids that match across an assistant tool_calls turn and
  // its corresponding tool responses. Emit ids as we walk forward.
  let lastToolCallIds: string[] = [];

  for (const c of contents) {
    if (c.role === 'user') {
      // Detect a "tool response" pseudo-turn (functionResponse parts).
      const fnResponses = c.parts.filter(p => p.functionResponse).map(p => p.functionResponse!);
      if (fnResponses.length > 0) {
        for (let i = 0; i < fnResponses.length; i++) {
          const id = lastToolCallIds[i] || `call_${counter++}`;
          out.push({
            role: 'tool',
            tool_call_id: id,
            name: fnResponses[i].name,
            content: fnResponses[i].response.content,
          });
        }
        continue;
      }
      // Normal user turn: collapse text parts (and ignore inlineData since
      // Llama is text-only here — voice was already transcribed upstream).
      const text = c.parts.map(p => p.text || '').filter(Boolean).join('\n').trim();
      if (text) out.push({ role: 'user', content: text });
      continue;
    }

    if (c.role === 'model') {
      const fnCalls = c.parts.filter(p => p.functionCall).map(p => p.functionCall!);
      const text = c.parts.map(p => p.text || '').filter(Boolean).join('\n').trim();
      if (fnCalls.length > 0) {
        const ids = fnCalls.map(() => `call_${counter++}`);
        lastToolCallIds = ids;
        out.push({
          role: 'assistant',
          content: text || null,
          tool_calls: fnCalls.map((fc, i) => ({
            id: ids[i],
            type: 'function',
            function: {
              name: fc.name,
              arguments: JSON.stringify(fc.args || {}),
            },
          })),
        });
      } else if (text) {
        out.push({ role: 'assistant', content: text });
      }
    }
  }
  return out;
}

function openAiToGemini(msg: OpenAiMessage): GeminiContent {
  const parts: GeminiPart[] = [];
  if (msg.content) parts.push({ text: msg.content });
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        // Some smaller models occasionally emit malformed JSON args; bail safely.
        args = {};
      }
      parts.push({ functionCall: { name: tc.function.name, args } });
    }
  }
  return { role: 'model', parts };
}

const OPENAI_TOOLS = toolDeclarations.map(t => ({
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));

export async function callGroqChat(
  env: Env,
  contents: GeminiContent[],
  systemInstruction: string,
  apiKey?: string,
): Promise<GeminiResponse> {
  const key = apiKey || env.GROQ_API_KEY;
  if (!key) {
    return { error: { code: 401, message: 'no GROQ_API_KEY' } };
  }
  const messages: OpenAiMessage[] = [
    { role: 'system', content: systemInstruction },
    ...geminiToOpenAi(contents),
  ];

  const body = {
    model: CHAT_MODEL,
    messages,
    tools: OPENAI_TOOLS,
    tool_choice: 'auto',
    temperature: 0.6,
    max_tokens: 2048,
  };

  const resp = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await resp.json()) as OpenAiResponse;
  if (!resp.ok || json.error) {
    return {
      error: {
        code: typeof json.error?.code === 'number' ? json.error.code : resp.status,
        message: json.error?.message || `groq http ${resp.status}`,
      },
    };
  }
  const choice = json.choices?.[0];
  if (!choice?.message) {
    return { error: { code: 500, message: 'groq: empty response' } };
  }
  return {
    candidates: [{
      content: openAiToGemini(choice.message),
      finishReason: choice.finish_reason,
    }],
  };
}
