import { driverClient, userClient, virtualAccountClient } from '@wheleers/db';
import { createWalletPageToken, DEPOSIT_PAGE_TOKEN_TTL_SECONDS } from '../auth/local';
import type { RidePageChatEvent } from '../http/ride-page.route';
import { confirmRideWithOffer, offerKey } from '../rides/whatsapp-ride.service';
import { cancelRiderSos, raiseRiderSos } from '../safety/rider-sos';
import { appendWhatsappConversation } from '../LLM/conversation-store';
import { logActivity } from '../analytics/log-activity';
import { getActiveRide, clearActiveRide, getBids, storeLastBatch, getRideState, getRideMeta, getGroupSeat, storePendingAccept, markOffersMessageSent, getPendingAccept, clearPendingAccept } from '../whatsapp-flows/bid-state';
import type { WhatsappBid } from '../whatsapp-flows/bid-state';
import { tripLines as sharedTripLines } from '../whatsapp-flows/trip-text';
import { formatBidList, sendOffersInChat, sortOffers } from '../whatsapp-flows/whatsapp-notifier';
import { MetaWhatsappRouteDeps } from './deps';
import { sendInteractive, sendMetaLinkButton, sendMetaReply } from './send';
import { ridePageUrl, sendSearchStarted } from './trip';

export interface ConfirmedRideForChat {
  driverId: string; driverName: string; driverPhone: string; driverRating: number; totalRides: number;
  vehicleModel: string; vehiclePlate: string; etaSeconds: number; fareNgn: number;
  pickupAddress?: string; destAddress?: string; stopAddresses?: string[];
}

export const SOS_REPLY_ID = 'ride_sos';

export const SOS_CANCEL_REPLY_ID = 'ride_sos_cancel';

export const TRACK_REPLY_ID = 'ride_track';

/** A signed URL for one of a driver's KYC photos. Null when there is none, storage is off, or it fails. */
export async function driverPhotoUrl(deps: MetaWhatsappRouteDeps, driverId: string, which: 'selfie' | 'car'): Promise<string | null> {
  if (!deps.driverKycStorage) return null;
  try {
    const kyc = await driverClient.findKycSubmission(driverId);
    const key = which === 'selfie' ? kyc?.selfieKey : kyc?.vehicleImageKeys?.[0];
    return key ? await deps.driverKycStorage.getSignedUrl(key) : null;
  } catch {
    return null;
  }
}

/* ── quick actions: the menu, history, repeat / reverse ─────────────────── */

/** Everything about the ride, as one tidy list — the text under the driver's photo. */
export function rideDetailsText(ride: ConfirmedRideForChat): string {
  return [
    `*Ride confirmed & paid*`,
    ``,
    `*YOUR DRIVER*`,
    `Name: ${ride.driverName}`,
    `Rating: ${ride.driverRating.toFixed(1)} · ${ride.totalRides.toLocaleString()} rides`,
    ...(ride.driverPhone ? [`Phone: ${ride.driverPhone}`] : []),
    ``,
    `*THE CAR*`,
    `Car: ${ride.vehicleModel}`,
    `Plate: *${ride.vehiclePlate}* — check it before you get in`,
    ``,
    `*YOUR TRIP*`,
    ...(ride.pickupAddress && ride.destAddress
      ? sharedTripLines({ pickupAddress: ride.pickupAddress, destAddress: ride.destAddress, stops: (ride.stopAddresses ?? []).map((address) => ({ address })) })
      : []),
    ``,
    `Fare: ₦${ride.fareNgn.toLocaleString()} — held in your wallet, paid when the trip ends`,
    `Arrives in about ${Math.max(1, Math.ceil(ride.etaSeconds / 60))} min`,
    ``,
    `*Track live trip* — watch your driver on the map.`,
    `*SOS* — feel unsafe at any point? One tap and Wheelers' safety team has your trip and location.`,
  ].join('\n').slice(0, 1024);   // WhatsApp's limit for a button message's body
}

/**
 * "Your ride is confirmed" — TWO messages, the same from the chat, the offers
 * form and the page:
 *
 * ONE message: the DRIVER'S photo on top, every detail under it, and two
 * buttons — Track live trip, SOS.
 *
 * A face is what the rider needs now; the car matters later, at the kerb, so
 * its photo rides on "has arrived" instead (sendDriverArrivedNotification).
 * This used to be two messages and the card wore the car.
 *
 * WhatsApp gives a message ONE link button or up to three reply buttons, never
 * both. Two buttons means reply buttons, and a reply button cannot open a link —
 * so SOS acts on the tap, and Track live trip answers with the map's link button
 * (handleRideCardTap). That one extra message is the price of the second button.
 *
 * No photo on file, or WhatsApp refuses the picture → the same card without it;
 * refuses that too → plain text. The details always arrive.
 */
export async function sendRideConfirmation(
  deps: MetaWhatsappRouteDeps,
  userId: string,
  phone: string,
  ride: ConfirmedRideForChat,
): Promise<string> {
  const selfieUrl = await driverPhotoUrl(deps, ride.driverId, 'selfie');
  const details = rideDetailsText(ride);

  const card = (photo: string | null) => ({
    type: 'button',
    ...(photo ? { header: { type: 'image', image: { link: photo } } } : {}),
    body: { text: details },
    action: {
      buttons: [
        ...(deps.appBaseUrl ? [{ type: 'reply', reply: { id: TRACK_REPLY_ID, title: 'Track live trip' } }] : []),
        { type: 'reply', reply: { id: SOS_REPLY_ID, title: 'SOS' } },
      ],
    },
  });
  // A photo Meta refuses (an expired link, a format it dislikes) must not cost
  // the rider their driver's details: the same card goes again without it.
  const sent = (selfieUrl !== null && await sendInteractive(deps, phone, card(selfieUrl))) || await sendInteractive(deps, phone, card(null));
  if (!sent) await sendMetaReply(deps, phone, details);
  return details;
}

/**
 * The ride card's buttons, and "I'm safe". Answered whatever else the chat is
 * doing. SOS gets one short message: a person who has just asked for help must
 * see that it was heard — and one who slipped needs the way to take it back.
 */
export async function handleRideCardTap(deps: MetaWhatsappRouteDeps, userId: string, phone: string, replyId: string): Promise<void> {
  if (replyId === TRACK_REPLY_ID) {
    const url = ridePageUrl(deps, userId);
    if (url) await sendMetaLinkButton(deps, phone, 'Your driver, live on the map.', 'Open live map', url);
    return;
  }
  if (replyId === SOS_CANCEL_REPLY_ID) {
    const withdrawn = await cancelRiderSos(userId);
    await sendMetaReply(deps, phone, withdrawn ? 'Glad you are safe — the alert has been withdrawn.' : 'You have no open alert. Tap *SOS* on your ride card if you ever need us.');
    return;
  }
  const { alreadyOpen } = await raiseRiderSos(userId);
  logActivity({ userId, eventType: 'safety_alert_raised', source: 'whatsapp', metadata: { alreadyOpen } });
  const text = `*${alreadyOpen ? 'We already have your alert' : 'SOS received'}.* Wheelers' safety team has your trip, your driver and your location.\n\nIn immediate danger? Call *112*.`;
  const sent = await sendInteractive(deps, phone, {
    type: 'button',
    body: { text },
    action: { buttons: [{ type: 'reply', reply: { id: SOS_CANCEL_REPLY_ID, title: "I'm safe" } }] },
  });
  if (!sent) await sendMetaReply(deps, phone, text);
}

/**
 * What happened on the bidding page, told to the chat. The page is where the
 * rider acts; the chat is the record — and where the driver's details need to
 * be when the page is closed and the car is outside.
 */
export function createRidePageChatNotifier(deps: MetaWhatsappRouteDeps) {
  return async (event: RidePageChatEvent): Promise<void> => {
    if (!event.phone) return;

    if (event.kind === 'search_started') {
      const text = await sendSearchStarted(deps, { id: event.userId }, event.phone, event);
      await appendWhatsappConversation(deps.redisClient, event.phone, [
        { role: 'user', content: `[named a price on the offers page: ₦${event.offerNgn.toLocaleString()}]` },
        { role: 'assistant', content: text },
      ]);
      return;
    }

    if (event.kind === 'search_cancelled') {
      const text = 'Search cancelled — nothing was charged. Message me whenever you need a ride.';
      await appendWhatsappConversation(deps.redisClient, event.phone, [
        { role: 'user', content: '[cancelled the search on the offers page]' },
        { role: 'assistant', content: text },
      ]);
      await sendMetaReply(deps, event.phone, text);
      return;
    }

    const ride = event.ride;
    const text = await sendRideConfirmation(deps, event.userId, event.phone, ride);
    await appendWhatsappConversation(deps.redisClient, event.phone, [
      { role: 'user', content: `[accepted ${ride.driverName}'s offer on the offers page]` },
      { role: 'assistant', content: text },
    ]);
  };
}

/* ── offers in the chat: tap one and it is yours ────────────────────────── */

/**
 * The offers on the table right now, as a fresh message to tap. `news` is the
 * reason a fresh one is needed ("Tunde changed their price…") and leads it.
 * Returns what was said, for the conversation log.
 */
export async function sendCurrentOffers(
  deps: MetaWhatsappRouteDeps,
  phone: string,
  rideId: string,
  news?: string,
): Promise<string> {
  const bids = sortOffers(await getBids(deps.redisClient, rideId));
  if (bids.length === 0) {
    const text = `${news ? `${news}\n\n` : ''}Still asking drivers near you — I'll message you the moment one responds.\n\nType a new price (e.g. *3000*) to change your offer, or *cancel* to stop.`;
    await sendMetaReply(deps, phone, text);
    return text;
  }

  const meta = await getRideMeta(deps.redisClient, rideId);
  const offerNgn = meta?.offerNgn ?? 0;
  // What "1" means if they type a number must be what this message shows.
  await storeLastBatch(deps.redisClient, rideId, bids);

  // A group seat is booked by number: the car only moves when every rider picks the same driver.
  const groupSeat = await getGroupSeat(deps.redisClient, rideId).catch(() => null);
  if (!groupSeat && deps.metaAccessToken && deps.metaPhoneNumberId) {
    const sent = await sendOffersInChat(
      { metaAccessToken: deps.metaAccessToken, metaPhoneNumberId: deps.metaPhoneNumberId, offersFormFlowId: deps.whatsappOffersFormFlowId, flowTokenSecret: deps.jwtSecret },
      phone, bids, offerNgn, news ? [news] : undefined, meta?.riderId,
    );
    if (sent === 'form') await markOffersMessageSent(deps.redisClient, rideId).catch(() => undefined);
    if (sent) return `${news ? `${news} ` : ''}[sent ${bids.length} offer${bids.length === 1 ? '' : 's'} to tap]`;
  }
  const text = `${news ? `${news}\n\n` : ''}${formatBidList(bids, offerNgn)}`;
  await sendMetaReply(deps, phone, text);
  return text;
}

/**
 * "Add money to ride with Tunde" — one button, to the deposit page, which opens
 * straight on the amount to send. Nothing else to do: the deposit landing is
 * what confirms the driver (see createWhatsappDepositFinisher).
 */
export async function sendRideTopupButton(
  deps: MetaWhatsappRouteDeps,
  userId: string,
  phone: string,
  short: { driverName: string; fareNgn: number; balanceNgn: number; shortNgn: number; sendNgn: number },
  news?: string,
): Promise<string> {
  const driver = short.driverName.split(' ')[0] || short.driverName;
  const lines = [
    ...(news ? [news, ''] : []),
    `*Add money to ride with ${driver}*`,
    ``,
    `Fare: ₦${short.fareNgn.toLocaleString()} · your wallet: ₦${short.balanceNgn.toLocaleString()}`,
    `Send *₦${short.sendNgn.toLocaleString()}* and ₦${short.shortNgn.toLocaleString()} lands in your wallet.`,
    ``,
    `The moment it lands, ${driver} is confirmed — no need to come back and tap anything.`,
  ];

  if (deps.appBaseUrl) {
    const token = createWalletPageToken(userId, 'deposit', deps.jwtSecret, DEPOSIT_PAGE_TOKEN_TTL_SECONDS);
    const url = `${deps.appBaseUrl.replace(/\/+$/, '')}/widget/wallet/deposit.html#t=${encodeURIComponent(token)}`;
    const text = lines.join('\n');
    await sendMetaLinkButton(deps, phone, text, 'Add money', url);
    return text;
  }

  // No page to open: the account number goes in the chat, as it used to.
  const account = await virtualAccountClient.findByUserId(userId).catch(() => null);
  if (account) {
    lines.push(``, `Bank: *${account.bankName}*`, `Account: \`\`\`${account.accountNumber}\`\`\``, `Name: *${account.accountName}*`);
  }
  const text = lines.join('\n');
  await sendMetaReply(deps, phone, text);
  return text;
}

/** Remember who they chose, so a deposit (or a typed *pay*) can finish the job. */
export async function rememberChosenOffer(deps: MetaWhatsappRouteDeps, userId: string, rideId: string, bid: WhatsappBid): Promise<void> {
  const driver = await driverClient.findById(bid.driverId).catch(() => null);
  await storePendingAccept(deps.redisClient, userId, {
    rideId,
    bidId: bid.bidId,
    driverId: bid.driverId,
    driverUserId: bid.driverUserId,
    driverName: bid.driverName,
    driverPhone: driver?.user?.phone ?? '',
    driverRating: bid.driverRating,
    totalRides: driver?.totalRides ?? 0,
    vehicleModel: bid.vehicleModel,
    vehiclePlate: bid.vehiclePlate,
    etaSeconds: bid.etaSeconds,
    fareNgn: bid.counterOfferNgn,
  });
}

/**
 * The rider took an offer in the chat — a tapped button, a tapped list row, a
 * typed number, or *pay*. One path for all four, and the same rules as the
 * page's Accept because it IS the same function underneath.
 *
 * `shownPriceNgn` is the price on the message they tapped. Chat messages cannot
 * be edited, so an old one can show a price the driver has since changed; a tap
 * on it shows them the new price instead of holding it.
 */
export async function acceptOfferInChat(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  rideId: string,
  key: string,
  shownPriceNgn: number | null,
): Promise<void> {
  const log = (reply: string) => appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: incomingMessage },
    { role: 'assistant', content: reply },
  ]);

  const bid = (await getBids(deps.redisClient, rideId)).find((candidate) => offerKey(candidate) === key);
  if (!bid) {
    await clearPendingAccept(deps.redisClient, user.id);
    await log(await sendCurrentOffers(deps, phone, rideId, 'That offer is no longer on the table — nothing was charged.'));
    return;
  }
  if (shownPriceNgn !== null && bid.counterOfferNgn !== shownPriceNgn) {
    await clearPendingAccept(deps.redisClient, user.id);
    await log(await sendCurrentOffers(deps, phone, rideId,
      `${bid.driverName} changed their price to ₦${bid.counterOfferNgn.toLocaleString()} (it was ₦${shownPriceNgn.toLocaleString()}) — nothing was charged.`));
    return;
  }

  const result = await confirmRideWithOffer({ redisClient: deps.redisClient, publisher: deps.publisher }, user.id, rideId, key);
  if (result.ok) {
    logActivity({ userId: user.id, eventType: 'ride_offer_accepted', source: 'whatsapp', rideId, metadata: { fareNgn: result.ride.fareNgn, driverId: result.ride.driverId } });
    await log(await sendRideConfirmation(deps, user.id, phone, result.ride));
    return;
  }

  const driver = `*${bid.driverName}*`;
  switch (result.code) {
    case 'WALLET_SHORT':
      await rememberChosenOffer(deps, user.id, rideId, bid);
      await log(await sendRideTopupButton(deps, user.id, phone, { driverName: bid.driverName, ...result }));
      return;
    case 'DRIVER_UNAVAILABLE':
      await clearPendingAccept(deps.redisClient, user.id);
      await log(await sendCurrentOffers(deps, phone, rideId, `${bid.driverName} can't be reached right now — your money has not moved.`));
      return;
    case 'DRIVER_TAKEN':
      await clearPendingAccept(deps.redisClient, user.id);
      await log(await sendCurrentOffers(deps, phone, rideId, `Another rider is confirming ${bid.driverName} right now — your money has not moved.`));
      return;
    case 'ALREADY_CONFIRMING': {
      const reply = `One moment — ${driver} is being confirmed.`;
      await log(reply);
      await sendMetaReply(deps, phone, reply);
      return;
    }
    case 'HOLD_FAILED':
    case 'CONFIRM_FAILED': {
      await rememberChosenOffer(deps, user.id, rideId, bid);
      const reply = result.code === 'HOLD_FAILED'
        ? `Could not hold the fare in your wallet just now — nothing was charged. Reply *pay* to try ${driver} again.`
        : `Could not confirm the ride just now — your money is locked safely. Reply *pay* to try ${driver} again.`;
      await log(reply);
      await sendMetaReply(deps, phone, reply);
      return;
    }
    default: {
      await clearPendingAccept(deps.redisClient, user.id);
      await clearActiveRide(deps.redisClient, user.id);
      const reply = 'This search has ended — nothing was charged. Reply *search again* for a fresh one.';
      await log(reply);
      await sendMetaReply(deps, phone, reply);
    }
  }
}

export function createOffersFormChatHooks(deps: MetaWhatsappRouteDeps) {
  const phoneOf = async (userId: string) => (await userClient.findById(userId).catch(() => null))?.phone ?? null;
  return {
    onRideConfirmed: async (userId: string, ride: ConfirmedRideForChat): Promise<void> => {
      const phone = await phoneOf(userId);
      if (!phone) return;
      logActivity({ userId, eventType: 'ride_offer_accepted', source: 'whatsapp_form', metadata: { fareNgn: ride.fareNgn, driverId: ride.driverId } });
      const said = await sendRideConfirmation(deps, userId, phone, ride);
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: `[accepted ${ride.driverName}'s offer in the offers form]` },
        { role: 'assistant', content: said },
      ]);
    },
    onWalletShort: async (userId: string, rideId: string, bid: WhatsappBid, short: { balanceNgn: number; fareNgn: number; shortNgn: number; sendNgn: number }): Promise<void> => {
      const phone = await phoneOf(userId);
      if (!phone) return;
      await rememberChosenOffer(deps, userId, rideId, bid);        // the deposit landing finishes the job
      const said = await sendRideTopupButton(deps, userId, phone, { driverName: bid.driverName, ...short });
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: `[chose ${bid.driverName} in the offers form — wallet short]` },
        { role: 'assistant', content: said },
      ]);
    },
  };
}

/**
 * A WhatsApp rider's deposit has landed. If they were adding money to take a
 * driver they had tapped, take that driver now — the deposit IS the "pay".
 * Returns true when the chat has been told what happened, so the plain
 * "deposit received" message is not sent on top.
 *
 * Everything that can go wrong between the tap and the transfer is answered
 * here, because nobody is looking at a screen when it happens:
 *   the driver left / re-priced / was taken → money stays in the wallet, fresh offers
 *   the search ended                        → money stays in the wallet, "search again"
 *   they sent too little                    → what is still missing, same button
 */
export function createWhatsappDepositFinisher(deps: MetaWhatsappRouteDeps) {
  return async (deposit: { userId: string; amountNgn: number; newBalanceNgn: number }): Promise<boolean> => {
    const pending = await getPendingAccept(deps.redisClient, deposit.userId);
    if (!pending) return false;
    const phone = (await userClient.findById(deposit.userId).catch(() => null))?.phone;
    if (!phone) return false;

    const received = `₦${deposit.amountNgn.toLocaleString()} received — your wallet has ₦${deposit.newBalanceNgn.toLocaleString()}.`;
    const log = (reply: string) => appendWhatsappConversation(deps.redisClient, phone, [
      { role: 'user', content: `[deposit of ₦${deposit.amountNgn.toLocaleString()} landed]` },
      { role: 'assistant', content: reply },
    ]);

    const activeRideId = await getActiveRide(deps.redisClient, deposit.userId);
    if (activeRideId !== pending.rideId) {
      // The search they were paying for is over. The money is theirs, in the wallet.
      await clearPendingAccept(deps.redisClient, deposit.userId);
      if (activeRideId) return false;
      const reply = `${received}\n\nThe search ended while your transfer was on its way, so *${pending.driverName}* was not booked. Your money is safe in your wallet — reply *search again* to find a driver.`;
      await log(reply);
      await sendMetaReply(deps, phone, reply);
      return true;
    }
    const state = await getRideState(deps.redisClient, pending.rideId).catch(() => null);
    if (state === 'confirmed' || state === 'in_progress') {
      await clearPendingAccept(deps.redisClient, deposit.userId);
      return false;
    }

    const key = pending.bidId ?? `driver:${pending.driverId}`;
    const bid = (await getBids(deps.redisClient, pending.rideId)).find((candidate) => offerKey(candidate) === key);
    if (!bid || bid.counterOfferNgn !== pending.fareNgn) {
      await clearPendingAccept(deps.redisClient, deposit.userId);
      const why = bid
        ? `${pending.driverName} changed their price to ₦${bid.counterOfferNgn.toLocaleString()} while your transfer was on its way, so nothing was booked.`
        : `${pending.driverName} is no longer available, so nothing was booked.`;
      await log(await sendCurrentOffers(deps, phone, pending.rideId, `${received} ${why} Your money is safe in your wallet.`));
      return true;
    }

    const result = await confirmRideWithOffer({ redisClient: deps.redisClient, publisher: deps.publisher }, deposit.userId, pending.rideId, key);
    if (result.ok) {
      logActivity({ userId: deposit.userId, eventType: 'ride_offer_accepted', source: 'whatsapp_deposit', rideId: pending.rideId, metadata: { fareNgn: result.ride.fareNgn, driverId: result.ride.driverId } });
      await log(await sendRideConfirmation(deps, deposit.userId, phone, result.ride));
      return true;
    }
    if (result.code === 'WALLET_SHORT') {
      await rememberChosenOffer(deps, deposit.userId, pending.rideId, bid);   // keep the choice alive for the next transfer
      await log(await sendRideTopupButton(deps, deposit.userId, phone, { driverName: bid.driverName, ...result },
        `${received} That is not quite enough for this ride yet.`));
      return true;
    }
    if (result.code === 'ALREADY_CONFIRMING') return true;   // their own tap got there first and is speaking
    if (result.code === 'HOLD_FAILED' || result.code === 'CONFIRM_FAILED') {
      const reply = `${received}\n\nI could not confirm *${pending.driverName}* just now. Reply *pay* to try again.`;
      await log(reply);
      await sendMetaReply(deps, phone, reply);
      return true;
    }
    await clearPendingAccept(deps.redisClient, deposit.userId);
    if (result.code === 'RIDE_GONE') {
      const reply = `${received}\n\nThe search ended while your transfer was on its way, so *${pending.driverName}* was not booked. Your money is safe in your wallet — reply *search again* to find a driver.`;
      await log(reply);
      await sendMetaReply(deps, phone, reply);
      return true;
    }
    await log(await sendCurrentOffers(deps, phone, pending.rideId,
      `${received} ${pending.driverName} ${result.code === 'DRIVER_TAKEN' ? 'was taken by another rider' : "can't be reached right now"}, so nothing was booked. Your money is safe in your wallet.`));
    return true;
  };
}

