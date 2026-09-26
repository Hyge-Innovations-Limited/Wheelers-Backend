import type { onboardWhatsappUser } from '../onboarding/user-onboarding';
import type { BookingStage } from '../whatsapp-flows/bid-state';
import type { parseOfferReplyId } from '../whatsapp-flows/whatsapp-notifier';
import type { MetaWhatsappRouteDeps } from './deps';
import type { MetaMessageInfo } from './parse';

/**
 * What one incoming message looks like to a stage handler: everything the stage
 * machine (handleIncomingMetaMessage) had worked out before it reached the stage.
 * A stage reads these; it never assigns them. It answers the message or it does
 * not — `true` means it did, and the machine stops there.
 */
export interface StageContext {
  deps: MetaWhatsappRouteDeps;
  user: Awaited<ReturnType<typeof onboardWhatsappUser>>;
  phone: string;
  incomingMessage: string;
  msgInfo: MetaMessageInfo;
  bookingStage: BookingStage | null;
  activeRideId: string | null;
  locationLat: number | undefined;
  locationLng: number | undefined;
  /** An offer tapped in the chat, parsed from its reply id. */
  tappedOffer: ReturnType<typeof parseOfferReplyId>;
  /** Run a message through the whole machine again — the way a stage re-dispatches. */
  replay: (message: MetaMessageInfo) => Promise<void>;
}
