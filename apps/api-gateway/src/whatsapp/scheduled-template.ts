import { createWalletPageToken, RIDE_PAGE_TOKEN_TTL_SECONDS } from '../auth/local';
import type { MetaWhatsappRouteDeps } from './deps';

/**
 * A ride for later starting its search outside the rider's 24 h WhatsApp
 * window: a plain message cannot reach them there, only an approved template.
 * Set WHATSAPP_SCHEDULED_TEMPLATE (its name in Meta) and, when not English,
 * WHATSAPP_SCHEDULED_TEMPLATE_LANG. Unset: rides for later are offered only
 * inside the window (the ride page's scheduleUntil), and one that would start
 * outside it does not start.
 *
 * The template (see the setup notes): body "Your ride for later from {{1}} to
 * {{2}} is looking for a driver now. Tap below to see the offers and pick one.",
 * one URL button "See driver offers" to https://<app>/ride-page/open/{{1}},
 * {{1}} being the rider's ride page link token (GET /ride-page/open/:token
 * sends them on to the page).
 */
export function scheduledStartTemplate(): { name: string; language: string } | null {
  const name = process.env['WHATSAPP_SCHEDULED_TEMPLATE']?.trim();
  if (!name) return null;
  return { name, language: process.env['WHATSAPP_SCHEDULED_TEMPLATE_LANG']?.trim() || 'en' };
}

/** A template parameter: one line, short (Meta refuses new lines, tabs and long runs of spaces). */
function templateText(value: string, max = 60): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  const first = flat.split(',')[0]?.trim() || flat;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first || '-';
}

/** Sends the start as the template. True when Meta took it. */
export async function sendScheduledStartTemplate(
  deps: Pick<MetaWhatsappRouteDeps, 'metaAccessToken' | 'metaPhoneNumberId' | 'jwtSecret'>,
  userId: string,
  phone: string,
  trip: { pickupAddress: string; destAddress: string },
): Promise<boolean> {
  const template = scheduledStartTemplate();
  if (!template || !deps.metaAccessToken || !deps.metaPhoneNumberId) return false;
  const token = createWalletPageToken(userId, 'ride', deps.jwtSecret, RIDE_PAGE_TOKEN_TTL_SECONDS);
  const response = await fetch(`https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: templateText(trip.pickupAddress) }, { type: 'text', text: templateText(trip.destAddress) }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: token }] },
        ],
      },
    }),
  }).catch(() => null);
  if (!response?.ok) {
    console.warn('[whatsapp] scheduled start template refused', { status: response?.status, payload: response ? (await response.text().catch(() => '')).slice(0, 300) : 'no response' });
    return false;
  }
  return true;
}
