import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { groupRideClient, walletClient, walletSecurityClient, withdrawalClient, rideClient } from '@wheleers/db';
import { RideRequestedEvent, RideCancelledEvent, FeedbackLoggedEvent } from '@wheleers/kafka-schemas';
import { QUICK_ACTION_IDS, isQuickActionId, asksForMenu } from './quick-actions';
import { onboardWhatsappUser } from '../onboarding/user-onboarding';
import { appendWhatsappConversation, getWhatsappConversation } from '../LLM/conversation-store';
import { WhatsappBotService } from '../LLM/whatsapp-bot.service';
import { createLlm } from '../LLM/llm';
import { geocodeMissLine, OUTSIDE_SERVICE_AREA_LINE } from '../LLM/geocoding';
import { parseRideIntent } from '../LLM/ride-intent-parser';
import { classifyWalletIntent, mightConcernMoney } from '../LLM/wallet-intent';
import { classifyBookingIntent, mightNotBeAnAddress } from '../LLM/booking-intent';
import { loadRiderMemory, rememberExchange, renderRiderMemoryForIntent } from '../LLM/rider-memory';
import { geocodeAddress, findPlaceOptions, findAreaSpots, kmBetween, SAME_CITY_KM } from '../LLM/geocoding';
import { buildReadyForMatchEvent } from '../group-ride/ready-event';
import { logActivity } from '../analytics/log-activity';
import { storeWhatsappRide, setActiveRide, getActiveRide, clearActiveRide, setPhoneLookup, cleanupRideKeys, setPendingLocation, setPendingAreaHint, clearPendingLocation, setBookingStage, getBookingStage, clearBookingStage, getBids, getRideMeta, storePendingRoute, getPendingRoute, clearPendingRoute, getGroupRequestRider, getPendingGeoChoices, clearPendingGeoChoices, getPendingFarPlace, clearPendingFarPlace, markOffersMessageSent, clearPendingAccept, clearPendingWhatsappWithdrawal, getLastRoute, getLastCompletedRide, clearLastCompletedRide } from '../whatsapp-flows/bid-state';
import { signFlowToken } from '../whatsapp-flows/encryption';
import { sendFlowOffersMessage, sendOffersReentryMessage } from '../whatsapp-flows/whatsapp-notifier';
import { CHANGE_PRICE_REPLY_ID, parseOfferReplyId } from '../whatsapp-flows/whatsapp-notifier';
import { readRawBody, sendJson } from './utils';
import { MetaWhatsappRouteDeps } from '../whatsapp/deps';
import type { StageContext } from '../whatsapp/stage-context';
import { inRide } from '../whatsapp/stages/in-ride';
import { locationPin } from '../whatsapp/stages/location-pin';
import { awaitingPickup } from '../whatsapp/stages/awaiting-pickup';
import { awaitingDestination } from '../whatsapp/stages/awaiting-destination';
import { awaitingRouteConfirmation } from '../whatsapp/stages/awaiting-route-confirmation';
import { addingStop } from '../whatsapp/stages/adding-stop';
import { awaitingTripConfirm } from '../whatsapp/stages/awaiting-trip-confirm';
import { awaitingPrice } from '../whatsapp/stages/awaiting-price';
import { getHeaderValue, isValidMetaSignature, replyAndLog, sendMetaFlowMessage, sendMetaReply, sendTypingIndicator, sendWhatsappText } from '../whatsapp/send';
import { CANCELLATION_REASON_PROMPT, MetaMessageInfo, NONE_OF_THESE, extractMetaMessages, isAffirmativeReply, isBookingOpener, isCancelCommand, isGroupCancelCommand, isGroupStatusCommand, isWithdrawalStage, isWithdrawalStatusCommand, parseCancellationReason, stripDirectionPrefix } from '../whatsapp/parse';
import { askIfFarPlaceIsMeant, bookingIntentGroq, sendPlaceChoices, takePickedPlace } from '../whatsapp/places';
import { ROUTE_PLAN_FAILED_REPLY, buildGroupSuggestionLine, handleTripTap, planRouteSafe, replanPendingRoute, samePlacePair, sendQuoteWithPriceButton, startBookingOver } from '../whatsapp/trip';
import { SOS_CANCEL_REPLY_ID, SOS_REPLY_ID, TRACK_REPLY_ID, handleRideCardTap } from '../whatsapp/ride-card';
import { handleQuickAction, sendQuickActions } from '../whatsapp/menu';
import { sendWalletPageButton } from '../whatsapp/wallet';
import { requirePrivacyConsent } from '../whatsapp/consent';
import { cancelGroupRide, convertGroupToNormalRide, handleGroupSelfie, handleGroupStageText, sendGroupStatus, startGroupRideFlow } from '../whatsapp/group';
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

    const ctx: StageContext = { activeRideId, bookingStage, deps, incomingMessage, locationLat, locationLng, msgInfo, phone, tappedOffer, user, replay: (message) => handleIncomingMetaMessage(deps, message) };

    if (activeRideId && !isLocation && bookingStage !== 'editing_pickup' && bookingStage !== 'editing_destination') {
      if (await inRide(ctx)) return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 2. LOCATION PIN — handle pickup and destination location shares
    // ══════════════════════════════════════════════════════════════════════

    if (isLocation && locationLat !== undefined && locationLng !== undefined && !isNaN(locationLat) && !isNaN(locationLng)) {
      if (await locationPin(ctx)) return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3. AWAITING DESTINATION — user can type an address or share a pin
    // ══════════════════════════════════════════════════════════════════════

    // ── Answering "whereabouts in <area>?" for the PICKUP ──
    if (bookingStage === 'awaiting_pickup' && !isLocation && incomingMessage.trim()) {
      if (await awaitingPickup(ctx)) return;
    }

    if (bookingStage === 'awaiting_destination' && !isLocation) {
      if (await awaitingDestination(ctx)) return;
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
      if (await awaitingRouteConfirmation(ctx)) return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // "WHERE IS THE STOP?" — a typed place, a tapped match, or "back"
    // ══════════════════════════════════════════════════════════════════════
    if (bookingStage === 'adding_stop' && !isLocation) {
      if (await addingStop(ctx)) return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // "IS THIS YOUR TRIP?" — before any price. Taps are handled above by id;
    // this is for what they TYPE: yes, a price, or what to change.
    // ══════════════════════════════════════════════════════════════════════
    if (bookingStage === 'awaiting_trip_confirm' && !isLocation) {
      if (await awaitingTripConfirm(ctx)) return;
    }

    if (bookingStage === 'awaiting_price' && !isLocation) {
      if (await awaitingPrice(ctx)) return;
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

