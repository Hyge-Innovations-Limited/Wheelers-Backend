import type { GroqClient } from './groq.client';
import type { WhatsappConversationMessage } from './types';

export type WalletIntent = 'deposit' | 'withdraw' | 'none';

/**
 * A three-way classification does not need the big model. Groq meters each
 * model separately, so a small one here is faster AND leaves the main model's
 * budget for the booking parser and the chat replies it actually needs.
 * Set GROQ_INTENT_MODEL='' to use the main model instead.
 */
export function walletIntentModel(mainModel: string): string {
  const configured = process.env['GROQ_INTENT_MODEL'];
  if (configured === undefined) return 'openai/gpt-oss-20b';
  return configured.trim() || mainModel;
}

/**
 * Does the rider want to move money — and which way?
 *
 * The MODEL decides, from meaning. There is deliberately no list of accepted
 * phrases: a list always loses to how people actually write ("abeg I wan put
 * money", "lemme cash out my earnings", "how I fit fund am?", "depsoit"), and
 * every miss dropped the rider into a chat reply that told them to go and type
 * a magic word.
 */
const WALLET_INTENT_PROMPT = `
You classify ONE WhatsApp message sent to Wheelers, a Nigerian ride-hailing service where every rider and driver has a naira wallet.
Return ONLY JSON: {"intent":"deposit"|"withdraw"|"none"}

"deposit"  — they want to PUT money INTO their Wheelers wallet now, or are asking HOW to: top up, fund, add money, load, recharge, credit their wallet, "where do I send money", "give me my account number", "I want to pay in". Any language, slang, Nigerian Pidgin, abbreviations or typos.
"withdraw" — they want to TAKE money OUT of their wallet to a bank account now, or are asking HOW to: withdraw, cash out, collect my money, send my balance/earnings to my bank, "I wan collect my money", "how do I get my money out".
"none"     — everything else, including:
  • booking or paying for a RIDE ("pay", "I'll pay 2000", "pay with wallet", a fare offer) — that is not a deposit
  • a place name that happens to contain a money word ("Bank Anthony Way", "First Bank Marina", "Cash n Carry")
  • asking only for their BALANCE
  • a complaint or question about a PAST transaction ("I deposited 5k and it hasn't shown", "my withdrawal is still pending", "withdraw status")
  • questions about fees or how long it takes, with no wish to do it now
  • cancelling something

Use the recent conversation to resolve short replies: if the assistant just said their wallet is short and they answer "ok let me do that" or "how?", that is "deposit".
When genuinely unsure, answer "none".
`.trim();

/**
 * Cheap guard so an address or a bare number never costs a model call. This
 * is NOT the intent decision — it only asks "could this message possibly be
 * about money?", generously, by word-stems (typos and Pidgin included). The
 * model makes the actual call.
 */
export function mightConcernMoney(message: string): boolean {
  const m = message.toLowerCase();
  if (m.trim().length < 3) return false;
  return /dep|top|fund|withd|w\/d|cash|money|moni|bank|acc(oun)?t|wallet|balanc|transf|send|pay|credit|load|recharg|collect|earn|naira|₦|kudi|owo|ego\b|put .*(in|for)/.test(m);
}

/** Only when the model is unreachable: the plainest wordings still work. */
function fallbackWalletIntent(message: string): WalletIntent {
  const m = message.toLowerCase();
  if (/\b(withdraw|withdrawal|cash\s*out|cashout)\b/.test(m) && !/\b(status|pending|hasn'?t|not|didn'?t)\b/.test(m)) return 'withdraw';
  if (/\b(deposit|top\s*-?\s*up|fund|add money)\b/.test(m) && !/\b(deposited|hasn'?t|not|didn'?t|pending)\b/.test(m)) return 'deposit';
  return 'none';
}

export async function classifyWalletIntent(
  groq: GroqClient,
  message: string,
  recentMessages: WhatsappConversationMessage[] = [],
): Promise<WalletIntent> {
  if (!groq.configured) return fallbackWalletIntent(message);

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: WALLET_INTENT_PROMPT },
    // Two turns of context is enough to read "ok" / "how?" correctly.
    ...recentMessages.slice(-2).map((entry) => ({ role: entry.role, content: entry.content.slice(0, 400) })),
    { role: 'user', content: message.slice(0, 500) },
  ];

  try {
    const result = await groq.completeJson(messages);
    const intent = result?.intent;
    return intent === 'deposit' || intent === 'withdraw' ? intent : 'none';
  } catch (error) {
    console.warn('[wallet-intent] classification failed — using the plain-wording fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackWalletIntent(message);
  }
}
