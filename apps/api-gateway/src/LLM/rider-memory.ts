/**
 * Rider memory — what the bot knows about the person it is talking to.
 *
 * Three sources, in order of trust:
 *   1. Rides in the database. Where they actually went, what they paid, how.
 *   2. Facts distilled from past conversations, stored as rider → predicate →
 *      object edges in UserMemoryFact (a small knowledge graph per rider).
 *   3. The durable transcript in WhatsappMessage, so the model sees more than
 *      the last ten turns Redis keeps.
 *
 * `loadRiderMemory` gathers all three; the render functions turn them into a
 * system message. `rememberExchange` runs after a reply, asks the model what
 * it learned, and writes the edges back. Nothing here blocks a reply: memory
 * that fails to load is simply absent, and extraction is fire-and-forget.
 */
import { memoryClient } from '@wheleers/db';
import type { GroqClient } from './groq.client';
import type { WhatsappConversationMessage } from './types';

export interface RiderMemoryFact {
  predicate: string;
  object: string;
  weight: number;
  lastSeenAt: Date;
}

export interface RiderMemoryRide {
  status: string;
  pickupAddress: string;
  destAddress: string;
  fareNgn: number | null;
  paymentMethod: string;
  createdAt: Date;
}

export interface RiderMemory {
  facts: RiderMemoryFact[];
  rides: RiderMemoryRide[];
  transcript: WhatsappConversationMessage[];
  /** Aggregated from rides: address → completed-trip count. */
  frequentPlaces: Array<{ address: string; count: number }>;
}

/** The relations the extractor may write. Anything else is dropped. */
export const MEMORY_PREDICATES = new Set([
  'home',            // where they live — an address or area
  'work',            // where they work / school
  'frequent_place',  // somewhere they go often
  'prefers_payment', // WALLET | CASH | CRYPTO_WALLET
  'language',        // english | pidgin | yoruba | igbo | hausa
  'called',          // how they like to be addressed
  'typical_offer_ngn', // what they usually offer for a ride
  'note',            // anything else worth keeping ("has a baby seat need", "travels with luggage")
]);

const EXTRACTION_ENABLED = (process.env['WHATSAPP_MEMORY_EXTRACTION'] ?? 'true').trim() !== 'false';
const TRANSCRIPT_TURNS = 24;

export async function loadRiderMemory(userId: string): Promise<RiderMemory> {
  const [facts, rides, transcript] = await Promise.all([
    memoryClient.listFacts(userId).catch(() => []),
    memoryClient.recentRides(userId, 10).catch(() => []),
    memoryClient.recentMessages(userId, TRANSCRIPT_TURNS).catch(() => []),
  ]);

  const rideRows: RiderMemoryRide[] = rides.map((r) => ({
    status: String(r.status),
    pickupAddress: r.pickupAddress,
    destAddress: r.destAddress,
    fareNgn: pickFare(r.fareFinalNgn, r.agreedFareNgn, r.riderOfferNgn),
    paymentMethod: String(r.paymentMethod),
    createdAt: r.createdAt,
  }));

  const counts = new Map<string, number>();
  for (const r of rideRows) {
    if (r.status !== 'COMPLETED') continue;
    for (const address of [r.pickupAddress, r.destAddress]) {
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }
  }
  const frequentPlaces = [...counts.entries()]
    .map(([address, count]) => ({ address, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    facts: facts.map((f) => ({ predicate: f.predicate, object: f.object, weight: f.weight, lastSeenAt: f.lastSeenAt })),
    rides: rideRows,
    transcript: transcript.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
      timestamp: m.createdAt.toISOString(),
    })),
    frequentPlaces,
  };
}

function pickFare(...values: Array<unknown>): number | null {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function bestFact(memory: RiderMemory, predicate: string): string | null {
  const hit = memory.facts.find((f) => f.predicate === predicate);
  return hit?.object ?? null;
}

function factsFor(memory: RiderMemory, predicate: string, limit: number): string[] {
  return memory.facts.filter((f) => f.predicate === predicate).slice(0, limit).map((f) => f.object);
}

function relativeDay(date: Date, now = new Date()): string {
  const days = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} week${days >= 14 ? 's' : ''} ago`;
  return date.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
}

function ngn(value: number): string {
  return `₦${Math.round(value).toLocaleString('en-NG')}`;
}

export function hasAnyMemory(memory: RiderMemory): boolean {
  return memory.facts.length > 0 || memory.rides.length > 0;
}

/** The "what we know" block for the chat bot. */
export function renderRiderMemory(memory: RiderMemory): string {
  const lines: string[] = ['What we know about this rider (from their own past rides and messages):'];

  const called = bestFact(memory, 'called');
  if (called) lines.push(`- likes to be called: ${called}`);
  const language = bestFact(memory, 'language');
  if (language) lines.push(`- usually writes in: ${language}`);
  const home = bestFact(memory, 'home');
  if (home) lines.push(`- home: ${home}`);
  const work = bestFact(memory, 'work');
  if (work) lines.push(`- work: ${work}`);
  const payment = bestFact(memory, 'prefers_payment');
  if (payment) lines.push(`- prefers to pay with: ${payment}`);
  const offer = bestFact(memory, 'typical_offer_ngn');
  if (offer) lines.push(`- typical offer: ${offer}`);
  for (const place of factsFor(memory, 'frequent_place', 3)) lines.push(`- often goes to: ${place}`);
  for (const note of factsFor(memory, 'note', 3)) lines.push(`- note: ${note}`);

  if (memory.frequentPlaces.length) {
    lines.push('- places from completed rides: ' + memory.frequentPlaces
      .map((p) => `${p.address} (${p.count}×)`).join('; '));
  }

  if (memory.rides.length) {
    lines.push('- recent rides:');
    for (const r of memory.rides.slice(0, 5)) {
      const fare = r.fareNgn ? `, ${ngn(r.fareNgn)}` : '';
      lines.push(`  • ${relativeDay(r.createdAt)}: ${r.pickupAddress} → ${r.destAddress} (${r.status.toLowerCase()}${fare}, ${r.paymentMethod.toLowerCase()})`);
    }
  }

  if (lines.length === 1) lines.push('- nothing yet — this is a new rider.');
  lines.push('Use this naturally. Do not recite it back, and do not claim anything not listed here.');
  return lines.join('\n');
}

/** The compact version for the intent extractor: only places and prices. */
export function renderRiderMemoryForIntent(memory: RiderMemory): string {
  const lines: string[] = ['What we know about this rider:'];
  const home = bestFact(memory, 'home');
  if (home) lines.push(`- home = ${home}`);
  const work = bestFact(memory, 'work');
  if (work) lines.push(`- work = ${work}`);
  for (const place of factsFor(memory, 'frequent_place', 3)) lines.push(`- frequent place = ${place}`);
  for (const p of memory.frequentPlaces.slice(0, 3)) lines.push(`- often rides to/from = ${p.address}`);
  for (const r of memory.rides.slice(0, 4)) {
    lines.push(`- ride ${relativeDay(r.createdAt)}: ${r.pickupAddress} → ${r.destAddress}`);
  }
  const payment = bestFact(memory, 'prefers_payment');
  if (payment) lines.push(`- usual payment = ${payment}`);
  if (lines.length === 1) return '';
  lines.push('Resolve "home", "work", "the usual", "same as last time" from this list. Leave fields null when memory has no match.');
  return lines.join('\n');
}

const EXTRACTION_PROMPT = `
You maintain a memory of a ride-hailing rider from their WhatsApp messages.
Return ONLY a JSON object: {"facts":[{"predicate":string,"object":string}]}.
Allowed predicates: home, work, frequent_place, prefers_payment, language, called, typical_offer_ngn, note.
Rules:
- Record only what the rider states or clearly implies about THEMSELVES, durably. One-off details of a single trip are NOT facts unless they say it's usual ("I always…", "my house is…").
- "home"/"work"/"frequent_place": a place name or address, as written, plus city if known (e.g. "12 Adebayo Street, Surulere, Lagos").
- "prefers_payment": WALLET, CASH or CRYPTO_WALLET — only when they express a preference, not for a single choice.
- "language": pidgin, english, yoruba, igbo or hausa — the language they write in.
- "called": a name or nickname they ask to be called.
- "typical_offer_ngn": a number, only if they say what they usually pay.
- "note": short, useful, non-sensitive (never health, religion, politics, money problems, ID numbers).
- Nothing to record → {"facts":[]}. Never invent.
`.trim();

/**
 * Learn from one exchange. Runs after the reply is sent, never throws.
 * `assistantReply` may be null for booking-path messages, where the reply was
 * generated by the state machine rather than the model.
 */
export function rememberExchange(
  groq: GroqClient,
  userId: string,
  userMessage: string,
  assistantReply: string | null,
): void {
  if (!EXTRACTION_ENABLED || !groq.configured) return;
  const text = userMessage.trim();
  // Location pins, bare numbers and one-word replies carry nothing to keep.
  if (text.length < 12 || text.startsWith('[')) return;

  void (async () => {
    try {
      const result = await groq.completeJson([
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: assistantReply
          ? `Rider: ${text}\nAssistant: ${assistantReply.slice(0, 400)}`
          : `Rider: ${text}` },
      ]);
      const raw = Array.isArray(result?.facts) ? (result!.facts as unknown[]) : [];
      const facts = raw
        .filter((f): f is { predicate: string; object: string } =>
          Boolean(f && typeof f === 'object'
            && typeof (f as { predicate?: unknown }).predicate === 'string'
            && typeof (f as { object?: unknown }).object === 'string'))
        .map((f) => ({ predicate: f.predicate.trim().toLowerCase(), object: f.object.trim() }))
        .filter((f) => MEMORY_PREDICATES.has(f.predicate) && f.object.length > 0 && f.object.length <= 300)
        .slice(0, 6);
      if (facts.length === 0) return;
      await memoryClient.upsertFacts(userId, facts);
    } catch (error) {
      console.warn('[rider-memory] extraction failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}
