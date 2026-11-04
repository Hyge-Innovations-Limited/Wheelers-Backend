import { memoryClient } from '@wheleers/db';
import { resolveUserId } from '../LLM/conversation-store';
import type { MetaMessageInfo } from './parse';

/**
 * Every WhatsApp message the bot sends, written to the rider's transcript word
 * for word (Timi, 4 Nov 2026): admin reads the chat as the rider saw it. It is
 * fed from the one wrapper all outgoing calls pass through
 * (usage/service-usage.ts), so no send path can be missed, and only once Meta
 * has taken the message.
 *
 * Never kept: read receipts and typing (not messages), and a template's
 * values (a sign-in code goes out as one) — a template is kept by its name.
 */
export interface OutboundEntry {
  to: string;
  content: string;
  kind: string;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** What a message to Meta says, as the rider sees it. Null when it is not a message to a person. */
export function describeOutbound(raw: unknown): OutboundEntry | null {
  let body: unknown = raw;
  if (typeof raw === 'string') {
    try { body = JSON.parse(raw); } catch { return null; }
  }
  if (!isObj(body) || body['messaging_product'] !== 'whatsapp' || 'status' in body) return null;
  const to = str(body['to']).replace(/\D/g, '');
  if (!to) return null;
  const type = str(body['type']);

  if (type === 'text') {
    const text = isObj(body['text']) ? str(body['text']['body']) : '';
    return text ? { to, content: text, kind: 'text' } : null;
  }
  if (type === 'reaction') {
    const emoji = isObj(body['reaction']) ? str(body['reaction']['emoji']) : '';
    return emoji ? { to, content: emoji, kind: 'reaction' } : null;
  }
  if (type === 'image') {
    const caption = isObj(body['image']) ? str(body['image']['caption']) : '';
    return { to, content: caption ? `[Photo] ${caption}` : '[Photo]', kind: 'image' };
  }
  if (type === 'template') {
    const name = isObj(body['template']) ? str(body['template']['name']) : '';
    return { to, content: `[Template: ${name || 'unnamed'}]`, kind: 'template' };
  }
  if (type === 'location') return { to, content: '[Location]', kind: 'location' };
  if (type !== 'interactive' || !isObj(body['interactive'])) return null;

  const it = body['interactive'];
  const header = isObj(it['header']) ? (str(it['header']['text']) || (isObj(it['header']['image']) ? '[Photo]' : '')) : '';
  const text = isObj(it['body']) ? str(it['body']['text']) : '';
  const action = isObj(it['action']) ? it['action'] : {};
  const words = [header, text].filter(Boolean).join('\n');
  const kindOf = str(it['type']);
  let under = '';
  let kind = 'buttons';
  if (kindOf === 'button' && Array.isArray(action['buttons'])) {
    under = action['buttons'].map((b) => (isObj(b) && isObj(b['reply']) ? str(b['reply']['title']) : '')).filter(Boolean).map((t) => `[${t}]`).join(' ');
  } else if (kindOf === 'list') {
    kind = 'list';
    under = str(action['button']) ? `[${str(action['button'])}]` : '';
  } else if (kindOf === 'flow') {
    kind = 'form';
    const cta = isObj(action['parameters']) ? str(action['parameters']['flow_cta']) : '';
    under = cta ? `[${cta}]` : '';
  } else if (kindOf === 'cta_url') {
    kind = 'link';
    const label = isObj(action['parameters']) ? str(action['parameters']['display_text']) : '';
    under = label ? `[${label}]` : '';
  } else if (kindOf === 'location_request_message') {
    kind = 'location';
    under = '[Send location]';
  } else {
    kind = kindOf || 'buttons';
  }
  const content = [words, under].filter(Boolean).join('\n');
  return content ? { to, content, kind } : null;
}

/** Writes one sent message to the rider's transcript. Never throws, never slows the send. */
export async function recordOutboundWhatsapp(raw: unknown): Promise<void> {
  try {
    const entry = describeOutbound(raw);
    if (!entry) return;
    const userId = await resolveUserId(entry.to);
    if (!userId) return;
    await memoryClient.appendMessages(userId, [{ role: 'assistant', content: entry.content, kind: entry.kind }]);
  } catch (error) {
    console.warn('[whatsapp] transcript write failed', error instanceof Error ? error.message : String(error));
  }
}

/** What a rider sent, as they sent it: words, a tap (the button's title), a place, a photo, a form finished. */
export function describeInbound(msg: Pick<MetaMessageInfo, 'messageBody' | 'isLocation' | 'locationLat' | 'locationLng' | 'isImage' | 'replyId' | 'flowCompleted'>): { content: string; kind: string } | null {
  const said = (msg.messageBody ?? '').trim();
  if (msg.flowCompleted) return { content: `[Finished the ${msg.flowCompleted.flow} form]`, kind: 'form' };
  if (msg.isLocation) {
    const at = msg.locationLat != null && msg.locationLng != null ? ` ${msg.locationLat.toFixed(5)}, ${msg.locationLng.toFixed(5)}` : '';
    return { content: `[Location]${said ? ` ${said}` : at}`, kind: 'location' };
  }
  if (msg.isImage) return { content: said ? `[Photo] ${said}` : '[Photo]', kind: 'image' };
  if (msg.replyId) return { content: said || msg.replyId, kind: 'tap' };
  return said ? { content: said, kind: 'text' } : null;
}

/** Every message a rider sends, kept as it arrives (once: a replayed message has no id and is not kept again). */
export async function recordInboundWhatsapp(userId: string, msg: MetaMessageInfo): Promise<void> {
  try {
    if (!msg.messageId) return;
    const entry = describeInbound(msg);
    if (!entry) return;
    await memoryClient.appendMessages(userId, [{ role: 'user', content: entry.content, kind: entry.kind }]);
  } catch (error) {
    console.warn('[whatsapp] transcript write failed', error instanceof Error ? error.message : String(error));
  }
}

const FORM_NAMES: Record<string, string> = { menu: 'Quick Actions', bids: 'Offers', edit: 'Edit trip', welcome: 'Welcome' };
/** Fields of a form step never shown: tokens, and anything long. */
const HIDDEN_FIELDS = new Set(['action', 'flow_token', 'token']);

/** One step in a WhatsApp form (opened, a screen's button, back), with the short things chosen on it. */
export function describeFormStep(formKey: string, body: { action?: string; screen?: string; data?: Record<string, unknown> }): string | null {
  if (!body.action || body.action === 'ping') return null;
  const form = FORM_NAMES[formKey] ?? 'Booking';
  const data = body.data ?? {};
  const did = body.action === 'INIT' ? 'opened' : body.action === 'BACK' ? 'back' : String(data['action'] ?? 'next');
  const chosen = Object.entries(data)
    .filter(([key, value]) => !HIDDEN_FIELDS.has(key) && (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length > 0 && value.length <= 60)))
    .slice(0, 5)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return `[${form} form] ${body.screen ? `${body.screen} · ` : ''}${did}${chosen.length ? ` (${chosen.join(', ')})` : ''}`;
}

/** Every step a rider takes in a form, in their transcript. Never throws. */
export async function recordFormStep(userId: string, formKey: string, body: { action?: string; screen?: string; data?: Record<string, unknown> }): Promise<void> {
  try {
    const content = describeFormStep(formKey, body);
    if (!content) return;
    await memoryClient.appendMessages(userId, [{ role: 'user', content, kind: 'form' }]);
  } catch (error) {
    console.warn('[whatsapp] transcript write failed', error instanceof Error ? error.message : String(error));
  }
}
