import { appendWhatsappConversation } from '../LLM/conversation-store';
import { createLlm } from '../LLM/llm';
import type { LlmClient } from '../LLM/llm';
import { kmBetween, SAME_CITY_KM } from '../LLM/geocoding';
import { storePendingGeoChoices, getPendingGeoChoices, clearPendingGeoChoices, storePendingFarPlace, noteBookingMiss } from '../whatsapp-flows/bid-state';
import type { PendingGeoChoices } from '../whatsapp-flows/bid-state';
import { MetaWhatsappRouteDeps } from './deps';
import { NONE_OF_THESE } from './parse';
import { clip, replyAndLog, sendMetaButtons, sendMetaReply } from './send';

export interface PlaceChoice { address: string; name?: string; distanceKm?: number }

/**
 * Row labels for the picker. WhatsApp allows 24 characters for a row's title
 * and 72 for the line under it — "Admiralty Way, Lekki, Nigeria" used to be
 * dumped into the title and arrive as "Admiralty Way, Lekki, Ni".
 *
 * The title carries WHAT DIFFERS between the options:
 *   • branches of one place drop the shared words — "Caleb University College
 *     of Law" / "Caleb University Admissions" → "College of Law" / "Admissions"
 *   • different streets keep their names — "Admiralty Way" / "Admiralty Road"
 *   • one name in several districts leads with the district — "Surulere" / "Akoka"
 * The full label, and how far it is, always sit underneath.
 */
export function placeChoiceRows(choices: Array<PlaceChoice | string>): Array<{ id: string; title: string; description: string }> {
  const parsed = choices.map((choice) => {
    const option = typeof choice === 'string' ? { address: choice } : choice;
    const parts = option.address.split(',').map((part) => part.replace(/\b\d{5,6}\b/g, '').trim()).filter(Boolean)
      .filter((part, index, all) => !(index === all.length - 1 && /^nigeria$/i.test(part)));
    const name = option.name?.trim() || parts[0] || option.address;
    const area = parts.find((part) => part.toLowerCase() !== name.toLowerCase()) ?? '';
    return { name, area, label: parts.join(', ') || option.address, distanceKm: option.distanceKm };
  });

  const distinctNames = new Set(parsed.map((place) => place.name.toLowerCase())).size;
  // Every option has the SAME name ("Shoprite" ×5, "Aiyetoro Street" ×2): the
  // area is what tells them apart. Otherwise the name leads, even if two repeat.
  const namesDiffer = distinctNames > 1 || parsed.length === 1;
  let titles: string[];
  if (namesDiffer) {
    // Names that fit are shown whole ("Admiralty Way" / "Admiralty Road"). Only
    // when one is too long for the 24 characters do the leading words every
    // option shares come off — they say nothing about which one is which, and
    // without this the part that matters ("… College of Law") is what gets cut.
    const words = parsed.map((place) => place.name.split(/\s+/));
    let shared = 0;
    if (parsed.some((place) => place.name.length > 24)) {
      while (words.every((w) => w.length > shared) && new Set(words.map((w) => w[shared]!.toLowerCase())).size === 1) shared += 1;
    }
    titles = words.map((w, index) => {
      // Only a name that does not fit gives up the shared words — "Shoprite
      // Shopping mall" fits and stays whole; "Caleb University College of Law"
      // does not, and becomes "College of Law".
      if (parsed[index]!.name.length <= 24) return parsed[index]!.name;
      const rest = w.slice(shared).join(' ');
      return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : parsed[index]!.name;
    });
  } else {
    titles = parsed.map((place) => place.area || place.name);
  }
  // Two rows may still read the same ("Ikorodu Garage" twice). The second one
  // becomes "Ikorodu Garage 2" — the line underneath says where each one is.
  const seen = new Map<string, number>();
  titles = titles.map((title) => {
    const key = clip(title, 24).toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? clip(title, 24) : `${clip(title, 22)} ${count}`;
  });

  return parsed.map((place, index) => {
    const distance = place.distanceKm != null ? ` · ${place.distanceKm < 10 ? place.distanceKm.toFixed(1) : Math.round(place.distanceKm)} km` : '';
    return {
      id: `place_choice_${index + 1}`,
      title: titles[index]!,
      description: `${clip(place.label, 72 - distance.length)}${distance}`,
    };
  });
}

/** The option a tap (or a typed number) picks, if a picker for one of these contexts is open. */
export async function takePickedPlace(
  deps: MetaWhatsappRouteDeps,
  userId: string,
  message: string,
  contexts: Array<PendingGeoChoices['context']>,
): Promise<{ context: PendingGeoChoices['context']; lat: number; lng: number; address: string } | null> {
  if (!/^[1-9]$/.test(message.trim())) return null;
  const choices = await getPendingGeoChoices(deps.redisClient, userId);
  if (!choices || !contexts.includes(choices.context)) return null;
  const pick = choices.options[Number(message.trim()) - 1];
  if (!pick) return null;
  await clearPendingGeoChoices(deps.redisClient, userId);
  return { context: choices.context, ...pick };
}

/**
 * Ask which place they meant with ONE message and a button. Tapping it opens
 * WhatsApp's own picker; the tap comes back as the option's number. If the
 * list cannot be sent, the same question goes out as numbered text — typing
 * the number has always worked and still does.
 */
export async function sendPlaceChoices(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  input: {
    context: PendingGeoChoices['context'];
    field: 'pickup' | 'destination' | 'stop';
    typed: string;
    candidates: Array<{ lat: number; lng: number; formattedAddress: string; name?: string; distanceKm?: number }>;
    /** A line to lead with, e.g. the pickup that is already settled. */
    intro?: string;
    /** Replaces "I found N places matching …" — for a question that is not about a typed name. */
    question?: string;
  },
): Promise<void> {
  const shown = input.candidates.slice(0, 9);
  const options = shown.map((c) => ({ lat: c.lat, lng: c.lng, address: c.formattedAddress }));
  await storePendingGeoChoices(deps.redisClient, user.id, { context: input.context, options });

  const rows = placeChoiceRows(shown.map((c) => ({ address: c.formattedAddress, name: c.name, distanceKm: c.distanceKm })));
  const body = `${input.intro ? `${input.intro}\n\n` : ''}${input.question ?? `I found ${options.length} places matching "${clip(input.typed.split(',')[0] ?? input.typed, 60)}".\n\nTap *Choose* and pick the right ${input.field}.`}`;
  const asText = [
    `Found a few places matching "${input.typed}" — which one did you mean?`,
    ``,
    ...options.map((option, index) => `*${index + 1}.* ${option.address}`),
    ``,
    `Reply with the number.`,
  ].join('\n');

  await appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: incomingMessage },
    { role: 'assistant', content: asText },
  ]);

  if (!deps.metaAccessToken || !deps.metaPhoneNumberId) {
    await sendMetaReply(deps, phone, asText);
    return;
  }
  const response = await fetch(`https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone.replace(/^\+/, ''),
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body },
        action: {
          button: 'Choose',
          sections: [{
            title: input.field === 'pickup' ? 'Pick the right pickup' : input.field === 'stop' ? 'Pick the stop' : 'Pick the destination',
            rows: [
              ...rows,
              { id: 'place_choice_none', title: NONE_OF_THESE, description: 'Type the address again with the area or a landmark' },
            ],
          }],
        },
      },
    }),
  }).catch(() => null);

  if (!response?.ok) {
    console.error('[whatsapp] place picker failed — falling back to numbered text', {
      status: response?.status ?? null,
      payload: response ? await response.text().catch(() => '') : 'network error',
    });
    await sendMetaReply(deps, phone, asText);
  }
}

// ── Reading the rider, not just the reply ────────────────────────────────

/** The small, fast model: Gemini flash-lite, with Groq's 20b as its backup. */
export function bookingIntentGroq(deps: MetaWhatsappRouteDeps): LlmClient {
  return createLlm({ groqApiKey: deps.groqApiKey, groqModel: deps.groqModel, timeoutMs: deps.groqTimeoutMs }, 'intent');
}

/**
 * The reply for "I could not use that". The first time it is the normal prompt
 * plus one line naming the exits. From the second time on the rider is plainly
 * stuck, so the exits become buttons — nobody should have to guess a magic
 * word to get out of a booking. Asking for help skips straight to the buttons.
 */
export async function replyWithWayOut(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  options: { prompt: string; hint: string; buttons: string[]; wantsHelp?: boolean },
): Promise<void> {
  const misses = await noteBookingMiss(deps.redisClient, user.id).catch(() => 1);
  if (misses < 2 && !options.wantsHelp) {
    await replyAndLog(deps, phone, incomingMessage, `${options.prompt}\n\n${options.hint}`);
    return;
  }

  const support = process.env['SUPPORT_CONTACT']?.trim();
  const body = [
    options.wantsHelp ? 'No wahala — here is what you can do from here:' : 'Looks like we are not getting anywhere — my bad. What would you like to do?',
    '',
    options.prompt,
    ...(support ? ['', `Need a person? Reach Wheelers support: ${support}`] : []),
  ].join('\n');
  if (options.wantsHelp) console.info('[whatsapp] rider asked for help mid-booking', { userId: user.id });

  await appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: incomingMessage },
    { role: 'assistant', content: body },
  ]);
  await sendMetaButtons(deps, phone, body, options.buttons);
}

/**
 * A place hundreds of km from the other end of the trip is almost always the
 * wrong match, not a real plan — "7 Osaro Isokpan" from Akoka resolved to Benin
 * City and the bot cheerfully quoted ₦97,100 for 311 km. Hold it and ask.
 * Returns true when it asked (the caller stops).
 */
export async function askIfFarPlaceIsMeant(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  field: 'pickup' | 'destination',
  place: { lat: number; lng: number; address: string },
  otherEnd: { lat: number; lng: number },
): Promise<boolean> {
  const distanceKm = Math.round(kmBetween(otherEnd, place));
  if (distanceKm <= SAME_CITY_KM) return false;

  await storePendingFarPlace(deps.redisClient, user.id, { field, ...place, distanceKm });
  const other = field === 'destination' ? 'pickup' : 'destination';
  await replyAndLog(deps, phone, incomingMessage, [
    `I found *${place.address}* — but that is about *${distanceKm.toLocaleString()} km* from your ${other}, in another city.`,
    '',
    `If you meant somewhere closer, send the ${field} again with the area or city — e.g. *"7 Osaro Isokpan, Yaba"*.`,
    '',
    `Reply *yes* if you really are going that far.`,
  ].join('\n'));
  return true;
}

