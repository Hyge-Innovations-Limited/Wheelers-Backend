import { clearBookingStage, clearPendingGeoChoices, getPendingRoute } from '../../whatsapp-flows/bid-state';
import { replyAndLog } from '../../whatsapp/send';
import { BOOKING_START_PROMPT, addStopToTrip, sendTripConfirmation } from '../../whatsapp/trip';
import { appendWhatsappConversation } from '../../LLM/conversation-store';
import { takePickedPlace } from '../../whatsapp/places';
import { stripDirectionPrefix } from '../../whatsapp/parse';
import type { StageContext } from '../stage-context';

/** The addingStop stage of the chat, carved out of handleIncomingMetaMessage. Returns true when it answered the message. */
export async function addingStop(ctx: StageContext): Promise<boolean> {
  const { deps, incomingMessage, phone, user } = ctx;

    const trip = await getPendingRoute(deps.redisClient, user.id);
    if (!trip) {
      await clearBookingStage(deps.redisClient, user.id);
      await replyAndLog(deps, phone, incomingMessage, `That trip has expired.\n\n${BOOKING_START_PROMPT}`);
      return true;
    }
    if (/^(back|no|nothing|never\s*mind|nevermind|leave it|cancel)[\s!.]*$/i.test(incomingMessage.trim())) {
      await clearPendingGeoChoices(deps.redisClient, user.id).catch(() => undefined);
      const said = await sendTripConfirmation(deps, user, phone, trip, 'No stop added — here is your trip');
      await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
      return true;
    }
    const pickedStop = await takePickedPlace(deps, user.id, incomingMessage, ['stop']);
    if (pickedStop) {
      await addStopToTrip(deps, user, phone, incomingMessage, trip, pickedStop.address, pickedStop);
      return true;
    }
    await addStopToTrip(deps, user, phone, incomingMessage, trip, stripDirectionPrefix(incomingMessage));
    return true;
    return false;
}
