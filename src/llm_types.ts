// Shared LLM types — kept separate from llm.ts to avoid circular imports
// between providers (groq.ts, llm.ts) and the orchestrator.

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: string } };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiResponse {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  error?: { code: number; message: string };
}
