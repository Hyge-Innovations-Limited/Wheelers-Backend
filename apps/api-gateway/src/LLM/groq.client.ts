import type { LlmChatMessage } from './types';

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';

export interface GroqClientConfig {
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

interface GroqChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
}

/**
 * Reasoning budget for JSON extraction calls. Empty string disables the
 * parameter entirely, for models that reject it.
 */
const REASONING_EFFORT = (process.env['GROQ_REASONING_EFFORT'] ?? 'low').trim();

export class GroqClient {
  constructor(private readonly config: GroqClientConfig) {}

  get configured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async complete(messages: LlmChatMessage[]): Promise<string | null> {
    return this.chat(messages, false);
  }

  async completeJson(messages: LlmChatMessage[]): Promise<Record<string, unknown> | null> {
    const raw = await this.chat(messages, true);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.warn('[groq] Failed to parse JSON response', { raw: raw.slice(0, 200) });
      return null;
    }
  }

  /**
   * JSON verdict about an image, via a Groq vision model (the configured chat
   * model can't see). Sends the image inline as a base64 data URL.
   */
  async completeVisionJson(
    prompt: string,
    imageBuffer: Buffer,
    mimeType: string,
  ): Promise<Record<string, unknown> | null> {
    if (!this.config.apiKey) return null;

    // Default verified against the live account (2026-08): qwen3.6-27b is the
    // multimodal model this key has access to — llama-4 vision returns 404.
    const visionModel = (process.env['GROQ_VISION_MODEL'] ?? 'qwen/qwen3.6-27b').trim();
    const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: visionModel,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          temperature: 0.1,
          // Reasoning-capable models spend completion tokens thinking before
          // the JSON — 300 truncated mid-object on qwen3.6.
          max_completion_tokens: 1500,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => null)) as GroqChatCompletionResponse | null;
      if (!response.ok) {
        const message = payload?.error?.message ?? `Groq vision request failed with status ${response.status}`;
        throw new Error(message);
      }

      const content = payload?.choices?.[0]?.message?.content?.trim();
      if (!content) return null;
      try {
        return JSON.parse(content) as Record<string, unknown>;
      } catch {
        console.warn('[groq] Failed to parse vision JSON response', { raw: content.slice(0, 200) });
        return null;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * One polite retry on a rate limit. Groq says exactly how long to wait
   * ("try again in 269ms"); when that is short, waiting beats falling back to
   * a dumber answer. A long wait is not worth holding a rider's reply for.
   */
  private async chat(messages: LlmChatMessage[], jsonMode: boolean): Promise<string | null> {
    try {
      return await this.chatOnce(messages, jsonMode);
    } catch (error) {
      const wait = rateLimitWaitMs(error);
      if (wait === null || wait > 2_500) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait + 150));
      return this.chatOnce(messages, jsonMode);
    }
  }

  private async chatOnce(messages: LlmChatMessage[], jsonMode: boolean): Promise<string | null> {
    if (!this.config.apiKey) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages,
        temperature: jsonMode ? 0.1 : 0.4,
        // Reasoning models (gpt-oss) spend completion tokens thinking before
        // they emit anything. At the old 300 the budget ran out mid-object and
        // Groq rejected the truncated result with "Failed to generate JSON" —
        // measured at 1 failure in 3. Every failure fell back to regex, which
        // is why a plain address silently stopped being understood.
        max_completion_tokens: jsonMode ? 700 : 600,
      };
      if (jsonMode) {
        body.response_format = { type: 'json_object' };
        // Extraction needs no deep reasoning, and capping it keeps the reply
        // inside the budget. Set GROQ_REASONING_EFFORT='' for models that do
        // not accept the parameter.
        if (REASONING_EFFORT) {
          body.reasoning_effort = REASONING_EFFORT;
        }
      }

      const response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => null)) as GroqChatCompletionResponse | null;
      if (!response.ok) {
        const message = payload?.error?.message ?? `Groq request failed with status ${response.status}`;
        throw new Error(message);
      }

      const content = payload?.choices?.[0]?.message?.content?.trim();
      return content || null;
    } finally {
      clearTimeout(timeout);
    }
  }
}


/** "…Please try again in 269.99ms." / "…in 3.2s." → milliseconds, or null if this is not a rate limit. */
export function rateLimitWaitMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/rate limit/i.test(message)) return null;
  const match = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(message);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.ceil(match[2].toLowerCase() === 's' ? value * 1000 : value) : null;
}
