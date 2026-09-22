import { signFlowToken } from './encryption';
import { META_FLOWS_ENABLED, OFFERS_FORM_FLOW_ENABLED } from './flow-toggle';
import { calculateRideFees } from '@wheleers/config';
import type { WhatsappBid, WhatsappRideMeta } from './bid-state';

export interface WhatsappNotifierDeps {
  metaAccessToken: string;
  metaPhoneNumberId: string;
  /** When set, bid updates for flow rides go out as a tappable flow message. */
  offersFlowId?: string;
  flowTokenSecret?: string;
  /** Published offers FORM (offers-form-flow.ts). With it, offers are one message with one button. */
  offersFormFlowId?: string;
}

/* ── offers, in the chat, as things to TAP ─────────────────────────────── */

/** What a tapped offer sends back: `offer:<price shown>:<offer key>`. */
const OFFER_REPLY = /^offer:(\d+):(.+)$/;
export const CHANGE_PRICE_REPLY_ID = 'offers_change_price';
export const CANCEL_SEARCH_REPLY_ID = 'offers_cancel';
export const CHANGE_PRICE_TITLE = 'Change my price';
export const CANCEL_SEARCH_TITLE = 'Cancel search';
/** WhatsApp allows ten rows in a list; two are "change my price" and "cancel". */
const MAX_OFFER_ROWS = 8;

/** Same handle the bidding page uses: the durable bid id when there is one. */
function keyOf(bid: WhatsappBid): string {
  return bid.bidId ?? `driver:${bid.driverId}`;
}

/**
 * The price rides in the id on purpose. A chat message cannot be edited, so an
 * old one may still show ₦2,800 after the driver has moved to ₦3,200 — and a tap
 * on it must never hold a fare the rider did not see.
 */
export function offerReplyId(bid: WhatsappBid): string {
  return `offer:${bid.counterOfferNgn}:${keyOf(bid)}`;
}

export function parseOfferReplyId(id: string | undefined): { shownPriceNgn: number; key: string } | null {
  const match = OFFER_REPLY.exec(id ?? '');
  return match ? { shownPriceNgn: Number(match[1]), key: match[2]! } : null;
}

/** Cheapest first, nearest breaking a tie — the order shown, and the order "1" means. */
export function sortOffers(bids: WhatsappBid[]): WhatsappBid[] {
  return [...bids].sort((a, b) => (a.counterOfferNgn - b.counterOfferNgn) || (a.etaSeconds - b.etaSeconds));
}

function offerFacts(bid: WhatsappBid): string {
  const etaMin = Math.max(1, Math.ceil(bid.etaSeconds / 60));
  return [bid.vehicleModel, bid.vehiclePlate, `${bid.driverRating.toFixed(1)}★`, `${etaMin} min away`].filter(Boolean).join(' · ');
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || 'Driver';
}

/** The interactive message for the offers on the table. Exported for tests. */
export function buildOffersMessage(
  bids: WhatsappBid[],
  riderOfferNgn: number,
  changes?: string[],
): Record<string, unknown> | null {
  const offers = sortOffers(bids);
  if (offers.length === 0) return null;
  const news = changes && changes.length > 0 ? `🔔 ${changes.join('\n🔔 ')}\n\n` : '';

  if (offers.length === 1) {
    const bid = offers[0]!;
    return {
      type: 'button',
      body: {
        text: `${news}🚗 *${bid.driverName}* offers *₦${bid.counterOfferNgn.toLocaleString()}*\n${offerFacts(bid)}\n\nYour price: ₦${riderOfferNgn.toLocaleString()}`.slice(0, 1024),
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: offerReplyId(bid), title: `Accept ₦${bid.counterOfferNgn.toLocaleString()}`.slice(0, 20) } },
          { type: 'reply', reply: { id: CHANGE_PRICE_REPLY_ID, title: CHANGE_PRICE_TITLE } },
          { type: 'reply', reply: { id: CANCEL_SEARCH_REPLY_ID, title: CANCEL_SEARCH_TITLE } },
        ],
      },
    };
  }

  const shown = offers.slice(0, MAX_OFFER_ROWS);
  const lines = shown.map((bid) => `*₦${bid.counterOfferNgn.toLocaleString()}* — ${bid.driverName}\n${offerFacts(bid)}`);
  const hidden = offers.length - shown.length;
  return {
    type: 'list',
    body: {
      text: [
        `${news}🚗 *${offers.length} drivers have made offers* · your price ₦${riderOfferNgn.toLocaleString()}`,
        '',
        lines.join('\n\n'),
        ...(hidden > 0 ? ['', `…and ${hidden} more at higher prices.`] : []),
        '',
        'Tap *Choose a driver* to take one.',
      ].join('\n').slice(0, 1024),
    },
    action: {
      button: 'Choose a driver',
      sections: [
        {
          title: 'Offers',
          rows: shown.map((bid) => ({
            id: offerReplyId(bid),
            title: `₦${bid.counterOfferNgn.toLocaleString()} · ${firstName(bid.driverName)}`.slice(0, 24),
            description: offerFacts(bid).slice(0, 72),
          })),
        },
        {
          title: 'Something else',
          rows: [
            { id: CHANGE_PRICE_REPLY_ID, title: CHANGE_PRICE_TITLE, description: 'Offer drivers a different amount' },
            { id: CANCEL_SEARCH_REPLY_ID, title: CANCEL_SEARCH_TITLE, description: 'Stop looking — nothing is charged' },
          ],
        },
      ],
    },
  };
}

/**
 * Offers go to the chat as things to tap: one offer is an "Accept ₦X" button,
 * several are a "Choose a driver" list. No "reply 1–3" instructions — the tap IS
 * the reply. Returns false when WhatsApp refuses the message, so the caller can
 * fall back to the numbered text list (the one case where numbers are still the
 * only way to answer).
 */
export async function sendOffersInChat(
  deps: WhatsappNotifierDeps,
  phone: string,
  bids: WhatsappBid[],
  riderOfferNgn: number,
  changes?: string[],
  /** Whose offers these are. With it and a published form, the message's one button opens the offers form. */
  riderId?: string,
): Promise<'form' | 'buttons' | false> {
  const buttons = buildOffersMessage(bids, riderOfferNgn, changes);
  if (!buttons) return false;

  // WhatsApp allows reply buttons OR one form button. The form wins when there is
  // one: accepting, changing the price, declining and cancelling all happen inside
  // it, so none of them costs another chat message.
  //
  // Its message says HOW MANY drivers, never who or how much: it is not sent again
  // while it sits unopened (see announceOffers), so anything more specific would go
  // stale. The form shows the live list the moment it opens.
  const form = riderId && OFFERS_FORM_FLOW_ENABLED && deps.offersFormFlowId && deps.flowTokenSecret
    ? {
        type: 'flow',
        body: {
          text: [
            `🚗 *${bids.length === 1 ? '1 driver found' : `${bids.length} drivers found`}* for your ₦${riderOfferNgn.toLocaleString()} offer.`,
            '',
            'Tap below to see who — accept one, decline them all, change your price or cancel. More drivers may have answered by the time you open it.',
          ].join('\n'),
        },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_id: deps.offersFormFlowId,
            flow_token: signFlowToken(`bids:${riderId}`, deps.flowTokenSecret),
            flow_cta: 'See driver offers',
            flow_action: 'data_exchange',
          },
        },
      }
    : null;
  if (form && await postInteractive(deps, phone, form)) return 'form';
  return (await postInteractive(deps, phone, buttons)) ? 'buttons' : false;
}

/** True when offers go out as the form message (one button) rather than reply buttons. */
export function offersFormIsOn(deps: WhatsappNotifierDeps): boolean {
  return OFFERS_FORM_FLOW_ENABLED && Boolean(deps.offersFormFlowId && deps.flowTokenSecret);
}

async function postInteractive(deps: WhatsappNotifierDeps, phone: string, interactive: Record<string, unknown>): Promise<boolean> {

  const response = await fetch(`https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone.replace(/^\+/, ''),
      type: 'interactive',
      interactive,
    }),
  }).catch(() => null);

  if (!response?.ok) {
    console.error('[whatsapp-notifier] tappable offers failed — falling back to the numbered list', {
      status: response?.status ?? null,
      payload: response ? await response.text().catch(() => '') : 'network error',
    });
    return false;
  }
  return true;
}

export async function sendMetaWhatsappMessage(
  deps: WhatsappNotifierDeps,
  to: string,
  body: string,
): Promise<void> {
  // Strip leading '+' — Meta expects phone numbers without it
  const recipient = to.replace(/^\+/, '');
  const endpoint = `https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deps.metaAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: { body },
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp-notifier] Meta send failed', { status: response.status, payload });
  }
}

// ── Build a single message listing all driver bids ────────────────────────

/** +234-format so WhatsApp renders the number as a tappable link. */
export function formatTappablePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('0')) return `+234${digits.slice(1)}`;
  if (digits.startsWith('234')) return `+${digits}`;
  return `+${digits}`;
}

function formatBidList(
  bids: WhatsappBid[],
  riderOfferNgn: number,
  changes?: string[],
): string {
  const count = bids.length;
  // An update reads as a change to one conversation, not a fresh fanfare —
  // "1 driver found!" four times about the same man read as spam.
  const header = changes && changes.length > 0
    ? `🔔 *Offer update*\n${changes.map((c) => `• ${c}`).join('\n')}\n\nYour offer: ₦${riderOfferNgn.toLocaleString()}\n`
    : `🚗 *${count} driver offer${count === 1 ? '' : 's'}*\n\nYour offer: ₦${riderOfferNgn.toLocaleString()}\n`;

  const lines = bids.map((bid, i) => {
    const num = i + 1;
    const etaMin = Math.ceil(bid.etaSeconds / 60);
    const away =
      bid.distanceKm !== undefined
        ? `${bid.distanceKm.toFixed(1)} km · ${etaMin} min away`
        : `${etaMin} min away`;
    return `*${num}.* ${bid.driverName} — ₦${bid.counterOfferNgn.toLocaleString()}\n    ${bid.vehicleModel} · ${bid.driverRating.toFixed(1)}★ · ${away}`;
  });

  // Lead with the shortest thing that works. Riders reply to a numbered list
  // with the number — telling them to type "accept 1" made the easy path look
  // unavailable.
  const footer = [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    'Reply with:',
    `• *1*${count > 1 ? ` – *${count}*` : ''} — the driver's number to book them`,
    '• A *price* (e.g. "1500") — to counter-offer and get new drivers',
    '• *more* — to see more drivers',
    '• *cancel* — to cancel the ride',
  ];

  return [header, ...lines, ...footer].join('\n');
}

export { formatBidList };

/**
 * Flow-booked rides keep bidding on the screen. WhatsApp cannot push into an
 * open flow, so each debounced bid batch sends a message with a 'View offers'
 * button — tapping it re-opens the flow, whose INIT loads the CURRENT bids.
 * Chat-text fallback when the flow id/secret are not wired.
 */
export async function sendFlowOffersMessage(
  deps: WhatsappNotifierDeps,
  to: string,
  riderId: string,
  meta: WhatsappRideMeta,
  bids: WhatsappBid[],
): Promise<void> {
  const count = bids.length;
  const body =
    count > 0
      ? `🚗 ${count} driver offer${count === 1 ? '' : 's'} on your ₦${meta.offerNgn.toLocaleString()} request!\nLowest: ₦${Math.min(...bids.map((b) => b.counterOfferNgn)).toLocaleString()}. Tap below to view and accept.`
      : `🔎 We're finding drivers for your ₦${meta.offerNgn.toLocaleString()} request!\nOffers land right here — tap below anytime to check them.`;

  if (!META_FLOWS_ENABLED || !deps.offersFlowId || !deps.flowTokenSecret) {
    await sendMetaWhatsappMessage(deps, to, body);
    return;
  }

  const recipient = to.replace(/^\+/, '');
  const endpoint = `https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deps.metaAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'interactive',
      interactive: {
        type: 'flow',
        header: { type: 'text', text: 'Driver offers 🚗' },
        body: { text: body },
        footer: { text: 'Wheelers' },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            // The OFFERS flow's entry screen IS the bid list — the booking
            // flow may only open on RIDE_SETUP, so it cannot show offers on
            // open. INIT here loads the live bid list every time.
            flow_id: deps.offersFlowId,
            flow_token: signFlowToken(`offers:${riderId}`, deps.flowTokenSecret),
            flow_cta: count > 0 ? 'View offers' : 'Check offers',
            flow_action: 'data_exchange',
          },
        },
      },
    }),
  });
  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp-notifier] flow offers message failed', { status: response.status, payload });
    // Never leave the rider unaware of money on the table.
    await sendMetaWhatsappMessage(deps, to, body);
  }
}

// ── Send batched bid notification (1 message with all drivers) ────────────

export async function sendBidNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  bids: WhatsappBid[],
  riderOfferNgn: number,
  changes?: string[],
): Promise<void> {
  const message = formatBidList(bids, riderOfferNgn, changes);
  await sendMetaWhatsappMessage(deps, phone, message);
}

export async function sendRideMatchedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  driverName: string,
  vehicleModel: string,
  vehiclePlate: string,
  etaSeconds: number,
  fareNgn: number,
  driverRating: number,
  driverPhone?: string | null,
): Promise<void> {
  const etaMin = Math.ceil(etaSeconds / 60);
  const fees = calculateRideFees(fareNgn);
  const msg = [
    `✅ *Ride confirmed!*`,
    ``,
    `Driver: *${driverName}*`,
    `Vehicle: ${vehicleModel} (${vehiclePlate})`,
    `Rating: ${driverRating.toFixed(1)}★`,
    `Fare: ₦${fees.totalNgn.toLocaleString()}`,
    ...(formatTappablePhone(driverPhone) ? [`Call your driver: ${formatTappablePhone(driverPhone)}`] : []),
    ``,
    `🚗 ${driverName} is on the way — they'll be with you in ~${etaMin} min.`,
  ].join('\n');

  await sendMetaWhatsappMessage(deps, phone, msg);
}

export async function sendDriverArrivedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  details?: {
    driverName?: string;
    vehicleModel?: string;
    vehiclePlate?: string;
    driverPhone?: string | null;
    /** The car's own photo. THIS is the moment for it — the rider is looking for it. */
    carPhotoUrl?: string | null;
  },
): Promise<void> {
  // Chat messages can't be edited, so each one stands alone: the rider must
  // never scroll back through the auction to learn which car to look for.
  const car = details?.vehicleModel
    ? ` — look for the *${details.vehicleModel}*${details.vehiclePlate ? ` (${details.vehiclePlate})` : ''}`
    : '';
  const call = formatTappablePhone(details?.driverPhone);
  const text = [
    `✅ *${details?.driverName ?? 'Your driver'} has arrived*${car}.`,
    ...(call ? [``, `Can't see them? Call: ${call}`] : []),
  ].join('\n');

  // ONE message: the car, with all of that as its caption. A photo Meta refuses
  // must never swallow "your driver is outside", so the text goes on its own then.
  if (details?.carPhotoUrl && await postImage(deps, phone, details.carPhotoUrl, text)) return;
  await sendMetaWhatsappMessage(deps, phone, text);
}

/** One picture with a caption. False when Meta refuses it, so the caller can fall back to text. */
async function postImage(deps: WhatsappNotifierDeps, phone: string, link: string, caption: string): Promise<boolean> {
  const response = await fetch(`https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone.replace(/^\+/, ''),
      type: 'image',
      image: { link, caption: caption.slice(0, 1024) },
    }),
  }).catch(() => null);
  if (!response?.ok) {
    console.error('[whatsapp-notifier] image failed — sending the words on their own', {
      status: response?.status ?? null,
      payload: response ? await response.text().catch(() => '') : 'network error',
    });
    return false;
  }
  return true;
}

export async function sendRideStartedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
): Promise<void> {
  await sendMetaWhatsappMessage(deps, phone, [
    `🚗 *Trip started*`,
    ``,
    `Sit back and stay safe. We'll send your receipt when you arrive.`,
  ].join('\n'));
}

export { sendRideCompletedNotification };

async function sendRideCompletedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  fareNgn: number,
  distanceKm: number,
  balanceNgn?: number,
): Promise<void> {
  const fees = calculateRideFees(fareNgn);
  const lines = [
    `🏁 *Trip complete!*`,
    ``,
    `Distance: ${distanceKm.toFixed(1)} km`,
    `Fare: ₦${fees.totalNgn.toLocaleString()} — paid from your wallet`,
    ...(balanceNgn !== undefined ? [`Balance: ₦${balanceNgn.toLocaleString()}`] : []),
    ``,
    `How was your driver? Reply *1–5* to rate them ⭐`,
  ];
  await sendMetaWhatsappMessage(deps, phone, lines.join('\n'));
}

export async function sendRideCancelledNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  details: {
    /** Raw machine reason (e.g. driver_cancelled) — never shown verbatim. */
    reason?: string;
    cancelledBy?: 'rider' | 'driver' | 'system';
    /** Money that was held for this ride and is now back in the wallet. */
    refundedNgn?: number;
    balanceNgn?: number;
  },
): Promise<void> {
  // A rider must never see a raw enum, and after paying they must be told —
  // in the same breath — that their money is back. "driver_cancelled" with
  // no refund line reads like a scam.
  const who =
    details.cancelledBy === 'driver' || details.reason === 'driver_cancelled' || details.reason === 'rider_no_show'
      ? 'Your driver had to cancel the trip. Sorry about that!'
      : details.cancelledBy === 'system'
        ? 'This ride was cancelled.'
        : 'Your ride has been cancelled.';

  const lines = [`❌ ${who}`];
  if (details.refundedNgn && details.refundedNgn > 0) {
    lines.push(
      '',
      `💰 Your ₦${details.refundedNgn.toLocaleString()} is back in your wallet` +
        (details.balanceNgn !== undefined
          ? ` — balance: ₦${details.balanceNgn.toLocaleString()}.`
          : '.'),
    );
  }
  lines.push('', 'Book another ride anytime — just send your route. 🚗');
  await sendMetaWhatsappMessage(deps, phone, lines.join('\n'));
}

/** A driver whose offer was on the rider's list is no longer available. */
export async function sendOfferWithdrawnNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  driverName: string | undefined,
  remaining: number,
): Promise<void> {
  const who = driverName ? `*${driverName}*` : 'One driver';
  const next = remaining > 0
    ? `Here ${remaining === 1 ? 'is the offer' : `are the ${remaining} offers`} still on the table 👇`
    : 'Other offers will land here as drivers respond.';
  await sendMetaWhatsappMessage(deps, phone, [
    `ℹ️ ${who} is no longer available — their offer has been removed.`,
    ``,
    next,
  ].join('\n'));
}

export async function sendBidTimeoutNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  offerNgn?: number,
): Promise<void> {
  // A dead end with no door is where riders churn. Name the two ways
  // forward, in order of what actually works.
  const lines = [
    offerNgn
      ? `😕 No driver took ₦${offerNgn.toLocaleString()} this time.`
      : '😕 No driver accepted this request.',
    '',
    'Two ways forward:',
    `• Reply *search again* — same route, fresh search`,
    offerNgn
      ? `• Send a higher offer (e.g. *${Math.ceil((offerNgn * 1.1) / 100) * 100}*) — usually gets drivers moving`
      : '• Send a higher offer — usually gets drivers moving',
  ];
  await sendMetaWhatsappMessage(deps, phone, lines.join('\n'));
}

export async function sendRiderPaidNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  newBalanceNgn: number,
): Promise<void> {
  await sendMetaWhatsappMessage(
    deps,
    phone,
    [
      `✅ *Payment received*`,
      ``,
      `Wallet balance: ₦${newBalanceNgn.toLocaleString()}`,
      ``,
      `Your driver has been told — they are on the way. 🚗`,
    ].join('\n'),
  );
}

export async function sendDepositConfirmation(
  deps: WhatsappNotifierDeps,
  phone: string,
  amountNgn: number,
  newBalanceNgn: number,
): Promise<void> {
  const msg = [
    `✅ *Deposit received*`,
    ``,
    `Amount: ₦${amountNgn.toLocaleString()}`,
    `Wallet balance: ₦${newBalanceNgn.toLocaleString()}`,
    ``,
    `Your wallet is ready — book a ride anytime. 🚗`,
  ].join('\n');

  await sendMetaWhatsappMessage(deps, phone, msg);
}

export async function sendSearchingNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  pickupAddress: string,
  destAddress: string,
  offerNgn: number,
  paymentMethod: string,
): Promise<void> {
  const payLabel = paymentMethod === 'WALLET' ? 'Wallet' : 'Cash';
  const msg = [
    `🔍 *Looking for drivers!*`,
    ``,
    `📍 ${pickupAddress}`,
    `📍 ${destAddress}`,
    ``,
    `Offer: ₦${offerNgn.toLocaleString()}`,
    `Payment: ${payLabel}`,
    ``,
    `I'll message you when drivers respond! 🚗`,
  ].join('\n');

  await sendMetaWhatsappMessage(deps, phone, msg);
}

export async function sendGroupRideGroupedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  riderCount: number,
  totalDistanceKm: number,
  totalDurationSeconds: number,
): Promise<void> {
  const durationMin = Math.max(1, Math.ceil(totalDurationSeconds / 60));
  const msg = [
    `🎉 *Group found!*`,
    ``,
    `You've been matched with ${riderCount - 1} other rider${riderCount - 1 === 1 ? '' : 's'} heading your way.`,
    `Shared route: ${totalDistanceKm.toFixed(1)} km · ~${durationMin} min`,
    ``,
    `We're finding a driver for your group now — I'll message you the moment one accepts. 🚗`,
  ].join('\n');

  await sendMetaWhatsappMessage(deps, phone, msg);
}

export async function sendGroupRideDriverAssignedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  driverName: string,
  vehicleModel: string,
  vehiclePlate: string,
  driverRating: number,
  etaSeconds: number,
): Promise<void> {
  const etaMin = Math.max(1, Math.ceil(etaSeconds / 60));
  const msg = [
    `✅ *Driver found for your group ride!*`,
    ``,
    `Driver: *${driverName}*`,
    `Vehicle: ${vehicleModel}${vehiclePlate ? ` (${vehiclePlate})` : ''}`,
    `Rating: ${driverRating.toFixed(1)}★`,
    ``,
    `🚗 ${driverName} is on the way — they'll reach the first pickup in ~${etaMin} min.`,
  ].join('\n');

  await sendMetaWhatsappMessage(deps, phone, msg);
}

export async function sendGroupRideDispatchNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  seatOfferNgn: number,
): Promise<void> {
  const msg = [
    `🚗 *Drivers are seeing your group ride now!*`,
    ``,
    `Your seat is offered at *₦${seatOfferNgn.toLocaleString()}* — driver offers for YOUR seat will land here as a numbered list.`,
    ``,
    `Reply a driver's *number* to book your seat, or a *price* to counter-offer. The car leaves when every rider has booked their seat with the same driver.`,
  ].join('\n');

  await sendMetaWhatsappMessage(deps, phone, msg);
}

export async function sendGroupRideWaitNudge(
  deps: WhatsappNotifierDeps,
  phone: string,
  waitedMinutes: number,
): Promise<void> {
  const msg = [
    `⏳ *Still looking for co-riders* — it's been ~${waitedMinutes} minutes with no group yet.`,
    ``,
    `Reply:`,
    `• *normal* — book this trip as a normal ride right now`,
    `• *wait* — keep looking for another ${waitedMinutes} minutes`,
    `• *cancel group* — stop looking`,
  ].join('\n');

  await sendMetaWhatsappMessage(deps, phone, msg);
}
