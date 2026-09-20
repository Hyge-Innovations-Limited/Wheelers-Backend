import type { LlmChatMessage } from './types';

const GEMINI_BASE_URL = (process.env['GEMINI_BASE_URL'] ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');

export interface GeminiClientConfig {
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

interface GeminiPart { text?: string; inlineData?: { mimeType: string; data: string } }
interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[] }

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string; details?: Array<{ retryDelay?: string }> };
}

/** Thrown for a non-2xx answer, carrying what a caller needs to decide on a retry. */
export class GeminiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs: number | null) {
    super(message);
    this.name = 'GeminiError';
  }
}

/** "3s" / "0.4s" → milliseconds. */
function parseRetryDelay(payload: GeminiResponse | null): number | null {
  for (const detail of payload?.error?.details ?? []) {
    const match = /^([\d.]+)s$/.exec(detail.retryDelay ?? '');
    if (match) return Math.round(Number(match[1]) * 1000);
  }
  return null;
}

/**
 * Gemini takes the system prompt separately and calls the assistant "model".
 * Several system messages (the prompt, then "what we know about this rider")
 * become one instruction; neighbouring turns from the same speaker are merged,
 * which the API prefers to a run of same-role entries.
 */
export function toGeminiRequest(messages: LlmChatMessage[]): { system: string; contents: GeminiContent[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content.trim()).filter(Boolean).join('\n\n');
  const contents: GeminiContent[] = [];
  for (const message of messages) {
    if (message.role === 'system' || !message.content.trim()) continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const previous = contents[contents.length - 1];
    if (previous && previous.role === role) previous.parts.push({ text: message.content });
    else contents.push({ role, parts: [{ text: message.content }] });
  }
  return { system, contents };
}

/**
 * Google Gemini, behind the same three methods the rest of the code already
 * calls on GroqClient — so nothing that USES a model knows or cares which one
 * answered.
 *
 * Why it is the primary: Groq's free tier allows ~8 intent reads a minute for
 * every rider combined, and a refused call silently degrades to keyword rules.
 * The same job on gemini flash-lite: 120 requests in one burst all accepted,
 * 35/35 messy phrasings correct, ~1.2 s each (measured 2026-09-20).
 */
export class GeminiClient {
  constructor(private readonly config: GeminiClientConfig) {}

  get configured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async complete(messages: LlmChatMessage[]): Promise<string | null> {
    const { system, contents } = toGeminiRequest(messages);
    return this.generate(system, contents, { temperature: 0.4, maxOutputTokens: 1024 });
  }

  async completeJson(messages: LlmChatMessage[]): Promise<Record<string, unknown> | null> {
    const { system, contents } = toGeminiRequest(messages);
    const raw = await this.generate(system, contents, {
      temperature: 0.1,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    });
    return parseJsonObject(raw, 'json');
  }

  /** Every Gemini flash model sees images natively — no separate vision model. */
  async completeVisionJson(prompt: string, imageBuffer: Buffer, mimeType: string): Promise<Record<string, unknown> | null> {
    const contents: GeminiContent[] = [{
      role: 'user',
      parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBuffer.toString('base64') } }],
    }];
    const raw = await this.generate('', contents, {
      temperature: 0.1,
      maxOutputTokens: 1500,
      responseMimeType: 'application/json',
    });
    return parseJsonObject(raw, 'vision');
  }

  /** One polite retry when Google names a short wait; otherwise the caller's fallback is the better answer. */
  private async generate(system: string, contents: GeminiContent[], generationConfig: Record<string, unknown>): Promise<string | null> {
    try {
      return await this.generateOnce(system, contents, generationConfig);
    } catch (error) {
      const wait = error instanceof GeminiError && error.status === 429 ? error.retryAfterMs : null;
      if (wait === null || wait > 2_500) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait + 150));
      return this.generateOnce(system, contents, generationConfig);
    }
  }

  private async generateOnce(system: string, contents: GeminiContent[], generationConfig: Record<string, unknown>): Promise<string | null> {
    if (!this.config.apiKey || contents.length === 0) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${GEMINI_BASE_URL}/models/${encodeURIComponent(this.config.model)}:generateContent`, {
        method: 'POST',
        // The key rides in a header, never the URL: URLs end up in logs.
        headers: { 'x-goog-api-key': this.config.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents,
          generationConfig,
        }),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => null)) as GeminiResponse | null;
      if (!response.ok) {
        throw new GeminiError(
          payload?.error?.message?.split('\n')[0] ?? `Gemini request failed with status ${response.status}`,
          response.status,
          parseRetryDelay(payload),
        );
      }

      const blocked = payload?.promptFeedback?.blockReason;
      if (blocked) {
        console.warn('[gemini] prompt blocked', { reason: blocked });
        return null;
      }
      const text = (payload?.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('').trim();
      return text || null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseJsonObject(raw: string | null, kind: string): Record<string, unknown> | null {
  if (!raw) return null;
  // JSON mode returns bare JSON, but a fenced block costs nothing to tolerate.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    console.warn(`[gemini] Failed to parse ${kind} response`, { raw: raw.slice(0, 200) });
    return null;
  }
}
