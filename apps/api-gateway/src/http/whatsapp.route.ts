import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { groupRideClient, walletClient, walletSecurityClient, withdrawalClient, rideClient } from '@wheleers/db';
import { validateRiderOffer, depositNeededFor } from '@wheleers/config';
import { RideRequestedEvent, RideCancelledEvent, RideOfferAcceptedEvent, FeedbackLoggedEvent } from '@wheleers/kafka-schemas';
import { offerKey, publishWhatsappRide } from '../rides/whatsapp-ride.service';
import { QUICK_ACTION_IDS, isQuickActionId, asksForMenu } from './quick-actions';
import { onboardWhatsappUser } from '../onboarding/user-onboarding';
import { appendWhatsappConversation, getWhatsappConversation } from '../LLM/conversation-store';
import { WhatsappBotService } from '../LLM/whatsapp-bot.service';
import { createLlm } from '../LLM/llm';
import { geocodeMissLine, isPinInsideServiceArea, outsideServiceAreaMatch, OUTSIDE_SERVICE_AREA_LINE } from '../LLM/geocoding';
import { parseRideIntent } from '../LLM/ride-intent-parser';
import { classifyWalletIntent, mightConcernMoney } from '../LLM/wallet-intent';
import { classifyBookingIntent, mightNotBeAnAddress } from '../LLM/booking-intent';
import type { BookingIntentResult } from '../LLM/booking-intent';
import { loadRiderMemory, rememberExchange, renderRiderMemoryForIntent } from '../LLM/rider-memory';
import { geocodeAddress, reverseGeocode, findPlaceOptions, findAreaSpots, kmBetween, SAME_CITY_KM } from '../LLM/geocoding';
import { buildReadyForMatchEvent } from '../group-ride/ready-event';
import { logActivity } from '../analytics/log-activity';
import { storeWhatsappRide, setActiveRide, getActiveRide, clearActiveRide, setPhoneLookup, cleanupRideKeys, setPendingLocation, setPendingAreaHint, getPendingAreaHint, clearPendingAreaHint, getPendingLocation, clearPendingLocation, setBookingStage, getBookingStage, clearBookingStage, getBids, getLastBatch, getRideState, getRideMeta, getAcceptedBid, storePendingRoute, getPendingRoute, clearPendingRoute, getGroupRequestRider, getPendingGeoChoices, clearPendingGeoChoices, getPendingFarPlace, clearPendingFarPlace, clearBookingMisses, getGroupSeat, recordAcceptedSeat, clearAcceptedSeats, getGroupSeatMembers, markOffersMessageSent, getPendingAccept, clearPendingAccept, clearPendingWhatsappWithdrawal, storeLastRoute, getLastRoute, getLastCompletedRide, clearLastCompletedRide } from '../whatsapp-flows/bid-state';
import { signFlowToken } from '../whatsapp-flows/encryption';
import { sendFlowOffersMessage, sendOffersReentryMessage } from '../whatsapp-flows/whatsapp-notifier';
import { CHANGE_PRICE_REPLY_ID, parseOfferReplyId } from '../whatsapp-flows/whatsapp-notifier';
import { readRawBody, sendJson } from './utils';
import { MetaWhatsappRouteDeps } from '../whatsapp/deps';
import { getHeaderValue, isValidMetaSignature, replyAndLog, sendFloorNudge, sendMetaFlowMessage, sendMetaLinkButton, sendMetaReply, sendTypingIndicator, sendWhatsappText } from '../whatsapp/send';
import { CANCELLATION_REASON_PROMPT, MetaMessageInfo, NONE_OF_THESE, extractEditAddress, extractMetaMessages, isAffirmativeReply, isBookingOpener, isCancelCommand, isEditDestinationCommand, isEditPickupCommand, isGroupCancelCommand, isGroupStatusCommand, isMoreCommand, isWithdrawalStage, isWithdrawalStatusCommand, looksLikeConversation, parseAcceptCommand, parseCancellationReason, parseCounterOffer, stripDirectionPrefix } from '../whatsapp/parse';
import { askIfFarPlaceIsMeant, bookingIntentGroq, replyWithWayOut, sendPlaceChoices, takePickedPlace } from '../whatsapp/places';
import { BOOKING_START_PROMPT, ROUTE_PLAN_FAILED_REPLY, addStopToTrip, askForNewEnd, askForStop, buildGroupSuggestionLine, changeEndOrAsk, confirmTripAndQuote, handleTripTap, planRouteSafe, removeStopFromTrip, replanPendingRoute, ridePageUrl, samePlacePair, sendEditTripForm, sendQuoteWithPriceButton, sendSearchStarted, sendTripConfirmation, sendTripEditMenu, startBookingOver } from '../whatsapp/trip';
import { SOS_CANCEL_REPLY_ID, SOS_REPLY_ID, TRACK_REPLY_ID, acceptOfferInChat, handleRideCardTap, sendCurrentOffers, sendRideTopupButton } from '../whatsapp/ride-card';
import { handleQuickAction, sendQuickActions } from '../whatsapp/menu';
import { sendWalletPageButton } from '../whatsapp/wallet';
import { requirePrivacyConsent } from '../whatsapp/consent';
import { applyGroupLocation, cancelGroupRide, convertGroupToNormalRide, handleGroupSelfie, handleGroupStageText, sendGroupStatus, startGroupRideFlow } from '../whatsapp/group';
export { placeChoiceRows } from '../whatsapp/places';
export { createRidePageChatNotifier, createOffersFormChatHooks, createWhatsappDepositFinisher } from '../whatsapp/ride-card';
export { createQuickActionsChatHooks } from '../whatsapp/menu';
export { normalizeAmountText, parseCounterOffer } from '../whatsapp/parse';
export type { MetaWhatsappRouteDeps } from '../whatsapp/deps';


function sendOk(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain');
  res.end('OK');
}

/* ─── Webhook verification (GET) ─── */

export function handleMetaWhatsappVerify(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetaWhatsappRouteDeps,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  console.info('[whatsapp] Verify attempt', { mode, token: token?.slice(0, 10), expected: deps.metaWebhookVerifyToken?.slice(0, 10) });
  if (mode === 'subscribe' && token === deps.metaWebhookVerifyToken) {
    console.info('[whatsapp] Webhook verified');
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(challenge ?? '');
    return;
  }

  sendJson(res, 403, { error: 'Verification failed' });
}

/* ─── Extract message from Meta webhook payload ─── */


/** The text fallback of the menu is numbered rows; a typed number maps back to the row's id by its title. */
const MENU_TITLE_TO_ID: Record<string, string> = {
  'Book a ride': QUICK_ACTION_IDS.book, 'Repeat last ride': QUICK_ACTION_IDS.repeat, 'Reverse last ride': QUICK_ACTION_IDS.reverse,
  'Ride history': QUICK_ACTION_IDS.history, 'Your current trip': QUICK_ACTION_IDS.currentTrip,
  'Add money': QUICK_ACTION_IDS.addMoney, 'Withdraw': QUICK_ACTION_IDS.withdraw, 'Contact support': QUICK_ACTION_IDS.support,
};

const RIDE_CARD_REPLIES: ReadonlySet<string> = new Set([TRACK_REPLY_ID, SOS_REPLY_ID, SOS_CANCEL_REPLY_ID]);

export async function handleMetaWhatsappWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetaWhatsappRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readRawBody(req);

    if (!isValidMetaSignature(rawBody, getHeaderValue(req, 'x-hub-signature-256'), deps.metaAppSecret)) {
      sendJson(res, 403, { error: 'Invalid signature' });
      return;
    }

    // Always respond 200 quickly — Meta requires fast acknowledgement
    sendOk(res);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      console.warn('[whatsapp] Invalid JSON in Meta webhook');
      return;
    }

    // Meta sends status updates (delivered, read) — those yield no messages.
    for (const msgInfo of extractMetaMessages(parsed)) {
      await handleIncomingMetaMessage(deps, msgInfo);
    }
  } catch (error) {
    console.error('[whatsapp] webhook handling failed', error);
  }
}

async function handleIncomingMetaMessage(
  deps: MetaWhatsappRouteDeps,
  msgInfo: MetaMessageInfo,
): Promise<void> {
  let dedupKey: string | null = null;
  try {
    // ── Dedup: Meta retries webhooks. SET NX is atomic, so two deliveries
    // of the same wamid in the same instant cannot both run. Released on a
    // thrown error below so the retry gets a real attempt.
    if (msgInfo.messageId) {
      dedupKey = `whatsapp:dedup:${msgInfo.messageId}`;
      const fresh = await deps.redisClient.setIfNotExists(dedupKey, '1', 300).catch(() => true);
      if (!fresh) return;
    }

    const { phone, profileName, messageBody: incomingMessage, isLocation, locationLat, locationLng } = msgInfo;

    // Blue-tick the message and show "typing…" while we think.
    sendTypingIndicator(deps, msgInfo.messageId);

    const user = await onboardWhatsappUser({
      phone,
      profileName,
      deps: {
        jwtSecret: deps.jwtSecret,
        publisher: deps.publisher,
        paymentsClient: deps.paymentsClient,
      },
    });

    // Store phone lookup for Kafka consumer notifications
    await setPhoneLookup(deps.redisClient, user.id, phone).catch(() => {});

    const activeRideId = await getActiveRide(deps.redisClient, user.id);
    const bookingStage = await getBookingStage(deps.redisClient, user.id);

    // Durable per-user record of every WhatsApp interaction — the Redis
    // conversation store caps at 10 messages and expires in 7 days.
    logActivity({
      userId: user.id,
      eventType: 'whatsapp_message_in',
      source: 'whatsapp',
      metadata: {
        isLocation,
        isImage: msgInfo.isImage ?? false,
        stage: bookingStage,
        hasActiveRide: Boolean(activeRideId),
        preview: incomingMessage.slice(0, 160),
      },
    });

    // ── A form closed: give the chat its button back, unless the form just sent a message itself ──
    if (msgInfo.flowCompleted) {
      if (!msgInfo.flowCompleted.rearm) return;
      if (msgInfo.flowCompleted.flow === 'quick_actions') {
        await sendQuickActions(deps, user, phone, activeRideId, '[closed Quick Actions]');
      } else if (msgInfo.flowCompleted.flow === 'offers' && activeRideId && deps.metaAccessToken && deps.metaPhoneNumberId) {
        const meta = await getRideMeta(deps.redisClient, activeRideId);
        if (meta) {
          const sent = await sendOffersReentryMessage({ metaAccessToken: deps.metaAccessToken, metaPhoneNumberId: deps.metaPhoneNumberId, offersFormFlowId: deps.whatsappOffersFormFlowId, flowTokenSecret: deps.jwtSecret }, phone, user.id, meta.offerNgn);
          if (sent) await markOffersMessageSent(deps.redisClient, activeRideId).catch(() => undefined);
        }
      }
      return;
    }

    // ── SOS. Before consent, before any booking step, before anything. ────
    if (msgInfo.replyId && RIDE_CARD_REPLIES.has(msgInfo.replyId)) {
      await handleRideCardTap(deps, user.id, phone, msgInfo.replyId);
      return;
    }

    // ── "Offer ₦X" on a too-low price: the tap IS the price ──────────────
    const floorTap = /^offer_floor:(\d+)$/.exec(msgInfo.replyId ?? '');
    if (floorTap) {
      await handleIncomingMetaMessage(deps, { ...msgInfo, messageId: '', replyId: undefined, messageBody: floorTap[1]! });
      return;
    }

    // ── Quick actions: the menu, history, repeat / reverse ───────────────
    if (isQuickActionId(msgInfo.replyId)) {
      await handleQuickAction(deps, user, phone, msgInfo.replyId!, incomingMessage, activeRideId);
      return;
    }

    // "menu" at any point. Mid-search or mid-trip it offers "your current trip"
    // in place of Book; a picker that is waiting for a number is not it.
    if (!isLocation && asksForMenu(incomingMessage) && !(await getPendingGeoChoices(deps.redisClient, user.id))) {
      await sendQuickActions(deps, user, phone, activeRideId, incomingMessage);
      return;
    }

    // A number typed at the text fallback of the menu or the history list
    // (WhatsApp refused the picker): the same tap, by other means.
    if (!isLocation && /^[1-9]$/.test(incomingMessage.trim())) {
      const choices = await getPendingGeoChoices(deps.redisClient, user.id);
      if (choices?.context === 'menu' || choices?.context === 'history') {
        const pick = choices.options[Number(incomingMessage.trim()) - 1];
        await clearPendingGeoChoices(deps.redisClient, user.id);
        if (pick) {
          const id = choices.context === 'history' ? `qa_hist:${pick.address}` : MENU_TITLE_TO_ID[pick.address] ?? QUICK_ACTION_IDS.book;
          await handleQuickAction(deps, user, phone, id, incomingMessage, activeRideId);
          return;
        }
      }
    }

    // ── A tap on an offers message ───────────────────────────────────────
    // Old messages stay tappable forever. One from a search that is over must
    // say so — not fall through to the model as the words "Accept ₦2,800".
    const tappedOffer = parseOfferReplyId(msgInfo.replyId);
    if (!activeRideId && (tappedOffer || msgInfo.replyId === CHANGE_PRICE_REPLY_ID)) {
      await clearPendingAccept(deps.redisClient, user.id);
      await replyAndLog(deps, phone, incomingMessage,
        'That search has ended — nothing was charged. Send your trip again, or reply *search again* for the same route.');
      return;
    }
    // They said "cancel", then took an offer instead of giving a reason: the tap wins.
    if (tappedOffer && bookingStage === 'awaiting_cancel_reason') await clearBookingStage(deps.redisClient, user.id);

    // ── A tap on the trip card or its Edit sheet ─────────────────────────
    if (msgInfo.replyId?.startsWith('trip_')) {
      await handleTripTap(deps, user, phone, incomingMessage, msgInfo.replyId, Boolean(activeRideId));
      return;
    }

    // ── "None of these" on a place picker ─────────────────────────────────
    if (!isLocation && incomingMessage.trim().toLowerCase() === NONE_OF_THESE.toLowerCase()) {
      const offered = await getPendingGeoChoices(deps.redisClient, user.id);
      if (offered) {
        await clearPendingGeoChoices(deps.redisClient, user.id);
        const field = offered.context === 'pickup' || offered.context === 'group_pickup' ? 'pickup' : offered.context === 'stop' ? 'stop' : 'destination';
        await replyAndLog(deps, phone, incomingMessage,
          `No problem. Type the ${field} again with the area or a nearby landmark — e.g. *"Admiralty Way, Lekki Phase 1"* — or share a location pin`);
        return;
      }
    }

    // ── Privacy consent comes first ───────────────────────────────────────
    // Two things never wait for it: a live trip (never interrupt one), and
    // FREEZE — someone locking a stolen phone's wallet must not meet a form.
    if (!activeRideId && !/^freeze$/i.test(incomingMessage.trim())) {
      if (await requirePrivacyConsent(deps, user, phone, msgInfo, (first) => handleIncomingMetaMessage(deps, first))) return;
    }

    // ── Booking opener → the tappable FLOW form (meta-flows) ──────────────
    // A bare greeting ("hi", "hi wassup", "book a ride abeg") with no active
    // ride gets the Book Ride button. This runs BEFORE the booking-stage
    // machine on purpose: a stale "awaiting pickup" stage from an abandoned
    // conversation used to swallow greetings forever. Greeting with no live
    // ride = fresh start — clear the stale stage and offer the form.
    // A greeting while a flow-booked ride is live re-sends the offers button
    // — the booking form would only dead-end on 'you have a ride in progress'.
    if (
      deps.legacyFlowsEnabled &&
      deps.whatsappOffersFlowId &&
      deps.metaAccessToken &&
      deps.metaPhoneNumberId &&
      activeRideId &&
      isBookingOpener(incomingMessage)
    ) {
      const flowMeta = await getRideMeta(deps.redisClient, activeRideId);
      if (flowMeta?.source === 'flow') {
        const flowBids = await getBids(deps.redisClient, activeRideId);
        await sendFlowOffersMessage(
          {
            metaAccessToken: deps.metaAccessToken,
            metaPhoneNumberId: deps.metaPhoneNumberId,
            offersFlowId: deps.whatsappOffersFlowId,
            flowTokenSecret: deps.jwtSecret,
          },
          phone,
          user.id,
          flowMeta,
          flowBids,
        ).catch((err) => console.warn('[whatsapp] offers re-entry failed', err));
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: '[sent offers button]' },
        ]);
        return;
      }
    }

    if (deps.legacyFlowsEnabled && deps.whatsappFlowId && !activeRideId && isBookingOpener(incomingMessage)) {
      const flowToken = signFlowToken(`new:${user.id}`, deps.jwtSecret);
      const sent = await sendMetaFlowMessage(deps, phone, flowToken);
      console.info('[whatsapp] booking opener', {
        message: incomingMessage.slice(0, 40),
        staleStage: bookingStage ?? null,
        sent,
      });
      if (sent) {
        if (bookingStage) await clearBookingStage(deps.redisClient, user.id).catch(() => {});
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: '[sent booking form]' },
        ]);
        return;
      }
      // Send failed — the conversation continues exactly as before.
    }

    // ── Cancellation reason — collect this before clearing the booking ──
    if (bookingStage === 'awaiting_cancel_reason' && !tappedOffer) {
      const reason = parseCancellationReason(incomingMessage);

      if (!reason) {
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage || '[Shared location pin]' },
          { role: 'assistant', content: CANCELLATION_REASON_PROMPT },
        ]);
        await sendMetaReply(deps, phone, CANCELLATION_REASON_PROMPT);
        return;
      }

      if (activeRideId) {
        const cancelledRide = await rideClient.findById(activeRideId).catch(() => null);
        const cancelEvent = RideCancelledEvent.parse({
          eventType: 'RIDE_CANCELLED',
          rideId: activeRideId,
          riderId: user.id,
          driverId: cancelledRide?.driverId ?? undefined,
          cancelledBy: 'rider',
          reason,
          timestamp: new Date().toISOString(),
        });
        await deps.publisher.publishRideEvent(cancelEvent);
        await clearActiveRide(deps.redisClient, user.id);
        await cleanupRideKeys(deps.redisClient, activeRideId);
        await clearPendingAccept(deps.redisClient, user.id);
      }

      await clearBookingStage(deps.redisClient, user.id);
      await clearPendingRoute(deps.redisClient, user.id);
      await clearPendingLocation(deps.redisClient, user.id);

      const reply = [
        activeRideId ? 'Ride cancelled.' : 'Booking cancelled.',
        `Reason: ${reason}`,
        '',
        'Any fare held for this ride will be returned to your wallet.',
      ].join('\n');
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ── Group ride: selfie images and stage dispatch ─────────────────────
    if (msgInfo.isImage) {
      if (bookingStage === 'group_awaiting_face_photo') {
        await handleGroupSelfie(deps, user, phone, msgInfo.imageMediaId);
      } else {
        await sendMetaReply(deps, phone,
          'Photos are only used for group-ride selfie verification right now. Type *group ride* to start one!');
      }
      return;
    }

    if (!isLocation && isGroupStatusCommand(incomingMessage)) {
      await sendGroupStatus(deps, user, phone, incomingMessage);
      return;
    }

    if (!isLocation && isGroupCancelCommand(incomingMessage)) {
      await cancelGroupRide(deps, user, phone, incomingMessage);
      return;
    }

    // "wait" / "normal" — answers to the pool wait-nudge. Only intercepted
    // when the rider actually has an open group request; otherwise these
    // words fall through to normal handling.
    if (!isLocation && /^(wait|keep waiting)\b/i.test(incomingMessage.trim())) {
      const matchRequestId = await getGroupRequestRider(deps.redisClient, user.id).catch(() => null);
      if (matchRequestId) {
        const request = await groupRideClient.findMatchRequestByIdForUser(matchRequestId, user.id).catch(() => null);
        if (request && ['READY_FOR_MATCH', 'MATCHING'].includes(request.status) && request.faceVerification) {
          await deps.publisher.publishGroupRideEvent(buildReadyForMatchEvent(request)).catch(() => {});
          await deps.redisClient.del(`whatsapp:group:${request.id}:wait_nudge`).catch(() => {});
          await replyAndLog(deps, phone, incomingMessage,
            `Still looking for co-riders — I'll check in again if nothing turns up.`);
          return;
        }
      }
    }

    if (!isLocation && /^normal(\s*ride)?$/i.test(incomingMessage.trim())) {
      const matchRequestId = await getGroupRequestRider(deps.redisClient, user.id).catch(() => null);
      if (matchRequestId) {
        await convertGroupToNormalRide(deps, user, phone, incomingMessage, matchRequestId);
        return;
      }
    }

    // A bare "group ride" typed mid-booking must start the group flow — the
    // stage handlers below would otherwise geocode it as an address. Longer
    // phrasings ("group ride from Yaba to Lekki") fall through to the intent
    // parser, which extracts the locations as prefills.
    if (
      !isLocation &&
      !activeRideId &&
      /^(?:i\s+(?:wanna|want\s+to)\s+)?(?:book\s+(?:a\s+)?)?(?:group|shared)\s*ride[\s!.]*$/i.test(incomingMessage.trim())
    ) {
      await startGroupRideFlow(deps, user, phone, incomingMessage);
      return;
    }

    if (
      !isLocation &&
      (bookingStage === 'group_awaiting_pickup' ||
        bookingStage === 'group_awaiting_destination' ||
        bookingStage === 'group_awaiting_confirm' ||
        bookingStage === 'group_awaiting_face_photo')
    ) {
      await handleGroupStageText(deps, user, phone, incomingMessage, bookingStage);
      return;
    }

    // ── "FREEZE" — the reply we ask for when a PIN reset was not them ─────
    if (/^freeze$/i.test(incomingMessage.trim()) && !isLocation) {
      // Far future: only support lifts it (admin → unfreeze withdrawals).
      await walletSecurityClient.freezeWithdrawals(user.id, new Date('2099-12-31T00:00:00Z'), 'user_freeze');
      logActivity({ userId: user.id, eventType: 'withdrawals_frozen_by_user', source: 'whatsapp', metadata: {} });
      await sendWhatsappText(deps, phone, incomingMessage,
        'Withdrawals are now locked on your account. Nothing can leave your wallet.\n\nDeposits and rides still work. Contact Wheelers support to unlock it once your phone is safe.');
      return;
    }

    // ── Wallet: the MODEL reads the intent; the page does the work ────────
    // No accepted-phrases list. Whatever the rider typed, in whatever
    // wording, the model says deposit / withdraw / neither — at any point in
    // the conversation, mid-booking or mid-ride included. The cheap guard in
    // front only spares a model call for an address or a bare number.
    if (
      !isLocation &&
      !msgInfo.isImage &&
      !isWithdrawalStatusCommand(incomingMessage) &&
      !isCancelCommand(incomingMessage) &&
      mightConcernMoney(incomingMessage)
    ) {
      const walletIntent = await classifyWalletIntent(
        createLlm({ groqApiKey: deps.groqApiKey, groqModel: deps.groqModel, timeoutMs: deps.groqTimeoutMs }, 'intent'),
        incomingMessage,
        await getWhatsappConversation(deps.redisClient, phone).catch(() => []),
      );
      if (walletIntent !== 'none') {
        await clearPendingWhatsappWithdrawal(deps.redisClient, user.id).catch(() => {});
        if (isWithdrawalStage(bookingStage)) await clearBookingStage(deps.redisClient, user.id);
        await sendWalletPageButton(deps, user, phone, incomingMessage, walletIntent);
        return;
      }
    }

    if (isWithdrawalStatusCommand(incomingMessage) && !isLocation) {
      const latest = (await withdrawalClient.listByUser(user.id, 1).catch(() => []))[0];
      if (!latest) {
        await sendWhatsappText(deps, phone, incomingMessage, 'You have no withdrawal requests yet. Reply *withdraw* to start one.');
        return;
      }

      const accountLast4 = latest.bankAccountNumber.slice(-4);
      const failure = latest.failureReason ? `\nReason: ${latest.failureReason}` : '';
      const reply = [
        `Withdrawal: ₦${Number(latest.requestedAmountNgn).toLocaleString()}`,
        `Status: *${latest.status}*`,
        `Bank account: ••••${accountLast4}`,
        `Requested: ${latest.createdAt.toLocaleString()}`,
        failure,
      ].filter(Boolean).join('\n');
      await sendWhatsappText(deps, phone, incomingMessage, `${reply}\n\nReply *withdraw status* to check again.`);
      return;
    }

    if (isWithdrawalStage(bookingStage) && !activeRideId) {
      // Left over from the old in-chat withdrawal. Bank details are no longer
      // taken in chat — clear the stale stage and hand over the page.
      await clearPendingWhatsappWithdrawal(deps.redisClient, user.id).catch(() => {});
      await clearBookingStage(deps.redisClient, user.id);
      await sendWalletPageButton(deps, user, phone, incomingMessage, 'withdraw');
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 1. ACTIVE RIDE — handle accept/counter/more/cancel commands
    // ══════════════════════════════════════════════════════════════════════

    if (activeRideId && !isLocation && bookingStage !== 'editing_pickup' && bookingStage !== 'editing_destination') {
      // ── Ride already confirmed/in progress — only allow cancel ──
      const rideState = await getRideState(deps.redisClient, activeRideId).catch(() => null);
      const confirmedStates = ['confirmed', 'in_progress', 'driver_assigned'];
      if (rideState && confirmedStates.includes(rideState)) {
        if (isCancelCommand(incomingMessage)) {
          await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
          await sendMetaReply(deps, phone, CANCELLATION_REASON_PROMPT);
          return;
        }
        // Quiet mode. From confirmed to complete, whatever they type gets the same short
        // answer and a menu of two (Your current trip, Add money) — no model, no booking
        // parser, no wallet chat. "cancel" above and SOS on the card still work.
        const accepted = await getAcceptedBid(deps.redisClient, activeRideId).catch(() => null);
        const driverName = accepted?.driverName ?? 'Your driver';
        const reply = rideState === 'in_progress'
          ? `*${driverName}* is driving you now.\n\nYour ride card is above — tap *Track live trip* on it. Reply *cancel* if you need to.`
          : `*${driverName}* is on the way.\n\nYour ride card is above — tap *Track live trip* on it. Reply *cancel* if you need to.`;
        await sendQuickActions(deps, user, phone, activeRideId, incomingMessage, false, reply);
        return;
      }

      // ── Tapped an offer: that is the whole decision ──
      if (tappedOffer) {
        await acceptOfferInChat(deps, user, phone, incomingMessage, activeRideId, tappedOffer.key, tappedOffer.shownPriceNgn);
        return;
      }
      if (msgInfo.replyId === CHANGE_PRICE_REPLY_ID) {
        const url = ridePageUrl(deps, user.id);
        const meta = await getRideMeta(deps.redisClient, activeRideId);
        const reply = `Your price is ₦${(meta?.offerNgn ?? 0).toLocaleString()}. Type a new one here (e.g. *${(Math.ceil(((meta?.offerNgn ?? 0) * 1.1) / 100) * 100).toLocaleString()}*)${url ? ' — or tap below to set it' : ''}. Every driver looking at your request sees it.`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        if (url) await sendMetaLinkButton(deps, phone, reply, 'Change my price', url);
        else await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Edit pickup / destination during active ride ──
      if (isEditPickupCommand(incomingMessage) || isEditDestinationCommand(incomingMessage)) {
        const isPickup = isEditPickupCommand(incomingMessage);
        const rideMeta = await getRideMeta(deps.redisClient, activeRideId);

        if (rideMeta && rideMeta.pickupLat && rideMeta.pickupLng && rideMeta.destinationLat && rideMeta.destinationLng) {
          const inlineAddress = extractEditAddress(incomingMessage);

          if (inlineAddress) {
            // Geocode FIRST — don't cancel the ride until we know the address is valid
            const geo = await geocodeAddress(deps.googleMapsApiKey, inlineAddress);
            if (!geo) {
              const label = isPickup ? 'pickup' : 'destination';
              const reply = `${geocodeMissLine(inlineAddress)} Your ride is still active.\n\nTry a more specific ${label} address or share a location pin`;
              await appendWhatsappConversation(deps.redisClient, phone, [
                { role: 'user', content: incomingMessage },
                { role: 'assistant', content: reply },
              ]);
              await sendMetaReply(deps, phone, reply);
              return;
            }

            const pickup = isPickup
              ? { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress }
              : { lat: rideMeta.pickupLat, lng: rideMeta.pickupLng, address: rideMeta.pickupAddress };
            const destination = !isPickup
              ? { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress }
              : { lat: rideMeta.destinationLat, lng: rideMeta.destinationLng, address: rideMeta.destinationAddress };

            // Plan the new route FIRST — don't cancel the ride until we know
            // the new route is drivable
            const plannedRoute = await planRouteSafe(deps, pickup, destination);
            if (!plannedRoute) {
              const reply = `${ROUTE_PLAN_FAILED_REPLY}\n\nYour ride is still active.`;
              await appendWhatsappConversation(deps.redisClient, phone, [
                { role: 'user', content: incomingMessage },
                { role: 'assistant', content: reply },
              ]);
              await sendMetaReply(deps, phone, reply);
              return;
            }

            // Route planned — now cancel the old ride
            const editCancelledRide = await rideClient.findById(activeRideId).catch(() => null);
            const cancelEvent = RideCancelledEvent.parse({
              eventType: 'RIDE_CANCELLED',
              rideId: activeRideId,
              riderId: user.id,
              driverId: editCancelledRide?.driverId ?? undefined,
              cancelledBy: 'rider',
              reason: 'rider_editing_route',
              timestamp: new Date().toISOString(),
            });
            await deps.publisher.publishRideEvent(cancelEvent);
            await clearActiveRide(deps.redisClient, user.id);
            await cleanupRideKeys(deps.redisClient, activeRideId);
            await clearPendingAccept(deps.redisClient, user.id);
            const distanceKm = plannedRoute.distanceKm;
            const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
            const suggestedFare = plannedRoute.suggestedFareNgn;
            const minFare = plannedRoute.minOfferNgn;

            await storePendingRoute(deps.redisClient, user.id, {
              pickupLat: pickup.lat, pickupLng: pickup.lng, pickupAddress: pickup.address,
              destLat: destination.lat, destLng: destination.lng, destAddress: destination.address,
              distanceKm, durationSeconds: plannedRoute.durationSeconds,
              suggestedFareNgn: suggestedFare, minOfferNgn: minFare,
              ratePerKmNgn: plannedRoute.ratePerKmNgn, route: plannedRoute.geometry,
            });
            await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

            const editedLabel = isPickup ? 'Pickup updated!' : 'Destination updated!';
            const reply = [
              `*${editedLabel}*`,
              ``,
              `Pickup: *${pickup.address}*`,
              ``,
              `Destination: *${destination.address}*`,
              ``,
              `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
              `Minimum fare: ₦${minFare.toLocaleString()}`,
              `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
              ``,
              `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
            ].join('\n');

            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendQuoteWithPriceButton(deps, user, phone, reply);
            return;
          }

          // No inline address — don't cancel yet, just switch to editing stage
          // Store route from current ride meta so editing handlers can replan
          await storePendingRoute(deps.redisClient, user.id, {
            pickupLat: rideMeta.pickupLat, pickupLng: rideMeta.pickupLng, pickupAddress: rideMeta.pickupAddress,
            destLat: rideMeta.destinationLat, destLng: rideMeta.destinationLng, destAddress: rideMeta.destinationAddress,
            distanceKm: rideMeta.distanceKm ?? 0, durationSeconds: rideMeta.durationSeconds ?? 0,
            suggestedFareNgn: rideMeta.suggestedFareNgn, minOfferNgn: 0, ratePerKmNgn: 0, route: null,
          });

          const label = isPickup ? 'pickup' : 'destination';
          const current = isPickup ? rideMeta.pickupAddress : rideMeta.destinationAddress;
          await setBookingStage(deps.redisClient, user.id, isPickup ? 'editing_pickup' : 'editing_destination');

          const reply = `Current ${label}: *${current}*\n\nSend a new ${label} location pin or type the address.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
      }

      // ── Cancel command ──
      if (isCancelCommand(incomingMessage)) {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        const reply = CANCELLATION_REASON_PROMPT;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Pay — rider pays to confirm the selected driver ──
      let pendingAccept = await getPendingAccept(deps.redisClient, user.id);
      if (pendingAccept && pendingAccept.rideId !== activeRideId) {
        // Left over from a ride that timed out or was cancelled. Acting on it
        // used to wipe the CURRENT ride's pointer on a stray "yes".
        await clearPendingAccept(deps.redisClient, user.id);
        pendingAccept = null;
      }
      if (pendingAccept && /^(yes|confirm|accept|go|proceed|pay)$/i.test(incomingMessage.trim())) {
        // Same path as a tap: wallet first, driver still there, hold, then confirm.
        await acceptOfferInChat(deps, user, phone, incomingMessage, pendingAccept.rideId,
          pendingAccept.bidId ?? `driver:${pendingAccept.driverId}`, pendingAccept.fareNgn);
        return;
      }

      // ── Accept a driver: "accept 1", "accept 3" (can override pending accept) ──
      const acceptNum = parseAcceptCommand(incomingMessage);
      if (acceptNum !== null) {
        const lastBatch = await getLastBatch(deps.redisClient, activeRideId);

        if (lastBatch.length === 0) {
          const reply = 'No drivers have bid yet. Hold tight — we\'ll notify you when drivers respond!';
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // A bare "accept" with a single bid on the table is unambiguous — take
        // it rather than making the rider retype it as "accept 1". With several
        // bids there is a real choice to make, so ask instead of guessing;
        // picking for them would commit their money to a fare they didn't choose.
        if (acceptNum.kind === 'unspecified' && lastBatch.length > 1) {
          const options = lastBatch
            .map(
              (bid, index) =>
                `${index + 1}. ${bid.driverName} — ₦${bid.counterOfferNgn} (${Math.ceil(
                  bid.etaSeconds / 60,
                )} min away)`,
            )
            .join('\n');
          const reply = `You have ${lastBatch.length} drivers to choose from:\n\n${options}\n\nJust reply with the number — 1 to ${lastBatch.length}.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        const bidIndex = acceptNum.kind === 'numbered' ? acceptNum.driverNumber - 1 : 0;
        const selectedBid = lastBatch[bidIndex];

        if (!selectedBid) {
          const reply = `Invalid driver number. Reply with a number from 1 to ${lastBatch.length}.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // ── Group seat: this accept books ONE seat, not the whole car ──
        const seatInfo = await getGroupSeat(deps.redisClient, activeRideId);
        if (seatInfo) {
          const seats = await recordAcceptedSeat(deps.redisClient, seatInfo.anchorRideId, {
            memberRideId: activeRideId,
            riderId: user.id,
            driverId: selectedBid.driverId,
            driverUserId: selectedBid.driverUserId,
            driverName: selectedBid.driverName,
            amountNgn: selectedBid.counterOfferNgn,
            etaSeconds: selectedBid.etaSeconds,
          });

          const sameDriverSeats = seats.filter((s) => s.driverId === selectedBid.driverId);
          const allAgreed = sameDriverSeats.length >= seatInfo.memberCount;
          const members = await getGroupSeatMembers(deps.redisClient, seatInfo.anchorRideId);

          if (allAgreed) {
            const totalNgn = sameDriverSeats.reduce((sum, s) => sum + s.amountNgn, 0);
            // CASH, deliberately: a WALLET acceptance makes wallet-service
            // escrow the ENTIRE group total from whichever member accepted
            // last. Until per-seat wallet settlement exists, each rider pays
            // the driver their own seat price directly.
            await deps.publisher.publishRideEvent(RideOfferAcceptedEvent.parse({
              eventType: 'RIDE_OFFER_ACCEPTED',
              rideId: seatInfo.anchorRideId,
              riderId: user.id,
              driverId: selectedBid.driverId,
              driverUserId: selectedBid.driverUserId,
              agreedFareNgn: totalNgn,
              paymentMethod: 'CASH',
              timestamp: new Date().toISOString(),
            }));
            await clearAcceptedSeats(deps.redisClient, seatInfo.anchorRideId);

            // Every member's active ride moves onto the trip itself so trip
            // updates (started, GPS, completed) reach them all.
            for (const member of members) {
              await setActiveRide(deps.redisClient, member.riderId, seatInfo.anchorRideId).catch(() => {});
            }

            await replyAndLog(deps, phone, incomingMessage,
              `Seat booked with *${selectedBid.driverName}* at ₦${selectedBid.counterOfferNgn.toLocaleString()}.\n\nThat was the last seat — your group is confirmed! Driver details coming right up.`);
            return;
          }

          const remaining = seatInfo.memberCount - sameDriverSeats.length;
          await replyAndLog(deps, phone, incomingMessage,
            `Seat booked with *${selectedBid.driverName}* at ₦${selectedBid.counterOfferNgn.toLocaleString()}.\n\n${sameDriverSeats.length}/${seatInfo.memberCount} seats booked with ${selectedBid.driverName} — waiting for ${remaining} co-rider${remaining === 1 ? '' : 's'}.`);

          // Nudge members who haven't booked with THIS driver yet.
          const bookedRiderIds = new Set(sameDriverSeats.map((s) => s.riderId));
          for (const member of members) {
            if (bookedRiderIds.has(member.riderId) || !member.phone) continue;
            await sendMetaReply(deps, member.phone,
              `A co-rider booked their seat with *${selectedBid.driverName}*. If ${selectedBid.driverName} has an offer in your list, reply its number to complete the group — the car moves when every seat is booked with the same driver.`).catch(() => {});
          }
          return;
        }

        // A typed number is a tap by other means: take the offer now.
        await acceptOfferInChat(deps, user, phone, incomingMessage, activeRideId, offerKey(selectedBid), selectedBid.counterOfferNgn);
        return;
      }

      // ── "more" command — show latest bids ──
      if (isMoreCommand(incomingMessage)) {
        const reply = await sendCurrentOffers(deps, phone, activeRideId);
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        return;
      }

      // ── Counter-offer with a price: "1500", "₦2000", "2k" ──
      const counterOffer = parseCounterOffer(incomingMessage);
      if (counterOffer !== null) {
        const meta = await getRideMeta(deps.redisClient, activeRideId);
        if (meta) {
          // The initial offer was validated against the minimum fare; a
          // counter-offer has to clear the same bar or the floor is bypassed
          // by simply typing a lower number once bidding has started.
          const validation = validateRiderOffer(counterOffer, meta.suggestedFareNgn);
          if (!validation.valid) {
            console.warn('[api-gateway][whatsapp] counter-offer rejected below minimum', {
              rideId: activeRideId,
              riderId: user.id,
              offerNgn: counterOffer,
              minOfferNgn: validation.minOfferNgn,
              suggestedFareNgn: meta.suggestedFareNgn,
            });
            const reply = `Your offer ₦${counterOffer.toLocaleString()} is below the minimum fare of ₦${validation.minOfferNgn.toLocaleString()}.\n\nPlease send a higher amount.`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return;
          }

          // Update the rider's offer in Redis
          meta.offerNgn = counterOffer;
          await deps.redisClient.set(
            `whatsapp:ride:${activeRideId}:meta`,
            JSON.stringify(meta),
            900,
          );

          // Publish counter-offer to ride-service so all drivers see the updated price
          await deps.publisher.publishRideEvent({
            eventType: 'RIDE_RIDER_COUNTER_OFFER',
            rideId: activeRideId,
            riderId: meta.riderId,
            counterOfferNgn: counterOffer,
            timestamp: new Date().toISOString(),
          });

          const reply = `Bid updated to ₦${counterOffer.toLocaleString()}. Drivers will see your new offer.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
      }

      // ── Chose a driver, still adding money — point back at the one button ──
      if (pendingAccept) {
        const wallet = await walletClient.findByUserId(user.id);
        const balanceNgn = wallet ? Number(wallet.balanceNgn) : 0;
        if (balanceNgn < pendingAccept.fareNgn) {
          const shortNgn = Math.ceil(pendingAccept.fareNgn - balanceNgn);
          const reply = await sendRideTopupButton(deps, user.id, phone, {
            driverName: pendingAccept.driverName, fareNgn: pendingAccept.fareNgn, balanceNgn, shortNgn, sendNgn: depositNeededFor(shortNgn),
          });
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          return;
        }
      }

      // ── Anything else while searching — show what is on the table, to tap ──
      const reply = await sendCurrentOffers(deps, phone, activeRideId);
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 2. LOCATION PIN — handle pickup and destination location shares
    // ══════════════════════════════════════════════════════════════════════

    if (isLocation && locationLat !== undefined && locationLng !== undefined && !isNaN(locationLat) && !isNaN(locationLng)) {
      // Block location pins during active ride (unless editing)
      if (activeRideId && bookingStage !== 'editing_pickup' && bookingStage !== 'editing_destination') {
        const reply = 'You have an active ride. Reply *edit from* or *edit to* to change your route, or *cancel* to start fresh.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: '[Shared location pin]' },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const reverseGeo = await reverseGeocode(deps.googleMapsApiKey, locationLat, locationLng);
      const address = reverseGeo?.formattedAddress ?? `${locationLat.toFixed(4)}, ${locationLng.toFixed(4)}`;

      if (!isPinInsideServiceArea(locationLat, locationLng, reverseGeo)) {
        const reply = `That pin is outside Nigeria (${address}). ${OUTSIDE_SERVICE_AREA_LINE}`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: '[Shared location pin]' },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Group ride pickup/destination pins ──
      if (bookingStage === 'group_awaiting_pickup' || bookingStage === 'group_awaiting_destination') {
        await applyGroupLocation(
          deps, user, phone,
          `[Shared location: ${address}]`,
          bookingStage,
          { lat: locationLat, lng: locationLng, address },
        );
        return;
      }

      // ── Adding a stop via location pin ──
      if (bookingStage === 'adding_stop') {
        const trip = await getPendingRoute(deps.redisClient, user.id);
        if (trip) {
          await addStopToTrip(deps, user, phone, `[Shared location: ${address}]`, trip, address, { lat: locationLat, lng: locationLng, address });
          return;
        }
      }

      // ── Editing pickup/destination via location pin ──
      if (bookingStage === 'editing_pickup' || bookingStage === 'editing_destination') {
        const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
        if (!pendingRoute) {
          await clearBookingStage(deps.redisClient, user.id);
          const label = bookingStage === 'editing_pickup' ? 'edit from' : 'edit to';
          const reply = `That edit timed out. Reply *${label}* again and then share the pin.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: `[Shared location: ${address}]` },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
        if (pendingRoute) {
          const pickup = bookingStage === 'editing_pickup'
            ? { lat: locationLat, lng: locationLng, address }
            : { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
          const destination = bookingStage === 'editing_destination'
            ? { lat: locationLat, lng: locationLng, address }
            : { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress };

          const plannedRoute = await planRouteSafe(deps, pickup, destination);
          if (!plannedRoute) {
            const reply = `${ROUTE_PLAN_FAILED_REPLY}\n\nYour booking is unchanged — try a different pin.`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: `[Shared location: ${address}]` },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return;
          }
          const distanceKm = plannedRoute.distanceKm;
          const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
          const suggestedFare = plannedRoute.suggestedFareNgn;
          const minFare = plannedRoute.minOfferNgn;

          // If rider had an active ride, cancel it now that the edit succeeded
          if (activeRideId) {
            const editCancelledRide = await rideClient.findById(activeRideId).catch(() => null);
            const cancelEvent = RideCancelledEvent.parse({
              eventType: 'RIDE_CANCELLED',
              rideId: activeRideId,
              riderId: user.id,
              driverId: editCancelledRide?.driverId ?? undefined,
              cancelledBy: 'rider',
              reason: 'rider_editing_route',
              timestamp: new Date().toISOString(),
            });
            await deps.publisher.publishRideEvent(cancelEvent);
            await clearActiveRide(deps.redisClient, user.id);
            await cleanupRideKeys(deps.redisClient, activeRideId);
            await clearPendingAccept(deps.redisClient, user.id);
          }

          await storePendingRoute(deps.redisClient, user.id, {
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            pickupAddress: pickup.address,
            destLat: destination.lat,
            destLng: destination.lng,
            destAddress: destination.address,
            distanceKm,
            durationSeconds: plannedRoute.durationSeconds,
            suggestedFareNgn: suggestedFare,
            minOfferNgn: minFare,
            ratePerKmNgn: plannedRoute.ratePerKmNgn,
            route: plannedRoute.geometry,
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

          const editedLabel = bookingStage === 'editing_pickup' ? 'Pickup updated!' : 'Destination updated!';
          const reply = [
            `*${editedLabel}*`,
            ``,
            `Pickup: *${pickup.address}*`,
            ``,
            `Destination: *${destination.address}*`,
            ``,
            `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
            `Minimum fare: ₦${minFare.toLocaleString()}`,
            `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
            ``,
            `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
          ].join('\n');

          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: `[Shared location: ${address}]` },
            { role: 'assistant', content: reply },
          ]);
          await sendQuoteWithPriceButton(deps, user, phone, reply);
          return;
        }
      }

      // A pin is the destination only while we are actually waiting for one.
      // Any other time it is a fresh pickup — a stale pickup from an
      // abandoned booking used to turn the next pin into a wrong-way route.
      const storedPickup = await getPendingLocation(deps.redisClient, user.id);
      const pendingPickup = bookingStage === 'awaiting_destination' ? storedPickup : null;

      if (!pendingPickup) {
        if (activeRideId) {
          const reply = 'You have an active ride. Reply *edit from* or *edit to* to change your route, or *cancel* to start fresh.';
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: `[Shared location: ${address}]` },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
        // ── FIRST location pin = PICKUP ──
        const rememberedDestination = (await getPendingAreaHint(deps.redisClient, user.id).catch(() => null))?.counterpartAddress?.trim();
        await clearPendingAreaHint(deps.redisClient, user.id).catch(() => {});
        await setPendingLocation(deps.redisClient, user.id, {
          lat: locationLat,
          lng: locationLng,
          address,
          savedAt: new Date().toISOString(),
        });
        await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

        // They already told us where they are going: answer the destination
        // step with it instead of asking again.
        if (rememberedDestination) {
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: `[Shared pickup location: ${address}]` },
            { role: 'assistant', content: `Pickup: ${address}` },
          ]);
          await handleIncomingMetaMessage(deps, { ...msgInfo, messageId: '', isLocation: false, locationLat: undefined, locationLng: undefined, messageBody: rememberedDestination });
          return;
        }

        const reply = `Pickup: *${address}*\n\nNow share your *destination* location pin!`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: `[Shared pickup location: ${address}]` },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── SECOND location pin = DESTINATION ──
      // We have pickup, now got destination — go straight to finding drivers
      const pickup = { lat: pendingPickup.lat, lng: pendingPickup.lng, address: pendingPickup.address };
      const destination = { lat: locationLat, lng: locationLng, address };

      // Check for existing active ride
      if (activeRideId) {
        await clearPendingLocation(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'You already have an active ride. Say *cancel* first to book a new one.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: `[Shared destination location: ${address}]` },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // Plan route, store it, and ask rider for their price
      const plannedRoute = await planRouteSafe(deps, pickup, destination);
      if (!plannedRoute) {
        // Keep the pending pickup and stage so the rider can re-share a pin
        const reply = ROUTE_PLAN_FAILED_REPLY;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: `[Shared destination location: ${address}]` },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      await clearPendingLocation(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);
      const distanceKm = plannedRoute.distanceKm;
      const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
      const suggestedFare = plannedRoute.suggestedFareNgn;
      const minFare = plannedRoute.minOfferNgn;

      await storePendingRoute(deps.redisClient, user.id, {
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        pickupAddress: pickup.address,
        destLat: destination.lat,
        destLng: destination.lng,
        destAddress: destination.address,
        distanceKm,
        durationSeconds: plannedRoute.durationSeconds,
        suggestedFareNgn: suggestedFare,
        minOfferNgn: minFare,
        ratePerKmNgn: plannedRoute.ratePerKmNgn,
        route: plannedRoute.geometry,
      });
      await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

      const groupSuggestion = await buildGroupSuggestionLine(user.id, pickup, destination);
      const reply = [
        `Pickup: *${pickup.address}*`,
        ``,
        `Destination: *${destination.address}*`,
        ``,
        `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
        `Minimum fare: ₦${minFare.toLocaleString()}`,
        `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
        ``,
        `Negotiate your price and we'll find you a driver!`,
        `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
      ].join('\n') + groupSuggestion;

      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: `[Shared destination location: ${address}]` },
        { role: 'assistant', content: reply },
      ]);
      await sendQuoteWithPriceButton(deps, user, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3. AWAITING DESTINATION — user can type an address or share a pin
    // ══════════════════════════════════════════════════════════════════════

    // ── Answering "whereabouts in <area>?" for the PICKUP ──
    if (bookingStage === 'awaiting_pickup' && !isLocation && incomingMessage.trim()) {
      if (isCancelCommand(incomingMessage)) {
        await clearPendingAreaHint(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'No problem — ride cancelled. Message me whenever you need one.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      if (mightNotBeAnAddress(incomingMessage)) {
        const pickupStepIntent = await classifyBookingIntent(bookingIntentGroq(deps), {
          step: 'pickup',
          message: incomingMessage,
          context: {},
          recentMessages: await getWhatsappConversation(deps.redisClient, phone),
        });
        if (pickupStepIntent.intent === 'cancel') {
          await clearPendingAreaHint(deps.redisClient, user.id);
          await clearBookingStage(deps.redisClient, user.id);
          await clearBookingMisses(deps.redisClient, user.id).catch(() => undefined);
          await replyAndLog(deps, phone, incomingMessage, 'No problem — ride cancelled. Message me whenever you need one.');
          return;
        }
        if (pickupStepIntent.intent === 'restart') {
          await startBookingOver(deps, user, phone, incomingMessage);
          return;
        }
        if (pickupStepIntent.intent === 'help') {
          await replyWithWayOut(deps, user, phone, incomingMessage, {
            wantsHelp: true,
            prompt: 'Where should we pick you up? Type the address or a nearby landmark, or share a location pin',
            hint: 'Or reply *start again* or *cancel*.',
            buttons: ['Start again', 'Cancel ride'],
          });
          return;
        }
      }

      const hint = await getPendingAreaHint(deps.redisClient, user.id);
      const answer = incomingMessage.trim();

      // A tap on the picker (or a typed number) answers "which pickup did you mean?".
      let pickedPickup: { lat: number; lng: number; formattedAddress: string } | null = null;
      if (/^[1-9]$/.test(answer)) {
        const choices = await getPendingGeoChoices(deps.redisClient, user.id);
        const pick = choices?.context === 'pickup' ? choices.options[Number(answer) - 1] : undefined;
        if (pick) {
          await clearPendingGeoChoices(deps.redisClient, user.id);
          pickedPickup = { lat: pick.lat, lng: pick.lng, formattedAddress: pick.address };
        }
      }

      // The question was "whereabouts in X?", so the expected answer is a
      // landmark. Riders often restate the whole trip instead ("I wanna go
      // from Allen"), and geocoding that verbatim asks Google to find a
      // sentence — which it answers with the country. Hand anything that
      // reads like a fresh request back to the intent parser by falling
      // through, rather than treating it as an address.
      if (looksLikeConversation(answer)) {
        await clearPendingAreaHint(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);
        // Deliberately no `return` — execution continues to intent parsing
        // below, which understands this sentence properly.
      } else {

      // "roundabout" on its own geocodes to nothing — it only means something
      // combined with the area they already named. Word order matters more
      // than it looks: measured against Google, "Allen roundabout" resolves to
      // the actual roundabout while "roundabout, Allen" returns ZERO_RESULTS.
      // Area first, then looser fallbacks, then the bare answer in case they
      // typed a full address instead of a landmark.
      const candidates = hint?.area
        ? [`${hint.area} ${answer}`, `${answer}, ${hint.area}`, answer]
        : [answer];

      // A name that exists in several places ("Admiralty" Way AND Road, "Aiyetoro"
      // in Surulere AND Akoka): ask, never assume. Only for a plain answer — when
      // they are answering "whereabouts in Lekki?", the area already narrows it.
      if (!pickedPickup && !hint?.area && !looksLikeConversation(answer)) {
        const matches = await findPlaceOptions(deps.googleMapsApiKey, answer, { spokenText: incomingMessage });
        if (matches.length > 1) {
          await sendPlaceChoices(deps, user, phone, incomingMessage, { context: 'pickup', field: 'pickup', typed: answer, candidates: matches });
          return;
        }
        if (matches.length === 1) pickedPickup = matches[0]!;
      }

      let pickupGeo = pickedPickup;
      for (const candidate of pickedPickup ? [] : candidates) {
        pickupGeo = await geocodeAddress(deps.googleMapsApiKey, candidate);
        if (pickupGeo) break;
      }

      if (!pickupGeo) {
        const missLine = outsideServiceAreaMatch(answer)
          ? geocodeMissLine(answer)
          : `Could not find "${answer}"${hint?.area ? ` in ${hint.area}` : ''} on the map.`;
        await replyWithWayOut(deps, user, phone, incomingMessage, {
          prompt: `${missLine}\n\nTry a nearby landmark or street name, or share a location pin`,
          hint: 'Or reply *start again* or *cancel*.',
          buttons: ['Start again', 'Cancel ride'],
        });
        return;
      }

      await setPendingLocation(deps.redisClient, user.id, {
        lat: pickupGeo.lat,
        lng: pickupGeo.lng,
        address: pickupGeo.formattedAddress,
        savedAt: new Date().toISOString(),
        // The hint is cleared below, so the destination they already gave has
        // to travel with the pickup for "yes" to mean anything next turn.
        suggestedDestination: hint?.counterpartAddress || undefined,
      });
      await clearPendingAreaHint(deps.redisClient, user.id);
      await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

      // They picked the pickup from a list, and told us the destination in the
      // same breath as the trip. Asking them to type "yes" is one message too
      // many: answer the destination step with what they already said.
      if (pickedPickup && hint?.counterpartAddress) {
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: `Pickup: ${pickupGeo.formattedAddress}` },
        ]);
        await handleIncomingMetaMessage(deps, { ...msgInfo, messageId: '', messageBody: hint.counterpartAddress });
        return;
      }

      // If they already told us where they were going, don't ask again.
      const reply = hint?.counterpartAddress
        ? `Pickup: *${pickupGeo.formattedAddress}*\n\nAnd your destination is *${hint.counterpartAddress}* — type "yes" to confirm, or send a different destination.`
        : `Pickup: *${pickupGeo.formattedAddress}*\n\nWhere are you going? Type the destination or share a pin`;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
      }
    }

    if (bookingStage === 'awaiting_destination' && !isLocation) {
      if (isCancelCommand(incomingMessage)) {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        const reply = CANCELLATION_REASON_PROMPT;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // Not every reply here is a destination. Anything that might be more
      // than a place is read for meaning first; a plain place skips the model.
      let destinationStepIntent: BookingIntentResult = { intent: 'answer' };
      if (mightNotBeAnAddress(incomingMessage) && !isAffirmativeReply(incomingMessage)) {
        const soFar = await getPendingLocation(deps.redisClient, user.id);
        destinationStepIntent = await classifyBookingIntent(bookingIntentGroq(deps), {
          step: 'destination',
          message: incomingMessage,
          context: { pickupAddress: soFar?.address },
          recentMessages: await getWhatsappConversation(deps.redisClient, phone),
        });
      }
      if (destinationStepIntent.intent === 'cancel') {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        await replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
        return;
      }
      if (destinationStepIntent.intent === 'restart') {
        await startBookingOver(deps, user, phone, incomingMessage);
        return;
      }
      if (destinationStepIntent.intent === 'change_pickup') {
        await clearPendingLocation(deps.redisClient, user.id);
        await clearPendingFarPlace(deps.redisClient, user.id).catch(() => undefined);
        await setBookingStage(deps.redisClient, user.id, 'awaiting_pickup');
        if (!destinationStepIntent.address) {
          await replyAndLog(deps, phone, incomingMessage, 'Sure — where should we pick you up instead? Type the address or share a location pin');
          return;
        }
        // They named the new pickup in the same breath: answer the pickup step with it.
        // No message id: this is the same WhatsApp message, already de-duplicated once.
        await handleIncomingMetaMessage(deps, { ...msgInfo, messageId: '', messageBody: destinationStepIntent.address });
        return;
      }
      // 'other' (a question, chatter) carries on below, where small talk is
      // handed to the chatbot as before.
      if (destinationStepIntent.intent === 'help' || destinationStepIntent.intent === 'confirm') {
        await replyWithWayOut(deps, user, phone, incomingMessage, {
          wantsHelp: destinationStepIntent.intent === 'help',
          prompt: 'Where are you going? Type the destination or share a location pin',
          hint: 'Or reply *change pickup*, *start again* or *cancel*.',
          buttons: ['Change pickup', 'Start again', 'Cancel ride'],
        });
        return;
      }

      const pendingPickup = await getPendingLocation(deps.redisClient, user.id);
      if (!pendingPickup) {
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'Session expired. Type your pickup and destination like:\n\n*"From [pickup] to [destination]"*\n\nOr share a location pin';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // We asked them to type "yes" to confirm the destination they named in
      // their first message. Checked before the small-talk filter because
      // "ok" counts as small talk there, and before geocoding because "Yes"
      // is not a place.
      const isAffirmative = /^(yes|yeah|yea|yep|yup|ok|okay|confirm|correct|sure|y)\b/i.test(incomingMessage.trim());

      // "yes" to "that is 311 km away, in another city — really?"
      const heldFarPlace = await getPendingFarPlace(deps.redisClient, user.id);
      if (heldFarPlace) await clearPendingFarPlace(deps.redisClient, user.id);
      const confirmedFarPlace = isAffirmative && heldFarPlace?.field === 'destination' ? heldFarPlace : null;

      const confirmedDestination = isAffirmative && !confirmedFarPlace ? pendingPickup.suggestedDestination?.trim() : undefined;

      if (isAffirmative && !confirmedDestination && !confirmedFarPlace) {
        const reply = `Where are you going? Type the destination or share a pin`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // Small talk is not a destination. This stage lives for ten minutes, so
      // a rider returning to an abandoned booking with "Hey wassup" had their
      // greeting geocoded. Leave it to the intent parser and the chatbot, and
      // keep the stage so their next real answer still lands here.
      // "going to X" is an answer, not chat, however the sentence starts.
      const strippedDestination = stripDirectionPrefix(incomingMessage);
      const isDirectionAnswer = strippedDestination !== incomingMessage.trim();
      if (!confirmedDestination && !isDirectionAnswer && looksLikeConversation(incomingMessage)) {
        // deliberately no reply and no return — falls through to intent parsing
      } else {

      // Try to geocode the typed destination
      const typedDestination = confirmedDestination ?? strippedDestination;

      // A bare number answers a pending "which one did you mean?" list.
      let destGeo: { lat: number; lng: number; formattedAddress: string } | null = confirmedFarPlace
        ? { lat: confirmedFarPlace.lat, lng: confirmedFarPlace.lng, formattedAddress: confirmedFarPlace.address }
        : null;
      const pickupPoint = { lat: pendingPickup.lat, lng: pendingPickup.lng };
      if (!destGeo && /^[1-9]$/.test(typedDestination)) {
        const choices = await getPendingGeoChoices(deps.redisClient, user.id);
        const pick = choices?.context === 'destination'
          ? choices.options[Number(typedDestination) - 1]
          : undefined;
        if (pick) {
          await clearPendingGeoChoices(deps.redisClient, user.id);
          destGeo = { lat: pick.lat, lng: pick.lng, formattedAddress: pick.address };
        }
      }

      if (!destGeo) {
        // "Whereabouts in Lekki?" → "the mall": search inside the area first.
        const destHint = await getPendingAreaHint(deps.redisClient, user.id).catch(() => null);
        const areaHint = destHint?.kind === 'destination' ? destHint.area?.trim() : undefined;
        const narrowed = areaHint && !typedDestination.toLowerCase().includes(areaHint.toLowerCase())
          ? `${typedDestination}, ${areaHint}`
          : typedDestination;
        // Lean the search towards the pickup: "7 Osaro Isokpan" from Akoka is
        // the one in Lagos, not the better-known street of that name in Benin.
        let candidates = await findPlaceOptions(deps.googleMapsApiKey, narrowed, { near: pickupPoint, spokenText: incomingMessage });
        if (candidates.length === 0 && narrowed !== typedDestination) {
          candidates = await findPlaceOptions(deps.googleMapsApiKey, typedDestination, { near: pickupPoint, spokenText: incomingMessage });
        }

        // Ambiguous place ("Aiyetoro" is in Surulere AND Akoka) — ask, don't
        // assume. A query that pins the area returns a single candidate.
        if (candidates.length > 1) {
          await sendPlaceChoices(deps, user, phone, incomingMessage, {
            context: 'destination',
            field: 'destination',
            typed: typedDestination,
            candidates,
          });
          return;
        }

        destGeo = candidates[0] ?? null;
      }

      if (!destGeo) {
        await replyWithWayOut(deps, user, phone, incomingMessage, {
          prompt: `${geocodeMissLine(typedDestination)}\n\nPlease type a more specific destination — add the area or a landmark — or share a location pin`,
          hint: 'Or reply *change pickup*, *start again* or *cancel*.',
          buttons: ['Change pickup', 'Start again', 'Cancel ride'],
        });
        return;
      }

      // Destination geocoded — plan route
      const pickup = { lat: pendingPickup.lat, lng: pendingPickup.lng, address: pendingPickup.address };
      const destination = { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress };

      // Still in another city after leaning towards the pickup? Ask before quoting.
      if (!confirmedFarPlace && await askIfFarPlaceIsMeant(deps, user, phone, incomingMessage, 'destination', destination, pickupPoint)) {
        return;
      }
      await clearBookingMisses(deps.redisClient, user.id).catch(() => undefined);

      const plannedRoute = await planRouteSafe(deps, pickup, destination);
      if (!plannedRoute) {
        // Keep the stage and pending pickup so their next answer still lands here
        const reply = ROUTE_PLAN_FAILED_REPLY;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      await clearPendingLocation(deps.redisClient, user.id);
      await clearPendingAreaHint(deps.redisClient, user.id).catch(() => {});
      await clearPendingGeoChoices(deps.redisClient, user.id).catch(() => {});
      await clearBookingStage(deps.redisClient, user.id);
      const distanceKm = plannedRoute.distanceKm;
      const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
      const suggestedFare = plannedRoute.suggestedFareNgn;
      const minFare = plannedRoute.minOfferNgn;

      await storePendingRoute(deps.redisClient, user.id, {
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        pickupAddress: pickup.address,
        destLat: destination.lat,
        destLng: destination.lng,
        destAddress: destination.address,
        distanceKm,
        durationSeconds: plannedRoute.durationSeconds,
        suggestedFareNgn: suggestedFare,
        minOfferNgn: minFare,
        ratePerKmNgn: plannedRoute.ratePerKmNgn,
        route: plannedRoute.geometry,
      });
      await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

      const groupSuggestion = await buildGroupSuggestionLine(user.id, pickup, destination);
      const reply = [
        `Pickup: *${pickup.address}*`,
        ``,
        `Destination: *${destination.address}*`,
        ``,
        `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
        `Minimum fare: ₦${minFare.toLocaleString()}`,
        `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
        ``,
        `Negotiate your price and we'll find you a driver!`,
        `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
      ].join('\n') + groupSuggestion;

      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendQuoteWithPriceButton(deps, user, phone, reply);
      return;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3b. EDITING PICKUP / DESTINATION — user types an address
    // ══════════════════════════════════════════════════════════════════════

    if ((bookingStage === 'editing_pickup' || bookingStage === 'editing_destination') && !isLocation) {
      // Cancel during editing — clear everything
      if (isCancelCommand(incomingMessage)) {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        const reply = CANCELLATION_REASON_PROMPT;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
      if (!pendingRoute) {
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'Session expired. Share a location pin to start a new booking';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const editField = bookingStage === 'editing_pickup' ? 'pickup' : 'destination';

      const pickedForEdit = await takePickedPlace(deps, user.id, incomingMessage, ['edit_pickup', 'edit_destination']);
      if (pickedForEdit) {
        await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute, editField, pickedForEdit.address, pickedForEdit);
        return;
      }

      // "yes" to a far-away place we held back, or a fresh address.
      const heldEditPlace = await getPendingFarPlace(deps.redisClient, user.id);
      if (heldEditPlace) await clearPendingFarPlace(deps.redisClient, user.id);
      if (heldEditPlace && heldEditPlace.field === editField && isAffirmativeReply(incomingMessage)) {
        await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute, editField, heldEditPlace.address, { ...heldEditPlace, farConfirmed: true });
        return;
      }

      // They may have changed their mind about editing at all.
      if (mightNotBeAnAddress(incomingMessage)) {
        const editIntent = await classifyBookingIntent(bookingIntentGroq(deps), {
          step: editField,
          message: incomingMessage,
          context: { pickupAddress: pendingRoute.pickupAddress, destinationAddress: pendingRoute.destAddress },
          recentMessages: await getWhatsappConversation(deps.redisClient, phone),
        });
        if (editIntent.intent === 'cancel') {
          await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
          await replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
          return;
        }
        if (editIntent.intent === 'restart') {
          await startBookingOver(deps, user, phone, incomingMessage);
          return;
        }
        if (editIntent.intent === 'help' || editIntent.intent === 'confirm') {
          // "ok leave it" / "never mind the change": back to the quote as it was.
          await setBookingStage(deps.redisClient, user.id, 'awaiting_price');
          await replyAndLog(deps, phone, incomingMessage,
            `No change made. Your trip is still:\n\nPickup: *${pendingRoute.pickupAddress}*\nDestination: *${pendingRoute.destAddress}*\n\nSend your price (suggested ₦${pendingRoute.suggestedFareNgn.toLocaleString()}), or reply *change pickup*, *change destination* or *cancel*.`);
          return;
        }
      }

      await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute, editField, stripDirectionPrefix(incomingMessage));
      return;
    }

    if (bookingStage === 'awaiting_route_confirmation' && !isLocation) {
      const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
      const answer = incomingMessage.trim();

      if (isCancelCommand(answer)) {
        await clearPendingRoute(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'No problem — nothing booked. Message me when you need a ride.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      if (!pendingRoute || pendingRoute.offerNgn === undefined) {
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'That took too long — send your pickup and destination again and we\'ll re-check the price.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const confirmed = /^(?:y|ya|yes|yeah|yep|ok|okay|correct|right|sure|go|confirm(?:ed)?|book(?:\s+it)?)(?:\s+(?:please|book(?:\s+it)?|go|proceed|confirm|now|abeg))?[\s!.]*$/i.test(answer);

      if (!confirmed) {
        // A new price is the correction we invited — apply it and re-confirm.
        const newOffer = parseCounterOffer(answer);
        if (newOffer !== null) {
          if (newOffer < pendingRoute.minOfferNgn) {
            const reply = `₦${newOffer.toLocaleString()} is below the minimum fare of ₦${pendingRoute.minOfferNgn.toLocaleString()} for this trip. Send a higher amount, or *yes* to book at ₦${pendingRoute.offerNgn.toLocaleString()}.`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return;
          }
          await storePendingRoute(deps.redisClient, user.id, { ...pendingRoute, offerNgn: newOffer });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_route_confirmation');
          const reply = [
            `Offer updated to ₦${newOffer.toLocaleString()}`,
            ``,
            `Pickup: *${pendingRoute.pickupAddress}*`,
            `Destination: *${pendingRoute.destAddress}*`,
            ``,
            `Reply *yes* to find drivers, or *edit pickup <address>* / *edit destination <address>* to fix the route.`,
          ].join('\n');
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Anything else is an address correction. The price handler knows
        // "edit pickup <address>" / "edit destination <address>"; a bare
        // address is applied as the destination directly.
        await setBookingStage(deps.redisClient, user.id, 'awaiting_price');
        if (!isEditPickupCommand(answer) && !isEditDestinationCommand(answer) && answer.length >= 3) {
          const geo = await geocodeAddress(deps.googleMapsApiKey, answer);
          if (geo) {
            const pickup = { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
            const destination = { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress };
            const replanned = await planRouteSafe(deps, pickup, destination);
            if (replanned) {
              await storePendingRoute(deps.redisClient, user.id, {
                pickupLat: pickup.lat,
                pickupLng: pickup.lng,
                pickupAddress: pickup.address,
                destLat: destination.lat,
                destLng: destination.lng,
                destAddress: destination.address,
                distanceKm: replanned.distanceKm,
                durationSeconds: replanned.durationSeconds,
                suggestedFareNgn: replanned.suggestedFareNgn,
                minOfferNgn: replanned.minOfferNgn,
                ratePerKmNgn: replanned.ratePerKmNgn,
                route: replanned.geometry,
              });
              const reply = [
                `Destination updated`,
                ``,
                `Pickup: *${pickup.address}*`,
                `Destination: *${destination.address}*`,
                `${replanned.distanceKm.toFixed(1)} km · ~${Math.ceil(replanned.durationSeconds / 60)} min`,
                `Minimum fare: ₦${replanned.minOfferNgn.toLocaleString()}`,
                `Suggested fare: ₦${replanned.suggestedFareNgn.toLocaleString()}`,
                ``,
                `Send your offer, or *edit pickup <address>* if the pickup is wrong.`,
              ].join('\n');
              await appendWhatsappConversation(deps.redisClient, phone, [
                { role: 'user', content: incomingMessage },
                { role: 'assistant', content: reply },
              ]);
              await sendMetaReply(deps, phone, reply);
              return;
            }
          }
        }
        const reply = [
          `Got it — nothing booked yet.`,
          ``,
          `Send a *price* to search with, or "edit pickup <address>" / "edit destination <address>" to fix the route.`,
        ].join('\n');
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const pickup = {
        lat: pendingRoute.pickupLat,
        lng: pendingRoute.pickupLng,
        address: pendingRoute.pickupAddress,
      };
      const destination = {
        lat: pendingRoute.destLat,
        lng: pendingRoute.destLng,
        address: pendingRoute.destAddress,
      };
      const offerNgn = pendingRoute.offerNgn;

      // Two quick "yes"es (different wamids) must not book twice.
      const publishClaim = await deps.redisClient.setIfNotExists(`whatsapp:user:${user.id}:publishing`, '1', 30).catch(() => true);
      if (!publishClaim) return;

      const rideId = randomUUID();
      const event = RideRequestedEvent.parse({
        eventType: 'RIDE_REQUESTED',
        rideId,
        riderId: user.id,
        pickup,
        destination,
        stops: pendingRoute.stops ?? [],
        plannedDistanceKm: pendingRoute.distanceKm,
        plannedDurationSeconds: pendingRoute.durationSeconds,
        fareEstimateNgn: pendingRoute.suggestedFareNgn,
        paymentMethod: 'WALLET',
        riderOfferNgn: offerNgn,
        suggestedFareNgn: pendingRoute.suggestedFareNgn,
        minOfferNgn: pendingRoute.minOfferNgn,
        ratePerKmNgn: pendingRoute.ratePerKmNgn,
        route: pendingRoute.route,
        timestamp: new Date().toISOString(),
      });

      try {
        await deps.publisher.publishRideEvent(event);
      } catch (publishError) {
        console.error('[api-gateway][whatsapp] ride publish FAILED — quote kept', {
          rideId,
          riderId: user.id,
          error: publishError instanceof Error ? publishError.message : String(publishError),
        });
        await deps.redisClient.del(`whatsapp:user:${user.id}:publishing`).catch(() => {});
        const reply = 'Could not start the search just now. Reply *yes* to try again.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }
      await clearPendingRoute(deps.redisClient, user.id);

      await storeWhatsappRide(deps.redisClient, rideId, {
        riderId: user.id,
        phone,
        pickupAddress: pickup.address,
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        destinationAddress: destination.address,
        destinationLat: destination.lat,
        destinationLng: destination.lng,
        distanceKm: pendingRoute.distanceKm,
        durationSeconds: pendingRoute.durationSeconds,
        offerNgn,
        suggestedFareNgn: pendingRoute.suggestedFareNgn,
        paymentMethod: 'WALLET',
        createdAt: new Date().toISOString(),
      });
      await setActiveRide(deps.redisClient, user.id, rideId);
      await setBookingStage(deps.redisClient, user.id, 'searching');
      await storeLastRoute(deps.redisClient, user.id, {
        pickupLat: pendingRoute.pickupLat,
        pickupLng: pendingRoute.pickupLng,
        pickupAddress: pendingRoute.pickupAddress,
        destLat: pendingRoute.destLat,
        destLng: pendingRoute.destLng,
        destAddress: pendingRoute.destAddress,
        distanceKm: pendingRoute.distanceKm,
        durationSeconds: pendingRoute.durationSeconds,
        suggestedFareNgn: pendingRoute.suggestedFareNgn,
        minOfferNgn: pendingRoute.minOfferNgn,
        ratePerKmNgn: pendingRoute.ratePerKmNgn,
        route: pendingRoute.route,
        offerNgn,
      });

      const reply = [
        `*Finding you a driver!*`,
        ``,
        `Pickup: *${pickup.address}*`,
        `Destination: *${destination.address}*`,
        `${pendingRoute.distanceKm.toFixed(1)} km · ~${Math.ceil(pendingRoute.durationSeconds / 60)} min`,
        `Your offer: ₦${offerNgn.toLocaleString()}`,
        ``,
        `We'll send you all available drivers!`,
      ].join('\n');

      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // "WHERE IS THE STOP?" — a typed place, a tapped match, or "back"
    // ══════════════════════════════════════════════════════════════════════
    if (bookingStage === 'adding_stop' && !isLocation) {
      const trip = await getPendingRoute(deps.redisClient, user.id);
      if (!trip) {
        await clearBookingStage(deps.redisClient, user.id);
        await replyAndLog(deps, phone, incomingMessage, `That trip has expired.\n\n${BOOKING_START_PROMPT}`);
        return;
      }
      if (/^(back|no|nothing|never\s*mind|nevermind|leave it|cancel)[\s!.]*$/i.test(incomingMessage.trim())) {
        await clearPendingGeoChoices(deps.redisClient, user.id).catch(() => undefined);
        const said = await sendTripConfirmation(deps, user, phone, trip, 'No stop added — here is your trip');
        await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
        return;
      }
      const pickedStop = await takePickedPlace(deps, user.id, incomingMessage, ['stop']);
      if (pickedStop) {
        await addStopToTrip(deps, user, phone, incomingMessage, trip, pickedStop.address, pickedStop);
        return;
      }
      await addStopToTrip(deps, user, phone, incomingMessage, trip, stripDirectionPrefix(incomingMessage));
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // "IS THIS YOUR TRIP?" — before any price. Taps are handled above by id;
    // this is for what they TYPE: yes, a price, or what to change.
    // ══════════════════════════════════════════════════════════════════════
    if (bookingStage === 'awaiting_trip_confirm' && !isLocation) {
      const trip = await getPendingRoute(deps.redisClient, user.id);
      if (!trip) {
        await clearBookingStage(deps.redisClient, user.id);
        await replyAndLog(deps, phone, incomingMessage, `That trip has expired.\n\n${BOOKING_START_PROMPT}`);
        return;
      }

      if (isCancelCommand(incomingMessage)) {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        await replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
        return;
      }

      // A tap on "which one did you mean?" after a typed change.
      const picked = await takePickedPlace(deps, user.id, incomingMessage, ['edit_pickup', 'edit_destination', 'stop']);
      if (picked) {
        if (picked.context === 'stop') await addStopToTrip(deps, user, phone, incomingMessage, trip, picked.address, picked);
        else await replanPendingRoute(deps, user, phone, incomingMessage, trip, picked.context === 'edit_pickup' ? 'pickup' : 'destination', picked.address, picked);
        return;
      }

      // A place in another city is waiting on a yes/no.
      const farPlace = await getPendingFarPlace(deps.redisClient, user.id);
      if (farPlace) {
        await clearPendingFarPlace(deps.redisClient, user.id);
        if (isAffirmativeReply(incomingMessage)) {
          await replanPendingRoute(deps, user, phone, incomingMessage, trip, farPlace.field, farPlace.address, { ...farPlace, farConfirmed: true });
          return;
        }
      }

      if (isEditPickupCommand(incomingMessage) || isEditDestinationCommand(incomingMessage)) {
        const field = isEditPickupCommand(incomingMessage) ? 'pickup' : 'destination';
        const inlineAddress = extractEditAddress(incomingMessage);
        if (inlineAddress) await replanPendingRoute(deps, user, phone, incomingMessage, trip, field, inlineAddress);
        else await askForNewEnd(deps, user, phone, incomingMessage, trip, field);
        return;
      }
      if (/^edit(\s+(my\s+)?trip)?[\s!.]*$/i.test(incomingMessage.trim())) {
        if (await sendEditTripForm(deps, user.id, phone, false)) {
          await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: '[sent the Edit trip form]' }]);
          return;
        }
        const said = await sendTripEditMenu(deps, phone, trip);
        await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
        return;
      }
      const removeTyped = /^remove\s+stop\s*(\d)?[\s!.]*$/i.exec(incomingMessage.trim());
      if (removeTyped) {
        await removeStopFromTrip(deps, user, phone, incomingMessage, trip, removeTyped[1] ? Number(removeTyped[1]) : undefined);
        return;
      }

      // They skipped ahead and named a price: the trip on screen is the trip
      // they are pricing. Confirm it and let the price step read the number.
      if (parseCounterOffer(incomingMessage) !== null) {
        await storePendingRoute(deps.redisClient, user.id, { ...trip, confirmed: true });
        await setBookingStage(deps.redisClient, user.id, 'awaiting_price');
        await handleIncomingMetaMessage(deps, { ...msgInfo, messageId: '', replyId: undefined });
        return;
      }
      if (isAffirmativeReply(incomingMessage)) {
        await confirmTripAndQuote(deps, user, phone, incomingMessage, trip);
        return;
      }

      const wanted = await classifyBookingIntent(bookingIntentGroq(deps), {
        step: 'confirm',
        message: incomingMessage,
        context: { pickupAddress: trip.pickupAddress, destinationAddress: trip.destAddress, stopAddresses: (trip.stops ?? []).map((stop) => stop.address) },
        recentMessages: await getWhatsappConversation(deps.redisClient, phone),
      });

      if (wanted.intent === 'confirm') {
        await confirmTripAndQuote(deps, user, phone, incomingMessage, trip);
        return;
      }
      if (wanted.intent === 'change_pickup' || wanted.intent === 'change_destination') {
        const field = wanted.intent === 'change_pickup' ? 'pickup' : 'destination';
        if (wanted.address) await changeEndOrAsk(deps, user, phone, incomingMessage, trip, field, wanted.address);
        else await askForNewEnd(deps, user, phone, incomingMessage, trip, field);
        return;
      }
      if (wanted.intent === 'add_stop') {
        // They named it → add it right here. They did not → the form is the shortest way to say where.
        if (wanted.address) await addStopToTrip(deps, user, phone, incomingMessage, trip, wanted.address);
        else if (await sendEditTripForm(deps, user.id, phone, true)) {
          await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: '[sent the Edit trip form]' }]);
        } else await askForStop(deps, user, phone, incomingMessage, trip);
        return;
      }
      if (wanted.intent === 'remove_stop') {
        await removeStopFromTrip(deps, user, phone, incomingMessage, trip);
        return;
      }
      if (wanted.intent === 'cancel') {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        await replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
        return;
      }
      if (wanted.intent === 'restart') {
        await startBookingOver(deps, user, phone, incomingMessage);
        return;
      }

      // Anything else: the trip again, with the three things they can do.
      const said = await sendTripConfirmation(deps, user, phone, trip,
        wanted.intent === 'help' ? 'No wahala — this is the trip I have for you' : 'I did not catch that — this is the trip I have for you');
      await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
      return;
    }

    if (bookingStage === 'awaiting_price' && !isLocation) {
      const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
      if (pendingRoute) {
        // ── "group" — switch this quote into the group-ride flow ──
        if (/^group(\s*ride)?$/i.test(incomingMessage.trim())) {
          await clearPendingRoute(deps.redisClient, user.id);
          await startGroupRideFlow(deps, user, phone, incomingMessage, {
            pickup: {
              lat: pendingRoute.pickupLat,
              lng: pendingRoute.pickupLng,
              address: pendingRoute.pickupAddress,
            },
            destination: {
              lat: pendingRoute.destLat,
              lng: pendingRoute.destLng,
              address: pendingRoute.destAddress,
            },
          });
          return;
        }

        // ── Direct edit commands: "edit pickup" / "edit destination" ──
        if (isEditPickupCommand(incomingMessage) || isEditDestinationCommand(incomingMessage)) {
          const isPickup = isEditPickupCommand(incomingMessage);
          const inlineAddress = extractEditAddress(incomingMessage);

          if (inlineAddress) {
            await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute, isPickup ? 'pickup' : 'destination', inlineAddress);
            return;
          }

          // No inline address — ask for it
          const label = isPickup ? 'pickup' : 'destination';
          const current = isPickup ? pendingRoute.pickupAddress : pendingRoute.destAddress;
          await setBookingStage(deps.redisClient, user.id, isPickup ? 'editing_pickup' : 'editing_destination');
          const reply = `Current ${label}: *${current}*\n\nSend a new ${label} location pin or type the address.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // ── Cancel during awaiting_price ──
        if (isCancelCommand(incomingMessage)) {
          await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
          const reply = CANCELLATION_REASON_PROMPT;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // A tap on "which one did you mean?" for a corrected address.
        const pickedEdit = await takePickedPlace(deps, user.id, incomingMessage, ['edit_pickup', 'edit_destination']);
        if (pickedEdit) {
          await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute,
            pickedEdit.context === 'edit_pickup' ? 'pickup' : 'destination', pickedEdit.address, pickedEdit);
          return;
        }

        // A place in another city is waiting on a yes/no.
        const farPlace = await getPendingFarPlace(deps.redisClient, user.id);
        if (farPlace) {
          await clearPendingFarPlace(deps.redisClient, user.id);
          if (isAffirmativeReply(incomingMessage)) {
            await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute, farPlace.field, farPlace.address, { ...farPlace, farConfirmed: true });
            return;
          }
          // Anything else is read normally below — usually the corrected address.
        }

        const offerNgn = parseCounterOffer(incomingMessage);

        if (offerNgn === null) {
          // Not a price. Rather than insist on one, find out what they DO want.
          const wanted = await classifyBookingIntent(bookingIntentGroq(deps), {
            step: 'price',
            message: incomingMessage,
            context: { pickupAddress: pendingRoute.pickupAddress, destinationAddress: pendingRoute.destAddress },
            recentMessages: await getWhatsappConversation(deps.redisClient, phone),
          });

          if (wanted.intent === 'change_pickup' || wanted.intent === 'change_destination') {
            const field = wanted.intent === 'change_pickup' ? 'pickup' : 'destination';
            await clearBookingMisses(deps.redisClient, user.id);
            if (wanted.address) {
              await changeEndOrAsk(deps, user, phone, incomingMessage, pendingRoute, field, wanted.address);
              return;
            }
            const current = field === 'pickup' ? pendingRoute.pickupAddress : pendingRoute.destAddress;
            await setBookingStage(deps.redisClient, user.id, field === 'pickup' ? 'editing_pickup' : 'editing_destination');
            await replyAndLog(deps, phone, incomingMessage,
              `Current ${field}: *${current}*\n\nSend the new ${field} — type the address or share a location pin`);
            return;
          }

          if (wanted.intent === 'add_stop') {
            await clearBookingMisses(deps.redisClient, user.id);
            if (wanted.address) await addStopToTrip(deps, user, phone, incomingMessage, pendingRoute, wanted.address);
            else await askForStop(deps, user, phone, incomingMessage, pendingRoute);
            return;
          }
          if (wanted.intent === 'remove_stop') {
            await clearBookingMisses(deps.redisClient, user.id);
            await removeStopFromTrip(deps, user, phone, incomingMessage, pendingRoute);
            return;
          }

          if (wanted.intent === 'cancel') {
            await clearBookingMisses(deps.redisClient, user.id);
            await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
            await replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
            return;
          }

          if (wanted.intent === 'restart') {
            await startBookingOver(deps, user, phone, incomingMessage);
            return;
          }

          const pricePrompt = `Minimum: ₦${pendingRoute.minOfferNgn.toLocaleString()}\nSuggested: ₦${pendingRoute.suggestedFareNgn.toLocaleString()}`;

          if (wanted.intent === 'confirm') {
            // Never turn a bare "ok" into a fare — they name the number.
            await replyAndLog(deps, phone, incomingMessage,
              `Almost there — just tell me your price.\n\n${pricePrompt}\n\nSend *${pendingRoute.suggestedFareNgn.toLocaleString()}* to go with the suggested fare, or name your own.`);
            return;
          }

          if (wanted.intent === 'answer') {
            // The model heard a price we could not read as a number ("two
            // thousand five hundred"). We do not guess amounts.
            await replyAndLog(deps, phone, incomingMessage,
              `I couldn't read that as an amount — please send it in figures, like *${pendingRoute.suggestedFareNgn.toLocaleString()}*.\n\n${pricePrompt}`);
            return;
          }

          await replyWithWayOut(deps, user, phone, incomingMessage, {
            wantsHelp: wanted.intent === 'help',
            prompt: `Please send a price for your ride.\n\n${pricePrompt}\n\nExample: *${pendingRoute.suggestedFareNgn.toLocaleString()}*`,
            hint: 'Or reply *change pickup*, *change destination* or *cancel*.',
            buttons: ['Change pickup', 'Change destination', 'Cancel ride'],
          });
          return;
        }

        await clearBookingMisses(deps.redisClient, user.id);

        if (offerNgn < pendingRoute.minOfferNgn) {
          await sendFloorNudge(deps, phone, incomingMessage, offerNgn, pendingRoute.minOfferNgn);
          return;
        }

        // Publish ride — payment happens when rider accepts a driver. The same
        // step the bidding page takes when they name the price there.
        const published = await publishWhatsappRide(deps, { id: user.id, phone }, pendingRoute, offerNgn);
        if (!published.ok) {
          if (published.code === 'ALREADY_PUBLISHING') return;
          const reply = published.code === 'BELOW_MINIMUM'
            ? `The lowest price for this trip is ₦${published.minOfferNgn.toLocaleString()}. Send that, or a higher amount.`
            : 'Could not start the search just now. Send your price again to retry.';
          await replyAndLog(deps, phone, incomingMessage, reply);
          return;
        }

        const searchText = await sendSearchStarted(deps, user, phone, {
          pickupAddress: pendingRoute.pickupAddress,
          destAddress: pendingRoute.destAddress,
          stopAddresses: (pendingRoute.stops ?? []).map((stop) => stop.address),
          offerNgn,
        });
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: searchText },
        ]);
        return;
      } else {
        // The quote expired (10 minutes) but the stage lingered — the price
        // used to fall through to the chatbot, which answered "3000" as chat.
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'That quote expired — send your pickup and destination again and we\'ll re-check the price.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 5. CANCEL RIDE (via LLM intent or direct text, no active ride)
    // ══════════════════════════════════════════════════════════════════════

    if (isCancelCommand(incomingMessage)) {
      // Clear any pending state
      await clearPendingLocation(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);
      await clearPendingRoute(deps.redisClient, user.id);

      const reply = 'Nothing to cancel. Share your location to book a ride!';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 6. NO ACTIVE RIDE, NO PENDING STATE — AI conversation / ride intent
    // ══════════════════════════════════════════════════════════════════════

    // ── "menu", or a bare "hi" with nothing going on: the quick actions ──
    if (isBookingOpener(incomingMessage)) {
      await sendQuickActions(deps, user, phone, null, incomingMessage, true);
      return;
    }

    // ── "Search again" is a VERB, not a vibe. Handled BEFORE the intent
    // parser: fed "keep searching", the LLM re-read the old route out of
    // the chat history as a brand-new request and asked the rider to
    // confirm addresses they had already confirmed. Restart the search.
    if (/^\s*(search again|keep searching|try again|retry|find (me )?(a )?driver)\b/i.test(incomingMessage)) {
      const lastRoute = await getLastRoute(deps.redisClient, user.id);
      if (!lastRoute) {
        const reply = 'Tell me the route first — like *"From 102 Opebi Rd to Yaba"* — and I\'ll find you a driver.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const rideId = randomUUID();
      const searchEvent = RideRequestedEvent.parse({
        eventType: 'RIDE_REQUESTED',
        rideId,
        riderId: user.id,
        pickup: { lat: lastRoute.pickupLat, lng: lastRoute.pickupLng, address: lastRoute.pickupAddress },
        destination: { lat: lastRoute.destLat, lng: lastRoute.destLng, address: lastRoute.destAddress },
        stops: lastRoute.stops ?? [],
        plannedDistanceKm: lastRoute.distanceKm,
        plannedDurationSeconds: lastRoute.durationSeconds,
        fareEstimateNgn: lastRoute.suggestedFareNgn,
        paymentMethod: 'WALLET',
        riderOfferNgn: lastRoute.offerNgn,
        suggestedFareNgn: lastRoute.suggestedFareNgn,
        minOfferNgn: lastRoute.minOfferNgn,
        ratePerKmNgn: lastRoute.ratePerKmNgn,
        route: lastRoute.route as never,
        timestamp: new Date().toISOString(),
      });
      await deps.publisher.publishRideEvent(searchEvent);

      await storeWhatsappRide(deps.redisClient, rideId, {
        riderId: user.id,
        phone,
        pickupAddress: lastRoute.pickupAddress,
        pickupLat: lastRoute.pickupLat,
        pickupLng: lastRoute.pickupLng,
        destinationAddress: lastRoute.destAddress,
        destinationLat: lastRoute.destLat,
        destinationLng: lastRoute.destLng,
        distanceKm: lastRoute.distanceKm,
        stops: lastRoute.stops,
        durationSeconds: lastRoute.durationSeconds,
        offerNgn: lastRoute.offerNgn,
        suggestedFareNgn: lastRoute.suggestedFareNgn,
        paymentMethod: 'WALLET',
        createdAt: new Date().toISOString(),
      });
      await setActiveRide(deps.redisClient, user.id, rideId);
      await setBookingStage(deps.redisClient, user.id, 'searching');

      const reply = [
        `*Searching again!*`,
        ``,
        `${lastRoute.pickupAddress} → ${lastRoute.destAddress}`,
        `Your offer: ₦${lastRoute.offerNgn.toLocaleString()}`,
        ``,
        `Asking drivers nearby — offers land here as they come. Sending a higher number any time raises your offer.`,
      ].join('\n');
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    const recentMessages = await getWhatsappConversation(deps.redisClient, phone);

    const groq = createLlm({ groqApiKey: deps.groqApiKey, groqModel: deps.groqModel, timeoutMs: deps.groqTimeoutMs });

    // Try to parse ride intent — with what we remember about this rider, so
    // "take me home" and "same place as last time" resolve to real addresses.
    const riderMemory = await loadRiderMemory(user.id).catch(() => null);
    const rideIntent = await parseRideIntent(
      groq,
      incomingMessage,
      riderMemory?.transcript?.length ? riderMemory.transcript : recentMessages,
      riderMemory ? renderRiderMemoryForIntent(riderMemory) : undefined,
    );

    if (rideIntent && (rideIntent.intent === 'ride_request' || rideIntent.intent === 'group_ride_request') && rideIntent.outsideNigeria) {
      const place = rideIntent.destination?.address || rideIntent.pickup?.address || 'that place';
      const reply = `${place} is outside Nigeria. ${OUTSIDE_SERVICE_AREA_LINE}\n\nAnywhere in Nigeria I can take you?`;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    if (rideIntent && rideIntent.intent !== 'other') {
      // Learn from booking messages too — the general-chat path does its own.
      rememberExchange(groq, user.id, incomingMessage, null);
    }

    // ── Money, caught by the general parser too (no guard in front of this one) ──
    if (rideIntent?.intent === 'deposit' || rideIntent?.intent === 'withdraw') {
      await sendWalletPageButton(deps, user, phone, incomingMessage, rideIntent.intent);
      return;
    }

    // ── Edit pickup/destination with no pending route → tell user to start fresh ──
    if (rideIntent?.intent === 'edit_pickup' || rideIntent?.intent === 'edit_destination') {
      const reply = 'No ride in progress to edit. Start a new ride by typing:\n\n*"From [pickup] to [destination]"*\n\nOr share a location pin';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    if (rideIntent?.intent === 'group_ride_request') {
      const pickupGeo = rideIntent.pickup?.specific && rideIntent.pickup.address.trim()
        ? await geocodeAddress(deps.googleMapsApiKey, rideIntent.pickup.address, { spokenText: incomingMessage })
        : null;
      const destGeo = rideIntent.destination?.specific && rideIntent.destination.address.trim()
        ? await geocodeAddress(deps.googleMapsApiKey, rideIntent.destination.address, { spokenText: incomingMessage })
        : null;

      await startGroupRideFlow(deps, user, phone, incomingMessage, {
        ...(pickupGeo
          ? { pickup: { lat: pickupGeo.lat, lng: pickupGeo.lng, address: pickupGeo.formattedAddress } }
          : {}),
        ...(destGeo
          ? { destination: { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress } }
          : {}),
      });
      return;
    }

    if (rideIntent?.intent === 'ride_request') {
      const hasPickup = rideIntent.pickup?.specific && rideIntent.pickup.address.trim();
      const hasDestination = rideIntent.destination?.specific && rideIntent.destination.address.trim();

      // ── Both pickup & destination typed → geocode both and plan route ──
      if (hasPickup && hasDestination) {
        // Pickup first, so the destination can be searched for NEAR it. Looked
        // up side by side, "osaro isokpan" had no idea the trip started in Lagos.
        const pickupOptions = await findPlaceOptions(deps.googleMapsApiKey, rideIntent.pickup!.address, { spokenText: incomingMessage });
        if (pickupOptions.length > 1) {
          // Several pickups by that name. Ask — and remember where they are
          // going, so choosing one carries straight on to the destination.
          await setPendingAreaHint(deps.redisClient, user.id, {
            kind: 'pickup',
            area: '',
            counterpartAddress: rideIntent.destination!.address.trim(),
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_pickup');
          await sendPlaceChoices(deps, user, phone, incomingMessage, {
            context: 'pickup', field: 'pickup', typed: rideIntent.pickup!.address, candidates: pickupOptions,
          });
          return;
        }
        const pickupGeo = pickupOptions[0] ?? null;

        const destOptions = pickupGeo
          ? await findPlaceOptions(deps.googleMapsApiKey, rideIntent.destination!.address, {
              spokenText: incomingMessage,
              near: { lat: pickupGeo.lat, lng: pickupGeo.lng },
            })
          : [];
        if (pickupGeo && destOptions.length > 1) {
          // "Caleb University" is a main campus, a College of Law, an admissions
          // office… The pickup is settled; the destination step takes the tap.
          await setPendingLocation(deps.redisClient, user.id, {
            lat: pickupGeo.lat, lng: pickupGeo.lng, address: pickupGeo.formattedAddress, savedAt: new Date().toISOString(),
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');
          await sendPlaceChoices(deps, user, phone, incomingMessage, {
            context: 'destination', field: 'destination', typed: rideIntent.destination!.address, candidates: destOptions,
            intro: `Pickup: *${pickupGeo.formattedAddress}*`,
          });
          return;
        }
        const destGeo = destOptions[0] ?? null;

        if (!pickupGeo) {
          const reply = `${geocodeMissLine(rideIntent.pickup!.address)}\n\nPlease try a more specific pickup address, or share a location pin`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        if (!destGeo) {
          // Pickup worked — save it and ask for destination again
          await setPendingLocation(deps.redisClient, user.id, {
            lat: pickupGeo.lat,
            lng: pickupGeo.lng,
            address: pickupGeo.formattedAddress,
            savedAt: new Date().toISOString(),
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

          const reply = `Pickup: *${pickupGeo.formattedAddress}*\n\n${geocodeMissLine(rideIntent.destination!.address)}\n\nPlease type a more specific destination or share a destination location pin`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Both geocoded — plan route and ask for price. Any pickup pin from an
        // abandoned booking is superseded by what they just typed.
        await clearPendingLocation(deps.redisClient, user.id).catch(() => {});
        const pickup = { lat: pickupGeo.lat, lng: pickupGeo.lng, address: pickupGeo.formattedAddress };
        const destination = { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress };

        // The same place twice ("from Admiralty Way to Admiralty Way"): keep the pickup, ask where they are going.
        if (samePlacePair(pickup, destination)) {
          await setPendingLocation(deps.redisClient, user.id, { ...pickup, savedAt: new Date().toISOString() });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');
          await replyAndLog(deps, phone, incomingMessage, `Your pickup and your destination are the same place: *${pickup.address}*.\n\nPickup kept. Where are you going? Type the destination or share a pin.`);
          return;
        }

        // A destination in another city: keep the pickup, and ask before quoting.
        // Their answer ("yes", or the address again with the area) is handled by
        // the destination step.
        if (kmBetween(pickup, destination) > SAME_CITY_KM) {
          await setPendingLocation(deps.redisClient, user.id, { ...pickup, savedAt: new Date().toISOString() });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');
          await askIfFarPlaceIsMeant(deps, user, phone, incomingMessage, 'destination', destination, pickup);
          return;
        }

        const plannedRoute = await planRouteSafe(deps, pickup, destination);
        if (!plannedRoute) {
          const reply = ROUTE_PLAN_FAILED_REPLY;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
        const distanceKm = plannedRoute.distanceKm;
        const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
        const suggestedFare = plannedRoute.suggestedFareNgn;
        const minFare = plannedRoute.minOfferNgn;

        await storePendingRoute(deps.redisClient, user.id, {
          pickupLat: pickup.lat,
          pickupLng: pickup.lng,
          pickupAddress: pickup.address,
          destLat: destination.lat,
          destLng: destination.lng,
          destAddress: destination.address,
          distanceKm,
          durationSeconds: plannedRoute.durationSeconds,
          suggestedFareNgn: suggestedFare,
          minOfferNgn: minFare,
          ratePerKmNgn: plannedRoute.ratePerKmNgn,
          route: plannedRoute.geometry,
        });

        // A rider who named a price used to be booked instantly — which meant
        // the ONE place the resolved addresses are shown was skipped entirely.
        // Geocoding can quietly land somewhere else ("15 Aiyetoro St, Ikeja"
        // resolves into Surulere), so the rider never saw where they were
        // actually being sent. Show it and take one "yes" first.
        if (rideIntent.offerNgn && rideIntent.offerNgn >= minFare) {
          await storePendingRoute(deps.redisClient, user.id, {
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            pickupAddress: pickup.address,
            destLat: destination.lat,
            destLng: destination.lng,
            destAddress: destination.address,
            distanceKm,
            durationSeconds: plannedRoute.durationSeconds,
            suggestedFareNgn: suggestedFare,
            minOfferNgn: minFare,
            ratePerKmNgn: plannedRoute.ratePerKmNgn,
            route: plannedRoute.geometry,
            offerNgn: rideIntent.offerNgn,
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_route_confirmation');

          const reply = [
            `Please check this is right`,
            ``,
            `Pickup: *${pickup.address}*`,
            `Destination: *${destination.address}*`,
            `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
            `Your offer: ₦${rideIntent.offerNgn.toLocaleString()}`,
            ``,
            `Reply *yes* to find a driver.`,
            `Wrong spot? Send the correct destination address, or *edit pickup <address>*. Different price? Just send the number.`,
          ].join('\n');

          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }


        await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

        const groupSuggestion = await buildGroupSuggestionLine(user.id, pickup, destination);
        const reply = [
          `Pickup: *${pickup.address}*`,
          ``,
          `Destination: *${destination.address}*`,
          ``,
          `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
          `Minimum fare: ₦${minFare.toLocaleString()}`,
          `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
          ``,
          `Negotiate your price and we'll find you a driver!`,
          `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
        ].join('\n') + groupSuggestion;

        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendQuoteWithPriceButton(deps, user, phone, reply);
        return;
      }

      // ── Pickup typed, destination missing or only an area ("… to Lekki") ──
      if (hasPickup) {
        const destinationAreaText = rideIntent.destination?.address?.trim() || undefined;
        const destinationArea = rideIntent.destination?.area?.trim() || destinationAreaText;

        const pickupMatches = await findPlaceOptions(deps.googleMapsApiKey, rideIntent.pickup!.address, { spokenText: incomingMessage });
        if (pickupMatches.length > 1) {
          await setPendingAreaHint(deps.redisClient, user.id, { kind: 'pickup', area: '', counterpartAddress: destinationAreaText });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_pickup');
          await sendPlaceChoices(deps, user, phone, incomingMessage, {
            context: 'pickup', field: 'pickup', typed: rideIntent.pickup!.address, candidates: pickupMatches,
          });
          return;
        }

        const pickupGeo = pickupMatches[0];
        if (pickupGeo) {
          await setPendingLocation(deps.redisClient, user.id, {
            lat: pickupGeo.lat,
            lng: pickupGeo.lng,
            address: pickupGeo.formattedAddress,
            savedAt: new Date().toISOString(),
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

          // They named an area to go to ("Lekki"): keep it — a one-word answer
          // resolves against it — and offer its well-known spots to tap.
          if (destinationArea && destinationAreaText) {
            await setPendingAreaHint(deps.redisClient, user.id, {
              kind: 'destination',
              area: destinationAreaText,
              counterpartAddress: rideIntent.pickup!.address.trim(),
            });
            const spots = await findAreaSpots(deps.googleMapsApiKey, destinationArea, pickupGeo).catch(() => []);
            if (spots.length >= 2) {
              await sendPlaceChoices(deps, user, phone, incomingMessage, {
                context: 'destination', field: 'destination', typed: destinationArea, candidates: spots,
                intro: `Pickup: *${pickupGeo.formattedAddress}*`,
                question: `Whereabouts in *${destinationArea}* are you headed?\n\nTap *Choose* for well-known spots — or type a landmark or street, or share a location pin`,
              });
              return;
            }
          }

          const reply = destinationArea
            ? `Pickup: *${pickupGeo.formattedAddress}*\n\nWhereabouts in *${destinationArea}* are you headed? A landmark, street or building works — or share a location pin`
            : `Pickup: *${pickupGeo.formattedAddress}*\n\nNow send your *destination* — type the address or share a location pin`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
        // The pickup they named will not geocode. Say so — falling through
        // used to ask "whereabouts are you headed?" and then expire.
        const reply = `${geocodeMissLine(rideIntent.pickup!.address)}\n\nTry a nearby landmark or street for the pickup, or share a location pin`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Something was named but it is too broad to geocode ──
      // "I wanna go from Allen" used to land on the generic template below,
      // which threw "Allen" away and made the rider retype everything. Ask
      // about the area they actually said, and remember it so a one-word
      // answer ("roundabout") can be resolved against it.
      const vaguePickup = rideIntent.pickup?.address?.trim();

      if (vaguePickup && !hasPickup) {
        await setPendingAreaHint(deps.redisClient, user.id, {
          kind: 'pickup',
          area: vaguePickup,
          counterpartAddress: hasDestination
            ? rideIntent.destination!.address.trim()
            : undefined,
        });
        await setBookingStage(deps.redisClient, user.id, 'awaiting_pickup');

        const areaName = rideIntent.pickup?.area?.trim() || vaguePickup;

        // "Ikorodu" is a town, not a pickup. Offer the spots riders actually
        // name there; typing a landmark or sharing a pin still works.
        const pickupSpots = await findAreaSpots(deps.googleMapsApiKey, areaName).catch(() => []);
        if (pickupSpots.length >= 2) {
          await sendPlaceChoices(deps, user, phone, incomingMessage, {
            context: 'pickup', field: 'pickup', typed: areaName, candidates: pickupSpots,
            question: `Whereabouts in *${areaName}* should the driver pick you up?\n\nTap *Choose* for well-known spots — or type a landmark or street, or share a location pin`,
          });
          return;
        }

        const reply =
          `Whereabouts in *${areaName}* should the driver pick you up?\n\n` +
          `Tell me a landmark, street or bus stop — e.g. "${areaName} roundabout" — or share a location pin`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Only a destination ("take me to Caleb University") ──
      // This used to fall through to the template below and throw away what
      // they said. Remember where they are going; the moment the pickup is
      // settled the destination step is answered with it.
      const knownDestination = rideIntent.destination?.address?.trim();
      if (knownDestination && !rideIntent.pickup?.address?.trim()) {
        await setPendingAreaHint(deps.redisClient, user.id, { kind: 'pickup', area: '', counterpartAddress: knownDestination });
        await setBookingStage(deps.redisClient, user.id, 'awaiting_pickup');
        const goingTo = (rideIntent.destination?.area?.trim() && !rideIntent.destination?.specific ? rideIntent.destination.area : knownDestination).split(',')[0];
        await replyAndLog(deps, phone, incomingMessage,
          `Heading to *${goingTo}* — got it.\n\nWhere should we pick you up? Type the address or a landmark, or share a location pin`);
        return;
      }

      // ── Nothing usable named at all → explain the format ──
      const reply = 'To book a ride, type your pickup and destination like:\n\n*"From [pickup address] to [destination]"*\n\nOr share your pickup location pin';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // Ignore empty messages (stickers, images, etc.) — don't send to LLM
    if (!incomingMessage.trim()) {
      return;
    }

    // ── The rating reply: after a trip, a bare 1–5 rates the driver. Armed
    // by the completion receipt ("Reply 1–5 to rate them"), disarmed once
    // used — so a lone digit weeks later can't accidentally become a rating.
    const bareRating = incomingMessage.trim().match(/^([1-5])(\s*\u2B50*|\s*stars?)?$/i);
    if (bareRating) {
      const lastCompleted = await getLastCompletedRide(deps.redisClient, user.id);
      if (lastCompleted) {
        const rating = Number(bareRating[1]);
        await deps.publisher.publishComplianceEvent(FeedbackLoggedEvent.parse({
          eventType: 'FEEDBACK_LOGGED',
          feedbackId: randomUUID(),
          rideId: lastCompleted.rideId,
          reviewerId: user.id,
          reviewerRole: 'RIDER',
          revieweeId: lastCompleted.driverUserId,
          rating,
          timestamp: new Date().toISOString(),
        }));
        await clearLastCompletedRide(deps.redisClient, user.id);
        const reply = rating >= 4
          ? `Thanks! Your ${rating}-star rating was sent${lastCompleted.driverName ? ` to ${lastCompleted.driverName}` : ''}. Book another ride anytime — just send your route.`
          : `Thanks for the honest ${rating}-star rating. Sorry that trip wasn't great — tell us what went wrong and we'll look into it.`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }
    }

    // ── Balance questions are MONEY questions — answered from the database,
    // never by the LLM. The model has old balances sitting in the chat
    // history and will happily parrot them; a rider who just got a refund
    // then "sees" their money missing and assumes theft.
    if (/\b(balance|how much.{0,20}(wallet|money|account)|wallet)\b/i.test(incomingMessage) &&
        !/withdraw|deposit|top ?up|fund/i.test(incomingMessage)) {
      const wallet = await walletClient.findByUserId(user.id).catch(() => null);
      const balance = wallet ? Number(wallet.balanceNgn) : 0;
      const locked = wallet ? Number(wallet.lockedNgn) : 0;
      const reply = locked > 0
        ? `Your wallet balance is ₦${balance.toLocaleString()} (plus ₦${locked.toLocaleString()} held for your current ride).`
        : `Your wallet balance is ₦${balance.toLocaleString()}.`;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // AI response for general messages
    const bot = new WhatsappBotService({
      apiKey: deps.groqApiKey,
      model: deps.groqModel,
      timeoutMs: deps.groqTimeoutMs,
      jwtSecret: deps.jwtSecret,
      appBaseUrl: deps.appBaseUrl,
    });
    const reply = await bot.generateReply({
      userId: user.id,
      phone,
      profileName,
      incomingMessage,
      isNewUser: user.created,
      recentMessages,
    });

    await appendWhatsappConversation(deps.redisClient, phone, [
      { role: 'user', content: incomingMessage || '[empty message]' },
      { role: 'assistant', content: reply },
    ]);

    await sendMetaReply(deps, phone, reply);
  } catch (error) {
    if (dedupKey) await deps.redisClient.del(dedupKey).catch(() => {});
    console.error('[whatsapp] message handling failed', error);
    // Don't try to send error — we already responded 200
  }
}

