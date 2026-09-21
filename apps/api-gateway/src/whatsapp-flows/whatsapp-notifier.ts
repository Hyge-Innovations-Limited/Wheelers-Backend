import { createWalletPageToken, RIDE_PAGE_TOKEN_TTL_SECONDS } from '../auth/local';
import { signFlowToken } from './encryption';
import { META_FLOWS_ENABLED } from './flow-toggle';
import { calculateRideFees } from '@wheleers/config';
import type { WhatsappBid, WhatsappRideMeta } from './bid-state';

export interface WhatsappNotifierDeps {
  metaAccessToken: string;
  metaPhoneNumberId: string;
  /** When set, bid updates for flow rides go out as a tappable flow message. */
  offersFlowId?: string;
  flowTokenSecret?: string;
  /**
   * With both set, offers are announced with a "View offers" button to the
   * bidding page instead of being listed in the chat.
   */
  appBaseUrl?: string;
  pageTokenSecret?: string;
}

/**
 * The chat's whole part in bidding when the rider is NOT on the page: one short
 * line and a button. The list itself — who, how much, how far — lives on the
 * page, where it updates in place instead of arriving as message after message.
 * Returns false when the button cannot be sent, so the caller can fall back to
 * the text list.
 */
export async function sendOffersButton(
  deps: WhatsappNotifierDeps,
  phone: string,
  riderId: string,
  bids: WhatsappBid[],
): Promise<boolean> {
  if (!deps.appBaseUrl || !deps.pageTokenSecret || bids.length === 0) return false;

  const best = [...bids].sort((a, b) => a.counterOfferNgn - b.counterOfferNgn)[0]!;
  const nearest = [...bids].sort((a, b) => a.etaSeconds - b.etaSeconds)[0]!;
  const headline = bids.length === 1
    ? `🚗 *${best.driverName}* offered ₦${best.counterOfferNgn.toLocaleString()} · ${Math.max(1, Math.ceil(best.etaSeconds / 60))} min away`
    : `🚗 *${bids.length} drivers have made offers* — from ₦${best.counterOfferNgn.toLocaleString()}, nearest ${Math.max(1, Math.ceil(nearest.etaSeconds / 60))} min away`;
  const token = createWalletPageToken(riderId, 'ride', deps.pageTokenSecret, RIDE_PAGE_TOKEN_TTL_SECONDS);
  const url = `${deps.appBaseUrl.replace(/\/+$/, '')}/widget/ride/ride.html#t=${encodeURIComponent(token)}`;

  const response = await fetch(`https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.metaAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone.replace(/^\+/, ''),
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: `${headline}\n\nTap *View offers* to compare and pick one — or reply *more* to see them here.` },
        action: { name: 'cta_url', parameters: { display_text: 'View offers', url } },
      },
    }),
  }).catch(() => null);

  if (!response?.ok) {
    console.error('[whatsapp-notifier] offers button failed — falling back to the text list', {
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
  },
): Promise<void> {
  // Chat messages can't be edited, so each one stands alone: the rider must
  // never scroll back through the auction to learn which car to look for.
  const car = details?.vehicleModel
    ? ` — look for the *${details.vehicleModel}*${details.vehiclePlate ? ` (${details.vehiclePlate})` : ''}`
    : '';
  const call = formatTappablePhone(details?.driverPhone);
  const lines = [
    `✅ *${details?.driverName ?? 'Your driver'} has arrived*${car}.`,
    ...(call ? [``, `Can't see them? Call: ${call}`] : []),
  ];
  await sendMetaWhatsappMessage(deps, phone, lines.join('\n'));
}

export async function sendRideStartedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
): Promise<void> {
  await sendMetaWhatsappMessage(deps, phone, 'Your ride has started! Stay safe. 🚗');
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
    ? `Reply *more* to see the ${remaining} still available.`
    : 'Other offers will land here as drivers respond.';
  await sendMetaWhatsappMessage(deps, phone, `ℹ️ ${who} is no longer available — their offer has been removed. ${next}`);
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
    `Payment received! Your wallet balance is now ₦${newBalanceNgn.toLocaleString()}. Your driver has been notified and is on the way.`,
  );
}

export async function sendDepositConfirmation(
  deps: WhatsappNotifierDeps,
  phone: string,
  amountNgn: number,
  newBalanceNgn: number,
): Promise<void> {
  const msg = [
    `Deposit received!`,
    ``,
    `Amount: NGN ${amountNgn.toLocaleString()}`,
    `Wallet balance: NGN ${newBalanceNgn.toLocaleString()}`,
    ``,
    `Your wallet is ready. Book a ride anytime!`,
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
