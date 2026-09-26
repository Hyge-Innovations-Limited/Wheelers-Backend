import { GoogleMapsRoutePlanner } from '@wheleers/config';
import type { PaymentsClient } from '@wheleers/payments';
import type { GatewayPublisher } from '../websocket/publisher';
import type { GroupRideFaceStorage } from '../storage/group-ride-face-storage';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';
import type { RedisClient } from '../redis/client';

export interface MetaWhatsappRouteDeps {
  jwtSecret: string;
  publisher: GatewayPublisher;
  paymentsClient: PaymentsClient;
  redisClient: RedisClient;
  routePlanner: GoogleMapsRoutePlanner;
  googleMapsApiKey: string;
  metaAccessToken?: string;
  metaPhoneNumberId?: string;
  metaAppSecret?: string;
  metaWebhookVerifyToken?: string;
  groqApiKey?: string;
  groqModel: string;
  groqTimeoutMs: number;
  appBaseUrl?: string;
  driverKycStorage?: DriverKycStorage;
  groupRideFaceStorage?: GroupRideFaceStorage;
  /** Platform treasury VA — payouts draw from this float when configured. */
  /** Published Meta Flow id for the booking form. Unset = chat-only booking. */
  whatsappFlowId?: string;
  whatsappOffersFlowId?: string;
  /** Published "Edit trip" form. Unset = Edit trip opens the chat's Choose sheet. */
  whatsappEditTripFlowId?: string;
  /** Published offers form. Unset = offers arrive with reply buttons / the Choose list. */
  whatsappOffersFormFlowId?: string;
  /** Published Quick Actions form. Unset = the menu is WhatsApp's list picker. */
  whatsappQuickActionsFlowId?: string;
  /** The two original flows (booking form, "Driver Offers"). Off unless WHATSAPP_LEGACY_FLOWS_ENABLED says so. */
  legacyFlowsEnabled?: boolean;
}

/* ─── Meta Cloud API helpers ─── */

export type WhatsappUser = { id: string };

