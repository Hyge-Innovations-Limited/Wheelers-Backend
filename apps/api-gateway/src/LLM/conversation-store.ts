import { userClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import type { WhatsappConversationMessage } from './types';

const CONVERSATION_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_MESSAGES = 10;

/**
 * phone → userId, so the durable transcript (whatsapp/transcript.ts, which
 * writes both sides as they happen) is keyed by user without a database
 * round-trip per message. A WhatsApp user's id never changes.
 */
const userIdByPhone = new Map<string, string>();

export async function resolveUserId(phone: string): Promise<string | null> {
  const cached = userIdByPhone.get(phone);
  if (cached) return cached;
  const user = await userClient.findByPrivyDid(`whatsapp:${phone}`).catch(() => null);
  if (!user) return null;
  if (userIdByPhone.size > 5_000) userIdByPhone.clear();
  userIdByPhone.set(phone, user.id);
  return user.id;
}

function getConversationKey(phone: string): string {
  return `whatsapp:conversation:${phone}`;
}

function parseConversation(raw: string | null): WhatsappConversationMessage[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is WhatsappConversationMessage => {
      return Boolean(
        entry &&
          typeof entry === 'object' &&
          (entry as WhatsappConversationMessage).role &&
          ((entry as WhatsappConversationMessage).role === 'user' ||
            (entry as WhatsappConversationMessage).role === 'assistant') &&
          typeof (entry as WhatsappConversationMessage).content === 'string' &&
          typeof (entry as WhatsappConversationMessage).timestamp === 'string',
      );
    });
  } catch {
    return [];
  }
}

export async function getWhatsappConversation(
  redisClient: RedisClient,
  phone: string,
): Promise<WhatsappConversationMessage[]> {
  const raw = await redisClient.get(getConversationKey(phone)).catch(() => null);
  return parseConversation(raw);
}

export async function appendWhatsappConversation(
  redisClient: RedisClient,
  phone: string,
  messages: Array<Pick<WhatsappConversationMessage, 'role' | 'content'>>,
): Promise<void> {
  const existing = await getWhatsappConversation(redisClient, phone);
  const timestamp = new Date().toISOString();
  const next = [
    ...existing,
    ...messages.map((message) => ({
      ...message,
      content: message.content.slice(0, 1_500),
      timestamp,
    })),
  ].slice(-MAX_MESSAGES);

  await redisClient.set(
    getConversationKey(phone),
    JSON.stringify(next),
    CONVERSATION_TTL_SECONDS,
  ).catch((error) => {
    console.warn('[whatsapp] conversation store failed', {
      phone,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

