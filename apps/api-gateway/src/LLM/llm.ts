import { GeminiClient } from './gemini.client';
import { GroqClient } from './groq.client';
import { walletIntentModel } from './wallet-intent';
import type { LlmChatMessage } from './types';

/**
 * What the rest of the code needs from a language model. Both providers fit
 * it, so callers depend on this and never on a vendor.
 */
export interface LlmClient {
  readonly configured: boolean;
  complete(messages: LlmChatMessage[]): Promise<string | null>;
  completeJson(messages: LlmChatMessage[]): Promise<Record<string, unknown> | null>;
  completeVisionJson(prompt: string, imageBuffer: Buffer, mimeType: string): Promise<Record<string, unknown> | null>;
}

/**
 * 'main'   — understanding a booking request, chat replies, photo checks.
 * 'intent' — the quick "what does this rider want?" reads that run on almost
 *            every message. A smaller, faster model is both enough and better
 *            (flash-lite scored 35/35 where the larger flash scored 33/35).
 */
export type LlmPurpose = 'main' | 'intent';

export interface LlmConfig {
  groqApiKey?: string;
  groqModel: string;
  timeoutMs: number;
}

// Pinned, not "-latest": an alias can change behaviour overnight. These are
// what the aliases resolved to when measured (2026-09-20).
const GEMINI_MODELS: Record<LlmPurpose, string> = {
  main: (process.env['GEMINI_MODEL'] ?? 'gemini-3.8-flash').trim(),
  intent: (process.env['GEMINI_INTENT_MODEL'] ?? 'gemini-3.5-flash-lite').trim(),
};

/** Gemini first; Groq answers only when Gemini cannot. */
class FallbackLlm implements LlmClient {
  constructor(
    private readonly primary: LlmClient,
    private readonly backup: LlmClient,
    private readonly label: string,
  ) {}

  get configured(): boolean {
    return this.primary.configured || this.backup.configured;
  }

  complete(messages: LlmChatMessage[]): Promise<string | null> {
    return this.firstAnswer('complete', (llm) => llm.complete(messages));
  }

  completeJson(messages: LlmChatMessage[]): Promise<Record<string, unknown> | null> {
    return this.firstAnswer('completeJson', (llm) => llm.completeJson(messages));
  }

  completeVisionJson(prompt: string, imageBuffer: Buffer, mimeType: string): Promise<Record<string, unknown> | null> {
    return this.firstAnswer('completeVisionJson', (llm) => llm.completeVisionJson(prompt, imageBuffer, mimeType));
  }

  /**
   * An error OR an empty answer from the primary sends the question to the
   * backup. If the backup is not set up, the primary's error surfaces as it
   * always did — callers already have their own no-model fallbacks.
   */
  private async firstAnswer<T>(what: string, ask: (llm: LlmClient) => Promise<T | null>): Promise<T | null> {
    if (!this.primary.configured) return ask(this.backup);
    try {
      const answer = await ask(this.primary);
      if (answer !== null || !this.backup.configured) return answer;
      console.warn(`[llm] ${this.label}: primary gave no answer — asking the backup`, { what });
    } catch (error) {
      if (!this.backup.configured) throw error;
      console.warn(`[llm] ${this.label}: primary failed — asking the backup`, {
        what,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return ask(this.backup);
  }
}

/**
 * The model for a job. With GEMINI_API_KEY set, Gemini is the primary and Groq
 * (when its key is set too) is the backup. Without it, this is exactly the
 * Groq-only behaviour from before — so a missing key degrades, never breaks.
 */
export function createLlm(config: LlmConfig, purpose: LlmPurpose = 'main'): LlmClient {
  const groq = new GroqClient({
    apiKey: config.groqApiKey,
    model: purpose === 'intent' ? walletIntentModel(config.groqModel) : config.groqModel,
    timeoutMs: config.timeoutMs,
  });
  const geminiKey = process.env['GEMINI_API_KEY']?.trim();
  if (!geminiKey) return groq;

  const gemini = new GeminiClient({ apiKey: geminiKey, model: GEMINI_MODELS[purpose], timeoutMs: config.timeoutMs });
  return new FallbackLlm(gemini, groq, purpose);
}

/** For the startup log: who is answering. Never the key. */
export function describeLlm(config: LlmConfig): string {
  const gemini = Boolean(process.env['GEMINI_API_KEY']?.trim());
  const groq = Boolean(config.groqApiKey);
  if (gemini) return `Gemini (${GEMINI_MODELS.main} / ${GEMINI_MODELS.intent})${groq ? `, Groq backup (${config.groqModel})` : ', no backup'}`;
  return groq ? `Groq only (${config.groqModel})` : 'NONE — the bot is running on keyword rules';
}
