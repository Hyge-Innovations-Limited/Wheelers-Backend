import { rideClient } from '@wheleers/db';
import { answerGroupOffer, GroupLiveError } from '../rides/group-live';
import { takeGroupSelfie } from '../http/group-ride.route';
import { signFlowToken } from '../whatsapp-flows/encryption';
import { expectGroupSelfie, groupSelfieExpectedKey } from '../whatsapp-flows/group-offer-flow';
import { downloadMetaMedia } from '../whatsapp-flows/meta-media';
import type { MetaWhatsappRouteDeps } from './deps';
import { sendWaitingInteractive, sendWaitingText } from './waiting-deal-chat';

/**
 * A group ride offer in the chat (Timi, 17 Nov 2026), for riders not on the ride page: one form message
 * (WHATSAPP_GROUP_FLOW_ID, npm run flow:push:group), or until it is published (or if Meta refuses it) two buttons,
 * Ride together / No thanks. A yes with no selfie on file sends one as a photo in the chat within 60 s.
 */

export const GROUP_JOIN_ID = 'grp_join';
export const GROUP_DECLINE_ID = 'grp_decline';
type FormMeta = { metaAccessToken?: string; metaPhoneNumberId?: string; flowTokenSecret?: string };
const naira = (n: number) => `₦${Math.round(n).toLocaleString('en-NG')}`;

export function isGroupLiveReply(id: string | undefined | null): boolean {
  return id === GROUP_JOIN_ID || id === GROUP_DECLINE_ID;
}

/** The offer's words: who, where, the seat. */
export function groupOfferText(view: { riders: Array<{ you: boolean; name: string; pickup: string }>; seatPriceNgn: number; ownPriceNgn: number; extraMinutes: number }): string {
  const others = view.riders.filter((r) => !r.you).map((r) => `${r.name}${r.pickup ? ` (${r.pickup})` : ''}`);
  return [
    `*${others.length} rider${others.length === 1 ? ' is' : 's are'} going your way*`,
    `${others.join(' and ')} ${others.length === 1 ? 'is' : 'are'} on your road.`,
    '',
    `Ride together for *${naira(view.seatPriceNgn)}* instead of ${naira(view.ownPriceNgn)}, about ${view.extraMinutes} min more. You have 20 seconds.`,
  ].join('\n');
}

/** The offer: the form when published, else the two buttons. */
export async function sendGroupOffer(meta: FormMeta, to: string, riderId: string, view: Parameters<typeof groupOfferText>[0]): Promise<void> {
  const text = groupOfferText(view);
  const flowId = process.env['WHATSAPP_GROUP_FLOW_ID']?.trim();
  if (flowId && meta.flowTokenSecret) {
    const sent = await postInteractive(meta, to, {
      type: 'flow',
      body: { text },
      action: { name: 'flow', parameters: { flow_message_version: '3', flow_id: flowId, flow_token: signFlowToken(`grp:${riderId}`, meta.flowTokenSecret), flow_cta: 'Answer', flow_action: 'data_exchange' } },
    });
    if (sent) return;
  }
  await sendWaitingInteractive(meta, to, {
    type: 'button',
    body: { text },
    action: { buttons: [{ type: 'reply', reply: { id: GROUP_JOIN_ID, title: 'Ride together' } }, { type: 'reply', reply: { id: GROUP_DECLINE_ID, title: 'No thanks' } }] },
  });
}

async function postInteractive(meta: FormMeta, to: string, interactive: Record<string, unknown>): Promise<boolean> {
  if (!meta.metaAccessToken || !meta.metaPhoneNumberId) return false;
  const response = await fetch(`https://graph.facebook.com/v21.0/${meta.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${meta.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, ''), type: 'interactive', interactive }),
  }).catch(() => null);
  return Boolean(response?.ok);
}

export const SELFIE_ASK = 'Send a photo of your face here now (within 60 seconds). Riders in your group see it. You only do this once.';

/** A tap on Ride together / No thanks. Never throws. */
export async function handleGroupLiveTap(deps: MetaWhatsappRouteDeps, userId: string, phone: string, replyId: string): Promise<void> {
  const answer = replyId === GROUP_JOIN_ID ? 'join' : 'decline';
  try {
    const ride = await rideClient.findActiveByRider(userId).catch(() => null);
    if (!ride) {
      await sendWaitingText(deps, phone, 'This group ride offer has ended.');
      return;
    }
    const result = await answerGroupOffer(deps.redisClient, ride.id, userId, answer);
    if (answer === 'decline') {
      await sendWaitingText(deps, phone, 'No problem. Your own search goes on.');
      return;
    }
    if (result.selfieNeeded) {
      await expectGroupSelfie(deps.redisClient, userId);
      await sendWaitingText(deps, phone, SELFIE_ASK);
      return;
    }
    await sendWaitingText(deps, phone, "You're in. We'll tell you here when your group is set.");
  } catch (error) {
    if (error instanceof GroupLiveError) {
      await sendWaitingText(deps, phone, error.message);
      return;
    }
    console.warn('[group-live-chat] tap failed', { userId, error: error instanceof Error ? error.message : String(error) });
    await sendWaitingText(deps, phone, 'Something went wrong. Try again.');
  }
}

/** A photo in the chat while a group ride selfie is expected: true when it was taken as one (handled). */
export async function handleGroupLivePhoto(deps: MetaWhatsappRouteDeps, userId: string, phone: string, mediaId: string | undefined): Promise<boolean> {
  if (!(await deps.redisClient.get(groupSelfieExpectedKey(userId)).catch(() => null))) return false;
  if (!mediaId || !deps.metaAccessToken) {
    await sendWaitingText(deps, phone, 'Could not read that photo. Send it again.');
    return true;
  }
  try {
    const media = await downloadMetaMedia(deps.metaAccessToken, mediaId);
    const result = await takeGroupSelfie(
      { faceStorage: deps.groupRideFaceStorage, groqApiKey: deps.groqApiKey, groqModel: deps.groqModel, groqTimeoutMs: deps.groqTimeoutMs, redisClient: deps.redisClient },
      userId,
      media.buffer.toString('base64'),
      media.mimeType,
    );
    if (!result.ok) {
      await sendWaitingText(deps, phone, result.error);
      return true;
    }
    await deps.redisClient.del(groupSelfieExpectedKey(userId)).catch(() => undefined);
    await sendWaitingText(deps, phone, "Selfie saved. You're in; we'll tell you here when your group is set.");
  } catch (error) {
    console.warn('[group-live-chat] selfie failed', { userId, error: error instanceof Error ? error.message : String(error) });
    await sendWaitingText(deps, phone, 'Could not save that photo. Send a clear selfie again.');
  }
  return true;
}
